/**
 * Lifecycle helpers for the agent endpoints — runs after a successful
 * submit to advance the pipeline state.
 *
 * Responsibilities:
 *
 *   - **Mark next-ready set** — flip any `pending` subtask_instances on the
 *     same run whose `requires` are now satisfied to `ready` (M5).
 *
 *   - **Spawns** (M8 / issue #13). When the just-completed subtask declares
 *     `spawns: { for_each, template, bind_as? }`, instantiate one child
 *     instance per element of the parent's `output[for_each]` array. The
 *     real work lives in `src/api/agent/spawns.ts`; this module wires it
 *     into the post-CAS lifecycle.
 *
 *   - **Run-completion flip** — when every `subtask_instances` row of a
 *     run is in a terminal state (`done`, `skipped`, or `failed`) and no
 *     more spawns can fire, flip the run to `status='completed'` and set
 *     `completed_at`. Webhook delivery and `final_output` composition
 *     (M10 / M11) remain TODOs; flipping the row to `completed` is the
 *     deterministic precondition both depend on.
 *
 * @see DESIGN.md §3.1 — `requires`, `spawns`, `composes`
 * @see DESIGN.md §3.3 — claim/CAS lifecycle
 * @see src/api/agent/spawns.ts — spawn-row insertion
 */

import type Database from "better-sqlite3";

import type { SubtaskDef } from "@murmur/contracts-types";

import { applySpawns } from "./spawns.js";

/**
 * Promote any `pending` subtask_instances on `runId` whose `requires`
 * have all been satisfied (i.e. every prerequisite subtask has at least
 * one `done` instance) to `status='ready'`.
 *
 * Reads the run's pipeline def from `pipelines.def_json`, walks each
 * pending instance's `subtask_id` → `requires`, and bumps to ready when
 * all requirements are met. Idempotent: re-running on an already-ready
 * run is a no-op (only `pending` rows are considered).
 *
 * Implementation note: writes happen inside the caller's transaction;
 * this function does NOT open or commit one.
 *
 * @param db  open better-sqlite3 connection
 * @param runId  the run whose dependents to consider
 * @param now  RFC 3339 UTC timestamp to set as `updated_at` on flipped rows
 * @returns the list of instance ids that were promoted to `ready`
 */
export function markNextReady(
  db: Database.Database,
  runId: string,
  now: string,
): ReadonlyArray<string> {
  // 1. Read the pipeline def to get each subtask's `requires`.
  const pipelineRow = db
    .prepare(
      `SELECT pipelines.def_json AS def_json
         FROM pipelines
         JOIN runs ON runs.pipeline_id = pipelines.id
        WHERE runs.id = ?`,
    )
    .get(runId) as { def_json: string } | undefined;
  if (pipelineRow === undefined) return [];

  let def: PipelineDefForLifecycle;
  try {
    def = JSON.parse(pipelineRow.def_json) as PipelineDefForLifecycle;
  } catch {
    return [];
  }

  // 2. The set of subtask_ids that have at least one done instance on
  //    this run. Used to test `requires` satisfaction.
  const doneRows = db
    .prepare(
      `SELECT DISTINCT subtask_id FROM subtask_instances
        WHERE run_id = ? AND status = 'done'`,
    )
    .all(runId) as ReadonlyArray<{ subtask_id: string }>;
  const doneSet = new Set(doneRows.map((r) => r.subtask_id));

  // 3. For each pending instance on this run, check if every entry in
  //    its subtask def's `requires` is satisfied; if so, flip to ready.
  const pending = db
    .prepare(
      `SELECT id, subtask_id FROM subtask_instances
        WHERE run_id = ? AND status = 'pending'`,
    )
    .all(runId) as ReadonlyArray<{ id: string; subtask_id: string }>;

  const update = db.prepare(
    `UPDATE subtask_instances
        SET status = 'ready', updated_at = ?
      WHERE id = ? AND status = 'pending'`,
  );

  const promoted: string[] = [];
  for (const row of pending) {
    const subtaskDef = def.subtasks.find((s) => s.id === row.subtask_id);
    if (subtaskDef === undefined) continue;
    const requires = subtaskDef.requires ?? [];
    const allDone = requires.every((r) => doneSet.has(r));
    if (allDone) {
      update.run(now, row.id);
      promoted.push(row.id);
    }
  }
  return promoted;
}

