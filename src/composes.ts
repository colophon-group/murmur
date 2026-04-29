/**
 * `final_output.composes` runtime — assembles the webhook payload from
 * per-subtask outputs after a run completes.
 *
 * Two phases, both pure functions of their inputs (no time, no I/O
 * beyond the supplied DB handle in the runtime call):
 *
 *   1. Registration-time validation (`validateComposes`) — called from
 *      `POST /pipelines` (M4) once the pipeline def is otherwise
 *      structurally valid. Confirms that every subtask id referenced
 *      by every rule resolves to an actual subtask in the def.
 *      Subtask-id misreferences are caught here, not at run time.
 *   2. Run-time evaluation (`composeFinalOutput`) — called when all
 *      subtask instances of a run have submitted (M9 / completion path).
 *      Reads `subtask_results` joined to `subtask_instances` by run, then
 *      walks the parsed AST for each rule and writes into a fresh
 *      output object. Rules apply in array order; later rules can
 *      overwrite earlier ones.
 *
 * Errors at runtime are policy-driven: missing subtask submissions or
 * missing fields are *logged* and treated as null/empty (rule-shape-
 * dependent — `flatten` returns `[]`, wildcard skips, rename omits the
 * key, cartesian uses the listItem alone). This matches the issue's
 * verification: "reference to nonexistent field → runtime error logged,
 * treated as null/empty".
 *
 * @see DESIGN.md §3.1 — final_output.composes (jobseek worked example)
 * @see docs/contracts.md §7 — Compose-rule grammar (authoritative prose)
 * @see docs/contracts/pipeline-def.schema.json — `$defs/ComposeRule`
 *   (authoritative regex; this parser must accept exactly that grammar)
 */

import type Database from "better-sqlite3";

import type { PipelineDef } from "@murmur/contracts-types";

import { log } from "./logger.js";

// --------------------------------------------------------------------------
// AST
// --------------------------------------------------------------------------

/**
 * Parsed, typed representation of one compose rule. `parseComposeRule`
 * produces a node from a raw rule string; downstream evaluation reads
 * the discriminator and never re-parses the source.
 */
export type ComposeAst =
  | { readonly kind: "wildcard"; readonly subtask: string }
  | {
      readonly kind: "wildcard_prefix";
      readonly subtask: string;
      readonly prefix: string;
    }
  | {
      readonly kind: "rename_field";
      readonly key: string;
      readonly subtask: string;
      readonly field: string;
    }
  | { readonly kind: "rename_whole"; readonly key: string; readonly subtask: string }
  | {
      readonly kind: "cartesian";
      readonly key: string;
      readonly listSubtask: string;
      readonly listField: string;
      readonly spawnSubtask: string;
    }
  | {
      readonly kind: "flatten";
      readonly key: string;
      readonly subtasks: ReadonlyArray<string>;
      readonly field: string;
    };

// --------------------------------------------------------------------------
// Grammar — regexes mirror docs/contracts/pipeline-def.schema.json
// --------------------------------------------------------------------------

/** `<subtask>.*` — wildcard expansion. */
const RE_WILDCARD = /^([a-z][a-z0-9-]*)\.\*$/;

/** `<subtask>.<prefix>_*` — wildcard-prefix expansion. */
const RE_WILDCARD_PREFIX = /^([a-z][a-z0-9-]*)\.([a-z][a-zA-Z0-9_]*)_\*$/;

/** `<key>: <subtask>.<field>` — rename single field. */
const RE_RENAME_FIELD =
  /^([a-z][a-zA-Z0-9_]*):\s*([a-z][a-z0-9-]*)\.([a-zA-Z_][a-zA-Z0-9_]*)$/;

/** `<key>: <subtask>.*` — rename whole output. */
const RE_RENAME_WHOLE = /^([a-z][a-zA-Z0-9_]*):\s*([a-z][a-z0-9-]*)\.\*$/;

/** `<key>: <list_subtask>.<field> × <spawn_subtask>.*` — cartesian product. */
const RE_CARTESIAN =
  /^([a-z][a-zA-Z0-9_]*):\s*([a-z][a-z0-9-]*)\.([a-zA-Z_][a-zA-Z0-9_]*)\s*×\s*([a-z][a-z0-9-]*)\.\*$/;

