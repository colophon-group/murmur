/**
 * `task_tool(subcommand, claim, args)` dispatcher (DESIGN.md §3.4, §3.6).
 *
 * Pure function — no HTTP route is registered here. The MCP `task_tool`
 * handler (M6) and any future HTTP shim call {@link dispatchTaskTool}.
 *
 * The dispatcher walks the following pipeline, folding every failure
 * into the M0 `EnvelopeResponse` shape:
 *
 *   1. **Resolve claim.** Look up `subtask_instances` by `claim_token`,
 *      joined to `runs` and `pipelines`. If unknown, expired, or status
 *      is anything other than `claimed` → `claim_lost`.
 *   2. **Locate subcommand.** Find the subtask def in the pipeline def
 *      whose `id` matches the claim's `subtask_id`; search its
 *      `subcommands[]` for `name === subcommand`. If the subtask itself
 *      has no `subcommands`, or the name is missing →
 *      `unknown_subcommand` with `data.available: string[]`.
 *   3. **Validate args.** Run `validateAgainst(input_schema, args)` from
 *      M9. Fail → return the Ajv `validation:<path>:<msg>` strings.
 *      No `input_schema` declared on the subcommand → args are passed
 *      through unvalidated (subcommand author opted out).
 *   4. **Build the proxy request.** Bearer auth, `X-Murmur-Subcommand`,
 *      `X-Murmur-Claim-Token` headers (constants from
 *      `@murmur/contracts-types`). Method + URL parsed from the
 *      subcommand's `endpoint` ("METHOD URL" form).
 *   5. **POST with timeout + cap.** 15s `AbortController` timeout. Read
 *      the body chunk-by-chunk and abort at 1 MB. The HTTP client is
 *      `undici`'s `Pool` per origin with `connections: 50` cap, kept in
 *      a module-scoped `Map` so a flood of concurrent calls reuses
 *      sockets rather than opening one per call.
 *   6. **Audit.** One `agent_actions` row per call (kind=`task_tool`),
 *      with `args_json` + `response_json` truncated to 4 KB. Audit is
 *      written even for failure paths so operators can diagnose.
 *
 * **Concurrency note.** `dispatchTaskTool` is `async`, but every DB
 * read it issues is synchronous (better-sqlite3). The DB is touched
 * once at the start (claim + def lookup) and once at the end (audit
 * insert). The HTTP round-trip is the only part that yields. Two
 * concurrent calls on the same claim are serialised by the better-
 * sqlite3 connection mutex on the audit insert; that's the only
 * shared mutable state between calls.
 *
 * **No mid-flight TTL slide for MVP.** DESIGN.md §3.3 lists a sliding
 * TTL on success as "Reinstated for full ws coverage" — we don't update
 * `expires_at` here. A 14s probe + 10s claim TTL means a probe can
 * outlive its claim; that's the documented tradeoff for the demo.
 *
 * @see DESIGN.md §3.4 — Dispatch
 * @see DESIGN.md §3.6 — Failure modes (publisher_timeout, publisher_5xx,
 *                       publisher_response_too_large)
 */

import type Database from "better-sqlite3";
import { Pool } from "undici";

import type { EnvelopeResponse, Err, Ok } from "@murmur/contracts-types";
import { MurmurHeaders } from "@murmur/contracts-types";

import { truncateForAudit } from "./audit.js";
import { validateAgainst } from "./validation.js";

/**
 * Options accepted by {@link dispatchTaskTool}.
 *
 * Most fields are seams for testing. Production callers (the MCP
 * `task_tool` handler) supply only `db`, `claimToken`, `subcommand`,
 * `args`, `bearer`.
 */
