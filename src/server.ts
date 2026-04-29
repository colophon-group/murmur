import type { Hono } from "hono";

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
 *
 * @returns a Hono instance ready to be served.
 */
export declare function createServer(): Hono;
