/**
 * Tests for the M1 webhook HMAC signing path (issue #81).
 *
 * Companion to `src/webhook.test.ts` — that file covers the M10
 * delivery contract (retry, idempotency, fire-and-forget). This file
 * exercises the additive `X-Murmur-Signature` header introduced by M1
 * and the per-publisher `webhook_signing_secret` lookup it depends on.
 */

import { createHmac } from "node:crypto";

import type Database from "better-sqlite3";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { X_MURMUR_SIGNATURE } from "@murmur/contracts-types";
import type { PipelineDef } from "@murmur/contracts-types";

import { seedDemoPublisher } from "./db/bootstrap.js";
import { openDb } from "./db/index.js";
import { runMigrations } from "./db/migrate.js";
import {
  awaitPendingWebhookDeliveries,
  deliverWebhook,
  lookupActiveWebhookSigningSecret,
  resetPendingWebhookDeliveriesForTest,
  type WebhookFetch,
} from "./webhook.js";

const PIPELINE_ID = "test-pipe";
const RUN_ID = "run-hmac-1";
const WEBHOOK_URL = "https://publisher.test/webhook";
const TEST_BEARER = "test-bearer-hmac";
const SEED_NOW = "2026-05-07T12:00:00.000Z";

const PIPELINE_DEF: PipelineDef = {
  id: PIPELINE_ID,
  initial_input: { type: "object" },
  subtasks: [
    {
      id: "the-subtask",
      instructions: "do it",
      output_schema: { type: "object" },
    } as PipelineDef["subtasks"][number],
  ],
  final_output: {
    composes: ["the-subtask.*"],
    webhook: WEBHOOK_URL,
  },
};

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function makeFetch(
  status = 200,
): { fn: WebhookFetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fn: WebhookFetch = async (url, init) => {
    calls.push({ url, headers: { ...init.headers }, body: init.body });
    return { status };
  };
  return { fn, calls };
}

let db: Database.Database;

beforeEach(() => {
  db = openDb(":memory:");
  runMigrations(db);
  seedDemoPublisher(db, { MURMUR_TOKEN: TEST_BEARER });

  // Seed pipeline + completed run with one done subtask + result.
  db.prepare(
    `INSERT INTO pipelines (id, version, def_json, created_at, updated_at)
     VALUES (?, 1, ?, ?, ?)`,
  ).run(PIPELINE_ID, JSON.stringify(PIPELINE_DEF), SEED_NOW, SEED_NOW);
  db.prepare(
    `INSERT INTO runs (id, pipeline_id, pipeline_version, status,
                       initial_input_json, webhook_url, created_at, completed_at)
     VALUES (?, ?, 1, 'completed', '{}', ?, ?, ?)`,
  ).run(RUN_ID, PIPELINE_ID, WEBHOOK_URL, SEED_NOW, SEED_NOW);
  db.prepare(
    `INSERT INTO subtask_instances (id, run_id, subtask_id, status,
                                    input_json, created_at, updated_at)
     VALUES ('inst-1', ?, 'the-subtask', 'done', '{}', ?, ?)`,
  ).run(RUN_ID, SEED_NOW, SEED_NOW);
  db.prepare(
    `INSERT INTO subtask_results (instance_id, output_json, submitted_at)
     VALUES ('inst-1', ?, ?)`,
  ).run(JSON.stringify({ ok: true }), SEED_NOW);
});

afterEach(async () => {
  await awaitPendingWebhookDeliveries();
  resetPendingWebhookDeliveriesForTest();
  db.close();
});

describe("lookupActiveWebhookSigningSecret", () => {
  it("returns the seeded webhook_signing_secret for the demo publisher", () => {
    const secret = lookupActiveWebhookSigningSecret(db, RUN_ID);
    expect(secret).not.toBeNull();
    expect(typeof secret).toBe("string");
    // 32 bytes base64url = 43 chars (no padding).
    expect(secret!.length).toBeGreaterThanOrEqual(42);
  });

  it("returns null when the publisher has no active webhook_signing secret", () => {
    db.prepare(
      `UPDATE publisher_secrets SET revoked_at = ?
        WHERE publisher_id = 'pub_demo_seed' AND kind = 'webhook_signing'`,
    ).run(SEED_NOW);

    const secret = lookupActiveWebhookSigningSecret(db, RUN_ID);
    expect(secret).toBeNull();
  });

  it("picks the most-recent active secret when multiple exist (rotation)", () => {
    // Insert a newer webhook_signing secret. The lookup should return
    // the newer one per the `created_at DESC` ordering.
    db.prepare(
      `INSERT INTO publisher_secrets
         (id, publisher_id, kind, secret_value, prefix, created_at)
       VALUES ('newer-secret-id', 'pub_demo_seed', 'webhook_signing',
               'BRAND_NEW_SECRET', 'NEW', ?)`,
    ).run("2099-01-01T00:00:00.000Z");

    const secret = lookupActiveWebhookSigningSecret(db, RUN_ID);
    expect(secret).toBe("BRAND_NEW_SECRET");
  });
});

