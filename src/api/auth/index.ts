/**
 * Human-plane auth API — `POST /auth/exchange`, `POST /auth/refresh`,
 * `DELETE /auth/session` (M2, issue #82).
 *
 * The dashboard (M4) handles the GitHub OAuth code flow and presents
 * Murmur with the resulting access_token. Murmur verifies the token by
 * introspecting GitHub's `/user` endpoint, looks up or creates the
 * `users` row, and issues a Murmur JWT carrying the user's
 * publisher memberships. The JWT is the bearer credential for every
 * subsequent human-plane API call.
 *
 * @see src/auth/jwt.ts — JWT sign / verify
 * @see src/auth/oauth_github.ts — verifier
 * @see docs/auth.md — full lifecycle
 */

import type Database from "better-sqlite3";
import { Hono } from "hono";

import type { Err, Ok } from "@murmur/contracts-types";

import { recordHumanAudit } from "../../audit/human_audit.js";
import {
  hashRefreshToken,
  mintRefreshToken,
  signJwt,
  type JwtMembership,
} from "../../auth/jwt.js";
import {
  getHumanUserId,
  jwtAuth,
} from "../../auth/jwt_auth.js";
import {
  verifyGitHubAccessToken,
  type GitHubFetch,
} from "../../auth/oauth_github.js";
import { newRowId } from "../../auth/tokens.js";

/**
 * Options accepted by {@link createAuthApp}.
 */
export interface CreateAuthAppOptions {
  readonly db: Database.Database;
  /** HMAC secret used to sign + verify session JWTs. */
  readonly jwtSecret: Buffer;
  /** Refresh-token TTL in seconds (default 30 days). */
  readonly refreshTtlSeconds?: number;
  /** Test seam for the GitHub /user introspection HTTP. */
  readonly githubFetchImpl?: GitHubFetch;
  /** Test seam for `now()` in seconds. */
  readonly nowSecondsFn?: () => number;
  /** Test seam for new id generation. */
  readonly newIdFn?: () => string;
}

const DEFAULT_REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Public response shapes — exported so tests + the dashboard share the
 * type.
 */
export interface AuthExchangeOk {
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly display_name: string;
    readonly avatar_url: string;
  };
  readonly session_jwt: string;
  readonly refresh_token: string;
  readonly publishers: ReadonlyArray<{
    readonly id: string;
    readonly slug: string;
    readonly display_name: string;
    readonly role: "admin" | "reviewer" | "viewer";
  }>;
}

export interface AuthRefreshOk {
  readonly session_jwt: string;
  readonly refresh_token: string;
}

/**
 * Build the `/auth/*` sub-app. Mounted by `src/server.ts` when
 * `MURMUR_JWT_SECRET` is supplied; without the secret the routes are
 * absent and any call gets a 404 from the parent's notFound handler.
 */
