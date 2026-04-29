import { Hono } from "hono";

import type { Err } from "@murmur/contracts-types";

/**
 * Build the Murmur HTTP application.
 *
 * Routes:
 *   - `GET  /health` → `200 { ok: true }`
 *   - everything else → `404 { ok: false, errors: ["not_found"] }`
 *
 * The factory is pure: it creates and returns a Hono instance with no side
 * effects (no `serve`, no `listen`, no env reads). `src/index.ts` is responsible
 * for binding it to a port. Keeping the app pure makes it trivial to exercise
 * with `app.request(...)` in unit tests without opening a real socket.
 *
 * The 404 body is typed against `Err` from `@murmur/contracts-types` so any
 * future drift from the canonical envelope shape (per `docs/contracts.md` §4)
 * is caught at compile time rather than slipping through.
 */
export function createServer(): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

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