export interface DispatchTaskToolOptions {
  /** Open better-sqlite3 connection. The dispatcher does not own its lifecycle. */
  readonly db: Database.Database;
  /** The `claim` value the agent received from `pull_task`. */
  readonly claimToken: string;
  /** The subcommand name the agent invoked (e.g. `"probe monitor"`). */
  readonly subcommand: string;
  /** The agent-supplied args. Not validated by the dispatcher beyond the schema check. */
  readonly args: unknown;
  /**
   * Fallback bearer when the run's publisher has no active
   * `subcommand_bearer` row. Pre-M1 the caller passed `MURMUR_TOKEN`
   * here (single-bearer model); post-M1 the publisher's per-tenant
   * `subcommand_bearer` (resolved via the claim's `run → pipeline →
   * publisher` chain) takes precedence and the dispatcher falls back to
   * this fallback only if no active row exists. Production callers that
   * always seed a `subcommand_bearer` for every publisher can leave this
   * empty; tests and pre-seed deployments pass `MURMUR_TOKEN` for
   * graceful degradation.
   *
   * @see src/db/bootstrap.ts — boot-time `subcommand_bearer` seed
   */
  readonly bearer: string;
  /**
   * Override the per-call timeout. Default 15_000 ms (DESIGN.md §3.6).
   * Tests use small values (e.g. 100ms) to exercise the timeout path
   * without sleeping.
   */
  readonly timeoutMs?: number;
  /**
   * Override the response body cap. Default 1_048_576 bytes (1 MB).
   * Tests use small values to exercise the cap path quickly.
   */
  readonly responseCapBytes?: number;
  /**
   * Override the now() function for deterministic timestamps. Two roles:
   *
   *   1. The string returned is bound into the `expires_at > ?` filter
   *      of the claim-resolution SQL — so this seam ALSO controls the
   *      claim-expiry comparison, not just audit-row `ts`. Tests that
   *      seed a fixed `expires_at` MUST pin `nowFn` to a moment within
   *      that TTL window or the dispatcher will (correctly) report
   *      `claim_lost`.
   *   2. The string is reused as the `agent_actions.ts` value of the
   *      audit row, so a deterministic clock yields a deterministic
   *      audit log.
   *
   * Default `() => new Date().toISOString()`. Mirrors the `nowFn` seam
   * on M5's `createWorkRoutes` (`src/api/agent/work.ts`).
   */
  readonly nowFn?: () => string;
  /**
   * Override the pool factory for tests. Production uses the
   * module-scoped `Map<origin, Pool>` cache.
   */
  readonly poolFactory?: (origin: string) => Pool;
}

/**
 * Successful proxy response. The publisher's parsed JSON body is
 * surfaced verbatim under `data`. If the publisher returns a non-JSON
 * body but a 2xx status, `data` is the raw string; this is acceptable
 * for the demo (publishers in scope return JSON).
 */
export type DispatchSuccessData = unknown;

/**
 * Body shape attached to `unknown_subcommand` failures so the agent
 * can self-correct without a round-trip.
 */
export interface UnknownSubcommandData {
  readonly available: ReadonlyArray<string>;
}

/**
 * Dispatch a `task_tool` invocation. Folds every failure into the
 * `EnvelopeResponse` shape — never throws. The error tokens used are
 * stable across MVP and post-MVP:
 *
 *   - `claim_lost`               — claim unknown / expired / status≠claimed.
 *   - `unknown_subcommand`       — name not in the subtask's `subcommands[]`.
 *                                  `data.available: string[]` lists valid names.
 *   - `validation:<path>:<msg>`  — args fail `input_schema` (one entry per
 *                                  Ajv error; `validateAgainst` formats them).
 *   - `publisher_timeout`        — 15s elapsed before headers. Outbound
 *                                  socket aborted via `AbortController`.
 *   - `publisher_5xx` + `<code>` — publisher returned 5xx. Both tokens
 *                                  appear in `errors`, in that order.
 *   - `publisher_response_too_large` — response body exceeded 1 MB.
 *                                      Read aborted; pool socket released.
 *   - `publisher_unreachable`    — DNS/connect/TLS error. Catch-all for
 *                                  network-level failures distinct from
 *                                  the above.
 *
 * @returns an `EnvelopeResponse` ready for serialisation by the caller.
 */
