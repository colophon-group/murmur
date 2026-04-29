/**
 * Publisher sub-app — three publisher-facing endpoints.
 *
 * Routes (DESIGN.md §3.2):
 *   - `POST /pipelines`               — register/upsert a pipeline def.
 *   - `POST /pipelines/{id}/runs`     — start a run.
 *   - `GET  /runs/{run_id}`           — poll run state + audit log.
 *
 * The sub-app is mounted by `src/server.ts`. All three routes inherit
 * the bearer-auth middleware installed at the root of the main app
 * (`/health` is the only carve-out). This module's factory does NOT
 * install auth itself — composing auth twice would be wrong.
 *
 * The factory takes a `db` handle by injection so the same code is
 * exercisable in tests with `:memory:` and in production with a
 * file-backed DB. There is no module-level singleton.
 */

import type Database from "better-sqlite3";
import { Hono } from "hono";

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
 * @returns a Hono instance with the three routes registered. Mount it
 *   onto the main app with `app.route("/", publisherApp)` (the routes
 *   carry their own absolute-style paths under `/`).
 */
export function createPublisherApp(options: CreatePublisherAppOptions): Hono {
  // Sub-app composition; the actual route bodies live in the sibling
  // modules. Each `mount*` function attaches its routes to this Hono
  // instance.
  const app = new Hono();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- wired by mount fns once interfaces are filled in
  const _db = options.db;
  // Implementations land in step 6.
  return app;
}
