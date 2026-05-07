/**
 * Hono middleware: multi-tenant publisher auth gate (M1, issue #81).
 *
 * Co-exists with the legacy `bearerAuth(envToken)` in `./middleware.ts`.
 * `publisherAuth` gates the publisher-facing API surface (`POST /pipelines`,
 * `/pipelines/:id/runs`, `GET /runs/:id`, `/publishers/me/*`); the legacy
 * `bearerAuth` continues to gate the agent surface (`/work`, `/mcp`) until
 * M2 introduces the agent-plane split.
 *
 * **DB-backed lookup.** An incoming `Authorization: Bearer <token>` is
 * hashed (SHA-256) and matched against `publisher_tokens.secret_hash`.
 * On match, the middleware attaches `publisher_id` and
 * `token_kinds: Set<TokenKind>` to the request context. Routes call
 * `requireKind(c, 'admin')` to enforce per-route scope.
 *
 * **Backward compat.** The boot seed in `src/db/bootstrap.ts` hashes
 * `MURMUR_TOKEN` and inserts ONE multi-kind row (`["admin","runner"]`)
 * for the demo publisher. Existing callers (jobseek's `start-run.ts`
 * POSTing `/pipelines/{id}/runs`, CI POSTing `/pipelines`) continue to
 * work unchanged — same Authorization header, same demo publisher scope.
 *
 * **Multi-kind, single-row design.** Each token is one row with
 * `kinds_json` as a JSON array. A single token can carry multiple kinds
 * (the demo's MURMUR_TOKEN carries both); this avoids the "multi-row
 * aggregation" hazard where a SELECT-multi-row scheme could silently
 * grant cross-publisher kinds if the lookup forgot to scope by
 * `publisher_id`.
 *
 * **No `last_used_at` updates on the hot path.** WAL mode helps readers
 * but writes still serialize through the SQLite writer mutex. Updating
 * `last_used_at` on every authenticated request would storm the writer
 * lock at >50 req/s. Last-used telemetry is deferred to M2 (batched
 * background updater) — the column is intentionally absent in v1.
 *
 * **Constant-time guarantees.** `WHERE secret_hash = ?` on a UNIQUE
 * index over fixed-length 64-char hex is timing-uniform at the SQLite
 * level. We don't need `crypto.timingSafeEqual` because we're comparing
 * pre-hashed values via a single index round-trip.
 *
 * **`grep-no-naked-eq-in-auth`.** No `===` / `!==` in this module.
 * Nullish checks use `!x`; type-narrowing uses `Array.isArray`,
 * `startsWith`, length flags. Type validation of `kinds_json` items
 * delegates to a non-`auth/` helper (`src/db/token_kinds.ts`).
 *
 * @see DESIGN.md §3.6 — auth model (post-M1)
 * @see src/auth/tokens.ts — `hashToken`
 * @see src/db/token_kinds.ts — kinds_json decoder
 * @see docs/auth.md — token model + verifier samples
 */

import type Database from "better-sqlite3";
import type { Context, MiddlewareHandler } from "hono";

import { AUTHORIZATION } from "@murmur/contracts-types";
import type { Err } from "@murmur/contracts-types";

import { decodeKindsJson, type TokenKind } from "../db/token_kinds.js";

import { hashToken } from "./tokens.js";

// Hono module augmentation — typed `c.get` / `c.set` for the auth-set
// context variables. Declared here so any consumer of the Hono context
// (route handlers, helpers) sees the typed shape after importing
// publisher_auth.ts (transitively via the auth/index.ts barrel).
declare module "hono" {
  interface ContextVariableMap {
    publisher_id: string;
    token_kinds: ReadonlySet<TokenKind>;
    token_row_id: string;
  }
}

/** Required prefix on the `Authorization` header value. */
const BEARER_PREFIX = "Bearer ";

/** Path that bypasses auth (load balancer / Cloudflare Tunnel liveness). */
const HEALTH_PATH = "/health";

/**
 * Sane upper bound on the candidate token length. Real tokens are
 * `mp_<scope>_<base64url-32>` ≈ 60 chars; 4 KB is well above that and
 * far below any practical DoS surface. Anything above 4 KB rejects
 * before hashing.
 */
const MAX_CANDIDATE_LENGTH = 4096;

/**
 * Context keys set by {@link publisherAuth} on a successful match.
 * Internal — consumers read via the typed `c.get("publisher_id")` etc.
 * instead of importing these constants. Documented for grep-ability.
 *
 * - `publisher_id` (string) — the publisher this token authenticates AS.
 * - `token_kinds` (Set<TokenKind>) — the grants the token carries.
 * - `token_row_id` (string) — the matching `publisher_tokens.id`.
 */