export async function dispatchTaskTool(
  options: DispatchTaskToolOptions,
): Promise<EnvelopeResponse<DispatchSuccessData | UnknownSubcommandData>> {
  const {
    db,
    claimToken,
    subcommand,
    args,
    bearer,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    responseCapBytes = DEFAULT_RESPONSE_CAP_BYTES,
    nowFn = defaultNowFn,
    poolFactory,
  } = options;

  /* 1. Resolve claim. */
  const now = nowFn();
  const claim = lookupClaim(db, claimToken, now);
  if (claim === null) {
    const body: Err = { ok: false, errors: ["claim_lost"] };
    return body;
  }

  /* 2. Locate subcommand in the active subtask def. */
  const def = parsePipelineDef(claim.def_json);
  if (def === null) {
    // Pipeline def unparseable. Surface as a stable failure.
    return { ok: false, errors: ["pipeline_not_found"] };
  }
  const subtask = def.subtasks.find((s) => s.id === claim.subtask_id);
  if (subtask === undefined) {
    return { ok: false, errors: ["pipeline_not_found"] };
  }
  const subcmds = subtask.subcommands ?? [];
  const subcmd = subcmds.find((s) => s.name === subcommand);
  if (subcmd === undefined) {
    const data: UnknownSubcommandData = {
      available: subcmds.map((s) => s.name),
    };
    return {
      ok: false,
      errors: ["unknown_subcommand"],
      // The envelope contract permits `data` only on `Ok`. We emit the
      // available list as part of the error envelope by attaching it
      // under a typed cast. The MCP/HTTP shim handles serialisation.
      // (See the issue's "Unknown subcommand" verification for the
      // exact wire shape.)
      ...({ data } as { data: UnknownSubcommandData }),
    } as Err & { data: UnknownSubcommandData };
  }

  /* 3. Validate args against input_schema (if declared). */
  if (subcmd.input_schema !== undefined) {
    const v = validateAgainst(subcmd.input_schema, args);
    if (!v.ok) {
      // No audit row for validation failures: the call never left the
      // server, the publisher is uninvolved, and the agent's args are
      // already echoed to it via the error response. Adds noise, no signal.
      return { ok: false, errors: v.errors };
    }
  }

  /* 4. Build the proxy request. */
  const parsed = parseEndpoint(subcmd.endpoint);
  if (parsed === null) {
    return { ok: false, errors: ["pipeline_not_found"] };
  }

  const pool = (poolFactory ?? defaultPoolFactory)(parsed.origin);

  /* 5. POST with timeout + cap. Prefer the publisher's own
   *    `subcommand_bearer` (M1, issue #81) so a hostile publisher can't
   *    learn another publisher's bearer via task_tool dispatch. Fall
   *    back to the legacy MURMUR_TOKEN value passed via `opts.bearer`
   *    for pre-M1 deployments where no `subcommand_bearer` row has
   *    been seeded yet. */
  const dispatchBearer =
    claim.publisher_subcommand_bearer !== null
      ? claim.publisher_subcommand_bearer
      : bearer;

  const argsJson = safeStringify(args);
  const httpResult = await proxyToPublisher({
    pool,
    path: parsed.pathname,
    method: parsed.method,
    bearer: dispatchBearer,
    subcommand,
    claimToken,
    body: argsJson,
    timeoutMs,
    responseCapBytes,
  });

  /* 6. Audit. Write one row regardless of outcome. */
  const auditArgs = truncateForAudit(argsJson);
  const auditResp = truncateForAudit(httpResult.responseJson ?? null);
  const truncated = auditArgs.truncated || auditResp.truncated ? 1 : 0;
  try {
    db.prepare(
      `INSERT INTO agent_actions
         (instance_id, ts, kind, subcommand, args_json, response_json, truncated)
       VALUES (?, ?, 'task_tool', ?, ?, ?, ?)`,
    ).run(
      claim.instance_id,
      nowFn(),
      subcommand,
      auditArgs.text,
      auditResp.text,
      truncated,
    );
  } catch {
    // Audit failure must not mask the dispatch result. The DB error
    // surfaces via the migrations test path; in production a missing
    // audit row is recoverable, a missing dispatch reply is not.
  }

  /* 7. Translate the HTTP outcome into the envelope. */
  if (httpResult.kind === "ok") {
    const body: Ok<DispatchSuccessData> = { ok: true, data: httpResult.data };
    return body;
  }
  return { ok: false, errors: httpResult.errors };
}

/**
 * Tear down every cached pool. Tests call this in `afterEach`/`afterAll`
 * to ensure no socket leaks across test cases. Production has no need
 * to call this — the pools live for the process lifetime.
 *
 * @returns a promise that resolves when every pool's `close()` has
 *          completed.
 */
export async function closeAllPools(): Promise<void> {
  const pools = Array.from(pools_.values());
  pools_.clear();
  await Promise.all(pools.map((p) => p.close()));
}

/**
 * Inspect the count of cached pools. Tests use this to assert that
 * the module-scoped cache is being reused rather than churned.
 */
export function poolCount(): number {
  return pools_.size;
}

/* --------------------------------------------------------------------
 * Internals
 * -------------------------------------------------------------------- */

/** Default 15s timeout per DESIGN.md §3.6. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** Default 1 MB response cap per DESIGN.md §3.6. */
const DEFAULT_RESPONSE_CAP_BYTES = 1_048_576;

/**
 * Per-origin connection cap. The issue's quality gate calls for a hard
 * limit (e.g., 50 concurrent). 50 is also undici's default for `Pool`
 * but we set it explicitly so a future undici default change cannot
 * silently weaken the cap.
 */
const POOL_CONNECTIONS_PER_ORIGIN = 50;

/** Module-scoped cache: one undici Pool per origin. Reused across calls. */
const pools_: Map<string, Pool> = new Map();

