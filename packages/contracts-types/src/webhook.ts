/**
 * Webhook contract — Murmur → publisher accept handler.
 *
 * @see docs/contracts.md §6
 */

/**
 * Body of the webhook POST.
 *
 * The body IS the composed `final_output` directly — no envelope, no
 * wrapper. Per-run metadata travels in headers, not the body:
 *
 *   - `Authorization: Bearer <MURMUR_TOKEN>`
 *   - `Idempotency-Key: <run_id>`
 *   - `Content-Type: application/json`
 *
 * The body's exact shape is determined by the pipeline def's
 * `final_output.composes` rules (§7) — it is a JSON object whose keys
 * are pipeline-specific. This type alias names that "naked composed
 * object" so callers can spell its intent without committing to a
 * specific pipeline's keys.
 *
 * History: an earlier draft of the contract wrapped `final_output`
 * inside a `{ run_id, pipeline_id, pipeline_version, completed_at,
 * final_output }` envelope. The shipped sender (`src/webhook.ts`)
 * never emitted that wrapper, and the receiver (jobseek's accept
 * handler) was implemented against the naked shape. Issue #63
 * reconciled the spec to match: the body is the composed object, and
 * `run_id` is the `Idempotency-Key` header. If the publisher needs
 * other run metadata in the future, surface it as `X-Murmur-*`
 * headers — do not nest it inside the body.
 */
export type WebhookPayload = Readonly<Record<string, unknown>>;

/**
 * Response shape the publisher's accept handler MUST return.
 *
 * - 2xx (any) — Murmur considers delivery successful and stops retrying.
 * - non-2xx — Murmur retries exactly once after 30 seconds. After that,
 *   the run is marked `webhook_failed` and the publisher must reconcile
 *   via `GET /runs/{run_id}`.
 *
 * Body content is ignored by Murmur. Publishers SHOULD return the
 * canonical envelope `{ ok: true }` for symmetry, but it is not required.
 */
export interface WebhookAcceptResponse {
  readonly ok: true;
}

/**
 * Demo-grade dedupe window: forever (writer's UNIQUE constraint on the
 * catalog table). No expiring cache; the publisher's idempotency is
 * durable.
 *
 * This constant exists so docs and tests can reference a single source
 * of truth. `null` denotes "no expiring window — durable on writer side".
 *
 * The type is widened to `number | null` so a future tightening (e.g.,
 * adopting an in-memory dedupe window in milliseconds) is a value-only
 * change, not a type-shape break for downstream consumers.
 */
export const WEBHOOK_DEDUPE_WINDOW_MS: number | null = null;

/**
 * Number of additional delivery attempts after the first. MVP: 1 retry
 * after 30s on non-2xx.
 */
export const WEBHOOK_RETRY_COUNT = 1;

/**
 * Delay before the single retry, in milliseconds.
 */
export const WEBHOOK_RETRY_DELAY_MS = 30_000;
