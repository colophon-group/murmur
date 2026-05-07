/**
 * Hono middleware: JWT bearer auth for the human-plane (M2, issue #82).
 *
 * Co-exists with `bearerAuth` (legacy single-bearer for /work, /mcp)
 * and `publisherAuth` (machine-plane multi-tenant from M1). This
 * middleware gates routes that act on behalf of a human user (member
 * management, M3 HITL decisions, M4 dashboard reads).
 *
 * **Wire format.** `Authorization: Bearer <jwt>`. The JWT is signed
 * HS256 by `signJwt` in `./jwt.ts` using the boot-loaded
 * `MURMUR_JWT_SECRET`. The middleware verifies the signature, checks
 * `exp`, and looks up the user in the DB to enforce a soft-disable
 * (`users.disabled_at`).
 *
 * **Context vars set on success:**
 *   - `human_user_id` — the verified user_id from the JWT `sub`.
 *   - `human_memberships` — the per-publisher role grants snapshot.
 *
 * **No `===` / `!==` in this module.** Length-flag tests and `!x`
 * patterns to satisfy `grep-no-naked-eq-in-auth`.
 *
 * @see src/auth/jwt.ts — `signJwt` / `verifyJwt`
 * @see docs/auth.md — JWT shape + verifier
 */

import type Database from "better-sqlite3";
import type { Context, MiddlewareHandler } from "hono";

import { AUTHORIZATION } from "@murmur/contracts-types";

import { unauthorized } from "./publisher_auth.js";
import { verifyJwt, type JwtClaims, type JwtMembership } from "./jwt.js";

/** Required prefix on the `Authorization` header. */
const BEARER_PREFIX = "Bearer ";

// Hono module augmentation for typed `c.get(...)` on the human-plane
// context vars. Co-exists with the publisher_auth augmentation.
declare module "hono" {
  interface ContextVariableMap {
    human_user_id: string;
    human_memberships: ReadonlyArray<JwtMembership>;
  }
}

/**
 * Construct the JWT-bearer middleware. Verifies + decodes the JWT,
 * checks the user exists and is not soft-disabled, and attaches
 * `human_user_id` + `human_memberships` to the request context.
 *
 * @param nowSecondsFn test seam — defaults to wall-clock seconds.
 *   Tests pin a fixed timestamp consistent with the JWT's `iat`/`exp`
 *   so the verify path doesn't reject a freshly-issued JWT as expired.
 */
export function jwtAuth(
  db: Database.Database,
  jwtSecret: Buffer,
  nowSecondsFn: () => number = () => Math.floor(Date.now() / 1000),
): MiddlewareHandler {
  const lookupUserStmt = db.prepare(
    `SELECT id, disabled_at FROM users WHERE id = ?`,
  );

  return async (c, next) => {
    const header = c.req.header(AUTHORIZATION);
    if (!header) {
      return unauthorized(c);
    }
    if (!header.startsWith(BEARER_PREFIX)) {
      return unauthorized(c);
    }
    const token = header.slice(BEARER_PREFIX.length);
    if (token.length < 1) {
      return unauthorized(c);
    }

    const verified = verifyJwt(jwtSecret, token, nowSecondsFn());
    if (!verified.ok) {
      return unauthorized(c);
    }
    const claims: JwtClaims = verified.claims;

    // Soft-disable check. `users.disabled_at IS NOT NULL` ⇒ 401 even
    // with a valid JWT — admin can revoke a user without waiting for
    // the JWT to expire by setting disabled_at.
    const userRow = lookupUserStmt.get(claims.sub) as
      | { id: string; disabled_at: string | null }
      | undefined;
    if (!userRow) {
      return unauthorized(c);
    }
    if (userRow.disabled_at) {
      return unauthorized(c);
    }

    c.set("human_user_id", claims.sub);
    c.set("human_memberships", claims.memberships);
    await next();
  };
}

/**
 * Read the human user_id attached by `jwtAuth`. Returns `null` if the
 * middleware did not run.
 */
export function getHumanUserId(c: Context): string | null {
  const id = c.get("human_user_id") as string | undefined;
  if (!id) return null;
  return id;
}

// `requireRole` and `getHumanMemberships` will land alongside the
// first consumer (M3 HITL endpoints). Keeping them out of the M2 cut
// avoids ts-prune flagging them as cross-file dead exports.
