/**
 * Publisher admin API (M1, issue #81).
 *
 * Six routes covering the machine-plane lifecycle for a publisher
 * namespace:
 *
 *   - `POST /publishers`                            — bootstrap (gated by `bootstrapAuth`)
 *   - `GET /publishers/me`                          — read publisher metadata
 *   - `PATCH /publishers/me`                        — update display_name
 *   - `POST /publishers/me/tokens/:kind/rotate`     — mint new + revoke old
 *   - `DELETE /publishers/me/tokens/:kind/:id`      — revoke a specific row
 *   - `GET /publishers/me/audit`                    — read recent audit events
 *
 * The `:kind` path param is one of `admin`, `runner`, `webhook_signing`,
 * `subcommand_bearer`. The first two are stored hashed in
 * `publisher_tokens`; the latter two are stored plaintext in
 * `publisher_secrets`. The rotate handler dispatches accordingly. The
 * DELETE handler operates on the corresponding table.
 *
 * **Auth.** `POST /publishers` is mounted with `bootstrapAuth(envBuf)` —
 * a deployment-wide secret loaded from `MURMUR_BOOTSTRAP_TOKEN`. The
 * remaining `me/*` routes are mounted under `publisherAuth(db)` and
 * call `requireKind(c, 'admin')` per route — runner-only tokens cannot
 * read or mutate publisher metadata.
 *
 * **Token / secret rotation atomicity.** Each rotate handler runs the
 * INSERT-new + UPDATE-revoke-old sequence inside a single SQLite
 * transaction. The new token is minted INSIDE the txn so its row id is
 * available for audit; the old rows are revoked AFTER the new is
 * inserted so a crash mid-rotate leaves the old still active (no
 * lock-out).
 *
 * **One-time secret return.** Rotate / bootstrap responses include the
 * minted plaintext exactly once. Storage is hashed (admin/runner) or
 * plaintext (webhook_signing/subcommand_bearer) — but the response is
 * the operator's only chance to capture admin/runner secrets. For the
 * plaintext-stored kinds, the value can also be re-fetched via a
 * future `GET /publishers/me/secrets/:kind` (not in v1; operators
 * read directly from the DB if needed).
 *
 * @see DESIGN.md §3.6 — auth model
 * @see src/auth/publisher_auth.ts — `publisherAuth` / `requireKind`
 * @see src/auth/bootstrap_auth.ts — `bootstrapAuth`
 * @see src/audit/publisher_audit.ts — audit row writer
 */

import type Database from "better-sqlite3";
import type { Hono } from "hono";

import type { Err, Ok } from "@murmur/contracts-types";

import { recordPublisherAudit } from "../../audit/publisher_audit.js";
import {
  getPublisherId,
  requireKind,
} from "../../auth/publisher_auth.js";
import {
  hashToken,
  mintToken,
  newRowId,
  type TokenScope,
} from "../../auth/tokens.js";
import {
  decodeKindsJson,
  encodeKindsJson,
  type TokenKind,
} from "../../db/token_kinds.js";

/**
 * Body shape for `POST /publishers` (bootstrap).
 */
interface PostPublishersBody {
  readonly slug?: unknown;
  readonly display_name?: unknown;
}

/**
 * Body shape for `PATCH /publishers/me`.
 */
interface PatchPublishersMeBody {
  readonly display_name?: unknown;
}

/**
 * Successful response shape for `POST /publishers`. The minted admin
 * token is the operator's only chance to capture this secret —
 * subsequent reads return only the prefix.
 */
export interface PostPublisherOk {
  readonly id: string;
  readonly slug: string;
  readonly display_name: string;
  readonly admin_token: {
    readonly id: string;
    readonly token: string;
    readonly prefix: string;
  };
  readonly webhook_signing_secret: {
    readonly id: string;
    readonly value: string;
    readonly prefix: string;
  };
  readonly subcommand_bearer: {
    readonly id: string;
    readonly value: string;
    readonly prefix: string;
  };
}

