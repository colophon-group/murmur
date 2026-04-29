/**
 * `GET /work/next` and `POST /work/{claim_token}/result` — the two atomic
 * agent endpoints (DESIGN.md §3.3).
 *
 * Both endpoints use the M0 envelope (`{ ok, errors?, data? }`); there is
 * no parallel `accepted` shape (grep-no-accepted-key:allow — prose). Both
 * are mounted by `createAgentApp` in `src/api/agent/index.ts`.
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

import { randomBytes } from "node:crypto";

import { Hono } from "hono";

import type Database from "better-sqlite3";

import type { Err, Ok } from "@murmur/contracts-types";

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
 * Audit-log payload truncation cap (DESIGN.md §3.6).
 *
 * `args_json` and `response_json` on `agent_actions` are capped at 4 KB.
 * Truncation is recorded by setting `truncated = 1`. The audit log is for
 * post-mortem inspection — full payloads live in `subtask_results`.
 */
const AUDIT_PAYLOAD_LIMIT_BYTES = 4 * 1024;

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
 * Subset of the pipeline def we read off `pipelines.def_json`. Kept local
 * so the route is decoupled from the (still-evolving) authoritative type.
 */
interface PipelineDefRow {
  readonly subtasks: ReadonlyArray<{
    readonly id: string;
    readonly instructions?: string;
    readonly output_schema?: Readonly<Record<string, unknown>>;
  }>;
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
  const db = options.db;
  const ttlMs = options.ttlMs ?? DEFAULT_CLAIM_TTL_MS;
  const nowFn = options.nowFn ?? (() => nowIso());
  const claimTokenFn = options.claimTokenFn ?? freshClaimToken;

  // Compile the prepared statements once at construction time. Re-binding
  // happens on every call but the parse step runs once.
  const claimStmt = db.prepare(CLAIM_SQL);
  const casStmt = db.prepare(CAS_SQL);
  const insertResultStmt = db.prepare(INSERT_RESULT_SQL);
  const insertActionStmt = db.prepare(INSERT_AGENT_ACTION_SQL);
  const lookupPipelineStmt = db.prepare(
    `SELECT pipelines.def_json AS def_json
       FROM pipelines
       JOIN runs ON runs.pipeline_id = pipelines.id
      WHERE runs.id = ?`,
  );

  const app = new Hono();