/** `<key>: flatten([<s1>, <s2>, ...].<field>)` — flatten across subtasks. */
const RE_FLATTEN =
  /^([a-z][a-zA-Z0-9_]*):\s*flatten\(\[([a-z0-9, -]+)\]\.([a-zA-Z_][a-zA-Z0-9_]*)\)$/;

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

/**
 * Parse one rule string into a {@link ComposeAst} node.
 *
 * Throws an Error with a stable, prefixed message
 * (`compose_rule_unparseable: <rule>`) when the rule matches none of the
 * six grammar shapes. Callers that only want to surface the failure
 * should catch and adapt; {@link validateComposes} does this.
 *
 * @param rule the raw compose-rule string from `final_output.composes`.
 * @returns the parsed AST node.
 * @throws Error when the rule is unrecognised.
 */
export function parseComposeRule(rule: string): ComposeAst {
  // Try wildcard first — most common in real pipelines and disambiguates
  // from rename-whole (the latter requires a `:` and a key prefix).
  const mWildcard = RE_WILDCARD.exec(rule);
  if (mWildcard !== null && mWildcard[1] !== undefined) {
    return { kind: "wildcard", subtask: mWildcard[1] };
  }

  const mPrefix = RE_WILDCARD_PREFIX.exec(rule);
  if (mPrefix !== null && mPrefix[1] !== undefined && mPrefix[2] !== undefined) {
    return { kind: "wildcard_prefix", subtask: mPrefix[1], prefix: mPrefix[2] };
  }

  const mRenameWhole = RE_RENAME_WHOLE.exec(rule);
  if (
    mRenameWhole !== null &&
    mRenameWhole[1] !== undefined &&
    mRenameWhole[2] !== undefined
  ) {
    return {
      kind: "rename_whole",
      key: mRenameWhole[1],
      subtask: mRenameWhole[2],
    };
  }

  const mCartesian = RE_CARTESIAN.exec(rule);
  if (
    mCartesian !== null &&
    mCartesian[1] !== undefined &&
    mCartesian[2] !== undefined &&
    mCartesian[3] !== undefined &&
    mCartesian[4] !== undefined
  ) {
    return {
      kind: "cartesian",
      key: mCartesian[1],
      listSubtask: mCartesian[2],
      listField: mCartesian[3],
      spawnSubtask: mCartesian[4],
    };
  }

  const mFlatten = RE_FLATTEN.exec(rule);
  if (
    mFlatten !== null &&
    mFlatten[1] !== undefined &&
    mFlatten[2] !== undefined &&
    mFlatten[3] !== undefined
  ) {
    const ids = mFlatten[2]
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return {
      kind: "flatten",
      key: mFlatten[1],
      subtasks: ids,
      field: mFlatten[3],
    };
  }

  // Order matters here — `RE_RENAME_FIELD` is the most permissive of the
  // colon-prefixed shapes; we tried more specific shapes (`rename_whole`,
  // `cartesian`, `flatten`) first.
  const mRenameField = RE_RENAME_FIELD.exec(rule);
  if (
    mRenameField !== null &&
    mRenameField[1] !== undefined &&
    mRenameField[2] !== undefined &&
    mRenameField[3] !== undefined
  ) {
    return {
      kind: "rename_field",
      key: mRenameField[1],
      subtask: mRenameField[2],
      field: mRenameField[3],
    };
  }

  throw new Error(`compose_rule_unparseable: ${rule}`);
}

/**
 * Registration-time validation of `final_output.composes`.
 *
 * Confirms (a) every rule parses, and (b) every subtask id referenced
 * by every rule resolves to an actual subtask in `def.subtasks`.
 *
 * Returns `{ ok: true }` on success; `{ ok: false, error }` with a
 * single human-readable error string on failure (the first failure
 * encountered — the publisher will fix and resubmit).
 *
 * Pure: same input → same output. Does not log; the caller decides
 * whether to surface the error.
 *
 * @param def the pipeline def to validate.
 * @returns ok/err discriminated union.
 */
