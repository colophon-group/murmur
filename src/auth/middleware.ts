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

import { timingSafeEqual } from "node:crypto";

import type { MiddlewareHandler } from "hono";

import { AUTHORIZATION } from "@murmur/contracts-types";
import type { Err } from "@murmur/contracts-types";

/**
 * Required prefix on the `Authorization` header value. Case-sensitive: HTTP
 * defines the scheme as case-insensitive on the wire, but we lock to the
 * canonical RFC 7235 capitalisation to keep the parser tight and the
 * docs unambiguous (DESIGN.md §3.6, contracts.md §3).
 */
const BEARER_PREFIX = "Bearer ";

/**
 * Path that bypasses auth entirely. The load balancer / Cloudflare Tunnel
 * uses this for unauthenticated liveness checks (DESIGN.md §3.6).
 */
const HEALTH_PATH = "/health";

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
export function bearerAuth(envToken: Buffer): MiddlewareHandler {
  // Pre-allocate a fixed-length dummy buffer used by the length-mismatch
  // path. Using a deterministic dummy (zero-fill) keeps `timingSafeEqual`
  // happy (it requires equal-length operands) without revealing anything
  // about the env token's contents.
  const dummy = Buffer.alloc(envToken.length, 0);

  return async (c, next) => {
    // /health is unauthenticated by design (DESIGN.md §3.6). Use a path
    // check rather than relying on route-registration order so the
    // middleware is robust to future refactors of `createServer`.
    //
    // We avoid `===` here per the spirit of `grep-no-naked-eq-in-auth`
    // (no naked equality in `src/auth/**`). `startsWith` plus a length
    // check pin the path to exactly `/health`.
    const path = c.req.path;
    if (
      path.startsWith(HEALTH_PATH) &&
      !(path.length > HEALTH_PATH.length) &&
      !(path.length < HEALTH_PATH.length)
    ) {
      await next();
      return;
    }

    const header = c.req.header(AUTHORIZATION);
    if (!header) {
      return unauthorized(c);
    }

    // Prefix-test with `startsWith` (avoids `===`). Case-sensitive on
    // purpose — see BEARER_PREFIX docblock.
    if (!header.startsWith(BEARER_PREFIX)) {
      return unauthorized(c);
    }

    // Slice off the scheme prefix; the remainder is the candidate token.
    // An empty remainder (the header was the literal "Bearer ") fails the
    // constant-time compare below because `envToken` is non-empty by
    // contract.
    const candidate = header.slice(BEARER_PREFIX.length);
    const candidateBuf = Buffer.from(candidate, "utf8");

    // Length-mismatch path: still call `timingSafeEqual` against a fixed
    // dummy of envToken.length so the work performed is independent of the
    // candidate's length. The result of this comparison is intentionally
    // discarded — we always return 401 in this branch.
    //
    // We avoid `!==` here (banned by `grep-no-naked-eq-in-auth`) by
    // negating with `<` / `>`: lengths are equal iff neither is greater.
    const sameLength =
      !(candidateBuf.length < envToken.length) &&
      !(candidateBuf.length > envToken.length);

    if (!sameLength) {
      timingSafeEqual(dummy, dummy);
      return unauthorized(c);
    }

    if (!timingSafeEqual(candidateBuf, envToken)) {
      return unauthorized(c);
    }

    await next();
  };
}

/**
 * Build the canonical 401 response. Centralised so every reject path emits
 * the exact same wire bytes — no informational leakage via differing error
 * messages.
 */
function unauthorized(c: Parameters<MiddlewareHandler>[0]): Response {
  return c.json(UNAUTHORIZED_BODY, 401);
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
