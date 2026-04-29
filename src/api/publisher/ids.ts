/**
 * Opaque-id generators for runs and subtask instances.
 *
 * Identifiers are caller-generated random strings (hex-encoded random
 * bytes) — the schema treats them as opaque (`TEXT NOT NULL`); see
 * `src/db/schema.md`. Prefixes (`r_`, `i_`) keep them visually distinct
 * in logs and in the `Idempotency-Key` header for webhook delivery.
 *
 * @see DESIGN.md §3.6 — webhook idempotency keys are run ids
 */

/**
 * Mint a new run id of the form `r_<24 hex chars>` (96 bits of entropy).
 *
 * @returns a fresh run id; collisions are statistically negligible at this
 *   width.
 */
export function newRunId(): string {
  throw new Error("not implemented");
}

/**
 * Mint a new subtask-instance id of the form `i_<24 hex chars>`.
 *
 * @returns a fresh instance id.
 */
export function newInstanceId(): string {
  throw new Error("not implemented");
}
