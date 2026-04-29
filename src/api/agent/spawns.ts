/**
 * `spawns` runtime — instantiates one `subtask_instances` child row per
 * element of the parent's `output[for_each]` array (DESIGN.md §3.1, M8).
 *
 * Called from `src/api/agent/lifecycle.ts#spawnChildren`, itself called
 * from `src/api/agent/work.ts` inside the same `BEGIN IMMEDIATE`
 * transaction as the parent's CAS submit. Atomicity is the caller's
 * responsibility — this module performs INSERTs only and surfaces
 * thrown errors verbatim so the caller can ROLLBACK.
 *
 * Semantics (DESIGN.md §3.1, worked `list-boards` → `configure-board`
 * example, lines 172–175):
 *
 *   - The `spawns:` block lives on the *parent* subtask def.
 *   - `for_each` names a top-level field on the parent's submitted
 *     output. The field's value MUST be an array; missing-or-non-array
 *     is treated as zero-spawn (the empty-array path) per the issue's
 *     "for-each field missing in output" edge case.
 *   - `template` names the subtask def to use for each child. The
 *     template is NOT in the run-start ready set (see
 *     `src/api/publisher/ready_set.ts#spawnTemplateIds`); spawned rows
 *     are the only way it gets instances.
 *   - `bind_as` (optional, M8) names the input key under which the child
 *     sees the for_each element. If omitted the element is the entire
 *     input; if set the input is `{ [bind_as]: <element> }`.
 *
 * @see DESIGN.md §3.1 — `spawns` schema field + jobseek worked example
 * @see src/api/agent/lifecycle.ts — call site, `spawnChildren`
 * @see src/api/agent/work.ts — outer transaction
 */

import type Database from "better-sqlite3";

import type { SpawnsDef, SubtaskDef } from "@murmur/contracts-types";

/**
 * The columns we INSERT for each spawned child. Mirrors the
 * `subtask_instances` schema in `src/db/schema.md`. `claim_token` and
 * `expires_at` default to NULL (the row is freshly `ready`, not claimed).
 */
export interface SpawnedChildRow {
  readonly id: string;
  readonly run_id: string;
  readonly subtask_id: string;
  readonly parent_instance_id: string;
  readonly spawn_index: number;
  readonly status: "ready";
  readonly input_json: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * Compute the child input payload that the spawned subtask will see in
 * its `pull_task` (`/work/next`) response under `data.input`.
 *
 * If the parent's `spawns.bind_as` is set, the input is
 * `{ [bind_as]: <element> }`. Otherwise the input is the element itself.
 *
 * Exported for unit tests; production callers go through {@link applySpawns}.
 *
 * @param spawns the parent's validated `SpawnsDef`.
 * @param element one element of the parent's `output[for_each]` array.
 * @returns a JSON-serialisable input document for the child instance.
 */
export function bindChildInput(spawns: SpawnsDef, element: unknown): unknown {
  if (spawns.bind_as !== undefined && spawns.bind_as.length > 0) {
    return { [spawns.bind_as]: element };
  }
  return element;
}

/**
 * Read `output[for_each]` and return it as a JS array IFF it is one.
 * Anything else (`undefined`, non-object output, non-array field, null)
 * yields `null` — which the caller treats as "no spawn fires".
 *
 * Per the issue's edge cases:
 *   - "For-each field missing in output (schema should catch first; if
 *     it slips through, no spawn fires)" → return null.
 *   - "Empty array → no rows inserted" → return `[]`. The caller still
 *     audits the no-op via the parent's existing `submit_result` row;
 *     no separate audit row is written.
 *
 * Exported for unit tests; production callers go through {@link applySpawns}.
 *
 * @param output the parent's submitted (already-schema-validated) result.
 * @param fieldName the `for_each` field name (DESIGN.md §3.1's flat
 *   single-field shape; not a JSON Pointer or dotted path).
 * @returns the array (possibly empty), or `null` when the field is
 *   absent / not an array.
 */
export function extractForEachArray(
  output: unknown,
  fieldName: string,
): ReadonlyArray<unknown> | null {
  if (output === null || typeof output !== "object" || Array.isArray(output)) {
    return null;
  }
  const value = (output as Record<string, unknown>)[fieldName];
  if (!Array.isArray(value)) return null;
  return value;
}

/**
 * Instantiate spawn children for a just-submitted parent.
 *
 * Behaviour:
 *
 *   - If `parentSubtaskDef.spawns` is undefined → return `[]` (no-op).
 *     This is the "pipeline without a `spawns` directive" path.
 *   - If `output[spawns.for_each]` is not an array → return `[]`. The
 *     missing-field edge case.
 *   - Otherwise insert one `subtask_instances` row per array element, in
 *     order, with `status='ready'`, `parent_instance_id=parentInstanceId`,
 *     `spawn_index = i`, and `input_json = JSON.stringify(bindChildInput(...))`.
 *     Returns the spawned ids in insertion order. Duplicate elements
 *     produce two children (no dedup) — the issue explicitly allows this.
 *
 * Inserts happen on the caller-supplied `db` connection. The caller is
 * responsible for the surrounding transaction (see `work.ts` —
 * `BEGIN IMMEDIATE` wraps `casStmt` + `markNextReady` + this call).
 *
 * @param db an open better-sqlite3 connection.
 * @param parentInstanceId the just-completed parent's `subtask_instances.id`.
 * @param parentRunId the run id (children inherit it).
 * @param parentSubtaskDef the parent's `SubtaskDef` (must include the
 *   `spawns` block when relevant; passing a def without `spawns` is a no-op).
 * @param output the parent's submitted, schema-validated result.
 * @param now an RFC 3339 UTC string used as `created_at` and `updated_at`.
 * @param mintInstanceId function called once per spawned row to mint a
 *   fresh, unique `subtask_instances.id`. Injected so tests can stub.
 * @returns the spawned child instance ids in insertion order.
 *   Empty array when no spawn fires.
 */
export function applySpawns(
  db: Database.Database,
  parentInstanceId: string,
  parentRunId: string,
  parentSubtaskDef: SubtaskDef,
  output: unknown,
  now: string,
  mintInstanceId: () => string,
): ReadonlyArray<string> {
  void db;
  void parentInstanceId;
  void parentRunId;
  void parentSubtaskDef;
  void output;
  void now;
  void mintInstanceId;
  throw new Error("not implemented");
}

/**
 * Prepared INSERT for one spawned child row. Bound parameters mirror the
 * full `subtask_instances` insert in `src/api/publisher/pipelines.ts` but
 * also populate `parent_instance_id` and `spawn_index` (which the
 * publisher's run-start path leaves NULL).
 */
export const INSERT_SPAWN_CHILD_SQL = `
INSERT INTO subtask_instances (
  id, run_id, subtask_id, parent_instance_id, spawn_index,
  status, input_json, created_at, updated_at
) VALUES (
  @id, @run_id, @subtask_id, @parent_instance_id, @spawn_index,
  @status, @input_json, @created_at, @updated_at
)
`;
