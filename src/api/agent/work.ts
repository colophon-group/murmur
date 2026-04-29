/**
 * `GET /work/next` and `POST /work/{claim_token}/result` — the two atomic
 * agent endpoints (DESIGN.md §3.3).
 *
 * Both endpoints use the M0 envelope (`{ ok, errors?, data? }`); there is
 * no `accepted:` parallel shape. Both are mounted by `createAgentApp` in
 * `src/api/agent/index.ts`.
 *
 * Atomicity rules:
 *
 *   - `GET /work/next` runs a single `UPDATE … RETURNING` inside
 *     `BEGIN IMMEDIATE`. The transaction wrapping is what serialises
 *     concurrent claims at the SQLite layer (better-sqlite3 is sync; a
 *     `BEGIN IMMEDIATE` raises `SQLITE_BUSY` if another writer holds the
 *     RESERVED lock — for in-process concurrency this is a non-issue
 *     because better-sqlite3 already serialises writes at the connection
 *     mutex). See `src/db/concurrency.test.ts` for the contract.
 *
 *   - `POST /work/{claim_token}/result` runs CAS as a single
 *     `UPDATE … RETURNING`. If the row no longer matches the predicate
 *     (token unknown, expired, already done), the UPDATE returns no
 *     rows and the endpoint emits `{ok: false, errors: ['claim_lost']}`.
 *     On success, the result and audit rows write inside the same
 *     transaction so a crash mid-handler cannot leave a `done` row
 *     without its `subtask_results` companion.
 *
 * @see DESIGN.md §3.3 — Server endpoints (agent-facing)
 * @see src/api/agent/sql.ts — the prepared statements
 */

import { Hono } from "hono";

import type Database from "better-sqlite3";

import type { EnvelopeResponse, Err, Ok } from "@murmur/contracts-types";

import { validateAgainst } from "../../dispatch/validation.js";

import {
  CAS_SQL,
  CLAIM_SQL,
  INSERT_AGENT_ACTION_SQL,
  INSERT_RESULT_SQL,
} from "./sql.js";
import { markNextReady, maybeFinaliseRun, spawnChildren } from "./lifecycle.js";

/**
 * Default claim TTL: 10 minutes (DESIGN.md §3.3, "Fixed 10-minute TTL.").
 *
 * Tests override this to a small value (e.g. 50ms) so the
 * "expired claim → claim_lost" path is exercisable without sleeping.
 */
export const DEFAULT_CLAIM_TTL_MS = 10 * 60 * 1000;

/**
 * Options accepted by {@link createWorkRoutes}.
 *
 * `db` is an open better-sqlite3 connection; the routes do not own its
 * lifecycle. `ttlMs` overrides the default 10-minute claim TTL — used by
 * tests to exercise the expired-claim path. `nowFn` and `claimTokenFn`
 * are seams for deterministic testing (clock and RNG).
 */
export interface CreateWorkRoutesOptions {
  readonly db: Database.Database;
  readonly ttlMs?: number;
  /** Returns the current time as an RFC 3339 UTC string. */
  readonly nowFn?: () => string;
  /** Returns a fresh claim token (opaque, ≥16 bytes of entropy). */
  readonly claimTokenFn?: () => string;
}

/**
 * Shape of the row RETURNED by `CLAIM_SQL`. Mirrors the columns we
 * project; everything is `string` because SQLite stores them as `TEXT`.
 */
export interface ClaimedRow {
  readonly id: string;
  readonly run_id: string;
  readonly subtask_id: string;
  readonly input_json: string;
  readonly claim_token: string;
  readonly expires_at: string;
}

/**
 * Shape of the row RETURNED by `CAS_SQL` on a successful submit.
 */
export interface CasOkRow {
  readonly id: string;
  readonly run_id: string;
  readonly subtask_id: string;
}

/**
 * Successful `/work/next` payload (the `data` slot in the M0 envelope).
 * `null` is also a valid `data` for the no-work case.
 */
export interface NextWorkData {
  readonly instructions: string;
  readonly input: unknown;
  readonly output_schema: Readonly<Record<string, unknown>>;
  /** Opaque token; agent passes it back on subcommand and submit. */
  readonly claim: string;
}

/**
 * Successful `/result` payload — the run id, so the agent can correlate
 * (and so it appears in the audit trail).
 */
export interface SubmitOkData {
  readonly run_id: string;
}

/**
 * Body shape for `POST /work/{claim_token}/result`.
 */
export interface SubmitBody {
  readonly result: unknown;
  readonly notes?: string;
}

/**
 * Build a Hono sub-app exposing `GET /next` and `POST /:claim_token/result`.
 *
 * The sub-app is mounted at `/work` by `createServer`, yielding the final
 * routes `GET /work/next` and `POST /work/{claim_token}/result`.
 *
 * @returns a Hono app (no app-level middleware; bearer auth applies at the
 *   parent app's `app.use('*', ...)` level).
 */
export function createWorkRoutes(options: CreateWorkRoutesOptions): Hono {
  void options;
  throw new Error("not implemented");
}

/**
 * Helper: format `Date` as an RFC 3339 UTC string with millisecond
 * precision (`YYYY-MM-DDTHH:MM:SS.sssZ`). Matches the format used by
 * existing migration code (`new Date().toISOString()`). Exported for tests.
 */
export function nowIso(d: Date = new Date()): string {
  return d.toISOString();
}

/**
 * Helper: build a fresh claim token. Returns a URL-safe string with
 * ≥128 bits of entropy. Exported for tests.
 */
export function freshClaimToken(): string {
  throw new Error("not implemented");
}

/**
 * Lookup the run's `subtask_def_id` → `{instructions, output_schema, input}`
 * tuple by reading `pipelines.def_json`. Used after a successful claim to
 * project the agent-facing payload.
 *
 * @returns the projected payload, or `null` if the pipeline def cannot be
 *   located or the subtask def is not in it (which would indicate schema
 *   drift between when the run started and now — a hard error in a real
 *   deployment, surfaced here as a null so the route can return 500).
 */
export function projectClaimPayload(
  db: Database.Database,
  runId: string,
  subtaskId: string,
  inputJson: string,
  claimToken: string,
): NextWorkData | null {
  void db;
  void runId;
  void subtaskId;
  void inputJson;
  void claimToken;
  throw new Error("not implemented");
}

/**
 * Type-only re-export so consumers (and tests) can build envelope literals
 * without importing the contracts package twice.
 */
export type AgentEnvelope<T> = EnvelopeResponse<T>;
export type AgentOk<T> = Ok<T>;
export type AgentErr = Err;
