/**
 * `GET /runs/{run_id}` and `GET /runs` route handlers.
 *
 * `GET /runs/{run_id}` returns the publisher-facing run status: the
 * run's current status, its final output (when completed), and the
 * per-subtask audit trail. Each `agent_actions` row's
 * `args_json`/`response_json` payloads are truncated per `./truncate.ts`
 * so the response stays scannable for a long-running pipeline.
 *
 * `GET /runs` lists runs filtered by `status`, `pipeline_id`, and
 * arbitrary `initial_input.<field>` equality predicates against the
 * `initial_input_json` blob, paginated by `limit`/`offset`. See the
 * companion section in `docs/contracts.md`.
 *
 * @see DESIGN.md §3.2 — GET /runs/{run_id}
 * @see colophon-group/murmur#76 — GET /runs (list)
 */

import type Database from "better-sqlite3";
import type { Hono } from "hono";

import type { Err, Ok } from "@murmur/contracts-types";

import {
  AGENT_ACTION_PAYLOAD_CAP_BYTES,
  truncatePayload,
} from "./truncate.js";

/**
 * One audit-log entry returned in `GET /runs/{run_id}`.
 *
 * Payload fields are clipped to {@link AGENT_ACTION_PAYLOAD_CAP_BYTES}
 * with a {@link TRUNCATION_MARKER} suffix when oversize.
 */
export interface AgentActionView {
  readonly id: number;
  readonly instance_id: string;
  readonly subtask_id: string;
  readonly ts: string;
  readonly kind: string;
  readonly subcommand: string | null;
  readonly args_json: string | null;
  readonly response_json: string | null;
  readonly truncated: boolean;
}

/**
 * Body shape returned by `GET /runs/{run_id}` on success.
 *
 * `final_output` is present iff `status === 'completed'`; `agent_actions`
 * is always present (empty array when the run has no actions yet).
 */
export interface RunStatusView {
  readonly run_id: string;
  readonly pipeline_id: string;
  readonly pipeline_version: number;
  readonly status: string;
  readonly final_output?: unknown;
  /**
   * One of `pending`, `delivered`, `failed`, or `null` when the run is
   * still in-flight or webhook delivery has not been attempted yet
   * (M10). The column is NULL on creation and transitions
   * `null → pending → delivered | failed`.
   */
  readonly webhook_status: string | null;
  readonly agent_actions: ReadonlyArray<AgentActionView>;
}

/** Shape of the `runs` row we read. */
interface RunRow {
  readonly id: string;
  readonly pipeline_id: string;
  readonly pipeline_version: number;
  readonly status: string;
  readonly final_output_json: string | null;
  readonly webhook_status: string | null;
}

/** Shape of the joined `agent_actions` row we read. */
interface AgentActionRow {
  readonly id: number;
  readonly instance_id: string;
  readonly subtask_id: string;
  readonly ts: string;
  readonly kind: string;
  readonly subcommand: string | null;
  readonly args_json: string | null;
  readonly response_json: string | null;
  readonly truncated: number;
}

/**
 * One row returned by `GET /runs`. A trimmed projection of `runs` —
 * just enough for an agent to disambiguate a natural-language request
 * (e.g. *"add Stripe to jobseek"*) into a concrete `run_id`.
 */
export interface RunListItem {
  readonly run_id: string;
  readonly pipeline_id: string;
  readonly status: string;
  readonly initial_input: unknown;
  readonly created_at: string;
  readonly webhook_status: string | null;
}

/**
 * Body shape returned by `GET /runs` on success. Empty `runs` array
 * is the documented "no matches" outcome — never 404.
 */
export interface RunListView {
  readonly runs: ReadonlyArray<RunListItem>;
}

/**
 * Hard server-side cap on `?limit=`. Callers asking for more silently
 * receive at most this many rows. Sized for the demo: a single user's
 * pending-run carousel never exceeds a handful.
 */
export const RUN_LIST_MAX_LIMIT = 100;

/**
 * Default `?limit=` when the caller omits the param.
 */
export const RUN_LIST_DEFAULT_LIMIT = 25;

/**
 * Whitelist regex for the `<field>` segment of an
 * `initial_input.<field>=<value>` query param. The field name is
 * interpolated (with the `$.` JSON-Pointer prefix) into the SQL via
 * `JSON_EXTRACT`, so anything outside this charset would open the
 * door to SQL injection. The value side stays bound.
 */