export function validateComposes(
  def: PipelineDef,
): { readonly ok: true } | { readonly ok: false; readonly error: string } {
  const knownIds = new Set<string>();
  for (const sub of def.subtasks) {
    knownIds.add(sub.id);
  }

  for (const rule of def.final_output.composes) {
    let ast: ComposeAst;
    try {
      ast = parseComposeRule(rule);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }

    const refs = referencedSubtasks(ast);
    for (const id of refs) {
      if (!knownIds.has(id)) {
        return {
          ok: false,
          error: `compose_rule_unknown_subtask: rule="${rule}" subtask_id="${id}"`,
        };
      }
    }
  }

  return { ok: true };
}

/**
 * Evaluate `final_output.composes` against the submitted outputs of one
 * run. Pure relative to its DB inputs — same DB state and same `def`
 * always produce the same output object.
 *
 * Reads:
 *   - `subtask_results` rows for the run (one per submitted instance).
 *   - `subtask_instances` rows for the run (for `subtask_id`,
 *     `parent_instance_id`, `spawn_index`).
 *
 * Output shape: a plain JSON-serialisable object. Returns `unknown`
 * because the shape is publisher-defined.
 *
 * Field-not-present (e.g. a `flatten` rule names a field absent from a
 * subtask's output) is logged at `warn` and treated as null/empty per
 * the issue's verification.
 *
 * @param db an open SQLite connection (better-sqlite3).
 * @param runId the run whose outputs to compose.
 * @param def the pipeline def (already-validated; we trust it).
 * @returns the composed final-output object.
 */