  /* ---------- GET /work/next ---------- */
  app.get("/next", (c) => {
    const now = nowFn();
    const expiresAt = new Date(Date.parse(now) + ttlMs).toISOString();
    const token = claimTokenFn();

    // Atomic claim: BEGIN IMMEDIATE upgrades to RESERVED on entry; the
    // single UPDATE … RETURNING below is the only write inside the txn.
    // better-sqlite3 serialises connection-level writes via its native
    // mutex, but BEGIN IMMEDIATE is still required because:
    //   1. It pins the row choice + status flip into one logical step
    //      (no one else can write between the inner SELECT and the UPDATE).
    //   2. The contract `src/db/concurrency.test.ts` enforces remains
    //      independent of the in-process mutex (file-backed multi-process
    //      use eventually applies).
    //
    // We do NOT issue an explicit `claim` agent_action insert inside the
    // same txn because the `agent_actions` table FK depends on the
    // instance row already existing. The UPDATE … RETURNING already wrote
    // the row before we INSERT, so this is fine — we issue the INSERT
    // immediately after COMMIT.
    db.exec("BEGIN IMMEDIATE");
    let row: ClaimedRow | undefined;
    try {
      row = claimStmt.get(token, expiresAt, now) as ClaimedRow | undefined;
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // ignore — the original error is surfaced below
      }
      throw err;
    }

    if (row === undefined) {
      // Empty queue. Per the issue: HTTP 200 with body, NOT 204.
      const body: Ok<null> = { ok: true, data: null };
      return c.json(body, 200);
    }

    const payload = projectClaimPayload(
      row.run_id,
      row.subtask_id,
      row.input_json,
      row.claim_token,
      lookupPipelineStmt,
    );
    if (payload === null) {
      // Pipeline def not resolvable → schema drift. Treat as an internal
      // error; the row stays `claimed` so the sweeper can release it.
      const body: Err = {
        ok: false,
        errors: ["pipeline_not_found"],
      };
      return c.json(body, 500);
    }

    // Audit: log the claim. Truncate the projected input if it exceeds
    // the §3.6 4 KB cap.
    const args = truncatePayload(JSON.stringify({ claim: row.claim_token }));
    const resp = truncatePayload(JSON.stringify({ instance_id: row.id }));
    insertActionStmt.run(
      row.id,
      now,
      "claim",
      null,
      args.text,
      resp.text,
      args.truncated || resp.truncated ? 1 : 0,
    );

    const okBody: Ok<NextWorkData> = { ok: true, data: payload };
    return c.json(okBody, 200);
  });

  /* ---------- POST /work/{claim_token}/result ---------- */
  app.post("/:claim_token/result", async (c) => {
    const token = c.req.param("claim_token");
    let body: SubmitBody;
    try {
      body = (await c.req.json()) as SubmitBody;
    } catch {
      const errBody: Err = { ok: false, errors: ["bad_json"] };
      return c.json(errBody, 400);
    }
    if (
      body === null ||
      typeof body !== "object" ||
      !("result" in body)
    ) {
      const errBody: Err = { ok: false, errors: ["bad_request"] };
      return c.json(errBody, 400);
    }

    const now = nowFn();

    // Resolve the row by claim_token to validate the result against the
    // subtask's output_schema BEFORE we run the CAS. We deliberately do
    // not run the CAS first: a schema-invalid result must not flip the
    // row to `done`. The lookup is a simple SELECT — no lock taken;
    // worst case the row's status changed between SELECT and CAS, in
    // which case the CAS UPDATE returns zero rows and we report
    // `claim_lost` (correct: the agent's window was lost).
    const lookup = db
      .prepare(
        `SELECT id, run_id, subtask_id, status, expires_at
           FROM subtask_instances
          WHERE claim_token = ?`,
      )
      .get(token) as
      | {
          id: string;
          run_id: string;
          subtask_id: string;
          status: string;
          expires_at: string;
        }
      | undefined;

    if (
      lookup === undefined ||
      lookup.status !== "claimed" ||
      lookup.expires_at <= now
    ) {
      // Audit: log the rejected submit. We can only attach `instance_id`
      // when we resolved the row; if not, drop on the floor (we'd have
      // an FK violation). Silent here keeps the contract clean — a noisy
      // unknown-claim audit row would be agent-driven garbage.
      const errBody: Err = { ok: false, errors: ["claim_lost"] };
      return c.json(errBody, 200);
    }

    // Pipeline def lookup so we can grab the right output_schema for
    // validation.
    const pipelineDef = readPipelineDef(lookup.run_id, lookupPipelineStmt);
    if (pipelineDef === null) {
      const errBody: Err = { ok: false, errors: ["pipeline_not_found"] };
      return c.json(errBody, 500);
    }
    const subtaskDef = pipelineDef.subtasks.find(
      (s) => s.id === lookup.subtask_id,
    );
    if (subtaskDef === undefined || subtaskDef.output_schema === undefined) {
      const errBody: Err = { ok: false, errors: ["pipeline_not_found"] };
      return c.json(errBody, 500);
    }

    const validation = validateAgainst(subtaskDef.output_schema, body.result);
    if (!validation.ok) {
      // Schema-fail path: leave the row claimed so the agent (or sweeper)
      // can retry. Issue requires the validation error string format.
      // Audit the rejection so operators can diagnose.
      const args = truncatePayload(JSON.stringify(body));
      const resp = truncatePayload(
        JSON.stringify({ errors: validation.errors }),
      );
      insertActionStmt.run(
        lookup.id,
        now,
        "submit_result",
        null,
        args.text,
        resp.text,
        args.truncated || resp.truncated ? 1 : 0,
      );
      const errBody: Err = { ok: false, errors: validation.errors };
      return c.json(errBody, 400);
    }

    // CAS submit + result write + audit + lifecycle, all in one txn so
    // a crash leaves the DB consistent.
    db.exec("BEGIN IMMEDIATE");
    let casRow: CasOkRow | undefined;
    try {
      casRow = casStmt.get(now, token, now) as CasOkRow | undefined;
      if (casRow === undefined) {
        // Lost the CAS race. Roll back and fall through to the
        // claim_lost path. No audit row here — see the unknown-claim
        // rationale above.
        db.exec("ROLLBACK");
      } else {
        const outputJson = JSON.stringify(validation.value);
        insertResultStmt.run(casRow.id, outputJson, now);

        // Audit: notes ride in args_json so they're visible in the
        // run-status response (DESIGN.md §3.1 last bullet, §3.6 audit).
        // The result column is intentionally NOT mirrored into
        // subtask_results.notes — DESIGN.md §3.1 requires notes live in
        // the audit log only.
        const args = truncatePayload(JSON.stringify(body));
        const resp = truncatePayload(
          JSON.stringify({ run_id: casRow.run_id }),
        );
        insertActionStmt.run(
          casRow.id,
          now,
          "submit_result",
          null,
          args.text,
          resp.text,
          args.truncated || resp.truncated ? 1 : 0,
        );

        // Mark next ready set inside the same transaction.
        markNextReady(db, casRow.run_id, now);

        // M8 stub: spawn children. M10 stub: maybe finalise run.
        spawnChildren(db, casRow.id, validation.value, now);
        maybeFinaliseRun(db, casRow.run_id, now);

        db.exec("COMMIT");
      }
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // ignore
      }
      throw err;
    }

    if (casRow === undefined) {
      const errBody: Err = { ok: false, errors: ["claim_lost"] };
      return c.json(errBody, 200);
    }

    const okBody: Ok<SubmitOkData> = {
      ok: true,
      data: { run_id: casRow.run_id },
    };
    return c.json(okBody, 200);
  });

  return app;
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
 * 128 bits of entropy (16 random bytes, base64url-encoded). Exported for
 * tests so harnesses can match its shape.
 */