/**
 * Local mirror of just the pipeline-def fields {@link markNextReady} cares
 * about. Avoids a tight coupling to the (still-evolving) authoritative
 * `PipelineDef` type while keeping the code typed.
 */
interface PipelineDefForLifecycle {
  readonly subtasks: ReadonlyArray<{
    readonly id: string;
    readonly requires?: ReadonlyArray<string>;
  }>;
}

/**
 * Spawn child `subtask_instances` rows when the just-completed parent's
 * subtask def declares a `spawns:` block (DESIGN.md §3.1, M8).
 *
 * Look up the parent's run id and subtask id from `subtask_instances`,
 * read the run's pipeline def from `pipelines.def_json`, find the
 * matching `SubtaskDef`, and delegate to {@link applySpawns}. Returns
 * the spawned ids in insertion order; an empty result means the parent
 * had no `spawns` directive, the for_each field was missing, or the
 * for_each array was empty (issue's edge cases).
 *
 * Inserts run on the caller-supplied transaction. The caller (the CAS
 * submit handler in `src/api/agent/work.ts`) wraps this call in a
 * `BEGIN IMMEDIATE` so a thrown error rolls back any partial spawn
 * inserts atomically with the CAS.
 *
 * @param db an open better-sqlite3 connection (already inside a txn).
 * @param parentInstanceId the just-completed parent's instance id.
 * @param output the parent's submitted, schema-validated result.
 * @param now an RFC 3339 UTC string (used for child `created_at` /
 *   `updated_at`).
 * @param mintInstanceId function called once per spawned row.
 * @returns the spawned child instance ids in insertion order.
 */
export function spawnChildren(
  db: Database.Database,
  parentInstanceId: string,
  output: unknown,
  now: string,
  mintInstanceId: () => string,
): ReadonlyArray<string> {
  const parent = lookupParentForSpawn(db, parentInstanceId);
  if (parent === null) return [];

  const subtaskDef = lookupSubtaskDef(db, parent.run_id, parent.subtask_id);
  if (subtaskDef === null) return [];

  // Delegate the actual INSERTs. `applySpawns` is a pure-against-the-db
  // helper: it does not open a transaction, and a thrown SQLite error
  // (e.g., FK violation) propagates up so the caller's BEGIN IMMEDIATE
  // can ROLLBACK atomically with the parent's CAS.
  return applySpawns(
    db,
    parentInstanceId,
    parent.run_id,
    subtaskDef,
    output,
    now,
    mintInstanceId,
  );
}

/**
 * Flip the run to `completed` when every `subtask_instances` row is in a
 * terminal state (`done`, `skipped`, or `failed`) AND there are no
 * `pending`, `ready`, or `claimed` rows left that could still spawn or
 * advance.
 *
 * Idempotent: a second call after the row is already `completed` is a
 * no-op and returns `false`. Composing `final_output` and POSTing the
 * webhook are deferred to M11 / M10 respectively (issue #18); the row
 * flip is the deterministic precondition both depend on.
 *
 * Inserts run on the caller-supplied transaction. The caller wraps this
 * in the same `BEGIN IMMEDIATE` as the parent CAS submit so the run
 * status flip is atomic with the parent's submit.
 *
 * @param db an open better-sqlite3 connection (already inside a txn).
 * @param runId the run to consider.
 * @param now an RFC 3339 UTC string used for `completed_at`.
 * @returns `true` if the run was flipped to `completed` by this call,
 *   `false` otherwise (still running, already completed, or any other
 *   terminal status).
 */
