import { Hono } from "hono";

/**
 * Build the Murmur HTTP application.
 *
 * Routes:
 *   - `GET  /health` → `200 { ok: true }`
 *   - everything else → `404 { ok: false, errors: [{ code: "not_found", message }] }`
 *
 * The factory is pure: it creates and returns a Hono instance with no side
 * effects (no `serve`, no `listen`, no env reads). `src/index.ts` is responsible
 * for binding it to a port. Keeping the app pure makes it trivial to exercise
 * with `app.request(...)` in unit tests without opening a real socket.
 */
export function createServer(): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  // 404 fallback. The body conforms to M0's response envelope shape:
  // `{ ok: false, errors: [...] }`. See docs/contracts.md §4.4.
  app.notFound((c) =>
    c.json(
      {
        ok: false,
        errors: [
          {
            code: "not_found",
            message: `No route matches ${c.req.method} ${c.req.path}`,
          },
        ],
      },
      404,
    ),
  );

  return app;
}