export const RUN_LIST_INITIAL_INPUT_FIELD_RE = /^[A-Za-z0-9_]+$/;

/**
 * Mount the `GET /runs/{run_id}` route onto the given Hono sub-app.
 *
 * Routes:
 *   - `GET /runs/{run_id}`
 *     • 200 `{ ok: true, data: RunStatusView }` on success.
 *     • 404 `{ ok: false, errors: ["run_not_found"] }` if unknown.
 *
 * @param app the sub-app to mount onto.
 * @param db the open SQLite handle.
 */
export function mountRunRoutes(app: Hono, db: Database.Database): void {
  const selectRun = db.prepare(
    `SELECT id, pipeline_id, pipeline_version, status, final_output_json,
            webhook_status
       FROM runs WHERE id = ?`,
  );
  // Join through subtask_instances so the audit row carries `subtask_id`
  // — agent_actions itself only knows `instance_id`. Order primarily by
  // `ts ASC` per issue #17 (the audit-trail consumer reads
  // chronologically); fall back to `id ASC` so two rows logged in the
  // same millisecond keep insertion order.
  const selectActions = db.prepare(
    `SELECT a.id, a.instance_id, i.subtask_id, a.ts, a.kind, a.subcommand,
            a.args_json, a.response_json, a.truncated
       FROM agent_actions a
       JOIN subtask_instances i ON i.id = a.instance_id
      WHERE i.run_id = ?
      ORDER BY a.ts ASC, a.id ASC`,
  );

  mountRunListRoute(app, db);

  app.get("/runs/:run_id", (c) => {
    const runId = c.req.param("run_id");
    if (runId === undefined || runId === "") {
      const err: Err = { ok: false, errors: ["run_id_required"] };
      return c.json(err, 400);
    }
    const row = selectRun.get(runId) as RunRow | undefined;
    if (row === undefined) {
      const err: Err = { ok: false, errors: ["run_not_found"] };
      return c.json(err, 404);
    }

    const actionRows = selectActions.all(runId) as ReadonlyArray<AgentActionRow>;
    const agent_actions: AgentActionView[] = [];
    for (const a of actionRows) {
      const args = truncatePayload(a.args_json, AGENT_ACTION_PAYLOAD_CAP_BYTES);
      const resp = truncatePayload(
        a.response_json,
        AGENT_ACTION_PAYLOAD_CAP_BYTES,
      );
      agent_actions.push({
        id: a.id,
        instance_id: a.instance_id,
        subtask_id: a.subtask_id,
        ts: a.ts,
        kind: a.kind,
        subcommand: a.subcommand,
        args_json: args.text,
        response_json: resp.text,
        // The DB-side `truncated` flag is set when M5+ writes oversize
        // payloads (capped at 4 KB); we OR it with our read-time flag so
        // either kind of truncation surfaces to the caller.
        truncated:
          a.truncated > 0 || args.truncated || resp.truncated,
      });
    }

    const view: RunStatusView = row.final_output_json !== null
      ? {
          run_id: row.id,
          pipeline_id: row.pipeline_id,
          pipeline_version: row.pipeline_version,
          status: row.status,
          final_output: JSON.parse(row.final_output_json) as unknown,
          webhook_status: row.webhook_status,
          agent_actions,
        }
      : {
          run_id: row.id,
          pipeline_id: row.pipeline_id,
          pipeline_version: row.pipeline_version,
          status: row.status,
          webhook_status: row.webhook_status,
          agent_actions,
        };
    const ok: Ok<RunStatusView> = { ok: true, data: view };
    return c.json(ok, 200);
  });
}

/**
 * Mount the `GET /runs` (list) route onto the given Hono sub-app.
 *
 * Query params (all optional):
 *   - `status` — exact match against `runs.status`.
 *   - `pipeline_id` — exact match.
 *   - `initial_input.<field>` — equality against
 *     `JSON_EXTRACT(initial_input_json, '$.<field>')`. `<field>` MUST
 *     match {@link RUN_LIST_INITIAL_INPUT_FIELD_RE}; otherwise 400.
 *     Multiple `initial_input.*` params are AND-combined.
 *   - `limit` — integer in `[1, RUN_LIST_MAX_LIMIT]`. Values above the
 *     cap are clamped silently. Default {@link RUN_LIST_DEFAULT_LIMIT}.
 *   - `offset` — non-negative integer. Default 0.
 *
 * Response:
 *   - 200 `{ ok: true, data: { runs: RunListItem[] } }`. `runs` may be
 *     empty (NEVER 404 on an empty result set).
 *   - 400 `{ ok: false, errors: [...] }` on malformed params.
 *
 * Auth is inherited from the bearer-auth middleware mounted at the
 * server root by `createServer`; this handler does not re-check.
 *
 * @param app the publisher sub-app.
 * @param db the open SQLite handle.
 */
