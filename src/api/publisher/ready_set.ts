/**
 * Ready-set computation for `POST /pipelines/{id}/runs`.
 *
 * The "ready set" is the set of subtask_instances that are eligible to
 * be claimed at run start — i.e., before any subtask has submitted.
 * For the MVP these are exactly the static subtasks that:
 *
 *   1. Have an empty or absent `requires` array (no upstream
 *      dependencies — DESIGN.md §3.1, last bullet on schema fields).
 *   2. Are NOT the template of some other subtask's `spawns` block.
 *      Spawn-template subtasks are instantiated dynamically when their
 *      parent submits; they have no row at run-start.
 *
 * The function is pure — given the validated pipeline def, the run id,
 * and the resolved initial input, it returns the rows to insert. The
 * DB write is the caller's responsibility (kept transactional with the
 * `runs` insert).
 *
 * @see DESIGN.md §3.1 — `requires`, `spawns`
 * @see src/db/schema.md — `subtask_instances` columns
 */

import type { PipelineDef } from "@murmur/contracts-types";

/**
 * One row to insert into `subtask_instances` at run start.
 *
 * Mirrors the column set of `subtask_instances` (see `src/db/schema.md`).
 * `claim_token`, `expires_at`, `parent_instance_id`, `spawn_index` are
 * intentionally omitted — they default to NULL for ready-set rows
 * (the rows aren't claimed and aren't spawned children).
 */
export interface ReadyRow {
  /** Caller-minted instance id (`i_<hex>`). */
  readonly id: string;
  /** Run id this row belongs to. */
  readonly run_id: string;
  /** Pipeline-def subtask id (e.g., `pre-verify`). */
  readonly subtask_id: string;
  /** Always `"ready"` for ready-set rows. */
  readonly status: "ready";
  /** JSON-encoded resolved input for this instance. */
  readonly input_json: string;
  /** RFC 3339 timestamp; `created_at` and `updated_at` are equal at insert. */
  readonly created_at: string;
  /** RFC 3339 timestamp. */
  readonly updated_at: string;
}

/**
 * Identify subtask ids that are spawn templates — i.e., that appear as
 * the `template` of some other subtask's `spawns` block. These are NOT
 * in the ready set because their instances are created dynamically when
 * the parent submits.
 *
 * @param def a validated pipeline definition.
 * @returns the set of spawn-template subtask ids (lookup-friendly).
 */
export function spawnTemplateIds(def: PipelineDef): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const subtask of def.subtasks) {
    const spawns = subtask.spawns;
    if (spawns !== undefined) {
      ids.add(spawns.template);
    }
  }
  return ids;
}

/**
 * Compute the initial ready-set rows for a new run.
 *
 * Selection rules (per the module docblock):
 *   - subtask is NOT a spawn template, AND
 *   - `requires` is absent or empty.
 *
 * Each ready row's `input_json` is the JSON-encoded `initial_input` for
 * the run — the MVP does not (yet) resolve per-subtask `inputs` from
 * named refs into the publisher's initial input. For ready-set rows
 * authored from the static subtask list, passing the run-level
 * `initial_input` is the conservative choice and matches what the
 * agent will see in `pull_task` until M6 wires per-subtask resolution.
 *
 * The function does NOT touch the DB; it returns data the caller will
 * insert inside its run-creation transaction.
 *
 * @param def the validated pipeline definition.
 * @param runId the freshly-minted run id.
 * @param initialInput the publisher-supplied `initial_input` value.
 * @param now an RFC 3339 timestamp string used for `created_at` /
 *   `updated_at`. Passed in (rather than read from `Date.now()`) so the
 *   function is deterministic under test.
 * @param mintInstanceId function called once per ready row to obtain a
 *   unique `i_<hex>` id. Injectable so tests can stub.
 * @returns the rows to insert, in subtask-def declaration order.
 */
export function computeReadySet(
  def: PipelineDef,
  runId: string,
  initialInput: unknown,
  now: string,
  mintInstanceId: () => string,
): ReadonlyArray<ReadyRow> {
  const templates = spawnTemplateIds(def);
  const inputJson = JSON.stringify(initialInput);
  const rows: ReadyRow[] = [];
  for (const subtask of def.subtasks) {
    if (templates.has(subtask.id)) continue;
    const requires = subtask.requires ?? [];
    if (requires.length > 0) continue;
    rows.push({
      id: mintInstanceId(),
      run_id: runId,
      subtask_id: subtask.id,
      status: "ready",
      input_json: inputJson,
      created_at: now,
      updated_at: now,
    });
  }
  return rows;
}
