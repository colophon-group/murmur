/**
 * `GET /runs/{run_id}` route handler.
 *
 * Returns the publisher-facing run status: the run's current status,
 * its final output (when completed), and the per-subtask audit trail.
 * Each `agent_actions` row's `args_json`/`response_json` payloads are
 * truncated per `./truncate.ts` so the response stays scannable for a
 * long-running pipeline.
 *
 * @see DESIGN.md §3.2 — GET /runs/{run_id}
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
  readonly agent_actions: ReadonlyArray<AgentActionView>;
}

/** Shape of the `runs` row we read. */
interface RunRow {
  readonly id: string;
  readonly pipeline_id: string;
  readonly pipeline_version: number;
  readonly status: string;
  readonly final_output_json: string | null;
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
    `SELECT id, pipeline_id, pipeline_version, status, final_output_json
       FROM runs WHERE id = ?`,
  );
  // Join through subtask_instances so the audit row carries `subtask_id`
  // — agent_actions itself only knows `instance_id`.
  const selectActions = db.prepare(
    `SELECT a.id, a.instance_id, i.subtask_id, a.ts, a.kind, a.subcommand,
            a.args_json, a.response_json, a.truncated
       FROM agent_actions a
       JOIN subtask_instances i ON i.id = a.instance_id
      WHERE i.run_id = ?
      ORDER BY a.id ASC`,
  );

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
          agent_actions,
        }
      : {
          run_id: row.id,
          pipeline_id: row.pipeline_id,
          pipeline_version: row.pipeline_version,
          status: row.status,
          agent_actions,
        };
    const ok: Ok<RunStatusView> = { ok: true, data: view };
    return c.json(ok, 200);
  });
}
