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
import type { Pool } from "undici";

import type { EnvelopeResponse } from "@murmur/contracts-types";

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
   * The `MURMUR_TOKEN` value that gates Murmur's own endpoints. Murmur
   * forwards the SAME token to the publisher per DESIGN.md §3.6
   * (single-bearer model for the demo). Caller MUST supply; the
   * dispatcher does not read `process.env`.
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
   * Override the now() function for deterministic audit timestamps.
   * Default `() => new Date().toISOString()`.
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
  throw new Error("not implemented");
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
  throw new Error("not implemented");
}

/**
 * Inspect the count of cached pools. Tests use this to assert that
 * the module-scoped cache is being reused rather than churned.
 */
export function poolCount(): number {
  throw new Error("not implemented");
}
