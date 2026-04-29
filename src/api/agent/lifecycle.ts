/**
 * Lifecycle helpers for the agent endpoints — runs after a successful
 * submit to advance the pipeline state.
 *
 * For M5 (this PR), the responsibilities are:
 *
 *   - **Mark next-ready set** — flip any `pending` subtask_instances on the
 *     same run whose `requires` are now satisfied to `ready`. This is the
 *     deterministic-DAG path; spawn-driven instantiation is M8 territory.
 *
 * Stubs (not implemented in this PR — referenced for grep-trail):
 *
 *   - **Spawns** (M8 / issue #16). When the just-completed subtask declares
 *     `spawns: { for_each, template }`, instantiate one child instance per
 *     element of the parent's `output[for_each]` array. M5 leaves a TODO
 *     and returns without spawning.
 *
 *   - **Run-completion webhook** (M10 / issue #18). When all of a run's
 *     non-skipped subtasks reach `done`, compose `final_output` per the
 *     pipeline def's `composes:` rules and POST the run to `webhook_url`.
 *     M5 leaves a TODO; the run will sit in `running` until M10 ships.
 *
 * @see DESIGN.md §3.1 — `requires`, `spawns`, `composes`
 * @see DESIGN.md §3.3 — claim/CAS lifecycle
 */

import type Database from "better-sqlite3";

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
  // The bodies will land in step 6. Keeping the placeholder signature here
  // means the test file can import the symbol against an unimplemented
  // contract per AGENTS.md step 4.
  db: Database.Database,
  runId: string,
  now: string,
): ReadonlyArray<string> {
  void db;
  void runId;
  void now;
  throw new Error("not implemented");
}

/**
 * M8 stub — spawn child instances when the just-completed subtask declares
 * `spawns:`. NOT implemented in this PR. See issue #16.
 *
 * The function is exported (rather than left as a comment) so the import
 * graph stays stable when M8 lands and so a grep for `spawnChildren` finds
 * the documented stub.
 */
export function spawnChildren(
  db: Database.Database,
  parentInstanceId: string,
  output: unknown,
  now: string,
): ReadonlyArray<string> {
  void db;
  void parentInstanceId;
  void output;
  void now;
  // TODO(M8 / colophon-group/murmur#16): instantiate one child per
  // `output[spawns.for_each]` element, using the `spawns.template` subtask
  // def. For M5 this is a no-op so the deterministic happy path runs.
  return [];
}

/**
 * M10 stub — fire the run-completion webhook when all subtasks reach
 * `done`. NOT implemented in this PR. See issue #18.
 *
 * Same export-rather-than-comment rationale as `spawnChildren`.
 */
export function maybeFinaliseRun(
  db: Database.Database,
  runId: string,
  now: string,
): boolean {
  void db;
  void runId;
  void now;
  // TODO(M10 / colophon-group/murmur#18): when all non-skipped instances
  // of `runId` are `done`, compose `final_output` per the pipeline def's
  // `composes:` and POST it to `webhook_url`. For M5 this is a no-op and
  // the run stays in `status='running'`.
  return false;
}
