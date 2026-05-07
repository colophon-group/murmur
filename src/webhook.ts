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

import { createHmac } from "node:crypto";

import { request as undiciRequest } from "undici";

import type Database from "better-sqlite3";

import type { PipelineDef } from "@murmur/contracts-types";
import { X_MURMUR_SIGNATURE } from "@murmur/contracts-types";

import { composeFinalOutput } from "./composes.js";
import { log } from "./logger.js";

/**
 * Default delay between the first attempt and the retry (issue: "Retry
 * once on non-2xx after 30s"). Tests override this to keep CI fast.
 */
export const DEFAULT_WEBHOOK_RETRY_DELAY_MS = 30 * 1000;

/**
 * Default per-attempt HTTP timeout. The publisher should ack quickly;
 * a slow webhook receiver eats throughput. The accept handler in
 * jobseek-murmur-shim does a defense-in-depth `rerunProbes` step that
 * spawns one Python subprocess per board (Playwright + httpx + crawler
 * tree on a cold venv); empirically that takes ~20s for a 1-board run,
 * which busts the original 15s budget. 60s gives ~3x headroom and
 * still keeps a misbehaving receiver from holding murmur's delivery
 * worker for very long.
 */
export const DEFAULT_WEBHOOK_REQUEST_TIMEOUT_MS = 60 * 1000;

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
 * Module-scoped registry of in-flight retry promises. Each entry is a
 * promise that resolves once the scheduled retry attempt has run to
 * completion (success or failure persisted). Tests await these via
 * {@link awaitPendingWebhookDeliveries} before asserting on DB state.
 *
 * Production callers don't observe this — the promises are hooked up
 * so unhandled rejections are swallowed inside the retry path.
 */
