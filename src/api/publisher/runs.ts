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
  throw new Error("not implemented");
}
