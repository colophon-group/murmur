import type Database from "better-sqlite3";
import { Hono } from "hono";

import type { Err } from "@murmur/contracts-types";

import { createAgentApp } from "./api/agent/index.js";
import { createPublisherApp } from "./api/publisher/index.js";
import { bearerAuth } from "./auth/index.js";
import { log } from "./logger.js";
import { createMcpRoute } from "./mcp/server.js";
import { deliverWebhook } from "./webhook.js";

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
   * Optional open `better-sqlite3` handle. When supplied, both the publisher
   * sub-app (`src/api/publisher` — `POST /pipelines`, `POST /pipelines/{id}/runs`,
   * `GET /runs/{run_id}`) and the agent sub-app (`src/api/agent` — `GET /work/next`,
   * `POST /work/{claim_token}/result`) are mounted on top of the bearer-auth gate.
   * Tests that only exercise auth/health may omit it; in that case both sub-apps
   * are absent and any request to their paths falls through to the 404 handler.
   *
   * The factory does NOT take ownership — callers are responsible for the
   * connection's lifecycle. Migrations MUST have been run on the handle
   * before `createServer` is called; both sub-apps assume the schema is
   * already in place.
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

  // Sub-apps: registered only when a DB handle was supplied. Both inherit the
  // bearer-auth gate installed above. Publisher at `/` (each route owns its
  // own absolute path); agent at `/work` (DESIGN.md §3.3).
  if (options.db !== undefined) {
    const publisher = createPublisherApp({ db: options.db });
    app.route("/", publisher);
    // Construct the agent sub-app once and reuse it for both the HTTP
    // mount (`/work`) and the MCP transport (`/mcp`) — the MCP tool
    // handlers call this exact instance via `app.request(...)`,
    // sidestepping the network entirely (DESIGN.md §3.4 mounts both
    // surfaces on the same port; sharing the in-process app removes a
    // hop and a TLS round-trip).
    // Bind the webhook delivery hook with the boot-loaded bearer. The
    // factory is fire-and-forget per M10's "does not block submit_result
    // response" requirement; we swallow any throw inside the closure
    // because `deliverWebhook` already logs failures internally.
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
