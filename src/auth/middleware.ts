/**
 * Hono middleware: `Authorization: Bearer <MURMUR_TOKEN>` gate.
 *
 * Demo-grade auth per DESIGN.md §3.6. One shared bearer token gates every
 * Murmur endpoint (publisher API + MCP transport). `/health` is the single
 * documented bypass — used by the load balancer / Cloudflare Tunnel for
 * unauthenticated liveness checks.
 *
 * **Constant-time guarantee.** Token comparison uses `crypto.timingSafeEqual`.
 * If the supplied token's byte length differs from the env token's, we still
 * call `timingSafeEqual` against a fixed-length dummy buffer of the env-token
 * length, then return 401 unconditionally. This closes a length-based timing
 * oracle (early-return-on-length-mismatch is observable).
 *
 * **Why no `===` anywhere in this module.** The `grep-no-naked-eq-in-auth`
 * gate fails on `===`/`!==` inside `src/auth/`. All comparisons here are
 * flag-tests (`if (foo)`) or constant-time buffer comparisons.
 *
 * @see docs/contracts.md §3 — Proxy header set
 * @see DESIGN.md §3.6 — Demo-grade auth
 */

import type { MiddlewareHandler } from "hono";

import type { Err } from "@murmur/contracts-types";

/**
 * Construct a Hono middleware that enforces `Authorization: Bearer <token>`
 * on every request except `GET /health`.
 *
 * Contract:
 *   - `/health` (any method) → bypass auth entirely (next handler runs).
 *   - Missing `Authorization` header → 401 `{ ok: false, errors: ["unauthorized"] }`.
 *   - Header does not begin with `"Bearer "` (case-sensitive prefix) → 401.
 *   - Token bytes differ from `envToken` (constant-time compare) → 401.
 *   - Token bytes match `envToken` exactly → call `next()`.
 *
 * The 401 body is typed against `Err` from `@murmur/contracts-types` so any
 * drift from the canonical envelope shape (per `docs/contracts.md` §4) is
 * caught at compile time.
 *
 * @param envToken the boot-loaded `MURMUR_TOKEN` as a UTF-8 buffer. Pass by
 *   value (not by closure over `process.env`) so the middleware is pure and
 *   testable. Empty buffers MUST be rejected by the caller (see
 *   `readMurmurTokenFromEnv` in `src/index.ts`); this function does not
 *   re-validate the env-token shape.
 * @returns a `MiddlewareHandler` ready to be passed to `app.use('*', …)`.
 */
export function bearerAuth(_envToken: Buffer): MiddlewareHandler {
  throw new Error("not implemented");
}

/**
 * The canonical 401 body. Exported for tests (and would-be future routes
 * that need to emit the same shape) so the literal lives in exactly one
 * place. Typed as `Err` to lock the envelope shape.
 */
export const UNAUTHORIZED_BODY: Err = {
  ok: false,
  errors: ["unauthorized"],
};