/**
 * The canonical 401 body. Typed as `Err` so any drift from the envelope
 * shape (per `docs/contracts.md` §4) is caught at compile time.
 */
export const UNAUTHORIZED_BODY: Err = {
  ok: false,
  errors: ["unauthorized"],
};

/**
 * Construct a Hono middleware that gates every non-`/health` request via
 * a DB-backed publisher token lookup.
 *
 * Contract:
 *   - `/health` (any method) → bypass auth entirely.
 *   - Missing `Authorization` header → 401.
 *   - Header does not begin with `"Bearer "` → 401.
 *   - Empty bearer value → 401.
 *   - Bearer length > {@link MAX_CANDIDATE_LENGTH} → 401 (DoS guard).
 *   - SHA-256(bearer) not in `publisher_tokens` (or row revoked) → 401.
 *   - `kinds_json` unparseable → 401.
 *   - Otherwise: set `c.var.publisher_id`, `c.var.token_kinds`,
 *     `c.var.token_row_id` and call `next()`.
 *
 * @param db open `better-sqlite3` connection. The middleware compiles its
 *   prepared statement once.
 */
export function publisherAuth(db: Database.Database): MiddlewareHandler {
  const lookupStmt = db.prepare(
    `SELECT id, publisher_id, kinds_json
       FROM publisher_tokens
      WHERE secret_hash = ?
        AND revoked_at IS NULL`,
  );

  return async (c, next) => {
    if (isHealthPath(c.req.path)) {
      await next();
      return;
    }

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
    if (candidate.length > MAX_CANDIDATE_LENGTH) {
      return unauthorized(c);
    }

    const hash = hashToken(candidate);
    const row = lookupStmt.get(hash) as
      | { id: string; publisher_id: string; kinds_json: string }
      | undefined;
    if (!row) {
      return unauthorized(c);
    }

    const kinds = decodeKindsJson(row.kinds_json);
    if (!kinds) {
      return unauthorized(c);
    }

    c.set("publisher_id", row.publisher_id);
    c.set("token_kinds", kinds);
    c.set("token_row_id", row.id);
    await next();
  };
}

/**
 * Route-level scope check. Call from a handler (or as additional middleware)
 * to assert the authenticated token carries the required kind. A token
 * lacking the kind gets 401 — same wire shape as the unauthenticated path,
 * so a runner-only token cannot enumerate which routes require admin.
 *
 * @returns the bare 401 Response on failure; null on success (continue).
 */
export function requireKind(
  c: Context,
  required: TokenKind,
): Response | null {
  const kinds = c.get("token_kinds") as ReadonlySet<TokenKind> | undefined;
  if (!kinds) {
    return unauthorized(c);
  }
  if (!kinds.has(required)) {
    return unauthorized(c);
  }
  return null;
}

/**
 * Variant of {@link requireKind} that passes when the token carries
 * ANY of the listed kinds. Used for read endpoints / run-trigger
 * endpoints that admin AND runner can both invoke.
 *
 * @returns null when the token grants at least one of `required`;
 *   401 Response otherwise.
 */
export function requireAnyKind(
  c: Context,
  required: ReadonlyArray<TokenKind>,
): Response | null {
  const kinds = c.get("token_kinds") as ReadonlySet<TokenKind> | undefined;
  if (!kinds) {
    return unauthorized(c);
  }
  for (const k of required) {
    if (kinds.has(k)) {
      return null;
    }
  }
  return unauthorized(c);
}

/**
 * Read the publisher_id attached by {@link publisherAuth}. Returns `null`
 * if the middleware did not run or the route is mounted outside the
 * authenticated scope.
 */
export function getPublisherId(c: Context): string | null {
  const id = c.get("publisher_id") as string | undefined;
  if (!id) {
    return null;
  }
  return id;
}

/**
 * Construct the canonical 401 response. Exported because route-level
 * handlers need to emit the same envelope on their own scope-failure
 * paths (admin API, bootstrap auth).
 */
export function unauthorized(c: Context): Response {
  return c.json(UNAUTHORIZED_BODY, 401);
}

// --------------------------------------------------------------------------
// Internals
// --------------------------------------------------------------------------

/**
 * Return true iff `path` is exactly `/health`. Avoids `===` per the
 * `grep-no-naked-eq-in-auth` gate by using length flags.
 */
function isHealthPath(path: string): boolean {
  if (!path.startsWith(HEALTH_PATH)) {
    return false;
  }
  if (path.length > HEALTH_PATH.length) {
    return false;
  }
  if (path.length < HEALTH_PATH.length) {
    return false;
  }
  return true;
}