/**
 * Successful response shape for `GET /publishers/me`. Excludes secret
 * values; only metadata + active-token prefixes.
 */
export interface PublisherMeView {
  readonly id: string;
  readonly slug: string;
  readonly display_name: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly active_tokens: ReadonlyArray<TokenSummary>;
  readonly active_secrets: ReadonlyArray<SecretSummary>;
}

interface TokenSummary {
  readonly id: string;
  readonly kinds: ReadonlyArray<string>;
  readonly prefix: string;
  readonly source: string;
  readonly created_at: string;
}

interface SecretSummary {
  readonly id: string;
  readonly kind: string;
  readonly prefix: string;
  readonly created_at: string;
}

/**
 * Successful response for `POST /publishers/me/tokens/:kind/rotate` when
 * the kind is `admin` or `runner`. Returns the new token plaintext.
 */
export interface TokenRotateOk {
  readonly id: string;
  readonly kind: TokenKind;
  readonly token: string;
  readonly prefix: string;
}

/**
 * Successful response for `POST /publishers/me/tokens/:kind/rotate` when
 * the kind is `webhook_signing` or `subcommand_bearer`. Returns the new
 * secret value.
 */
export interface SecretRotateOk {
  readonly id: string;
  readonly kind: TokenKind;
  readonly value: string;
  readonly prefix: string;
}

/**
 * Mount the bootstrap-only `POST /publishers` route. Caller is
 * responsible for installing `bootstrapAuth` middleware on this sub-app.
 *
 * @param app the Hono sub-app to mount onto.
 * @param db the open `better-sqlite3` connection.
 */
