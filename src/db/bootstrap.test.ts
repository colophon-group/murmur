/**
 * Tests for `src/db/bootstrap.ts` — boot-time demo publisher seed
 * (M1, issue #81).
 *
 * Each test gets a fresh in-memory DB with `0001_init.sql` +
 * `0002_publishers_and_tokens.sql` applied. The migrations leave
 * `pub_demo_seed` already inserted; the seed under test then runs
 * against that.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hashToken } from "../auth/tokens.js";

import { openDb } from "./index.js";
import { runMigrations } from "./migrate.js";
import {
  DEFAULT_DEMO_DISPLAY_NAME,
  DEFAULT_DEMO_SLUG,
  DEMO_PUBLISHER_ID,
  seedDemoPublisher,
} from "./bootstrap.js";

// Deterministic seams for assertions.
const FIXED_NOW = "2026-05-07T12:00:00.000Z";
const FIXED_RANDOM = Buffer.alloc(32, 0xab); // base64url: q-vr…
let rowIdCounter = 0;
const newRowIdFn = (): string => {
  rowIdCounter += 1;
  return `row${rowIdCounter.toString().padStart(8, "0")}`;
};

let db: Database.Database;

beforeEach(() => {
  rowIdCounter = 0;
  db = openDb(":memory:");
  runMigrations(db);
});

afterEach(() => {
  db.close();
});

interface PublisherRow {
  readonly id: string;
  readonly slug: string;
  readonly display_name: string;
}

interface TokenRow {
  readonly id: string;
  readonly kinds_json: string;
  readonly secret_hash: string;
  readonly source: string;
  readonly revoked_at: string | null;
}

interface SecretRow {
  readonly id: string;
  readonly kind: string;
  readonly secret_value: string;
  readonly revoked_at: string | null;
}

const readPublisher = (): PublisherRow =>
  db
    .prepare(`SELECT id, slug, display_name FROM publishers WHERE id = ?`)
    .get(DEMO_PUBLISHER_ID) as PublisherRow;

const readTokens = (): ReadonlyArray<TokenRow> =>
  db
    .prepare(
      `SELECT id, kinds_json, secret_hash, source, revoked_at
         FROM publisher_tokens WHERE publisher_id = ?
        ORDER BY created_at ASC, id ASC`,
    )
    .all(DEMO_PUBLISHER_ID) as ReadonlyArray<TokenRow>;

const readSecrets = (): ReadonlyArray<SecretRow> =>
  db
    .prepare(
      `SELECT id, kind, secret_value, revoked_at
         FROM publisher_secrets WHERE publisher_id = ?
        ORDER BY created_at ASC, id ASC`,
    )
    .all(DEMO_PUBLISHER_ID) as ReadonlyArray<SecretRow>;

describe("seedDemoPublisher", () => {
  it("overrides slug + display_name from env when both are set", () => {
    seedDemoPublisher(
      db,
      {
        MURMUR_BOOTSTRAP_PUBLISHER_SLUG: "jobseek",
        MURMUR_BOOTSTRAP_PUBLISHER_NAME: "Jobseek",
      },
      { nowFn: () => FIXED_NOW, randomBytesFn: () => FIXED_RANDOM, newRowIdFn },
    );

    const row = readPublisher();
    expect(row.slug).toBe("jobseek");
    expect(row.display_name).toBe("Jobseek");
  });

  it("falls back to defaults when env is unset", () => {
    seedDemoPublisher(db, {}, {
      nowFn: () => FIXED_NOW,
      randomBytesFn: () => FIXED_RANDOM,
      newRowIdFn,
    });

    const row = readPublisher();
    expect(row.slug).toBe(DEFAULT_DEMO_SLUG);
    expect(row.display_name).toBe(DEFAULT_DEMO_DISPLAY_NAME);
  });

  it("grandfathers MURMUR_TOKEN as kinds_json=['admin','runner']", () => {
    const result = seedDemoPublisher(
      db,
      { MURMUR_TOKEN: "legacy-token-value" },
      { nowFn: () => FIXED_NOW, randomBytesFn: () => FIXED_RANDOM, newRowIdFn },
    );

    expect(result.grandfatherTokenInserted).toBe(true);
    expect(result.grandfatherTokenRotated).toBe(false);

    const tokens = readTokens();
    expect(tokens.length).toBe(1);
    expect(tokens[0]?.kinds_json).toBe('["admin","runner"]');
    expect(tokens[0]?.secret_hash).toBe(hashToken("legacy-token-value"));
    expect(tokens[0]?.source).toBe("env_grandfather");
    expect(tokens[0]?.revoked_at).toBeNull();
  });

  it("is idempotent — running twice with the same MURMUR_TOKEN produces one active token row", () => {
    seedDemoPublisher(
      db,
      { MURMUR_TOKEN: "stable-token" },
      { nowFn: () => FIXED_NOW, randomBytesFn: () => FIXED_RANDOM, newRowIdFn },
    );
    const second = seedDemoPublisher(
      db,
      { MURMUR_TOKEN: "stable-token" },
      { nowFn: () => FIXED_NOW, randomBytesFn: () => FIXED_RANDOM, newRowIdFn },
    );

    expect(second.grandfatherTokenInserted).toBe(false);
    expect(second.grandfatherTokenRotated).toBe(false);

    const active = readTokens().filter((t) => t.revoked_at === null);
    expect(active.length).toBe(1);
  });

  it("rotates the grandfather row when MURMUR_TOKEN value changes between boots", () => {
    seedDemoPublisher(
      db,
      { MURMUR_TOKEN: "old-token" },
      { nowFn: () => FIXED_NOW, randomBytesFn: () => FIXED_RANDOM, newRowIdFn },
    );
    const second = seedDemoPublisher(
      db,
      { MURMUR_TOKEN: "new-token" },
      { nowFn: () => FIXED_NOW, randomBytesFn: () => FIXED_RANDOM, newRowIdFn },
    );

    expect(second.grandfatherTokenInserted).toBe(true);
    expect(second.grandfatherTokenRotated).toBe(true);

    const tokens = readTokens();
    // One revoked (old), one active (new).
    const revoked = tokens.filter((t) => t.revoked_at !== null);
    const active = tokens.filter((t) => t.revoked_at === null);
    expect(revoked.length).toBe(1);
    expect(active.length).toBe(1);
    expect(revoked[0]?.secret_hash).toBe(hashToken("old-token"));
    expect(active[0]?.secret_hash).toBe(hashToken("new-token"));
  });

  it("skips the grandfather path when MURMUR_TOKEN is unset", () => {
    const result = seedDemoPublisher(
      db,
      {},
      { nowFn: () => FIXED_NOW, randomBytesFn: () => FIXED_RANDOM, newRowIdFn },
    );

    expect(result.grandfatherTokenInserted).toBe(false);
    expect(result.subcommandBearerInserted).toBe(false);
    expect(readTokens().length).toBe(0);
    // subcommand_bearer requires MURMUR_TOKEN; webhook_signing_secret does not.
    const secrets = readSecrets();
    expect(secrets.length).toBe(1);
    expect(secrets[0]?.kind).toBe("webhook_signing");
  });

  it("skips the grandfather path when MURMUR_TOKEN is empty string", () => {
    const result = seedDemoPublisher(
      db,
      { MURMUR_TOKEN: "" },
      { nowFn: () => FIXED_NOW, randomBytesFn: () => FIXED_RANDOM, newRowIdFn },
    );

    expect(result.grandfatherTokenInserted).toBe(false);
    expect(readTokens().length).toBe(0);
  });

  it("seeds subcommand_bearer = MURMUR_TOKEN value when MURMUR_TOKEN is set and no row exists", () => {
    const result = seedDemoPublisher(
      db,
      { MURMUR_TOKEN: "shared-bearer" },
      { nowFn: () => FIXED_NOW, randomBytesFn: () => FIXED_RANDOM, newRowIdFn },
    );

    expect(result.subcommandBearerInserted).toBe(true);

    const subcommand = readSecrets().filter((s) => s.kind === "subcommand_bearer");
    expect(subcommand.length).toBe(1);
    expect(subcommand[0]?.secret_value).toBe("shared-bearer");
  });

  it("rotates subcommand_bearer in lockstep with MURMUR_TOKEN rotation", () => {
    // Pre-fix behaviour: re-seed left the stale subcommand_bearer in
    // place, breaking task_tool dispatch (jobseek's shim verifies the
    // NEW MURMUR_TOKEN; Murmur was sending the OLD value as bearer).
    // Post-fix: subcommand_bearer rotation moves with MURMUR_TOKEN.
    seedDemoPublisher(
      db,
      { MURMUR_TOKEN: "first" },
      { nowFn: () => FIXED_NOW, randomBytesFn: () => FIXED_RANDOM, newRowIdFn },
    );
    const second = seedDemoPublisher(
      db,
      { MURMUR_TOKEN: "second" },
      { nowFn: () => FIXED_NOW, randomBytesFn: () => FIXED_RANDOM, newRowIdFn },
    );

    expect(second.subcommandBearerInserted).toBe(true);
    // Old row revoked, new row holds the rotated value.
    const all = readSecrets().filter((s) => s.kind === "subcommand_bearer");
    const active = all.filter((s) => s.revoked_at === null);
    const revoked = all.filter((s) => s.revoked_at !== null);
    expect(active.length).toBe(1);
    expect(active[0]?.secret_value).toBe("second");
    expect(revoked.length).toBe(1);
    expect(revoked[0]?.secret_value).toBe("first");
  });

  it("does NOT rotate subcommand_bearer when MURMUR_TOKEN is unchanged across boots", () => {
    seedDemoPublisher(
      db,
      { MURMUR_TOKEN: "stable" },
      { nowFn: () => FIXED_NOW, randomBytesFn: () => FIXED_RANDOM, newRowIdFn },
    );
    const second = seedDemoPublisher(
      db,
      { MURMUR_TOKEN: "stable" },
      { nowFn: () => FIXED_NOW, randomBytesFn: () => FIXED_RANDOM, newRowIdFn },
    );

    expect(second.subcommandBearerInserted).toBe(false);
    const subcommand = readSecrets().filter(
      (s) => s.kind === "subcommand_bearer" && s.revoked_at === null,
    );
    expect(subcommand.length).toBe(1);
    expect(subcommand[0]?.secret_value).toBe("stable");
  });

  it("generates a fresh webhook_signing_secret on first seed", () => {
    const result = seedDemoPublisher(
      db,
      { MURMUR_TOKEN: "any" },
      {
        nowFn: () => FIXED_NOW,
        randomBytesFn: () => Buffer.alloc(32, 0xff),
        newRowIdFn,
      },
    );

    expect(result.webhookSigningSecretInserted).toBe(true);
    const ws = readSecrets().filter((s) => s.kind === "webhook_signing");
    expect(ws.length).toBe(1);
    // 32 bytes of 0xff base64url-encoded.
    expect(ws[0]?.secret_value).toBe(Buffer.alloc(32, 0xff).toString("base64url"));
  });

  it("does not regenerate webhook_signing_secret on re-seed", () => {
    const first = seedDemoPublisher(
      db,
      { MURMUR_TOKEN: "any" },
      {
        nowFn: () => FIXED_NOW,
        randomBytesFn: () => Buffer.alloc(32, 0x11),
        newRowIdFn,
      },
    );
    const second = seedDemoPublisher(
      db,
      { MURMUR_TOKEN: "any" },
      {
        nowFn: () => FIXED_NOW,
        randomBytesFn: () => Buffer.alloc(32, 0x22),
        newRowIdFn,
      },
    );

    expect(first.webhookSigningSecretInserted).toBe(true);
    expect(second.webhookSigningSecretInserted).toBe(false);
    const ws = readSecrets().filter((s) => s.kind === "webhook_signing");
    expect(ws.length).toBe(1);
    // Stayed the first value.
    expect(ws[0]?.secret_value).toBe(Buffer.alloc(32, 0x11).toString("base64url"));
  });
});

describe("foreign-key check after migration + seed", () => {
  it("PRAGMA foreign_key_check returns zero violations after migration runs", () => {
    // The migration adds publisher_id to pipelines with DEFAULT
    // 'pub_demo_seed'; the demo publisher row exists; so no FK
    // violations are possible.
    const violations = db.prepare(`PRAGMA foreign_key_check`).all();
    expect(violations).toEqual([]);
  });
});
