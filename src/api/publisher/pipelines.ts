/**
 * `POST /pipelines` and `POST /pipelines/{id}/runs` route handlers.
 *
 * These mount onto the publisher sub-app from `./index.ts`. Both routes
 * sit behind the bearer-auth middleware installed in `src/server.ts`;
 * this module assumes auth has already passed when its handlers run.
 *
 * @see DESIGN.md §3.2 — POST /pipelines, POST /pipelines/{id}/runs
 */

import type Database from "better-sqlite3";
import type { Hono } from "hono";

/**
 * Maximum body size accepted by `POST /pipelines`. Anything larger is
 * rejected with `413 { ok: false, errors: ["payload_too_large"] }` BEFORE
 * the body is parsed as YAML — both to short-circuit obvious abuse and
 * to keep the YAML parser from chewing through pathological inputs.
 */
export const PIPELINE_BODY_BYTE_CAP = 5 * 1024 * 1024;

/**
 * Mount the pipeline-registration and run-creation routes onto the given
 * Hono sub-app.
 *
 * Routes registered (relative to the sub-app's mount point):
 *   - `POST /pipelines` — register/upsert a pipeline def.
 *     • body: `{ id, def_yaml }` (`def_yaml` is a YAML string).
 *     • 200 `{ ok: true, data: { id } }` on success.
 *     • 400 `{ ok: false, errors: ["yaml:<msg>"] }` on YAML parse failure.
 *     • 400 `{ ok: false, errors: ["validation:/path:msg", ...] }` on
 *       JSON Schema shape failures (one per offending path).
 *     • 413 `{ ok: false, errors: ["payload_too_large"] }` on >5 MB.
 *     • Last-write-wins on `id` collision (UPSERT, version bumped).
 *
 *   - `POST /pipelines/{id}/runs` — start a run.
 *     • body: `{ initial_input }`.
 *     • 200 `{ ok: true, data: { run_id } }` on success.
 *     • 404 `{ ok: false, errors: ["pipeline_not_found"] }` if `id` is
 *       unknown.
 *     • 400 `{ ok: false, errors: ["validation:/path:msg", ...] }` if
 *       `initial_input` fails the pipeline's `initial_input` schema.
 *
 * @param app the sub-app to mount onto (the publisher Hono).
 * @param db the open SQLite handle (from `openDb`).
 */
export function mountPipelineRoutes(app: Hono, db: Database.Database): void {
  throw new Error("not implemented");
}