export function composeFinalOutput(
  db: Database.Database,
  runId: string,
  def: PipelineDef,
): unknown {
  const submissions = loadSubmissions(db, runId);
  const out: Record<string, unknown> = {};

  for (const rule of def.final_output.composes) {
    let ast: ComposeAst;
    try {
      ast = parseComposeRule(rule);
    } catch (err) {
      // Should never happen if validateComposes was called at
      // registration; if it did happen, log and skip the rule.
      log.warn("compose_rule_unparseable_at_runtime", {
        run_id: runId,
        rule,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    applyRule(out, ast, submissions, runId, rule);
  }

  return out;
}

// --------------------------------------------------------------------------
// Internals
// --------------------------------------------------------------------------

/**
 * In-memory snapshot of one run's submitted outputs, indexed two ways:
 *
 *   - `bySubtaskId` — `subtask_id` → first-found output. For non-spawn
 *     subtasks there is exactly one row. For spawn-parent subtasks
 *     (e.g. `list-boards`) there is also exactly one. For spawn-child
 *     templates (e.g. `configure-board`) a single id maps to the
 *     first-by-spawn-index row, but use `bySubtaskIdAll` for the full
 *     list when iterating.
 *   - `bySubtaskIdAll` — `subtask_id` → ordered list of outputs (sorted
 *     by `spawn_index` ascending, NULLs first). Used by `cartesian`
 *     and `flatten` over spawn templates.
 */
interface RunSubmissions {
  readonly bySubtaskId: ReadonlyMap<string, unknown>;
  readonly bySubtaskIdAll: ReadonlyMap<string, ReadonlyArray<unknown>>;
}

/**
 * Read submitted outputs for one run from `subtask_results` joined to
 * `subtask_instances`. Builds the two indexes used by rule evaluation.
 *
 * Ordering: `spawn_index ASC NULLS FIRST` then `created_at ASC`. This is
 * the canonical "spawn order" the issue requires for cartesian.
 */
function loadSubmissions(
  db: Database.Database,
  runId: string,
): RunSubmissions {
  const rows = db
    .prepare(
      `SELECT i.subtask_id AS subtask_id,
              i.spawn_index AS spawn_index,
              r.output_json AS output_json
         FROM subtask_results r
         JOIN subtask_instances i ON i.id = r.instance_id
        WHERE i.run_id = ?
        ORDER BY i.spawn_index IS NULL DESC, i.spawn_index ASC, i.created_at ASC`,
    )
    .all(runId) as ReadonlyArray<{
    subtask_id: string;
    spawn_index: number | null;
    output_json: string;
  }>;

  const bySubtaskId = new Map<string, unknown>();
  const bySubtaskIdAll = new Map<string, unknown[]>();

  for (const row of rows) {
    const parsed = safeParseJson(row.output_json);
    if (!bySubtaskId.has(row.subtask_id)) {
      bySubtaskId.set(row.subtask_id, parsed);
    }
    let list = bySubtaskIdAll.get(row.subtask_id);
    if (list === undefined) {
      list = [];
      bySubtaskIdAll.set(row.subtask_id, list);
    }
    list.push(parsed);
  }

  return { bySubtaskId, bySubtaskIdAll };
}

/**
 * `JSON.parse` that swallows malformed input — `subtask_results.output_json`
 * was already schema-validated at submit, so a parse failure here means
 * the row is corrupt. Log and return null.
 */
function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch (err) {
    log.warn("compose_output_json_corrupt", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Subtask ids referenced by an AST node (used by validateComposes).
 */
function referencedSubtasks(ast: ComposeAst): ReadonlyArray<string> {
  switch (ast.kind) {
    case "wildcard":
    case "wildcard_prefix":
    case "rename_field":
    case "rename_whole":
      return [ast.subtask];
    case "cartesian":
      return [ast.listSubtask, ast.spawnSubtask];
    case "flatten":
      return ast.subtasks;
  }
}

/**
 * Apply one parsed rule to `out`, mutating in place. Centralised so the
 * logging policy (warn-on-missing) lives in one place.
 */
function applyRule(
  out: Record<string, unknown>,
  ast: ComposeAst,
  subs: RunSubmissions,
  runId: string,
  ruleSrc: string,
): void {
  switch (ast.kind) {
    case "wildcard": {
      const src = subs.bySubtaskId.get(ast.subtask);
      if (!isPlainObject(src)) {
        log.warn("compose_subtask_missing", {
          run_id: runId,
          rule: ruleSrc,
          subtask: ast.subtask,
        });
        return;
      }
      for (const [k, v] of Object.entries(src)) {
        if (v !== undefined) out[k] = v;
      }
      return;
    }
    case "wildcard_prefix": {
      const src = subs.bySubtaskId.get(ast.subtask);
      if (!isPlainObject(src)) {
        log.warn("compose_subtask_missing", {
          run_id: runId,
          rule: ruleSrc,
          subtask: ast.subtask,
        });
        return;
      }
      const want = `${ast.prefix}_`;
      for (const [k, v] of Object.entries(src)) {
        if (k.startsWith(want) && v !== undefined) {
          out[k] = v;
        }
      }
      return;
    }
    case "rename_field": {
      const src = subs.bySubtaskId.get(ast.subtask);
      if (!isPlainObject(src)) {
        log.warn("compose_subtask_missing", {
          run_id: runId,
          rule: ruleSrc,
          subtask: ast.subtask,
        });
        return;
      }
      if (!Object.prototype.hasOwnProperty.call(src, ast.field)) {
        log.warn("compose_field_missing", {
          run_id: runId,
          rule: ruleSrc,
          subtask: ast.subtask,
          field: ast.field,
        });
        return;
      }
      out[ast.key] = (src as Record<string, unknown>)[ast.field];
      return;
    }
    case "rename_whole": {
      const src = subs.bySubtaskId.get(ast.subtask);
      if (src === undefined) {
        log.warn("compose_subtask_missing", {
          run_id: runId,
          rule: ruleSrc,
          subtask: ast.subtask,
        });
        return;
      }
      out[ast.key] = src;
      return;
    }
    case "cartesian": {
      out[ast.key] = evaluateCartesian(ast, subs, runId, ruleSrc);
      return;
    }
    case "flatten": {
      out[ast.key] = evaluateFlatten(ast, subs, runId, ruleSrc);
      return;
    }
  }
}

/**
 * Cartesian product: pair each element of `<list_subtask>.<field>` with
 * the corresponding spawned-instance output by spawn order.
 *
 * Merge policy (per `docs/contracts.md` §7.1): listItem fields take
 * precedence on key collision; spawnOutput contributes only fields not
 * already set by the listItem. Implemented as
 * `{ ...spawnOutput, ...listItem }` so listItem keys overwrite.
 */
function evaluateCartesian(
  ast: { readonly listSubtask: string; readonly listField: string; readonly spawnSubtask: string },
  subs: RunSubmissions,
  runId: string,
  ruleSrc: string,
): ReadonlyArray<unknown> {
  const parentOut = subs.bySubtaskId.get(ast.listSubtask);
  if (!isPlainObject(parentOut)) {
    log.warn("compose_subtask_missing", {
      run_id: runId,
      rule: ruleSrc,
      subtask: ast.listSubtask,
    });
    return [];
  }
  const list = (parentOut as Record<string, unknown>)[ast.listField];
  if (!Array.isArray(list)) {
    log.warn("compose_field_missing", {
      run_id: runId,
      rule: ruleSrc,
      subtask: ast.listSubtask,
      field: ast.listField,
    });
    return [];
  }
  const spawnOutputs = subs.bySubtaskIdAll.get(ast.spawnSubtask) ?? [];

  const result: unknown[] = [];
  for (let i = 0; i < list.length; i += 1) {
    const listItem = list[i];
    const spawnOut = i < spawnOutputs.length ? spawnOutputs[i] : undefined;
    const merged: Record<string, unknown> = {};
    // Spawn output contributes first; the listItem then overrides on
    // key collision (§7.1 — listItem takes precedence).
    if (isPlainObject(spawnOut)) {
      for (const [k, v] of Object.entries(spawnOut)) {
        merged[k] = v;
      }
    } else if (spawnOut === undefined) {
      // No spawn child for this index — log and emit listItem alone.
      log.warn("compose_cartesian_missing_spawn", {
        run_id: runId,
        rule: ruleSrc,
        subtask: ast.spawnSubtask,
        index: i,
      });
    }
    if (isPlainObject(listItem)) {
      for (const [k, v] of Object.entries(listItem)) {
        merged[k] = v;
      }
    }
    result.push(merged);
  }
  return result;
}

/**
 * Flatten: read `<field>` from each named subtask's output and
 * concatenate. For non-spawn subtasks the input is the single output
 * (one row); for spawn-template subtasks (children present in
 * `bySubtaskIdAll`), iterate every spawn instance in spawn order.
 *
 * Null/missing/non-array values are skipped (logged at warn), order is
 * preserved per the issue: "concatenated array, nulls skipped, order
 * preserved" + "missing key → empty array (not null)".
 */
function evaluateFlatten(
  ast: { readonly subtasks: ReadonlyArray<string>; readonly field: string },
  subs: RunSubmissions,
  runId: string,
  ruleSrc: string,
): ReadonlyArray<unknown> {
  const acc: unknown[] = [];
  for (const id of ast.subtasks) {
    const all = subs.bySubtaskIdAll.get(id) ?? [];
    if (all.length === 0) {
      // No row at all for this subtask id — log and skip. (Validation
      // already proved the id was declared in `def.subtasks`; an empty
      // list here means it never submitted, e.g. skip_if pruned it.)
      log.warn("compose_subtask_missing", {
        run_id: runId,
        rule: ruleSrc,
        subtask: id,
      });
      continue;
    }
    for (const out of all) {
      if (!isPlainObject(out)) continue;
      const value = (out as Record<string, unknown>)[ast.field];
      if (value === null || value === undefined) {
        // Missing-or-null on a flatten target is allowed — these are
        // optional fields like `kb_entries`.
        continue;
      }
      if (!Array.isArray(value)) {
        log.warn("compose_flatten_non_array", {
          run_id: runId,
          rule: ruleSrc,
          subtask: id,
          field: ast.field,
        });
        continue;
      }
      for (const item of value) {
        acc.push(item);
      }
    }
  }
  return acc;
}

/** Type guard — JSON object (not null, not array). */
function isPlainObject(v: unknown): v is Readonly<Record<string, unknown>> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
