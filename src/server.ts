import type Database from "better-sqlite3";
import { Hono } from "hono";

import type { Err } from "@murmur/contracts-types";

import { bearerAuth } from "./auth/index.js";
import { createPublisherApp } from "./api/publisher/index.js";

/**
 * Options accepted by `createServer`.
 *
 * The factory remains pure (no env reads) — the caller is responsible for
 * loading `MURMUR_TOKEN` once at boot and passing the resulting buffer in.
 */
export interface CreateServerOptions {
  /**
   * The boot-loaded `MURMUR_TOKEN` as a UTF-8 buffer. Used by the bearer-auth
   * middleware to constant-time-compare incoming tokens. See
   * `src/auth/middleware.ts` for the comparison contract.
   *
   * MUST be a non-empty buffer; the caller (typically `readMurmurTokenFromEnv`
   * in `src/index.ts`) is responsible for rejecting empty/unset env values
   * before calling `createServer`.
   */
  token: Buffer;
  /**
   * Open SQLite handle. When supplied, the publisher sub-app
   * (`src/api/publisher`) is mounted and serves `POST /pipelines`,
   * `POST /pipelines/{id}/runs`, and `GET /runs/{run_id}`. When omitted,
   * the publisher routes are absent and any request to those paths falls
   * through to the 404 handler (e.g. tests that only exercise auth).
   *
   * The factory does NOT take ownership — callers are responsible for
   * lifecycle. Migrations MUST have been run on the handle before
   * `createServer` is called; the publisher sub-app assumes the schema
   * is already in place.
   */
  db?: Database.Database;
}

/**
 * Build the Murmur HTTP application.
 *
 * Routes:
 *   - `GET  /health` → `200 { ok: true }` (bypasses auth — see DESIGN.md §3.6).
 *   - All other requests are gated by `bearerAuth(token)`. On auth failure
 *     the middleware returns `401 { ok: false, errors: ["unauthorized"] }`.
 *   - 404 fallback (after auth) → `404 { ok: false, errors: ["not_found"] }`.
 *
 * The factory is pure: it creates and returns a Hono instance with no side
 * effects (no `serve`, no `listen`, no env reads). `src/index.ts` is responsible
 * for binding it to a port. Keeping the app pure makes it trivial to exercise
 * with `app.request(...)` in unit tests without opening a real socket.
 *
 * Both error bodies are typed against `Err` from `@murmur/contracts-types` so
 * any future drift from the canonical envelope shape (per `docs/contracts.md`
 * §4) is caught at compile time rather than slipping through.
 */
export function createServer(options: CreateServerOptions): Hono {
  const app = new Hono();

  // Mount the bearer-auth middleware BEFORE any business routes. The
  // middleware itself short-circuits on `/health` so the load balancer can
  // hit liveness without a token — DESIGN.md §3.6 explicitly carves this out.
  app.use("*", bearerAuth(options.token));

  app.get("/health", (c) => c.json({ ok: true }));

  // Publisher sub-app: registered only when a DB handle was supplied.
  // The sub-app exposes `POST /pipelines`, `POST /pipelines/{id}/runs`,
  // and `GET /runs/{run_id}`. Mounted at `/` because each route owns
  // its own absolute path; bearer-auth above the mount applies. See
  // `src/api/publisher/index.ts`.
  if (options.db !== undefined) {
    const publisher = createPublisherApp({ db: options.db });
    app.route("/", publisher);
  }

  // 404 fallback. The body conforms to M0's `Err` envelope shape:
  // `{ ok: false, errors: ["not_found"] }`. The string-token form is the
  // canonical shape for non-validation errors per `docs/contracts.md` §4.
  // Typed as `Err` so any drift from the envelope shape fails `tsc`.
  app.notFound((c) => {
    const body: Err = {
      ok: false,
      errors: ["not_found"],
    };
    return c.json(body, 404);
  });

  return app;
}