const pendingDeliveries: Set<Promise<void>> = new Set();

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
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const setTimeoutFn = opts.setTimeoutFn ?? defaultSetTimeout;
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_WEBHOOK_RETRY_DELAY_MS;
  const requestTimeoutMs =
    opts.requestTimeoutMs ?? DEFAULT_WEBHOOK_REQUEST_TIMEOUT_MS;
  const nowFn = opts.nowFn ?? (() => new Date().toISOString());

  // 1. Load the run + pipeline def.
  const loaded = loadRunForWebhook(db, runId);
  if (loaded === null) {
    log.error("webhook.run_not_found", { run_id: runId });
    return;
  }
  const { row, def } = loaded;

  // 2. Idempotency guard — if status is already terminal (`delivered`
  //    or `failed`), do nothing. Re-firing on already-pending is fine
  //    (treat as the first attempt of the cycle).
  if (row.webhook_status === "delivered" || row.webhook_status === "failed") {
    log.warn("webhook.already_terminal", {
      run_id: runId,
      webhook_status: row.webhook_status,
    });
    return;
  }

  // 3. Compose final_output (M11) and persist it + flip status to
  //    `pending`. Single small txn — no external HTTP yet.
  const finalOutput = composeFinalOutput(db, runId, def);
  const finalOutputJson = JSON.stringify(finalOutput);
  db.prepare(
    `UPDATE runs
        SET final_output_json = ?, webhook_status = 'pending'
      WHERE id = ?`,
  ).run(finalOutputJson, runId);

  // 4. Build request shape — same headers + body for both attempts.
  //
  // **Per-publisher bearer (M1, issue #81).** Pre-M1 the bearer was the
  // shared MURMUR_TOKEN, sent verbatim to every publisher's webhook URL.
  // That leaks MURMUR_TOKEN to any publisher whose webhook URL Murmur
  // posts to — a cross-publisher leak surfaced in pre-merge review.
  // Post-M1 we resolve the run's publisher's `subcommand_bearer` (the
  // per-tenant credential their shim accepts) and use it as the bearer
  // header. The demo publisher's `subcommand_bearer` was seeded equal
  // to MURMUR_TOKEN at boot (preserving backward compat with jobseek's
  // existing accept handler); new publishers get a freshly minted
  // random value scoped to themselves. `opts.bearer` (= MURMUR_TOKEN)
  // is the final fallback for pre-seed deployments where no
  // subcommand_bearer row exists yet.
  //
  // **HMAC signature.** When the run's publisher has an active
  // `webhook_signing` secret in `publisher_secrets`, sign the body with
  // HMAC-SHA256 over `<unix_ts>.<body>` and add the `X-Murmur-Signature:
  // t=<unix>,v1=<hex>` header. Additive — the bearer is retained for
  // publishers that haven't migrated their accept handler to verify
  // HMAC yet (drop in M10 cutover).
  const dispatchBearer =
    lookupActiveWebhookBearer(db, runId) ?? opts.bearer;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${dispatchBearer}`,
    "idempotency-key": runId,
  };
  const body = finalOutputJson;

  const signingSecret = lookupActiveWebhookSigningSecret(db, runId);
  if (signingSecret !== null) {
    const unixTs = Math.floor(Date.parse(nowFn()) / 1000);
    const v1 = createHmac("sha256", signingSecret)
      .update(`${unixTs.toString()}.${body}`, "utf8")
      .digest("hex");
    headers[X_MURMUR_SIGNATURE.toLowerCase()] = `t=${unixTs.toString()},v1=${v1}`;
  }

  const url = row.webhook_url;
  const hostForLog = scrubUrlForLog(url);

  // 5. First attempt.
  const firstOk = await tryDeliver({
    fetchImpl,
    url,
    headers,
    body,
    requestTimeoutMs,
    runId,
    hostForLog,
    attempt: 1,
  });

  if (firstOk) {
    db.prepare(`UPDATE runs SET webhook_status = 'delivered' WHERE id = ?`).run(
      runId,
    );
    log.info("webhook.delivered", {
      run_id: runId,
      attempt: 1,
      host: hostForLog,
      ts: nowFn(),
    });
    return;
  }

  // 6. Schedule the (one and only) retry. Detached so the caller's
  //    submit_result response races ahead.
  const retryPromise = new Promise<void>((resolve) => {
    setTimeoutFn(() => {
      void runRetry({
        db,
        runId,
        fetchImpl,
        url,
        headers,
        body,
        requestTimeoutMs,
        hostForLog,
        nowFn,
      })
        .catch((err: unknown) => {
          // tryDeliver swallows transport errors; runRetry only throws
          // on a DB failure mid-update. Surface, but don't reject the
          // tracking promise — tests must continue to drain.
          log.error("webhook.retry_unexpected_error", {
            run_id: runId,
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          resolve();
        });
    }, retryDelayMs);
  });

  pendingDeliveries.add(retryPromise);
  // Auto-cleanup: remove from the set after the promise settles so the
  // module-level set doesn't grow unbounded.
  void retryPromise.finally(() => {
    pendingDeliveries.delete(retryPromise);
  });
}

/**
 * Block until every retry scheduled by {@link deliverWebhook} during
 * this process's lifetime has settled. Tests use this between assertions
 * so the DB is in its post-retry state. Production callers never need
 * this.
 */
export async function awaitPendingWebhookDeliveries(): Promise<void> {
  // Snapshot the set — `finally` handlers may mutate it as deliveries
  // settle. `Promise.allSettled` drains both ok and err paths.
  const snapshot = Array.from(pendingDeliveries);
  await Promise.allSettled(snapshot);
}

/**
 * Test-only: clear the module-scoped pending-deliveries set. Used by
 * tests in their `afterEach` to guarantee no cross-test leakage if a
 * scheduled retry was deliberately abandoned.
 */
export function resetPendingWebhookDeliveriesForTest(): void {
  pendingDeliveries.clear();
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
  const row = db
    .prepare(
      `SELECT runs.id            AS id,
              runs.webhook_url   AS webhook_url,
              runs.webhook_status AS webhook_status,
              runs.final_output_json AS final_output_json,
              pipelines.def_json AS def_json
         FROM runs
         JOIN pipelines ON pipelines.id = runs.pipeline_id
        WHERE runs.id = ?`,
    )
    .get(runId) as
    | {
        id: string;
        webhook_url: string;
        webhook_status: string | null;
        final_output_json: string | null;
        def_json: string;
      }
    | undefined;
  if (row === undefined) return null;

  let def: PipelineDef;
  try {
    def = JSON.parse(row.def_json) as PipelineDef;
  } catch (err) {
    log.error("webhook.pipeline_def_unparseable", {
      run_id: runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  return {
    row: {
      id: row.id,
      webhook_url: row.webhook_url,
      webhook_status: row.webhook_status,
      final_output_json: row.final_output_json,
    },
    def,
  };
}

/**
 * Look up the most-recent active `webhook_signing` secret for the
 * publisher that owns this run. Returns `null` when no active row
 * exists — in that case webhook delivery proceeds without HMAC
 * (legacy bearer-only mode).
 *
 * Walks `runs → pipelines → publisher_secrets`; the
 * `idx_publisher_secrets_active` partial index makes the lookup an
 * O(log n) probe per delivery.
 *
 * Exported for tests; tests stub the publisher row and assert the
 * delivered headers carry / omit `X-Murmur-Signature` accordingly.
 */
export function lookupActiveWebhookSigningSecret(
  db: Database.Database,
  runId: string,
): string | null {
  return lookupActivePublisherSecret(db, runId, "webhook_signing");
}

/**
 * Look up the most-recent active `subcommand_bearer` for the publisher
 * that owns this run, used as the `Authorization: Bearer` value on
 * webhook delivery (M1, issue #81). Pre-M1 the shared MURMUR_TOKEN was
 * sent to every publisher's webhook URL — a cross-publisher leak. Post
 * M1 the per-tenant `subcommand_bearer` is the canonical webhook
 * bearer; the demo's value was seeded equal to MURMUR_TOKEN so the
 * legacy accept handler (which verifies MURMUR_TOKEN) keeps working.
 *
 * Returns `null` when no active row exists; the caller falls back to
 * the legacy `MURMUR_TOKEN` value passed via `opts.bearer`.
 *
 * Exported for tests.
 */
export function lookupActiveWebhookBearer(
  db: Database.Database,
  runId: string,
): string | null {
  return lookupActivePublisherSecret(db, runId, "subcommand_bearer");
}

/**
 * Internal — shared lookup helper for active per-publisher secrets
 * scoped by run. Picks the most-recent non-revoked row of `kind` for
 * the publisher that owns the run.
 */
function lookupActivePublisherSecret(
  db: Database.Database,
  runId: string,
  kind: string,
): string | null {
  const row = db
    .prepare(
      `SELECT publisher_secrets.secret_value AS secret_value
         FROM runs
         JOIN pipelines          ON pipelines.id = runs.pipeline_id
         JOIN publisher_secrets  ON publisher_secrets.publisher_id = pipelines.publisher_id
        WHERE runs.id = ?
          AND publisher_secrets.kind = ?
          AND publisher_secrets.revoked_at IS NULL
        ORDER BY publisher_secrets.created_at DESC
        LIMIT 1`,
    )
    .get(runId, kind) as { secret_value: string } | undefined;
  if (row === undefined) return null;
  return row.secret_value;
}

/**
 * Internal — log helper that scrubs the URL down to host. Exported for
 * tests so the scrub can be asserted without poking at the logger.
 *
 * Returns the bare host (no path, no query, no userinfo). If the input
 * is unparseable, returns a sentinel string. Never throws.
 */
export function scrubUrlForLog(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host;
  } catch {
    return "<unparseable>";
  }
}

// --------------------------------------------------------------------------
// Internals
// --------------------------------------------------------------------------

/**
 * Default transport — undici's `request`. We deliberately do NOT keep a
 * module-scoped `Pool` per origin (unlike `src/dispatch/task_tool.ts`)
 * because webhook delivery is low-volume and the publisher's host is
 * usually distinct from any subcommand publisher; a per-call client is
 * fine.
 */
const defaultFetch: WebhookFetch = async (url, init) => {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    DEFAULT_WEBHOOK_REQUEST_TIMEOUT_MS,
  );
  if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
    (timer as unknown as { unref: () => void }).unref();
  }
  try {
    const res = await undiciRequest(url, {
      method: "POST",
      headers: init.headers,
      body: init.body,
      signal: init.signal ?? controller.signal,
    });
    // Drain the body so undici can recycle the socket. We don't
    // surface the body to the caller — delivery only cares about the
    // status code per the issue.
    try {
      for await (const _ of res.body) {
        // discard
        void _;
      }
    } catch {
      // ignore drain errors; the status was the only thing we needed.
    }
    return { status: res.statusCode };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Default scheduler — Node's `setTimeout`. We `unref()` the handle so a
 * pending retry timer never blocks process exit (the caller's
 * `submit_result` response has already gone out by then).
 */
function defaultSetTimeout(callback: () => void, ms: number): unknown {
  const handle = setTimeout(callback, ms);
  if (typeof (handle as unknown as { unref?: () => void }).unref === "function") {
    (handle as unknown as { unref: () => void }).unref();
  }
  return handle;
}

interface DeliverAttemptInput {
  readonly fetchImpl: WebhookFetch;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly requestTimeoutMs: number;
  readonly runId: string;
  readonly hostForLog: string;
  readonly attempt: number;
}

/**
 * Run one delivery attempt. Returns true on 2xx, false on non-2xx OR a
 * transport error. Logs each outcome at info or warn; never throws.
 *
 * The `requestTimeoutMs` parameter currently only steers the default
 * undici transport (the test stub ignores it). The default transport
 * wires its own AbortController; we don't pass one in here so the
 * stub doesn't have to.
 */
async function tryDeliver(opts: DeliverAttemptInput): Promise<boolean> {
  try {
    const res = await opts.fetchImpl(opts.url, {
      method: "POST",
      headers: opts.headers,
      body: opts.body,
    });
    const ok = res.status >= 200 && res.status < 300;
    if (ok) {
      log.info("webhook.attempt_ok", {
        run_id: opts.runId,
        attempt: opts.attempt,
        host: opts.hostForLog,
        status: res.status,
      });
    } else {
      log.warn("webhook.attempt_non_2xx", {
        run_id: opts.runId,
        attempt: opts.attempt,
        host: opts.hostForLog,
        status: res.status,
      });
    }
    return ok;
  } catch (err) {
    log.warn("webhook.attempt_transport_error", {
      run_id: opts.runId,
      attempt: opts.attempt,
      host: opts.hostForLog,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

interface RunRetryInput {
  readonly db: Database.Database;
  readonly runId: string;
  readonly fetchImpl: WebhookFetch;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly requestTimeoutMs: number;
  readonly hostForLog: string;
  readonly nowFn: () => string;
}

/**
 * Run the second-and-final attempt, persisting `delivered` on 2xx or
 * `failed` otherwise. Quality gate: this MUST NOT schedule another
 * retry. Bounded at exactly one retry per the issue.
 */
async function runRetry(opts: RunRetryInput): Promise<void> {
  const ok = await tryDeliver({
    fetchImpl: opts.fetchImpl,
    url: opts.url,
    headers: opts.headers,
    body: opts.body,
    requestTimeoutMs: opts.requestTimeoutMs,
    runId: opts.runId,
    hostForLog: opts.hostForLog,
    attempt: 2,
  });

  const status = ok ? "delivered" : "failed";
  opts.db
    .prepare(`UPDATE runs SET webhook_status = ? WHERE id = ?`)
    .run(status, opts.runId);

  if (ok) {
    log.info("webhook.delivered", {
      run_id: opts.runId,
      attempt: 2,
      host: opts.hostForLog,
      ts: opts.nowFn(),
    });
  } else {
    log.error("webhook.failed", {
      run_id: opts.runId,
      host: opts.hostForLog,
      ts: opts.nowFn(),
    });
  }
}
