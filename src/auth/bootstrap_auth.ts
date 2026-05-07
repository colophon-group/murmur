/**
 * Hono middleware: bootstrap-token gate for `POST /publishers` (M1, issue #81).
 *
 * `POST /publishers` is the only endpoint that creates a brand-new
 * publisher row + its initial admin token. It can't be gated by
 * `publisherAuth` (chicken-and-egg — the publisher doesn't exist yet) so
 * we use a separate deployment-wide secret loaded from
 * `MURMUR_BOOTSTRAP_TOKEN`.
 *
 * **Why a separate secret.** Reusing `MURMUR_TOKEN` for bootstrap would
 * couple "I can trigger demo runs" with "I can mint new publishers" —
 * any leak escalates. A distinct env var is rotated independently and
 * scoped to operator hands.
 *
 * **Constant-time compare.** We use `crypto.timingSafeEqual` against a
 * length-padded buffer, identical pattern to `bearerAuth` in
 * `./middleware.ts`. Length-mismatch path still calls `timingSafeEqual`
 * against a dummy so the wall-clock cost is independent of input length.
 *
 * **Why no `===` / `!==`.** Same `grep-no-naked-eq-in-auth` constraint
 * as the rest of `src/auth/`. Length-flag tests + `!x` patterns.
 *
 * @see src/api/publisher/admin.ts — the bootstrap handler
 * @see DESIGN.md §3.6 — auth model
 */

import { timingSafeEqual } from "node:crypto";

import type { MiddlewareHandler } from "hono";

import { AUTHORIZATION } from "@murmur/contracts-types";

import { unauthorized } from "./publisher_auth.js";

/** Required prefix on the `Authorization` header value. */
const BEARER_PREFIX = "Bearer ";

/**
 * Construct a bootstrap-auth middleware that enforces
 * `Authorization: Bearer <MURMUR_BOOTSTRAP_TOKEN>`.
 *
 * @param bootstrapToken the boot-loaded `MURMUR_BOOTSTRAP_TOKEN` as a
 *   UTF-8 buffer. Empty buffers are rejected by the caller (see
 *   `readBootstrapTokenFromEnv` in `src/index.ts`); this function does
 *   not re-validate the token shape.
 * @returns a `MiddlewareHandler` to mount on `POST /publishers`.
 */
export function bootstrapAuth(bootstrapToken: Buffer): MiddlewareHandler {
  // Pre-allocate a fixed-length dummy used by the length-mismatch path.
  // Identical pattern to legacy `bearerAuth` so timing behaves uniformly.
  const dummy = Buffer.alloc(bootstrapToken.length, 0);

  return async (c, next) => {
    const header = c.req.header(AUTHORIZATION);
    if (!header) {
      return unauthorized(c);
    }
    if (!header.startsWith(BEARER_PREFIX)) {
      return unauthorized(c);
    }

    const candidate = header.slice(BEARER_PREFIX.length);
    if (candidate.length < 1) {
      return unauthorized(c);
    }
    const candidateBuf = Buffer.from(candidate, "utf8");

    const sameLength =
      !(candidateBuf.length < bootstrapToken.length) &&
      !(candidateBuf.length > bootstrapToken.length);

    if (!sameLength) {
      timingSafeEqual(dummy, dummy);
      return unauthorized(c);
    }

    if (!timingSafeEqual(candidateBuf, bootstrapToken)) {
      return unauthorized(c);
    }

    await next();
  };
}

/**
 * Read `MURMUR_BOOTSTRAP_TOKEN` from a `process.env`-shaped object as a
 * UTF-8 Buffer. Returns `undefined` when the var is unset or empty so
 * the caller can decide whether to mount the bootstrap route at all
 * (deployments without an operator-bootstrap-capable env simply skip
 * the route — and `POST /publishers` 404s).
 *
 * Pure function; takes `env` as input rather than reading
 * `process.env`.
 */
export function readBootstrapTokenFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): Buffer | undefined {
  const raw = env["MURMUR_BOOTSTRAP_TOKEN"];
  if (!raw) {
    return undefined;
  }
  return Buffer.from(raw, "utf8");
}