function defaultPoolFactory(origin: string): Pool {
  let pool = pools_.get(origin);
  if (pool === undefined) {
    pool = new Pool(origin, {
      connections: POOL_CONNECTIONS_PER_ORIGIN,
      pipelining: 1,
      // Keep-alive defaults are fine; we want sockets reused.
    });
    pools_.set(origin, pool);
  }
  return pool;
}

function defaultNowFn(): string {
  return new Date().toISOString();
}

/* ---------------- Claim lookup ---------------- */

interface ResolvedClaim {
  readonly instance_id: string;
  readonly subtask_id: string;
  readonly def_json: string;
  /**
   * The active per-publisher `subcommand_bearer`. Resolved via
   * `runs → pipelines → publishers → publisher_secrets` LEFT JOIN.
   * NULL when the publisher has no active subcommand_bearer (pre-M1
   * deployments, or operator revoked the secret without re-issuing).
   * Caller falls back to `opts.bearer` in that case.
   */
  readonly publisher_subcommand_bearer: string | null;
}

const LOOKUP_CLAIM_SQL = `
  SELECT subtask_instances.id          AS instance_id,
         subtask_instances.subtask_id  AS subtask_id,
         pipelines.def_json            AS def_json,
         (SELECT secret_value
            FROM publisher_secrets
           WHERE publisher_secrets.publisher_id = pipelines.publisher_id
             AND publisher_secrets.kind         = 'subcommand_bearer'
             AND publisher_secrets.revoked_at   IS NULL
           ORDER BY publisher_secrets.created_at DESC
           LIMIT 1)                    AS publisher_subcommand_bearer
    FROM subtask_instances
    JOIN runs      ON runs.id          = subtask_instances.run_id
    JOIN pipelines ON pipelines.id     = runs.pipeline_id
   WHERE subtask_instances.claim_token = ?
     AND subtask_instances.status      = 'claimed'
     AND subtask_instances.expires_at  > ?
`;

function lookupClaim(
  db: Database.Database,
  claimToken: string,
  nowIso: string,
): ResolvedClaim | null {
  const row = db.prepare(LOOKUP_CLAIM_SQL).get(claimToken, nowIso) as
    | {
        instance_id: string;
        subtask_id: string;
        def_json: string;
        publisher_subcommand_bearer: string | null;
      }
    | undefined;
  if (row === undefined) return null;
  return {
    instance_id: row.instance_id,
    subtask_id: row.subtask_id,
    def_json: row.def_json,
    publisher_subcommand_bearer: row.publisher_subcommand_bearer,
  };
}

/* ---------------- Pipeline def cache ---------------- */

interface CachedSubcommandDef {
  readonly name: string;
  readonly endpoint: string;
  readonly input_schema?: Record<string, unknown>;
}

interface CachedSubtaskDef {
  readonly id: string;
  readonly subcommands?: ReadonlyArray<CachedSubcommandDef>;
}

interface CachedPipelineDef {
  readonly subtasks: ReadonlyArray<CachedSubtaskDef>;
}

/**
 * Cache parsed pipeline defs by the raw `def_json` string. Identical
 * strings (the common case for repeated calls on the same pipeline
 * version) hit the cache; on def upsert the string changes and the
 * old entry is replaced. Bounded by `DEF_CACHE_LIMIT` LRU entries to
 * avoid unbounded growth in pathological deployments.
 */
const DEF_CACHE_LIMIT = 32;
const defCache: Map<string, CachedPipelineDef | null> = new Map();

function parsePipelineDef(defJson: string): CachedPipelineDef | null {
  const cached = defCache.get(defJson);
  if (cached !== undefined) {
    // Refresh LRU position.
    defCache.delete(defJson);
    defCache.set(defJson, cached);
    return cached;
  }
  let parsed: CachedPipelineDef | null;
  try {
    parsed = JSON.parse(defJson) as CachedPipelineDef;
  } catch {
    parsed = null;
  }
  // LRU eviction.
  if (defCache.size >= DEF_CACHE_LIMIT) {
    const oldest = defCache.keys().next().value;
    if (oldest !== undefined) defCache.delete(oldest);
  }
  defCache.set(defJson, parsed);
  return parsed;
}

/* ---------------- Endpoint parsing ---------------- */

interface ParsedEndpoint {
  readonly method: string;
  readonly origin: string;
  readonly pathname: string;
}

/**
 * Parse the pipeline-def `endpoint` string. DESIGN.md §3.1 uses the
 * "METHOD URL" form (e.g. `"POST https://example.com/path"`). We're
 * generous and accept a bare URL with an implied POST, since §3.4 only
 * speaks of a POST proxy.
 */