export function maybeFinaliseRun(
  db: Database.Database,
  runId: string,
  now: string,
): boolean {
  // 1. Bail out if the run is already terminal. The flip is idempotent
  //    but we want to avoid clobbering `completed_at`.
  const runRow = db
    .prepare(`SELECT status FROM runs WHERE id = ?`)
    .get(runId) as { status: string } | undefined;
  if (runRow === undefined) return false;
  if (runRow.status !== "running") return false;

  // 2. Count non-terminal instances. Terminal states are `done`,
  //    `skipped`, `failed`. Anything else (`pending`, `ready`,
  //    `claimed`, plus any future status) keeps the run live.
  const nonTerminal = db
    .prepare(
      `SELECT COUNT(*) AS c FROM subtask_instances
        WHERE run_id = ?
          AND status NOT IN ('done', 'skipped', 'failed')`,
    )
    .get(runId) as { c: number };
  if (nonTerminal.c > 0) return false;

  // 3. Sanity: the run must have at least one row (otherwise the
  //    publisher created the run with no subtasks — a bug, not a
  //    completion). Avoids flipping an empty-shell run to `completed`.
  const total = db
    .prepare(`SELECT COUNT(*) AS c FROM subtask_instances WHERE run_id = ?`)
    .get(runId) as { c: number };
  if (total.c === 0) return false;

  // 4. Flip. TODO(M11 / colophon-group/murmur#19): compose
  //    `final_output` per `final_output.composes`. TODO(M10 /
  //    colophon-group/murmur#18): POST the webhook. Both depend on the
  //    row being `completed`; this is the precondition.
  db.prepare(
    `UPDATE runs SET status = 'completed', completed_at = ? WHERE id = ?`,
  ).run(now, runId);
  return true;
}

/**
 * Helper: read the parent instance row's `(run_id, subtask_id)` so the
 * caller can locate the parent's `SubtaskDef` in the pipeline def.
 *
 * Returns `null` if the row no longer exists (would indicate a logic
 * error — the CAS just succeeded on this id).
 *
 * Exported so unit tests can probe the lookup independently of
 * {@link spawnChildren}.
 */
export function lookupParentForSpawn(
  db: Database.Database,
  parentInstanceId: string,
): { run_id: string; subtask_id: string } | null {
  const row = db
    .prepare(
      `SELECT run_id, subtask_id FROM subtask_instances WHERE id = ?`,
    )
    .get(parentInstanceId) as
    | { run_id: string; subtask_id: string }
    | undefined;
  if (row === undefined) return null;
  return { run_id: row.run_id, subtask_id: row.subtask_id };
}

/**
 * Helper: locate the parent's `SubtaskDef` inside the run's pipeline
 * `def_json`. Used by {@link spawnChildren} to access `spawns:` and the
 * template's full def.
 *
 * Exported so unit tests can probe the lookup independently of
 * {@link spawnChildren}.
 *
 * @returns the matching `SubtaskDef` or `null` if either the pipeline
 *   def cannot be located/parsed or the subtask def is missing.
 */
export function lookupSubtaskDef(
  db: Database.Database,
  runId: string,
  subtaskId: string,
): SubtaskDef | null {
  const row = db
    .prepare(
      `SELECT pipelines.def_json AS def_json
         FROM pipelines
         JOIN runs ON runs.pipeline_id = pipelines.id
        WHERE runs.id = ?`,
    )
    .get(runId) as { def_json: string } | undefined;
  if (row === undefined) return null;
  let def: { subtasks: ReadonlyArray<SubtaskDef> };
  try {
    def = JSON.parse(row.def_json) as { subtasks: ReadonlyArray<SubtaskDef> };
  } catch {
    return null;
  }
  const subtask = def.subtasks.find((s) => s.id === subtaskId);
  return subtask ?? null;
}
