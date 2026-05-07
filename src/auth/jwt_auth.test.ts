/**
 * Tests for `src/auth/jwt_auth.ts` — JWT bearer middleware.
 */

import type Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";

import { signJwt } from "./jwt.js";
import { getHumanUserId, jwtAuth } from "./jwt_auth.js";

const SECRET = Buffer.from("test-jwt-secret-32-bytes-padded.", "utf8");
const NOW_SECONDS = 1_700_000_000;

let db: Database.Database;
let app: Hono;

beforeEach(() => {
  db = openDb(":memory:");
  runMigrations(db);
  // Seed a real user row — the middleware looks the user up to enforce
  // the disabled_at soft-disable check.
  db.prepare(
    `INSERT INTO users (id, oauth_provider, oauth_subject, email, display_name, avatar_url, created_at, updated_at)
     VALUES (?, 'github', '1', 'a@e.com', 'A', 'https://x/y', ?, ?)`,
  ).run("usr_alice", "2026-05-07T00:00:00.000Z", "2026-05-07T00:00:00.000Z");

  app = new Hono();
  app.use("*", jwtAuth(db, SECRET, () => NOW_SECONDS));
  app.get("/echo", (c) => {
    const id = getHumanUserId(c);
    return c.json({ ok: true, data: { user_id: id } });
  });
});

afterEach(() => {
  db.close();
});

const validToken = (sub = "usr_alice"): string =>
  signJwt(
    SECRET,
    { sub, iss: "murmur", memberships: [] },
    { nowSeconds: NOW_SECONDS },
  );

describe("jwtAuth — happy path", () => {
  it("attaches human_user_id when the JWT is valid + user not disabled", async () => {
    const r = await app.request("/echo", {
      headers: { Authorization: `Bearer ${validToken()}` },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { data: { user_id: string } };
    expect(body.data.user_id).toBe("usr_alice");
  });
});

describe("jwtAuth — failure paths", () => {
  it("returns 401 without an Authorization header", async () => {
    const r = await app.request("/echo");
    expect(r.status).toBe(401);
  });

  it("returns 401 when header lacks the Bearer prefix", async () => {
    const r = await app.request("/echo", {
      headers: { Authorization: "Token xyz" },
    });
    expect(r.status).toBe(401);
  });

  it("returns 401 on empty bearer", async () => {
    const r = await app.request("/echo", {
      headers: { Authorization: "Bearer " },
    });
    expect(r.status).toBe(401);
  });

  it("returns 401 on a malformed JWT", async () => {
    const r = await app.request("/echo", {
      headers: { Authorization: "Bearer not.a.jwt" },
    });
    expect(r.status).toBe(401);
  });

  it("returns 401 on an expired JWT", async () => {
    const expired = signJwt(
      SECRET,
      { sub: "usr_alice", iss: "murmur", memberships: [] },
      { nowSeconds: NOW_SECONDS, ttlSeconds: 60 },
    );
    // Build the app with a clock 2h in the future so the expired
    // token surfaces.
    const futureApp = new Hono();
    futureApp.use("*", jwtAuth(db, SECRET, () => NOW_SECONDS + 7200));
    futureApp.get("/echo", (c) => c.json({ ok: true }));
    const r = await futureApp.request("/echo", {
      headers: { Authorization: `Bearer ${expired}` },
    });
    expect(r.status).toBe(401);
  });

  it("returns 401 when the JWT's user_id does not exist in the DB", async () => {
    const token = validToken("usr_ghost");
    const r = await app.request("/echo", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(401);
  });

  it("returns 401 when the user is soft-disabled", async () => {
    db.prepare(`UPDATE users SET disabled_at = ? WHERE id = ?`).run(
      "2026-05-07T12:00:00.000Z",
      "usr_alice",
    );
    const r = await app.request("/echo", {
      headers: { Authorization: `Bearer ${validToken()}` },
    });
    expect(r.status).toBe(401);
  });

  it("returns 401 when signed with a different secret", async () => {
    const wrongSecret = Buffer.from("not-the-real-secret-32-bytes-pad", "utf8");
    const token = signJwt(
      wrongSecret,
      { sub: "usr_alice", iss: "murmur", memberships: [] },
      { nowSeconds: NOW_SECONDS },
    );
    const r = await app.request("/echo", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(401);
  });
});

describe("getHumanUserId — outside middleware", () => {
  it("returns null on a context that did not pass through jwtAuth", async () => {
    const otherApp = new Hono();
    otherApp.get("/probe", (c) => {
      const id = getHumanUserId(c);
      return c.json({ ok: true, data: { id } });
    });
    const r = await otherApp.request("/probe");
    const body = (await r.json()) as { data: { id: string | null } };
    expect(body.data.id).toBeNull();
  });
});
