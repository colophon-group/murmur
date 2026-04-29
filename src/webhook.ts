/**
 * Webhook delivery — POST `final_output` to the publisher's webhook URL
 * after a run completes (DESIGN.md §3.6, M10 / issue #15).
 *
 * The flow:
 *
 *   1. Caller (the agent CAS submit handler in `src/api/agent/work.ts`)
 *      detects "this submit just flipped the run to `completed`"
 *      via the boolean returned by `maybeFinaliseRun`. It then invokes
 *      {@link deliverWebhook} immediately AFTER its own transaction
 *      committed, fire-and-forget. External HTTP MUST NOT live inside
 *      the DB txn.
 *   2. {@link deliverWebhook} runs the M11 composer
 *      (`composeFinalOutput`), persists `final_output_json` and
 *      `webhook_status='pending'`, then issues a POST to the webhook
 *      URL with bearer + `Idempotency-Key: <run_id>`.
 *   3. On 2xx: persist `webhook_status='delivered'` and stop.
 *   4. On non-2xx (or transport error): schedule ONE retry 30s later
 *      (no exponential backoff — bounded at exactly one retry per the
 *      issue's quality gate). On the second non-2xx: persist
 *      `webhook_status='failed'`.
 *
 * The retry timer is created via the injectable `setTimeoutFn` seam so
 * Vitest's fake timers can drive it deterministically. The promise
 * returned from {@link deliverWebhook} resolves once the FIRST attempt
 * has been made (and any 2xx persisted) — the retry, if any, runs
 * detached. {@link awaitPendingWebhookDeliveries} lets tests block on
 * outstanding retries before tearing down their DB.
 *
 * Idempotency: per the issue, the `Idempotency-Key` header is the
 * `run_id` verbatim, identical across the initial attempt and the
 * retry. The publisher dedupes by this key.
 *
 * Sensitive-data hygiene: this module logs delivery attempts but never
 * the bearer token nor the body. The webhook URL is logged by host
 * only (no path / query) so an unintended secret in the URL doesn't
 * end up on disk.
 *
 * @see DESIGN.md §3.6 — Webhook delivery
 * @see src/composes.ts — `composeFinalOutput` (M11)
 * @see src/api/agent/work.ts — fire-and-forget invocation site
 */

import { request as undiciRequest } from "undici";

import type Database from "better-sqlite3";

import type { PipelineDef } from "@murmur/contracts-types";

import { composeFinalOutput } from "./composes.js";
import { log } from "./logger.js";

/**
 * Default delay between the first attempt and the retry (issue: "Retry
 * once on non-2xx after 30s"). Tests override this to keep CI fast.
 */
export const DEFAULT_WEBHOOK_RETRY_DELAY_MS = 30 * 1000;

/**
 * Default per-attempt HTTP timeout. The publisher should ack quickly;
 * a slow webhook receiver eats throughput. 15s matches the dispatcher's
 * publisher-call timeout in M7.
 */
export const DEFAULT_WEBHOOK_REQUEST_TIMEOUT_MS = 15 * 1000;

/**
 * Minimal HTTP-response shape this module needs. Defined locally so
 * tests can supply a stub without depending on undici types.
 */
export interface WebhookHttpResponse {
  readonly status: number;
}

/**
 * Function signature for a transport. Production wires this to undici;
 * tests inject a stub that records calls and returns canned responses.
 */
export type WebhookFetch = (
  url: string,
  init: {
    readonly method: "POST";
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly signal?: AbortSignal;
  },
) => Promise<WebhookHttpResponse>;

/**
 * Function signature for `setTimeout` — minimal subset matching the
 * pieces this module uses. Generic over the handle type so tests can
 * pass a counter-handle factory and assert exact ms values.
 */
export type WebhookSetTimeout = (
  callback: () => void,
  ms: number,
) => unknown;

/**
 * Options accepted by {@link deliverWebhook}.
 */
export interface DeliverWebhookOptions {
  /**
   * The boot-loaded `MURMUR_TOKEN` value. Used as the `Bearer` credential
   * on the POST. Caller is responsible for keeping this off the wire
   * any other way; this module never logs it.
   */
  readonly bearer: string;
  /** Override now() for deterministic timestamps in tests. */
  readonly nowFn?: () => string;
  /** Override scheduling for fake-timer tests. */
  readonly setTimeoutFn?: WebhookSetTimeout;
  /** Override transport for tests. Defaults to undici's `request`. */
  readonly fetchImpl?: WebhookFetch;
  /** Override retry delay; default 30 000 ms. */
  readonly retryDelayMs?: number;
  /** Override per-attempt request timeout; default 15 000 ms. */
  readonly requestTimeoutMs?: number;
}

/**
 * Compose `final_output` and POST it to the run's webhook URL,
 * scheduling one retry 30s later on non-2xx.
 *
 * The function performs the FIRST attempt synchronously-with-respect-to
 * the returned promise; the retry, if needed, is detached via
 * `setTimeoutFn` and tracked internally so {@link
 * awaitPendingWebhookDeliveries} can block on it for tests.
 *
 * Side effects on the `runs` row:
 *   - On entry: writes `final_output_json` (composed) and sets
 *     `webhook_status='pending'` if currently NULL (idempotent — a
 *     duplicate call after `delivered`/`failed` is a no-op and logs
 *     `webhook_already_terminal`).
 *   - On 2xx: `webhook_status='delivered'`.
 *   - On second non-2xx: `webhook_status='failed'`.
 *
 * @param db open better-sqlite3 connection. Caller owns its lifecycle.
 * @param runId the run that just completed.
 * @param opts see {@link DeliverWebhookOptions}.
 * @returns a promise that resolves after the first attempt has been
 *   accounted for (success persisted, or retry scheduled). The retry,
 *   if any, runs detached.
 */
export async function deliverWebhook(
  db: Database.Database,
  runId: string,
  opts: DeliverWebhookOptions,
): Promise<void> {
  throw new Error("not implemented");
}

/**
 * Block until every retry scheduled by {@link deliverWebhook} during
 * this process's lifetime has settled. Tests use this between assertions
 * so the DB is in its post-retry state. Production callers never need
 * this.
 */
export async function awaitPendingWebhookDeliveries(): Promise<void> {
  throw new Error("not implemented");
}

/**
 * Test-only: clear the module-scoped pending-deliveries set. Used by
 * tests in their `afterEach` to guarantee no cross-test leakage if a
 * scheduled retry was deliberately abandoned.
 */
export function resetPendingWebhookDeliveriesForTest(): void {
  throw new Error("not implemented");
}

/**
 * Internal — readable subset of a `runs` row this module needs.
 * Exported for unit tests that probe the helper independently.
 */
export interface RunRowForWebhook {
  readonly id: string;
  readonly webhook_url: string;
  readonly webhook_status: string | null;
  readonly final_output_json: string | null;
}

/**
 * Internal — read the run's row + pipeline def. Returns null if the
 * row is missing or the pipeline def cannot be parsed (a hard error
 * upstream — surfaces as a logged failure here).
 */
export function loadRunForWebhook(
  db: Database.Database,
  runId: string,
): { readonly row: RunRowForWebhook; readonly def: PipelineDef } | null {
  throw new Error("not implemented");
}

/**
 * Internal — log helper that scrubs the URL down to host. Exported for
 * tests so the scrub can be asserted without poking at the logger.
 */
export function scrubUrlForLog(url: string): string {
  throw new Error("not implemented");
}