export function createAuthApp(options: CreateAuthAppOptions): Hono {
  const app = new Hono();
  const refreshTtl = options.refreshTtlSeconds ?? DEFAULT_REFRESH_TTL_SECONDS;
  const nowSecondsFn =
    options.nowSecondsFn ?? (() => Math.floor(Date.now() / 1000));
  const newIdFn = options.newIdFn ?? newRowId;

  // -- POST /auth/exchange -------------------------------------------------
  app.post("/exchange", async (c) => {
    const ipAddress = c.req.header("x-forwarded-for") ?? null;
    const userAgent = c.req.header("user-agent") ?? null;

    let body: { provider?: unknown; oauth_access_token?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json(badRequest(["bad_json"]), 400);
    }
    const provider = body.provider;
    const oauth_access_token = body.oauth_access_token;
    if (provider !== "github") {
      return c.json(badRequest(["provider_unsupported"]), 400);
    }
    if (
      typeof oauth_access_token !== "string" ||
      oauth_access_token.length < 1
    ) {
      return c.json(badRequest(["oauth_access_token_required"]), 400);
    }

    const verifyResult = await verifyGitHubAccessToken(
      oauth_access_token,
      options.githubFetchImpl,
    );
    if (!verifyResult.ok) {
      recordHumanAudit(options.db, {
        action: "sign_in_oauth_failed",
        payload: { provider, reason: verifyResult.reason },
        ipAddress,
        userAgent,
      });
      return c.json(badRequest([verifyResult.reason]), 401);
    }
    const identity = verifyResult.identity;
    const now = new Date().toISOString();

    // Upsert the user row. (oauth_provider, oauth_subject) is unique;
    // we look up first and INSERT or UPDATE accordingly.
    const existing = options.db
      .prepare(
        `SELECT id, disabled_at FROM users
          WHERE oauth_provider = ? AND oauth_subject = ?`,
      )
      .get("github", identity.subject) as
      | { id: string; disabled_at: string | null }
      | undefined;
    let userId: string;
    if (existing) {
      userId = existing.id;
      if (existing.disabled_at) {
        recordHumanAudit(options.db, {
          userId,
          action: "sign_in_disabled",
          ipAddress,
          userAgent,
        });
        return c.json(badRequest(["account_disabled"]), 401);
      }
      options.db
        .prepare(
          `UPDATE users
              SET email = ?, display_name = ?, avatar_url = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(
          identity.email,
          identity.display_name,
          identity.avatar_url,
          now,
          userId,
        );
    } else {
      userId = `usr_${newIdFn()}`;
      options.db
        .prepare(
          `INSERT INTO users
             (id, oauth_provider, oauth_subject, email, display_name,
              avatar_url, created_at, updated_at)
           VALUES (?, 'github', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          userId,
          identity.subject,
          identity.email,
          identity.display_name,
          identity.avatar_url,
          now,
          now,
        );
    }

    // Read memberships.
    const memberRows = options.db
      .prepare(
        `SELECT pm.publisher_id, pm.role, p.slug, p.display_name
           FROM publisher_members pm
           JOIN publishers p ON p.id = pm.publisher_id
          WHERE pm.user_id = ? AND pm.revoked_at IS NULL
          ORDER BY pm.granted_at ASC`,
      )
      .all(userId) as ReadonlyArray<{
      publisher_id: string;
      role: "admin" | "reviewer" | "viewer";
      slug: string;
      display_name: string;
    }>;

    const memberships: JwtMembership[] = memberRows.map((r) => ({
      publisher_id: r.publisher_id,
      role: r.role,
    }));
    const publishers = memberRows.map((r) => ({
      id: r.publisher_id,
      slug: r.slug,
      display_name: r.display_name,
      role: r.role,
    }));

    const session_jwt = signJwt(
      options.jwtSecret,
      { sub: userId, iss: "murmur", memberships },
      { nowSeconds: nowSecondsFn() },
    );
    const refresh = mintRefreshToken();
    const refreshIssuedAt = new Date(nowSecondsFn() * 1000).toISOString();
    const refreshExpiresAt = new Date(
      (nowSecondsFn() + refreshTtl) * 1000,
    ).toISOString();
    options.db
      .prepare(
        `INSERT INTO refresh_tokens
           (id, user_id, token_hash, issued_at, expires_at, user_agent, ip_address)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newIdFn(),
        userId,
        refresh.hash,
        refreshIssuedAt,
        refreshExpiresAt,
        userAgent,
        ipAddress,
      );

    recordHumanAudit(options.db, {
      userId,
      action: memberships.length > 0 ? "sign_in_success" : "sign_in_no_membership",
      payload: { provider: "github", memberships_count: memberships.length },
      ipAddress,
      userAgent,
    });

    const out: AuthExchangeOk = {
      user: {
        id: userId,
        email: identity.email,
        display_name: identity.display_name,
        avatar_url: identity.avatar_url,
      },
      session_jwt,
      refresh_token: refresh.plaintext,
      publishers,
    };
    return c.json({ ok: true, data: out } as Ok<AuthExchangeOk>, 200);
  });

  // -- POST /auth/refresh --------------------------------------------------
  app.post("/refresh", async (c) => {
    const ipAddress = c.req.header("x-forwarded-for") ?? null;
    const userAgent = c.req.header("user-agent") ?? null;

    let body: { refresh_token?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json(badRequest(["bad_json"]), 400);
    }
    const presented = body.refresh_token;
    if (typeof presented !== "string" || presented.length < 1) {
      return c.json(badRequest(["refresh_token_required"]), 400);
    }
    const presentedHash = hashRefreshToken(presented);
    const nowIso = new Date(nowSecondsFn() * 1000).toISOString();

    // Atomic rotate: lookup + revoke + issue new — under a single
    // BEGIN IMMEDIATE so a concurrent presentation of the same token
    // can't double-spend.
    options.db.exec("BEGIN IMMEDIATE");
    let issued: AuthRefreshOk | null = null;
    let userIdForAudit: string | null = null;
    try {
      const row = options.db
        .prepare(
          `SELECT id, user_id, expires_at FROM refresh_tokens
            WHERE token_hash = ? AND revoked_at IS NULL`,
        )
        .get(presentedHash) as
        | { id: string; user_id: string; expires_at: string }
        | undefined;
      if (!row) {
        options.db.exec("ROLLBACK");
        recordHumanAudit(options.db, {
          action: "session_refreshed",
          payload: { outcome: "refresh_token_unknown" },
          ipAddress,
          userAgent,
        });
        return c.json(badRequest(["refresh_token_invalid"]), 401);
      }
      if (row.expires_at <= nowIso) {
        options.db.exec("ROLLBACK");
        recordHumanAudit(options.db, {
          userId: row.user_id,
          action: "session_refreshed",
          payload: { outcome: "refresh_token_expired" },
          ipAddress,
          userAgent,
        });
        return c.json(badRequest(["refresh_token_expired"]), 401);
      }
      // Revoke presented row.
      options.db
        .prepare(`UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?`)
        .run(nowIso, row.id);
      // Re-load the user's memberships; could have changed since issue.
      const memberRows = options.db
        .prepare(
          `SELECT publisher_id, role FROM publisher_members
            WHERE user_id = ? AND revoked_at IS NULL`,
        )
        .all(row.user_id) as ReadonlyArray<{
        publisher_id: string;
        role: "admin" | "reviewer" | "viewer";
      }>;
      const memberships: JwtMembership[] = memberRows.map((r) => ({
        publisher_id: r.publisher_id,
        role: r.role,
      }));
      const session_jwt = signJwt(
        options.jwtSecret,
        { sub: row.user_id, iss: "murmur", memberships },
        { nowSeconds: nowSecondsFn() },
      );
      const fresh = mintRefreshToken();
      const expIso = new Date((nowSecondsFn() + refreshTtl) * 1000).toISOString();
      options.db
        .prepare(
          `INSERT INTO refresh_tokens
             (id, user_id, token_hash, issued_at, expires_at, user_agent, ip_address)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          newIdFn(),
          row.user_id,
          fresh.hash,
          nowIso,
          expIso,
          userAgent,
          ipAddress,
        );
      options.db.exec("COMMIT");
      issued = {
        session_jwt,
        refresh_token: fresh.plaintext,
      };
      userIdForAudit = row.user_id;
    } catch (err) {
      try {
        options.db.exec("ROLLBACK");
      } catch {
        // ignore — original error wins
      }
      throw err;
    }

    recordHumanAudit(options.db, {
      userId: userIdForAudit,
      action: "session_refreshed",
      payload: { outcome: "ok" },
      ipAddress,
      userAgent,
    });
    return c.json({ ok: true, data: issued } as Ok<AuthRefreshOk>, 200);
  });

  // -- DELETE /auth/session ------------------------------------------------
  // Requires JWT auth — revokes all active refresh tokens for the
  // authenticated user. Practical sign-out (the JWT itself remains
  // verifiable until its `exp`; the dashboard discards it on its end).
  // The middleware shares the same `nowSecondsFn` seam as the issue
  // path so a fixed-timestamp test fixture issues + verifies JWTs
  // against the same clock.
  const sessionAuth = jwtAuth(options.db, options.jwtSecret, nowSecondsFn);
  app.delete("/session", sessionAuth, (c) => {
    const userId = getHumanUserId(c);
    if (!userId) {
      return c.json(badRequest(["unauthorized"]), 401);
    }
    const ipAddress = c.req.header("x-forwarded-for") ?? null;
    const userAgent = c.req.header("user-agent") ?? null;
    const nowIso = new Date(nowSecondsFn() * 1000).toISOString();
    options.db
      .prepare(
        `UPDATE refresh_tokens SET revoked_at = ?
          WHERE user_id = ? AND revoked_at IS NULL`,
      )
      .run(nowIso, userId);
    recordHumanAudit(options.db, {
      userId,
      action: "session_revoked",
      ipAddress,
      userAgent,
    });
    return c.json({ ok: true, data: { id: userId } } as Ok<{ id: string }>, 200);
  });

  return app;
}

function badRequest(errors: ReadonlyArray<string>): Err {
  return { ok: false, errors };
}
