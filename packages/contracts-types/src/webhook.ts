/**
 * Webhook contract — Murmur → publisher accept handler.
 *
 * @see docs/contracts.md §6
 */

/**
 * Body of the webhook POST.
 *
 * Headers (set by Murmur, NOT in the body):
 *   - `Authorization: Bearer <MURMUR_TOKEN>`
 *   - `Idempotency-Key: <run_id>`
 *   - `Content-Type: application/json`
 *
 * `final_output` is the result of applying the pipeline's
 * `final_output.composes` rule to all subtask outputs.
 */
export interface WebhookPayload {
  /** Stable run identifier; also the value of the `Idempotency-Key` header. */
  readonly run_id: string;

  /** Pipeline def id (slug) the run was started from. */
  readonly pipeline_id: string;

  /**
   * Pipeline-def version the run was pinned to at start. MVP: integer
   * monotonically incremented on each `POST /pipelines` upsert.
   */
  readonly pipeline_version: number;

  /** RFC 3339 / ISO 8601 timestamp, UTC, when Murmur composed the output. */
  readonly completed_at: string;

  /** Composed final output. Shape determined by the pipeline's `composes` rule. */
  readonly final_output: Readonly<Record<string, unknown>>;
}

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
