/**
 * Tests for the human-plane `/auth/*` API (M2, issue #82).
 *
 * The GitHub OAuth introspection HTTP is mocked via `githubFetchImpl`
 * — every test injects a canned `/user` (and optionally `/user/emails`)
 * response so the test runs offline.
 */

import type Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { seedDemoPublisher } from "../../db/bootstrap.js";
import { openDb } from "../../db/index.js";
import { runMigrations } from "../../db/migrate.js";
import { verifyJwt } from "../../auth/jwt.js";
import type { GitHubFetch } from "../../auth/oauth_github.js";

import { createAuthApp } from "./index.js";

const JWT_SECRET = Buffer.from("test-jwt-secret-32-bytes-padded.", "utf8");

interface GitHubUserBody {
  readonly id: number;
  readonly login?: string;
  readonly name?: string | null;
  readonly email?: string | null;
  readonly avatar_url: string;
}

function fetchOk(user: GitHubUserBody): GitHubFetch {
  return async (url) => {
    if (url.endsWith("/user")) {
      return { status: 200, body: JSON.stringify(user) };
    }
    if (url.endsWith("/user/emails")) {
      return {
        status: 200,
        body: JSON.stringify([
          { email: "primary@example.com", primary: true, verified: true },
        ]),
      };
    }
    return { status: 404, body: "{}" };
  };
}

function fetchUnauthorized(): GitHubFetch {
  return async () => ({ status: 401, body: "{}" });
}

let db: Database.Database;
let app: Hono;
let nowSeconds = 1_700_000_000;
let idCounter = 0;

beforeEach(() => {
  db = openDb(":memory:");
  runMigrations(db);
  seedDemoPublisher(db, { MURMUR_TOKEN: "demo-bearer" });
  nowSeconds = 1_700_000_000;
  idCounter = 0;
  app = new Hono();
  const authApp = createAuthApp({
    db,
    jwtSecret: JWT_SECRET,
    githubFetchImpl: fetchOk({
      id: 4242,
      login: "alice",
      name: "Alice Anderson",
      email: "alice@example.com",
      avatar_url: "https://avatars/alice.png",
    }),
    nowSecondsFn: () => nowSeconds,
    newIdFn: () => {
      idCounter += 1;
      return `id${String(idCounter).padStart(8, "0")}`;
    },
  });
  app.route("/auth", authApp);
});

afterEach(() => {
  db.close();
});

describe("POST /auth/exchange — green path", () => {
  it("creates a user on first sign-in + returns a session JWT + refresh token", async () => {
    const r = await app.request("/auth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        oauth_access_token: "gho_test",
      }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      ok: boolean;
      data: {
        user: { id: string; email: string; display_name: string };
        session_jwt: string;
        refresh_token: string;
        publishers: Array<unknown>;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data.user.id.startsWith("usr_")).toBe(true);
    expect(body.data.user.email).toBe("alice@example.com");
    expect(body.data.user.display_name).toBe("Alice Anderson");
    expect(body.data.refresh_token.startsWith("mr_")).toBe(true);
    expect(body.data.publishers).toEqual([]); // no memberships yet

    // Verify the JWT is valid.
    const verified = verifyJwt(JWT_SECRET, body.data.session_jwt, nowSeconds);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.claims.sub).toBe(body.data.user.id);
    expect(verified.claims.memberships).toEqual([]);

    // User row written.
    const u = db
      .prepare(
        `SELECT id, email, display_name FROM users
          WHERE oauth_provider = 'github' AND oauth_subject = '4242'`,
      )
      .get() as { id: string; email: string; display_name: string };
    expect(u.email).toBe("alice@example.com");

    // Audit row.
    const ar = db
      .prepare(
        `SELECT action FROM human_audit ORDER BY id DESC LIMIT 1`,
      )
      .get() as { action: string };
    expect(ar.action).toBe("sign_in_no_membership");
  });

  it("updates an existing user on subsequent sign-in", async () => {
    const r1 = await app.request("/auth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "github", oauth_access_token: "x" }),
    });
    const b1 = (await r1.json()) as { data: { user: { id: string } } };
    const userId = b1.data.user.id;

    // Second sign-in with updated GitHub user data.
    app = new Hono();
    app.route(
      "/auth",
      createAuthApp({
        db,
        jwtSecret: JWT_SECRET,
        githubFetchImpl: fetchOk({
          id: 4242,
          login: "alice",
          name: "Alice A. (renamed)",
          email: "alice@example.com",
          avatar_url: "https://avatars/alice2.png",
        }),
        nowSecondsFn: () => nowSeconds + 60,
        newIdFn: () => `id${idCounter++}`,
      }),
    );

    const r2 = await app.request("/auth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "github", oauth_access_token: "x" }),
    });
    const b2 = (await r2.json()) as {
      data: { user: { id: string; display_name: string; avatar_url: string } };
    };
    expect(b2.data.user.id).toBe(userId);
    expect(b2.data.user.display_name).toBe("Alice A. (renamed)");
    expect(b2.data.user.avatar_url).toBe("https://avatars/alice2.png");
  });

  it("returns memberships when the user has publisher_member rows", async () => {
    // Create user via first exchange.
    const r1 = await app.request("/auth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "github", oauth_access_token: "x" }),
    });
    const userId = ((await r1.json()) as { data: { user: { id: string } } })
      .data.user.id;

    // Grant admin role on the demo publisher.
    db.prepare(
      `INSERT INTO publisher_members
         (id, publisher_id, user_id, role, granted_at)
       VALUES (?, 'pub_demo_seed', ?, 'admin', ?)`,
    ).run("pm-1", userId, "2026-05-07T12:00:00.000Z");

    // Re-exchange.
    const r2 = await app.request("/auth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "github", oauth_access_token: "x" }),
    });
    const body = (await r2.json()) as {
      data: {
        publishers: Array<{ id: string; role: string }>;
        session_jwt: string;
      };
    };
    expect(body.data.publishers).toHaveLength(1);
    expect(body.data.publishers[0]).toMatchObject({
      id: "pub_demo_seed",
      role: "admin",
    });
    const verified = verifyJwt(JWT_SECRET, body.data.session_jwt, nowSeconds);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.claims.memberships).toEqual([
      { publisher_id: "pub_demo_seed", role: "admin" },
    ]);
  });
});