function parseEndpoint(endpoint: string): ParsedEndpoint | null {
  const trimmed = endpoint.trim();
  let method = "POST";
  let urlPart = trimmed;

  const space = trimmed.indexOf(" ");
  if (space > 0) {
    const head = trimmed.slice(0, space);
    if (/^[A-Za-z]+$/.test(head)) {
      method = head.toUpperCase();
      urlPart = trimmed.slice(space + 1).trim();
    }
  }

  let url: URL;
  try {
    url = new URL(urlPart);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  return {
    method,
    origin: `${url.protocol}//${url.host}`,
    pathname: `${url.pathname}${url.search}`,
  };
}

/* ---------------- HTTP proxy ---------------- */

interface ProxyOk {
  readonly kind: "ok";
  readonly data: unknown;
  readonly responseJson: string;
}

interface ProxyErr {
  readonly kind: "err";
  readonly errors: ReadonlyArray<string>;
  readonly responseJson?: string;
}

interface ProxyOptions {
  readonly pool: Pool;
  readonly path: string;
  readonly method: string;
  readonly bearer: string;
  readonly subcommand: string;
  readonly claimToken: string;
  readonly body: string;
  readonly timeoutMs: number;
  readonly responseCapBytes: number;
}

async function proxyToPublisher(
  opts: ProxyOptions,
): Promise<ProxyOk | ProxyErr> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  // `unref` so a pending timer never blocks process exit.
  if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
    (timer as unknown as { unref: () => void }).unref();
  }

  let res;
  try {
    res = await opts.pool.request({
      method: opts.method as
        | "GET"
        | "POST"
        | "PUT"
        | "PATCH"
        | "DELETE"
        | "HEAD"
        | "OPTIONS",
      path: opts.path,
      headers: {
        [MurmurHeaders.AUTHORIZATION]: `Bearer ${opts.bearer}`,
        [MurmurHeaders.X_MURMUR_SUBCOMMAND]: opts.subcommand,
        [MurmurHeaders.X_MURMUR_CLAIM_TOKEN]: opts.claimToken,
        "content-type": "application/json",
      },
      body: opts.body,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (isAbortError(err) || controller.signal.aborted) {
      return { kind: "err", errors: ["publisher_timeout"] };
    }
    return { kind: "err", errors: ["publisher_unreachable"] };
  }

  // Headers are in. Stream-read the body with a hard byte cap, never
  // touching `res.body.text()` (which would buffer the whole thing).
  const status = res.statusCode;
  const reader = res.body;
  let total = 0;
  const chunks: Buffer[] = [];
  let tooLarge = false;

  try {
    for await (const chunk of reader) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.byteLength;
      if (total > opts.responseCapBytes) {
        tooLarge = true;
        // Abort the request — undici closes the underlying socket so we
        // don't keep the upstream sender writing into the void.
        controller.abort();
        // Drain whatever's left so undici can recycle the socket.
        // (Iteration breaks below; the abort already terminated the
        // server side per the test assertion.)
        break;
      }
      chunks.push(buf);
    }
  } catch (err) {
    clearTimeout(timer);
    if (isAbortError(err) || controller.signal.aborted) {
      // Could be timeout-mid-body OR our cap-induced abort. The
      // tooLarge flag disambiguates.
      if (tooLarge) {
        return { kind: "err", errors: ["publisher_response_too_large"] };
      }
      return { kind: "err", errors: ["publisher_timeout"] };
    }
    return { kind: "err", errors: ["publisher_unreachable"] };
  }
  clearTimeout(timer);

  if (tooLarge) {
    return { kind: "err", errors: ["publisher_response_too_large"] };
  }

  const responseJson = Buffer.concat(chunks).toString("utf8");

  if (status >= 500) {
    return {
      kind: "err",
      errors: ["publisher_5xx", String(status)],
      responseJson,
    };
  }
  if (status >= 400) {
    return {
      kind: "err",
      errors: ["publisher_4xx", String(status)],
      responseJson,
    };
  }

  // Success: parse JSON if possible; fall back to the raw string.
  let parsed: unknown;
  try {
    parsed = responseJson.length === 0 ? null : JSON.parse(responseJson);
  } catch {
    parsed = responseJson;
  }
  return { kind: "ok", data: parsed, responseJson };
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Error) {
    if (err.name === "AbortError") return true;
    if ("code" in err && (err as { code?: string }).code === "UND_ERR_ABORTED") {
      return true;
    }
  }
  return false;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return '"<unserializable>"';
  }
}