export function freshClaimToken(): string {
  return `c_${randomBytes(16).toString("base64url")}`;
}

/**
 * Truncate a JSON payload to {@link AUDIT_PAYLOAD_LIMIT_BYTES} bytes,
 * reporting whether truncation actually happened. Encoding is UTF-8.
 *
 * SQLite's TEXT type is byte-counted; we compare bytes, not code points.
 */
function truncatePayload(text: string): {
  text: string;
  truncated: boolean;
} {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= AUDIT_PAYLOAD_LIMIT_BYTES) {
    return { text, truncated: false };
  }
  // Slice on a byte boundary, then decode with replacement so we don't
  // emit a half-character at the cut point.
  const truncated = buf
    .subarray(0, AUDIT_PAYLOAD_LIMIT_BYTES)
    .toString("utf8");
  return { text: truncated, truncated: true };
}

/**
 * Read and parse a run's pipeline def, returning `null` if the run or
 * pipeline cannot be located (a hard error in production — surfaces as
 * 500 to the agent). Exported for tests.
 */
export function readPipelineDef(
  runId: string,
  stmt: Database.Statement,
): PipelineDefRow | null {
  const row = stmt.get(runId) as { def_json: string } | undefined;
  if (row === undefined) return null;
  try {
    return JSON.parse(row.def_json) as PipelineDefRow;
  } catch {
    return null;
  }
}

/**
 * Lookup the run's `subtask_def` → `{instructions, output_schema, input}`
 * tuple by reading `pipelines.def_json`. Used after a successful claim to
 * project the agent-facing payload.
 *
 * @returns the projected payload, or `null` if the pipeline def cannot be
 *   located or the subtask def is not in it (which would indicate schema
 *   drift between when the run started and now — a hard error in a real
 *   deployment, surfaced here as a null so the route can return 500).
 */
export function projectClaimPayload(
  runId: string,
  subtaskId: string,
  inputJson: string,
  claimToken: string,
  stmt: Database.Statement,
): NextWorkData | null {
  const def = readPipelineDef(runId, stmt);
  if (def === null) return null;
  const subtask = def.subtasks.find((s) => s.id === subtaskId);
  if (
    subtask === undefined ||
    subtask.instructions === undefined ||
    subtask.output_schema === undefined
  ) {
    return null;
  }
  let input: unknown = {};
  try {
    input = JSON.parse(inputJson);
  } catch {
    input = {};
  }
  return {
    instructions: subtask.instructions,
    input,
    output_schema: subtask.output_schema,
    claim: claimToken,
  };
}

