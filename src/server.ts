import type Database from "better-sqlite3";
import { Hono } from "hono";

import type { Err } from "@murmur/contracts-types";

import { createAgentApp } from "./api/agent/index.js";
import { createAuthApp } from "./api/auth/index.js";
import { mountBootstrapRoutes } from "./api/publisher/admin.js";
import { createPublisherApp } from "./api/publisher/index.js";
import { bearerAuth } from "./auth/index.js";
import { bootstrapAuth } from "./auth/bootstrap_auth.js";
import { publisherAuth } from "./auth/publisher_auth.js";
import { log } from "./logger.js";
import { createMcpRoute } from "./mcp/server.js";
import { deliverWebhook } from "./webhook.js";

/**
 * Options accepted by `createServer`.
 *
 * The factory remains pure (no env reads) — the caller is responsible for
 * loading every secret once at boot and passing the resulting buffers /
 * handles in.
 */
export interface CreateServerOptions {
  /**
   * The boot-loaded `MURMUR_TOKEN` as a UTF-8 buffer. Used by the
   * legacy `bearerAuth` middleware that gates the agent surface
   * (`/work`, `/mcp`) — single-bearer model preserved until M2 splits
   * the agent plane. The publisher API is gated separately by
   * `publisherAuth(db)`.
   *
   * MUST be a non-empty buffer.
   */
  token: Buffer;
  /**
   * Optional open `better-sqlite3` handle. When supplied, the publisher
   * sub-apps (token-gated and bootstrap-gated) and the agent sub-app
   * are mounted; without it, only `/health` responds.
   *
   * Migrations + boot-seed MUST have been run on the handle before
   * `createServer` is called.
   */
  db?: Database.Database;
  /**
   * Optional `MURMUR_BOOTSTRAP_TOKEN` as a UTF-8 buffer. When supplied
   * AND `db` is supplied, mounts `POST /publishers` gated by this
   * token. Without it, `POST /publishers` 404s and operators must seed
   * publishers via direct DB access (or env-driven boot-seed for the
   * demo publisher).
   *
   * Distinct from `token`: bootstrapping a new publisher is an
   * out-of-band operator action; coupling it to the demo MURMUR_TOKEN
   * would mean any leak escalates to "mint arbitrary publishers".
   */
  bootstrapToken?: Buffer;
  /**
   * Optional `MURMUR_JWT_SECRET` as a UTF-8 buffer. When supplied AND
   * `db` is supplied, mounts the human-plane `/auth/*` routes
   * (`POST /auth/exchange`, `POST /auth/refresh`, `DELETE /auth/session`).
   * Without it, those routes 404. Used by the dashboard (M4) to
   * exchange a GitHub OAuth access_token for a Murmur session JWT.
   */
  jwtSecret?: Buffer;
}

/**
 * Build the Murmur HTTP application.
 *
 * Routes:
 *   - `GET  /health` — `200 { ok: true }` (unauthenticated).
 *   - `POST /publishers` — gated by `bootstrapAuth(bootstrapToken)`
 *     when supplied; mints a new publisher + initial admin token.
 *   - `POST /pipelines`, `POST /pipelines/{id}/runs`, `GET /runs/...`,
 *     `/publishers/me/...` — gated by `publisherAuth(db)`.
 *   - `/work/*`, `/mcp/*` — gated by legacy `bearerAuth(token)`.
 *   - 404 fallback returns `{ ok: false, errors: ["not_found"] }`.
 *
 * **Auth zoning.** Three middleware factories run on disjoint path
 * patterns:
 *   - `bootstrapAuth` on `POST /publishers` (route-level middleware).
 *   - `publisherAuth(db)` on `/pipelines*`, `/runs*`, `/publishers/me*`.
 *   - `bearerAuth(token)` on `/work*`, `/mcp*`.
 *
 * Path-scoped `app.use(...)` is preferred over sub-app `use("*")` so
 * routing prefix matches stay clean (a sub-app mounted at `/` would
 * intercept every request before the more-specific `/work` and `/mcp`
 * sub-apps could).
 */
