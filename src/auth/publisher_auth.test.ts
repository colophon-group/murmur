/**
 * Tests for `src/auth/publisher_auth.ts` — multi-tenant publisher auth
 * middleware (M1, issue #81).
 */

import type Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { encodeKindsJson, type TokenKind } from "../db/token_kinds.js";
import { openDb } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";

import {
  publisherAuth,
  requireKind,
} from "./publisher_auth.js";
import { hashToken, newRowId } from "./tokens.js";

const NOW = "2026-05-07T12:00:00.000Z";

let db: Database.Database;

beforeEach(() => {
  db = openDb(":memory:");
  runMigrations(db);
});

afterEach(() => {
  db.close();
});

interface SeedTokenOptions {
  readonly publisherId: string;
  readonly slug: string;
  readonly token: string;
  readonly kinds: ReadonlyArray<TokenKind>;
  readonly revoked?: boolean;
}

function seedPublisherWithToken(opts: SeedTokenOptions): {
  readonly publisherId: string;
  readonly tokenRowId: string;
} {
  // The migration already inserted pub_demo_seed; for non-demo publishers
  // we create a new row.
  if (opts.publisherId !== "pub_demo_seed") {
    db.prepare(
      `INSERT INTO publishers (id, slug, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(opts.publisherId, opts.slug, opts.slug, NOW, NOW);
  } else {
    db.prepare(
      `UPDATE publishers SET slug = ?, display_name = ?, updated_at = ?
        WHERE id = ?`,
    ).run(opts.slug, opts.slug, NOW, opts.publisherId);
  }
  const rowId = newRowId();
  db.prepare(
    `INSERT INTO publisher_tokens
       (id, publisher_id, kinds_json, secret_hash, prefix, source, created_at, revoked_at)
     VALUES (?, ?, ?, ?, 'PREFIX01', 'api', ?, ?)`,
  ).run(
    rowId,
    opts.publisherId,
    encodeKindsJson(opts.kinds),
    hashToken(opts.token),
    NOW,
    opts.revoked === true ? NOW : null,
  );
  return { publisherId: opts.publisherId, tokenRowId: rowId };
}

interface AppContextSnapshot {
  readonly publisher_id?: string | undefined;
  readonly token_kinds?: ReadonlyArray<string> | undefined;
  readonly token_row_id?: string | undefined;
}

/**
 * Build a minimal Hono app with the middleware under test, exposing the
 * ctx values it set on a `/echo-ctx` route. Tests assert on the
 * snapshotted ctx.
 */
function buildApp(): Hono {
  const app = new Hono();
  app.use("*", publisherAuth(db));

  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/echo-ctx", (c) => {
    const publisherId = c.get("publisher_id") as string | undefined;
    const kinds = c.get("token_kinds") as Set<string> | undefined;
    const tokenRowId = c.get("token_row_id") as string | undefined;
    const snap: AppContextSnapshot = {
      publisher_id: publisherId,
      token_kinds: kinds !== undefined ? Array.from(kinds) : undefined,
      token_row_id: tokenRowId,
    };
    return c.json({ ok: true, data: snap });
  });

  app.get("/admin-only", (c) => {
    const fail = requireKind(c, "admin");
    if (fail) return fail;
    return c.json({ ok: true, data: { gate: "admin" } });
  });

  app.get("/runner-only", (c) => {
    const fail = requireKind(c, "runner");
    if (fail) return fail;
    return c.json({ ok: true, data: { gate: "runner" } });
  });

  return app;
}

describe("publisherAuth — bypass + reject paths", () => {
  it("bypasses /health without an Authorization header", async () => {
    const app = buildApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("returns 401 with the canonical body when Authorization is missing", async () => {
    const app = buildApp();
    const res = await app.request("/echo-ctx");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, errors: ["unauthorized"] });
  });

  it("returns 401 when the header lacks the Bearer prefix", async () => {
    const app = buildApp();
    const res = await app.request("/echo-ctx", {
      headers: { Authorization: "Basic xyz" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 on an empty bearer value (literal 'Bearer ')", async () => {
    const app = buildApp();
    const res = await app.request("/echo-ctx", {
      headers: { Authorization: "Bearer " },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 on an oversized bearer (>4 KB)", async () => {
    const app = buildApp();
    const longToken = "a".repeat(5000);
    const res = await app.request("/echo-ctx", {
      headers: { Authorization: `Bearer ${longToken}` },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 on a token whose hash is not in publisher_tokens", async () => {
    seedPublisherWithToken({
      publisherId: "pub_a",
      slug: "alpha",
      token: "mp_admin_AAAA",
      kinds: ["admin"],
    });
    const app = buildApp();
    const res = await app.request("/echo-ctx", {
      headers: { Authorization: "Bearer not-a-real-token" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 when the matching row is revoked", async () => {
    seedPublisherWithToken({
      publisherId: "pub_a",
      slug: "alpha",
      token: "mp_admin_REVOKED",
      kinds: ["admin"],
      revoked: true,
    });
    const app = buildApp();
    const res = await app.request("/echo-ctx", {
      headers: { Authorization: "Bearer mp_admin_REVOKED" },
    });
    expect(res.status).toBe(401);
  });
});

describe("publisherAuth — happy path", () => {
  it("attaches publisher_id, token_kinds, token_row_id on a valid bearer", async () => {
    const { publisherId, tokenRowId } = seedPublisherWithToken({
      publisherId: "pub_alpha",
      slug: "alpha",
      token: "mp_admin_VALID01",
      kinds: ["admin", "runner"],
    });
    const app = buildApp();
    const res = await app.request("/echo-ctx", {
      headers: { Authorization: "Bearer mp_admin_VALID01" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: AppContextSnapshot;
    };
    expect(body.data.publisher_id).toBe(publisherId);
    expect(body.data.token_row_id).toBe(tokenRowId);
    expect(new Set(body.data.token_kinds)).toEqual(
      new Set(["admin", "runner"]),
    );
  });

  it("rejects malformed kinds_json with 401 (defence in depth)", async () => {
    db.prepare(
      `INSERT INTO publishers (id, slug, display_name, created_at, updated_at)
       VALUES ('pub_mal', 'mal', 'Mal', ?, ?)`,
    ).run(NOW, NOW);
    db.prepare(
      `INSERT INTO publisher_tokens
         (id, publisher_id, kinds_json, secret_hash, prefix, source, created_at)
       VALUES (?, 'pub_mal', '{"not_an_array":true}', ?, 'PREFIX01', 'api', ?)`,
    ).run(newRowId(), hashToken("mp_admin_MALFORMED"), NOW);

    const app = buildApp();
    const res = await app.request("/echo-ctx", {
      headers: { Authorization: "Bearer mp_admin_MALFORMED" },
    });
    expect(res.status).toBe(401);
  });
});

describe("requireKind — per-route scope enforcement", () => {
  it("admin-only route accepts an admin token", async () => {
    seedPublisherWithToken({
      publisherId: "pub_a",
      slug: "alpha",
      token: "mp_admin_AONLY",
      kinds: ["admin"],
    });
    const app = buildApp();
    const res = await app.request("/admin-only", {
      headers: { Authorization: "Bearer mp_admin_AONLY" },
    });
    expect(res.status).toBe(200);
  });

  it("admin-only route rejects a runner-only token with 401", async () => {
    seedPublisherWithToken({
      publisherId: "pub_a",
      slug: "alpha",
      token: "mp_runner_RONLY",
      kinds: ["runner"],
    });
    const app = buildApp();
    const res = await app.request("/admin-only", {
      headers: { Authorization: "Bearer mp_runner_RONLY" },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, errors: ["unauthorized"] });
  });

  it("runner-only route accepts a runner token", async () => {
    seedPublisherWithToken({
      publisherId: "pub_a",
      slug: "alpha",
      token: "mp_runner_RONLY2",
      kinds: ["runner"],
    });
    const app = buildApp();
    const res = await app.request("/runner-only", {
      headers: { Authorization: "Bearer mp_runner_RONLY2" },
    });
    expect(res.status).toBe(200);
  });

  it("multi-kind token (admin+runner) satisfies both gates", async () => {
    seedPublisherWithToken({
      publisherId: "pub_a",
      slug: "alpha",
      token: "mp_admin_BOTH",
      kinds: ["admin", "runner"],
    });
    const app = buildApp();
    const adminRes = await app.request("/admin-only", {
      headers: { Authorization: "Bearer mp_admin_BOTH" },
    });
    const runnerRes = await app.request("/runner-only", {
      headers: { Authorization: "Bearer mp_admin_BOTH" },
    });
    expect(adminRes.status).toBe(200);
    expect(runnerRes.status).toBe(200);
  });
});

describe("publisherAuth — multi-tenant isolation", () => {
  it("each publisher's token resolves to its own publisher_id", async () => {
    seedPublisherWithToken({
      publisherId: "pub_a",
      slug: "alpha",
      token: "mp_admin_FORALPHA",
      kinds: ["admin"],
    });
    seedPublisherWithToken({
      publisherId: "pub_b",
      slug: "beta",
      token: "mp_admin_FORBETA",
      kinds: ["admin"],
    });

    const app = buildApp();
    const aRes = await app.request("/echo-ctx", {
      headers: { Authorization: "Bearer mp_admin_FORALPHA" },
    });
    const bRes = await app.request("/echo-ctx", {
      headers: { Authorization: "Bearer mp_admin_FORBETA" },
    });
    const aBody = (await aRes.json()) as { data: AppContextSnapshot };
    const bBody = (await bRes.json()) as { data: AppContextSnapshot };
    expect(aBody.data.publisher_id).toBe("pub_a");
    expect(bBody.data.publisher_id).toBe("pub_b");
  });
});