export function mountBootstrapRoutes(
  app: Hono,
  db: Database.Database,
): void {
  app.post("/publishers", async (c) => {
    let body: PostPublishersBody;
    try {
      body = (await c.req.json()) as PostPublishersBody;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json(badRequest([`json:${msg}`]), 400);
    }
    if (typeof body !== "object" || body === null) {
      return c.json(badRequest(["body must be a JSON object"]), 400);
    }

    const slug = body.slug;
    const display_name = body.display_name;
    if (typeof slug !== "string" || !/^[a-z][a-z0-9-]*[a-z0-9]$/.test(slug)) {
      return c.json(
        badRequest(["slug must be a kebab-case string (^[a-z][a-z0-9-]*[a-z0-9]$)"]),
        400,
      );
    }
    if (typeof display_name !== "string" || display_name.length < 1) {
      return c.json(badRequest(["display_name must be a non-empty string"]), 400);
    }

    // Slug-collision check (the UNIQUE index will catch this too, but a
    // pre-check returns a clean 409 instead of a SQLite SQLITE_CONSTRAINT
    // bubbling up as 500).
    const existing = db
      .prepare(`SELECT id FROM publishers WHERE slug = ?`)
      .get(slug);
    if (existing !== undefined) {
      return c.json(badRequest(["publisher_slug_taken"]), 409);
    }

    const now = new Date().toISOString();
    const publisherId = `pub_${newRowId()}`;
    const adminMinted = mintToken("admin");
    const webhookSecret = mintToken("webhook_signing");
    const subcommandSecret = mintToken("subcommand_bearer");

    const adminTokenRowId = newRowId();
    const webhookSecretRowId = newRowId();
    const subcommandSecretRowId = newRowId();

    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO publishers (id, slug, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(publisherId, slug, display_name, now, now);

      db.prepare(
        `INSERT INTO publisher_tokens
           (id, publisher_id, kinds_json, secret_hash, prefix, source, created_at)
         VALUES (?, ?, ?, ?, ?, 'bootstrap', ?)`,
      ).run(
        adminTokenRowId,
        publisherId,
        encodeKindsJson(["admin"]),
        adminMinted.hash,
        adminMinted.prefix,
        now,
      );

      const insertSecret = db.prepare(
        `INSERT INTO publisher_secrets
           (id, publisher_id, kind, secret_value, prefix, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      insertSecret.run(
        webhookSecretRowId,
        publisherId,
        "webhook_signing",
        webhookSecret.plaintext,
        webhookSecret.prefix,
        now,
      );
      insertSecret.run(
        subcommandSecretRowId,
        publisherId,
        "subcommand_bearer",
        subcommandSecret.plaintext,
        subcommandSecret.prefix,
        now,
      );

      recordPublisherAudit(db, {
        publisherId,
        action: "publisher_created",
        nowFn: () => now,
        metadata: { slug },
      });
      recordPublisherAudit(db, {
        publisherId,
        action: "token_minted",
        tokenKind: "admin",
        nowFn: () => now,
        metadata: { source: "bootstrap" },
      });
      recordPublisherAudit(db, {
        publisherId,
        action: "secret_rotated",
        tokenKind: "webhook_signing",
        nowFn: () => now,
        metadata: { source: "bootstrap" },
      });
      recordPublisherAudit(db, {
        publisherId,
        action: "secret_rotated",
        tokenKind: "subcommand_bearer",
        nowFn: () => now,
        metadata: { source: "bootstrap" },
      });
      recordPublisherAudit(db, {
        publisherId,
        action: "bootstrap_invoked",
        nowFn: () => now,
      });
    });
    tx();

    const out: PostPublisherOk = {
      id: publisherId,
      slug,
      display_name,
      admin_token: {
        id: adminTokenRowId,
        token: adminMinted.plaintext,
        prefix: adminMinted.prefix,
      },
      webhook_signing_secret: {
        id: webhookSecretRowId,
        value: webhookSecret.plaintext,
        prefix: webhookSecret.prefix,
      },
      subcommand_bearer: {
        id: subcommandSecretRowId,
        value: subcommandSecret.plaintext,
        prefix: subcommandSecret.prefix,
      },
    };
    const ok: Ok<PostPublisherOk> = { ok: true, data: out };
    return c.json(ok, 201);
  });
}

/**
 * Mount the publisher-token-gated admin routes (`/publishers/me/*`).
 * Caller is responsible for installing `publisherAuth` middleware on
 * this sub-app.
 *
 * @param app the Hono sub-app to mount onto.
 * @param db the open `better-sqlite3` connection.
 */
export function mountAdminMeRoutes(app: Hono, db: Database.Database): void {
  app.get("/publishers/me", (c) => {
    const fail = requireScopeRead(c);
    if (fail) return fail;
    const publisherId = getPublisherId(c);
    if (publisherId === null) return c.json(forbidden, 401);

    const view = readPublisherView(db, publisherId);
    if (view === null) return c.json(forbidden, 401);
    const ok: Ok<PublisherMeView> = { ok: true, data: view };
    return c.json(ok, 200);
  });

  app.patch("/publishers/me", async (c) => {
    const fail = requireKind(c, "admin");
    if (fail) return fail;
    const publisherId = getPublisherId(c);
    if (publisherId === null) return c.json(forbidden, 401);

    let body: PatchPublishersMeBody;
    try {
      body = (await c.req.json()) as PatchPublishersMeBody;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json(badRequest([`json:${msg}`]), 400);
    }
    if (typeof body !== "object" || body === null) {
      return c.json(badRequest(["body must be a JSON object"]), 400);
    }

    const display_name = body.display_name;
    if (display_name === undefined) {
      return c.json(badRequest(["display_name is required"]), 400);
    }
    if (typeof display_name !== "string" || display_name.length < 1) {
      return c.json(badRequest(["display_name must be a non-empty string"]), 400);
    }

    const now = new Date().toISOString();
    db.prepare(
      `UPDATE publishers SET display_name = ?, updated_at = ? WHERE id = ?`,
    ).run(display_name, now, publisherId);

    recordPublisherAudit(db, {
      publisherId,
      action: "publisher_updated",
      nowFn: () => now,
      metadata: { display_name },
    });

    const view = readPublisherView(db, publisherId);
    if (view === null) return c.json(forbidden, 401);
    const ok: Ok<PublisherMeView> = { ok: true, data: view };
    return c.json(ok, 200);
  });

  app.post("/publishers/me/tokens/:kind/rotate", (c) => {
    const fail = requireKind(c, "admin");
    if (fail) return fail;
    const publisherId = getPublisherId(c);
    if (publisherId === null) return c.json(forbidden, 401);

    const kindParam = c.req.param("kind");
    const kind = parseTokenKindParam(kindParam);
    if (kind === null) {
      return c.json(badRequest(["unknown_kind"]), 400);
    }

    const result = rotateTokenOrSecret(db, publisherId, kind);
    return c.json({ ok: true, data: result }, 200);
  });

  app.delete("/publishers/me/tokens/:kind/:id", (c) => {
    const fail = requireKind(c, "admin");
    if (fail) return fail;
    const publisherId = getPublisherId(c);
    if (publisherId === null) return c.json(forbidden, 401);

    const kindParam = c.req.param("kind");
    const id = c.req.param("id");
    const kind = parseTokenKindParam(kindParam);
    if (kind === null) {
      return c.json(badRequest(["unknown_kind"]), 400);
    }
    if (id === undefined || id.length < 1) {
      return c.json(badRequest(["id_required"]), 400);
    }

    const ok = revokeTokenOrSecret(db, publisherId, kind, id);
    if (!ok) {
      return c.json(badRequest(["token_not_found"]), 404);
    }
    return c.json({ ok: true, data: { id } }, 200);
  });

  app.get("/publishers/me/audit", (c) => {
    const fail = requireKind(c, "admin");
    if (fail) return fail;
    const publisherId = getPublisherId(c);
    if (publisherId === null) return c.json(forbidden, 401);

    const limitParam = c.req.query("limit");
    const limit =
      limitParam !== undefined && /^\d+$/.test(limitParam)
        ? Number(limitParam)
        : 50;

    const rows = db
      .prepare(
        `SELECT id, ts, action, token_kind, actor_user_id, metadata_json
           FROM publisher_audit_events
          WHERE publisher_id = ?
          ORDER BY ts DESC, id DESC
          LIMIT ?`,
      )
      .all(publisherId, Math.min(Math.max(1, limit), 200)) as ReadonlyArray<{
      id: number;
      ts: string;
      action: string;
      token_kind: string | null;
      actor_user_id: string | null;
      metadata_json: string | null;
    }>;

    return c.json({ ok: true, data: { events: rows } }, 200);
  });
}

// --------------------------------------------------------------------------
// Internals
// --------------------------------------------------------------------------

const forbidden: Err = { ok: false, errors: ["unauthorized"] };

function badRequest(errors: ReadonlyArray<string>): Err {
  return { ok: false, errors };
}

/**
 * Either kind ('admin' / 'runner') is acceptable for read paths
 * (`GET /publishers/me`). Both kinds can read; only admin can mutate.
 */
function requireScopeRead(c: Parameters<typeof requireKind>[0]): Response | null {
  // For v1 we accept either admin or runner on read paths. The cleanest
  // way to express "either" is to check both and only fail if neither.
  const admin = requireKind(c, "admin");
  if (admin === null) return null;
  const runner = requireKind(c, "runner");
  if (runner === null) return null;
  return admin; // 401
}

function parseTokenKindParam(kind: string | undefined): TokenKind | null {
  if (kind === undefined) return null;
  if (kind === "admin") return "admin";
  if (kind === "runner") return "runner";
  if (kind === "webhook_signing") return "webhook_signing";
  if (kind === "subcommand_bearer") return "subcommand_bearer";
  return null;
}

function readPublisherView(
  db: Database.Database,
  publisherId: string,
): PublisherMeView | null {
  interface PublisherRow {
    readonly id: string;
    readonly slug: string;
    readonly display_name: string;
    readonly created_at: string;
    readonly updated_at: string;
  }
  const row = db
    .prepare(
      `SELECT id, slug, display_name, created_at, updated_at
         FROM publishers WHERE id = ?`,
    )
    .get(publisherId) as PublisherRow | undefined;
  if (row === undefined) {
    return null;
  }

  interface ActiveTokenRow {
    readonly id: string;
    readonly kinds_json: string;
    readonly prefix: string;
    readonly source: string;
    readonly created_at: string;
  }
  const tokenRows = db
    .prepare(
      `SELECT id, kinds_json, prefix, source, created_at
         FROM publisher_tokens
        WHERE publisher_id = ? AND revoked_at IS NULL
        ORDER BY created_at DESC`,
    )
    .all(publisherId) as ReadonlyArray<ActiveTokenRow>;

  const active_tokens: TokenSummary[] = [];
  for (const t of tokenRows) {
    let kinds: string[];
    try {
      const parsed = JSON.parse(t.kinds_json) as unknown;
      kinds = Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
      kinds = [];
    }
    active_tokens.push({
      id: t.id,
      kinds,
      prefix: t.prefix,
      source: t.source,
      created_at: t.created_at,
    });
  }

  interface ActiveSecretRow {
    readonly id: string;
    readonly kind: string;
    readonly prefix: string;
    readonly created_at: string;
  }
  const secretRows = db
    .prepare(
      `SELECT id, kind, prefix, created_at
         FROM publisher_secrets
        WHERE publisher_id = ? AND revoked_at IS NULL
        ORDER BY created_at DESC`,
    )
    .all(publisherId) as ReadonlyArray<ActiveSecretRow>;

  const active_secrets: SecretSummary[] = secretRows.map((s) => ({
    id: s.id,
    kind: s.kind,
    prefix: s.prefix,
    created_at: s.created_at,
  }));

  return {
    id: row.id,
    slug: row.slug,
    display_name: row.display_name,
    created_at: row.created_at,
    updated_at: row.updated_at,
    active_tokens,
    active_secrets,
  };
}

/**
 * Mint a new token/secret of the given kind, revoke prior active rows
 * of that kind, and write the audit row. Returns the operator-facing
 * response (token plaintext or secret value, exposed once).
 */
function rotateTokenOrSecret(
  db: Database.Database,
  publisherId: string,
  kind: TokenKind,
): TokenRotateOk | SecretRotateOk {
  const now = new Date().toISOString();
  const newRowIdValue = newRowId();
  const minted = mintToken(kind as TokenScope);

  const tx = db.transaction(() => {
    if (kind === "admin" || kind === "runner") {
      db.prepare(
        `INSERT INTO publisher_tokens
           (id, publisher_id, kinds_json, secret_hash, prefix, source, created_at)
         VALUES (?, ?, ?, ?, ?, 'api', ?)`,
      ).run(
        newRowIdValue,
        publisherId,
        encodeKindsJson([kind]),
        hashToken(minted.plaintext),
        minted.prefix,
        now,
      );
      // Revoke prior active rows that grant ONLY the rotated kind.
      // Multi-kind rows (e.g. demo's admin+runner) are NOT auto-revoked
      // by a single-kind rotate — operators rotate the multi-kind row
      // separately if needed (DELETE explicit).
      db.prepare(
        `UPDATE publisher_tokens
            SET revoked_at = ?
          WHERE publisher_id = ?
            AND id != ?
            AND revoked_at IS NULL
            AND kinds_json = ?`,
      ).run(now, publisherId, newRowIdValue, encodeKindsJson([kind]));

      recordPublisherAudit(db, {
        publisherId,
        action: "token_rotated",
        tokenKind: kind,
        nowFn: () => now,
      });
    } else {
      db.prepare(
        `INSERT INTO publisher_secrets
           (id, publisher_id, kind, secret_value, prefix, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        newRowIdValue,
        publisherId,
        kind,
        minted.plaintext,
        minted.prefix,
        now,
      );
      db.prepare(
        `UPDATE publisher_secrets
            SET revoked_at = ?
          WHERE publisher_id = ?
            AND id != ?
            AND revoked_at IS NULL
            AND kind = ?`,
      ).run(now, publisherId, newRowIdValue, kind);

      recordPublisherAudit(db, {
        publisherId,
        action: "secret_rotated",
        tokenKind: kind,
        nowFn: () => now,
      });
    }
  });
  tx();

  if (kind === "admin" || kind === "runner") {
    return {
      id: newRowIdValue,
      kind,
      token: minted.plaintext,
      prefix: minted.prefix,
    };
  }
  return {
    id: newRowIdValue,
    kind,
    value: minted.plaintext,
    prefix: minted.prefix,
  };
}

/**
 * Revoke a specific token or secret row by id. Returns true on success
 * (the row existed, was active, granted the path-supplied kind, and is
 * now revoked); false otherwise. Mismatches (row exists for kind X but
 * the path says kind Y) return false — same wire shape as "row not
 * found" so the path can't be used as a kind-enumeration oracle.
 *
 * **Kind verification.** The path-supplied `kind` MUST match the row's
 * actual grant set:
 *   - For `admin` / `runner`: the row's `kinds_json` must contain the
 *     requested kind. Multi-kind rows (the demo's grandfather token
 *     grants both admin and runner) only revoke when the path matches
 *     ONE of their granted kinds — and the audit row records the
 *     requested kind, not all granted kinds, so an operator revoking
 *     "the runner row" doesn't accidentally see an `admin_revoked`
 *     audit entry.
 *   - For `webhook_signing` / `subcommand_bearer`: the row's `kind`
 *     column must match the requested kind exactly.
 *
 * Without this verification, `DELETE /tokens/runner/<admin-row-id>`
 * would happily revoke the admin row and emit an audit entry tagged
 * `runner` — a real bug surfaced in the M1 PR pre-merge review.
 */
function revokeTokenOrSecret(
  db: Database.Database,
  publisherId: string,
  kind: TokenKind,
  id: string,
): boolean {
  const now = new Date().toISOString();

  if (kind === "admin" || kind === "runner") {
    interface TokenRow {
      readonly kinds_json: string;
    }
    const row = db
      .prepare(
        `SELECT kinds_json FROM publisher_tokens
          WHERE id = ? AND publisher_id = ? AND revoked_at IS NULL`,
      )
      .get(id, publisherId) as TokenRow | undefined;
    if (!row) {
      return false;
    }
    const grantedKinds = decodeKindsJson(row.kinds_json);
    if (!grantedKinds || !grantedKinds.has(kind)) {
      // Row exists but doesn't grant the requested kind — refuse to
      // revoke. Same return as not-found; no kind-enumeration oracle.
      return false;
    }
    db.prepare(
      `UPDATE publisher_tokens SET revoked_at = ? WHERE id = ?`,
    ).run(now, id);

    recordPublisherAudit(db, {
      publisherId,
      action: "token_revoked",
      tokenKind: kind,
      nowFn: () => now,
      metadata: { row_id: id },
    });
    return true;
  }

  // webhook_signing / subcommand_bearer
  const result = db
    .prepare(
      `UPDATE publisher_secrets
          SET revoked_at = ?
        WHERE id = ?
          AND publisher_id = ?
          AND kind = ?
          AND revoked_at IS NULL`,
    )
    .run(now, id, publisherId, kind);
  if (result.changes < 1) {
    return false;
  }

  recordPublisherAudit(db, {
    publisherId,
    action: "secret_revoked",
    tokenKind: kind,
    nowFn: () => now,
    metadata: { row_id: id },
  });
  return true;
}

