/**
 * Publisher sub-app — publisher-facing endpoints (machine plane).
 *
 * Routes:
 *   - `POST /pipelines`                             — register/upsert pipeline (admin).
 *   - `POST /pipelines/{id}/runs`                   — start a run (admin OR runner).
 *   - `GET  /runs/{run_id}`                         — poll run state (admin OR runner).
 *   - `GET  /runs`                                  — list runs (admin OR runner).
 *   - `GET  /publishers/me`                         — read publisher metadata (any).
 *   - `PATCH /publishers/me`                        — update display_name (admin).
 *   - `POST /publishers/me/tokens/:kind/rotate`     — mint new + revoke old (admin).
 *   - `DELETE /publishers/me/tokens/:kind/:id`      — revoke specific row (admin).
 *   - `GET  /publishers/me/audit`                   — read audit events (admin).
 *
 * The sub-app is mounted by `src/server.ts` under the `publisherAuth(db)`
 * middleware (M1, issue #81). Per-route scope is enforced via
 * `requireKind` / `requireAnyKind` calls inside each handler.
 *
 * The factory takes a `db` handle by injection so the same code is
 * exercisable in tests with `:memory:` and in production with a
 * file-backed DB. There is no module-level singleton.
 */

import type Database from "better-sqlite3";
import { Hono } from "hono";

import { mountAdminMeRoutes } from "./admin.js";
import { mountPipelineRoutes } from "./pipelines.js";
import { mountRunRoutes } from "./runs.js";

/**
 * Options accepted by {@link createPublisherApp}.
 */
export interface CreatePublisherAppOptions {
  /**
   * Open SQLite handle. The handle is borrowed — callers retain ownership
   * and are responsible for closing it. Migrations MUST have been run on
   * this handle before any request hits the sub-app; the sub-app does
   * not run migrations itself.
   */
  readonly db: Database.Database;
}

/**
 * Build the publisher sub-app.
 *
 * @param options see {@link CreatePublisherAppOptions}.
 * @returns a Hono instance with all publisher routes registered. Mount
 *   it onto the main app with `app.route("/", publisherApp)` (the routes
 *   carry their own absolute-style paths under `/`).
 */
export function createPublisherApp(options: CreatePublisherAppOptions): Hono {
  const app = new Hono();
  mountPipelineRoutes(app, options.db);
  mountRunRoutes(app, options.db);
  mountAdminMeRoutes(app, options.db);
  return app;
}