describe("POST /auth/exchange — failure paths", () => {
  it("returns 400 on missing provider", async () => {
    const r = await app.request("/auth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ oauth_access_token: "x" }),
    });
    expect(r.status).toBe(400);
  });

  it("returns 400 on unsupported provider", async () => {
    const r = await app.request("/auth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "myspace", oauth_access_token: "x" }),
    });
    expect(r.status).toBe(400);
  });

  it("returns 401 + audit when GitHub rejects the access token", async () => {
    app = new Hono();
    app.route(
      "/auth",
      createAuthApp({
        db,
        jwtSecret: JWT_SECRET,
        githubFetchImpl: fetchUnauthorized(),
      }),
    );
    const r = await app.request("/auth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "github", oauth_access_token: "bad" }),
    });
    expect(r.status).toBe(401);

    const auditRow = db
      .prepare(
        `SELECT action, user_id FROM human_audit ORDER BY id DESC LIMIT 1`,
      )
      .get() as { action: string; user_id: string | null };
    expect(auditRow.action).toBe("sign_in_oauth_failed");
    expect(auditRow.user_id).toBeNull();
  });

  it("returns 401 + audit for a soft-disabled user", async () => {
    // First sign-in to create the user.
    const r1 = await app.request("/auth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "github", oauth_access_token: "x" }),
    });
    const userId = ((await r1.json()) as { data: { user: { id: string } } })
      .data.user.id;

    // Disable.
    db.prepare(`UPDATE users SET disabled_at = ? WHERE id = ?`).run(
      "2026-05-07T12:00:00.000Z",
      userId,
    );

    // Second exchange should 401.
    const r2 = await app.request("/auth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "github", oauth_access_token: "x" }),
    });
    expect(r2.status).toBe(401);

    const audit = db
      .prepare(
        `SELECT action FROM human_audit
          WHERE user_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(userId) as { action: string };
    expect(audit.action).toBe("sign_in_disabled");
  });
});

describe("POST /auth/refresh", () => {
  it("rotates the refresh token + issues a fresh JWT", async () => {
    const r1 = await app.request("/auth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "github", oauth_access_token: "x" }),
    });
    const exchangeBody = (await r1.json()) as {
      data: {
        user: { id: string };
        refresh_token: string;
        session_jwt: string;
      };
    };
    const oldRefresh = exchangeBody.data.refresh_token;

    nowSeconds += 3600;
    const r2 = await app.request("/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: oldRefresh }),
    });
    expect(r2.status).toBe(200);
    const refreshBody = (await r2.json()) as {
      data: { session_jwt: string; refresh_token: string };
    };
    expect(refreshBody.data.refresh_token).not.toBe(oldRefresh);
    expect(refreshBody.data.session_jwt).not.toBe(
      exchangeBody.data.session_jwt,
    );

    // Old refresh token now revoked — re-presenting it 401s.
    const r3 = await app.request("/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: oldRefresh }),
    });
    expect(r3.status).toBe(401);
  });

  it("returns 401 on unknown refresh token", async () => {
    const r = await app.request("/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: "mr_unknown" }),
    });
    expect(r.status).toBe(401);
  });
});

describe("DELETE /auth/session", () => {
  it("revokes all active refresh tokens for the JWT user", async () => {
    const r1 = await app.request("/auth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "github", oauth_access_token: "x" }),
    });
    const ex = (await r1.json()) as {
      data: { session_jwt: string; user: { id: string } };
    };

    const r2 = await app.request("/auth/session", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${ex.data.session_jwt}` },
    });
    expect(r2.status).toBe(200);

    const active = db
      .prepare(
        `SELECT COUNT(*) AS n FROM refresh_tokens
          WHERE user_id = ? AND revoked_at IS NULL`,
      )
      .get(ex.data.user.id) as { n: number };
    expect(active.n).toBe(0);
  });

  it("returns 401 without a Bearer JWT", async () => {
    const r = await app.request("/auth/session", { method: "DELETE" });
    expect(r.status).toBe(401);
  });
});