export function mountRunListRoute(app: Hono, db: Database.Database): void {
  app.get("/runs", (c) => {
    // Hono returns query params as Record<string, string> for first-only
    // wins; that's fine for our scalar params. We re-read the URL when we
    // need to walk the full set of `initial_input.*` keys.
    const url = new URL(c.req.url);
    const params = url.searchParams;

    // --- Numeric params -----------------------------------------------
    const limitRaw = params.get("limit");
    let limit = RUN_LIST_DEFAULT_LIMIT;
    if (limitRaw !== null) {
      const parsed = parseStrictInt(limitRaw);
      if (parsed === null || parsed < 1) {
        const err: Err = { ok: false, errors: ["limit_invalid"] };
        return c.json(err, 400);
      }
      // Silent clamp at the server-side cap (per issue scope).
      limit = Math.min(parsed, RUN_LIST_MAX_LIMIT);
    }

    const offsetRaw = params.get("offset");
    let offset = 0;
    if (offsetRaw !== null) {
      const parsed = parseStrictInt(offsetRaw);
      if (parsed === null || parsed < 0) {
        const err: Err = { ok: false, errors: ["offset_invalid"] };
        return c.json(err, 400);
      }
      offset = parsed;
    }

    // --- Filter params ------------------------------------------------
    const wherePieces: string[] = [];
    const bindings: Array<string | number> = [];

    const status = params.get("status");
    if (status !== null && status.length > 0) {
      wherePieces.push("status = ?");
      bindings.push(status);
    }

    const pipelineId = params.get("pipeline_id");
    if (pipelineId !== null && pipelineId.length > 0) {
      wherePieces.push("pipeline_id = ?");
      bindings.push(pipelineId);
    }

    // initial_input.<field>=<value> — collected by walking every query
    // key. Multiple entries AND-combine.
    for (const [key, value] of params.entries()) {
      if (!key.startsWith("initial_input.")) continue;
      const field = key.slice("initial_input.".length);
      if (!RUN_LIST_INITIAL_INPUT_FIELD_RE.test(field)) {
        const err: Err = {
          ok: false,
          errors: [`initial_input_field_invalid:${field}`],
        };
        return c.json(err, 400);
      }
      // The field name is interpolated into the SQL string; the value
      // stays bound. The regex above is the SQL-injection guard.
      wherePieces.push(
        `JSON_EXTRACT(initial_input_json, '$.${field}') = ?`,
      );
      bindings.push(value);
    }

    // --- Build + run query --------------------------------------------
    const whereSql =
      wherePieces.length > 0 ? ` WHERE ${wherePieces.join(" AND ")}` : "";
    const sql =
      `SELECT id, pipeline_id, status, initial_input_json, created_at,` +
      ` webhook_status FROM runs${whereSql} ORDER BY created_at DESC,` +
      ` id ASC LIMIT ? OFFSET ?`;
    bindings.push(limit, offset);

    interface Row {
      readonly id: string;
      readonly pipeline_id: string;
      readonly status: string;
      readonly initial_input_json: string;
      readonly created_at: string;
      readonly webhook_status: string | null;
    }
    // `prepare` is not cached because the SQL shape varies with the
    // filter set; the prepare cost is negligible at demo scale and the
    // alternative (cache by SQL string) adds complexity without benefit.
    const rows = db.prepare(sql).all(...bindings) as ReadonlyArray<Row>;

    const runs: RunListItem[] = rows.map((row) => ({
      run_id: row.id,
      pipeline_id: row.pipeline_id,
      status: row.status,
      initial_input: JSON.parse(row.initial_input_json) as unknown,
      created_at: row.created_at,
      webhook_status: row.webhook_status,
    }));

    const ok: Ok<RunListView> = { ok: true, data: { runs } };
    return c.json(ok, 200);
  });
}

/**
 * Strict integer parser: rejects floats, scientific notation, leading
 * `+`, whitespace, and any string that doesn't round-trip through
 * `String(parseInt(...))`. Returns `null` on bad input.
 */
function parseStrictInt(raw: string): number | null {
  if (!/^-?\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  return n;
}