describe("deliverWebhook — HMAC signature (M1)", () => {
  it("adds X-Murmur-Signature with t=<unix>,v1=<hmac> to webhook deliveries", async () => {
    const { fn, calls } = makeFetch(200);
    await deliverWebhook(db, RUN_ID, {
      bearer: "anything",
      fetchImpl: fn,
      nowFn: () => "2026-05-07T12:00:00.000Z",
    });

    expect(calls.length).toBe(1);
    const sigHeader = calls[0]!.headers[X_MURMUR_SIGNATURE.toLowerCase()];
    expect(sigHeader).toBeDefined();

    // Wire shape: t=<digits>,v1=<hex64>
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(sigHeader!);
    expect(m).not.toBeNull();

    const t = m![1]!;
    const v1 = m![2]!;
    const secret = lookupActiveWebhookSigningSecret(db, RUN_ID)!;
    const expected = createHmac("sha256", secret)
      .update(`${t}.${calls[0]!.body}`, "utf8")
      .digest("hex");
    expect(v1).toBe(expected);
  });

  it("uses the publisher's subcommand_bearer (not opts.bearer) on the Authorization header", async () => {
    // M1 (issue #81) per-publisher bearer: pre-M1 the bearer was the
    // shared MURMUR_TOKEN (= opts.bearer). Post-M1 we resolve the run's
    // publisher's `subcommand_bearer` and use IT as the bearer; opts.bearer
    // is only the fallback when no active subcommand_bearer exists. The
    // demo's subcommand_bearer was seeded equal to MURMUR_TOKEN
    // (= TEST_BEARER) in beforeEach, so the bearer here matches that.
    const { fn, calls } = makeFetch(200);
    await deliverWebhook(db, RUN_ID, {
      bearer: "fallback-only-token",
      fetchImpl: fn,
      nowFn: () => "2026-05-07T12:00:00.000Z",
    });

    expect(calls[0]!.headers["authorization"]).toBe(
      `Bearer ${TEST_BEARER}`,
    );
    // HMAC header is ALSO present (additive).
    expect(
      calls[0]!.headers[X_MURMUR_SIGNATURE.toLowerCase()],
    ).toBeDefined();
  });

  it("falls back to opts.bearer when the publisher has no active subcommand_bearer", async () => {
    // Revoke the demo's seeded subcommand_bearer so the fallback path
    // kicks in.
    db.prepare(
      `UPDATE publisher_secrets SET revoked_at = ?
        WHERE publisher_id = 'pub_demo_seed' AND kind = 'subcommand_bearer'`,
    ).run(SEED_NOW);

    const { fn, calls } = makeFetch(200);
    await deliverWebhook(db, RUN_ID, {
      bearer: "fallback-token-XYZ",
      fetchImpl: fn,
      nowFn: () => "2026-05-07T12:00:00.000Z",
    });

    expect(calls[0]!.headers["authorization"]).toBe(
      "Bearer fallback-token-XYZ",
    );
  });

  it("omits X-Murmur-Signature when no active webhook_signing secret exists", async () => {
    db.prepare(
      `UPDATE publisher_secrets SET revoked_at = ?
        WHERE publisher_id = 'pub_demo_seed' AND kind = 'webhook_signing'`,
    ).run(SEED_NOW);

    const { fn, calls } = makeFetch(200);
    await deliverWebhook(db, RUN_ID, {
      bearer: "anything",
      fetchImpl: fn,
      nowFn: () => "2026-05-07T12:00:00.000Z",
    });

    expect(calls.length).toBe(1);
    expect(
      calls[0]!.headers[X_MURMUR_SIGNATURE.toLowerCase()],
    ).toBeUndefined();
    // Legacy bearer still present — backward compat path stays alive.
    expect(calls[0]!.headers["authorization"]).toBeDefined();
  });
});
