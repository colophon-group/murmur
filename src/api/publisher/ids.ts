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

import { randomBytes } from "node:crypto";

/**
 * Width in bytes of the random suffix appended to each id. 12 bytes
 * (96 bits) hex-encodes to 24 chars and is well above the demo-grade
 * collision-resistance bar.
 */
const ID_RANDOM_BYTES = 12;

/**
 * Mint a new run id of the form `r_<24 hex chars>` (96 bits of entropy).
 *
 * @returns a fresh run id; collisions are statistically negligible at this
 *   width.
 */
export function newRunId(): string {
  return `r_${randomBytes(ID_RANDOM_BYTES).toString("hex")}`;
}

/**
 * Mint a new subtask-instance id of the form `i_<24 hex chars>`.
 *
 * @returns a fresh instance id.
 */
export function newInstanceId(): string {
  return `i_${randomBytes(ID_RANDOM_BYTES).toString("hex")}`;
}