export function createServer(options: CreateServerOptions): Hono {
  const app = new Hono();

  // Health bypasses every gate (load balancer / Cloudflare Tunnel).
  app.get("/health", (c) => c.json({ ok: true }));

  if (options.db !== undefined) {
    // Auth zoning — register middleware FIRST, then routes. Hono runs
    // matching middleware in registration order; we rely on path
    // specificity, not registration order, for which middleware fires
    // on a given request.

    // Agent surface: legacy single-bearer.
    app.use("/work/*", bearerAuth(options.token));
    app.use("/mcp/*", bearerAuth(options.token));

    // Publisher API: token-DB-backed multi-tenant gate.
    app.use("/pipelines", publisherAuth(options.db));
    app.use("/pipelines/*", publisherAuth(options.db));
    app.use("/runs", publisherAuth(options.db));
    app.use("/runs/*", publisherAuth(options.db));
    // `/publishers/me*` covers `/publishers/me`, `/publishers/me/tokens/...`,
    // `/publishers/me/audit`. The bare `/publishers` path (POST bootstrap)
    // is NOT covered by this middleware — bootstrap has its own gate
    // installed below as route-level middleware.
    app.use("/publishers/me", publisherAuth(options.db));
    app.use("/publishers/me/*", publisherAuth(options.db));

    // Human-plane auth (M2, issue #82): /auth/* routes when
    // MURMUR_JWT_SECRET is supplied. Without the secret, the routes
    // are absent and any call gets a 404.
    if (options.jwtSecret !== undefined) {
      const authApp = createAuthApp({
        db: options.db,
        jwtSecret: options.jwtSecret,
      });
      app.route("/auth", authApp);
    }

    // Bootstrap: POST /publishers gated by MURMUR_BOOTSTRAP_TOKEN.
    // Path-scoped middleware via `app.use('/publishers', mw)` would
    // also intercept GET /publishers/me; instead, install bootstrapAuth
    // ONLY on POST /publishers via Hono's per-method route-level
    // middleware. We re-build the route here rather than reusing
    // mountBootstrapRoutes (which uses `app.post('/publishers', handler)`
    // without auth wiring) so the auth + handler are unified at one
    // call site.
    if (options.bootstrapToken !== undefined) {
      const bootstrapZone = new Hono();
      mountBootstrapRoutes(bootstrapZone, options.db);
      // Register `app.post('/publishers', ...)` with route-level
      // bootstrapAuth, then defer to the bootstrapZone's handler. The
      // simpler way: a thin pass-through that calls bootstrapZone's
      // matching route via app.request.
      app.post(
        "/publishers",
        bootstrapAuth(options.bootstrapToken),
        async (c) => {
          // Re-issue against the inner zone — the mounted handler does
          // the heavy lifting (parse, validate, mint, audit).
          const innerReq = new Request(
            new URL("/publishers", c.req.url).toString(),
            {
              method: "POST",
              headers: c.req.raw.headers,
              body: await c.req.raw.clone().arrayBuffer(),
            },
          );
          return bootstrapZone.fetch(innerReq);
        },
      );
    }

    // Publisher routes — pipelines, runs, /publishers/me/*.
    app.route("/", createPublisherApp({ db: options.db }));

    // Agent + MCP routes.
    const tokenForWebhook = options.token.toString("utf8");
    const dbForWebhook = options.db;
    const deliverWebhookFn = (runId: string): void => {
      void deliverWebhook(dbForWebhook, runId, {
        bearer: tokenForWebhook,
      }).catch((err: unknown) => {
        log.error("webhook.delivery_failed", {
          run_id: runId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    };
    const agent = createAgentApp({
      db: options.db,
      deliverWebhookFn,
    });
    app.route("/work", agent);
    app.route("/mcp", createMcpRoute({ agentApp: agent }));
  }

  // 404 fallback. The body conforms to M0's `Err` envelope shape.
  app.notFound((c) => {
    const body: Err = {
      ok: false,
      errors: ["not_found"],
    };
    return c.json(body, 404);
  });

  return app;
}
