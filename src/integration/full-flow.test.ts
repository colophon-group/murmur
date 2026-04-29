/**
 * Cross-repo integration test (issue #35 / I1) — end-to-end wire-level
 * verification that Murmur's `task_tool` proxy and `webhook` delivery
 * compose with a stub jobseek over real HTTP, with envelope shape and
 * header casing matching M0 contracts.
 *
 * Test bullets are taken verbatim from issue #35's "Verification"
 * section; every named bullet has at least one corresponding `it()`
 * below.
 *
 * The mock-jobseek runs on `127.0.0.1:0` (kernel-assigned port) and
 * captures `req.rawHeaders` so we can assert on the wire-cased header
 * names. The Murmur side is in-process via Hono's `app.request(...)`
 * — no TCP socket, but the dispatcher's outbound `task_tool` calls
 * and the webhook delivery DO go over the wire (to the mock).
 */

import Database from "better-sqlite3";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { Hono } from "hono";

import {
  MurmurHeaders,
  type EnvelopeResponse,
  type PipelineDef,
  type Err,
} from "@murmur/contracts-types";

import { createAgentApp } from "../api/agent/index.js";
import { createPublisherApp } from "../api/publisher/index.js";
import { bearerAuth } from "../auth/index.js";
import { runMigrations } from "../db/migrate.js";
import { closeAllPools } from "../dispatch/task_tool.js";
import { createMcpRoute } from "../mcp/server.js";
import {
  awaitPendingWebhookDeliveries,
  deliverWebhook,
  resetPendingWebhookDeliveriesForTest,
  type WebhookFetch,
  type WebhookSetTimeout,
} from "../webhook.js";

import {
  buildJobseekPipeline,
  type BuildJobseekPipelineOptions,
} from "./fixtures/jobseek-pipeline.js";
import {
  findRawHeader,
  startMockJobseek,
  type MockJobseek,
  type RecordedRequest,
} from "./mock-jobseek.js";
import {
  runScriptedAgent,
  type BoardSpec,
  type TaskToolResponse,
} from "./scripted-agent.js";

/* -------------------------------------------------------------------- */
/* Fixtures                                                              */
/* -------------------------------------------------------------------- */

const TEST_TOKEN = "integration-test-murmur-token";
const TEST_TOKEN_BUF = Buffer.from(TEST_TOKEN, "utf8");

interface IntegrationHarness {
  readonly db: Database.Database;
  readonly app: Hono;
  readonly mock: MockJobseek;
  readonly pipelineId: string;
  readonly pipelineDef: PipelineDef;
  /**
   * Promises for in-flight first-attempt webhook deliveries. Tests
   * `await Promise.allSettled(harness.webhookFirstAttempts)` between the
   * scripted agent finishing and reading `runs.webhook_status`. The
   * production wiring in `src/server.ts` is fire-and-forget — we
   * mirror it here but ALSO retain the promises so the test can
   * synchronise against them deterministically (no `setTimeout(0)`
   * polling, no flaky waits).
   */
  readonly webhookFirstAttempts: Promise<void>[];
}

/**
 * Build a Hono app structurally identical to `createServer` but with
 * a webhook-delivery hook the test can synchronise against.
 *
 * The shape mirrors `src/server.ts` so any drift in production wiring
 * surfaces here as a test failure (the harness composes the same
 * `bearerAuth`, `createPublisherApp`, `createAgentApp`,
 * `createMcpRoute` primitives in the same order).
 */
function buildHarnessApp(
  db: Database.Database,
  token: Buffer,
  webhookFirstAttempts: Promise<void>[],
): Hono {
  const app = new Hono();
  app.use("*", bearerAuth(token));
  app.get("/health", (c) => c.json({ ok: true }));

  const publisher = createPublisherApp({ db });
  app.route("/", publisher);

  const tokenStr = token.toString("utf8");
  const deliverWebhookFn = (runId: string): void => {
    const p = deliverWebhook(db, runId, { bearer: tokenStr }).catch(() => {
      // Surface nothing — `deliverWebhook` already logs internally and
      // the test asserts on observable state (DB rows + mock log),
      // not on rejection of this promise. Swallowing matches the
      // production wiring in `src/server.ts`.
    });
    webhookFirstAttempts.push(p);
  };

  const agent = createAgentApp({ db, deliverWebhookFn });
  app.route("/work", agent);
  app.route("/mcp", createMcpRoute({ agentApp: agent }));

  app.notFound((c) => {
    const body: Err = { ok: false, errors: ["not_found"] };
    return c.json(body, 404);
  });

  return app;
}

/**
 * Boot the in-process Murmur, start a fresh mock-jobseek, and register
 * the §3.1 pipeline pointed at the mock. Returns a handle each test
 * uses to drive the loop and assert on captured wire data.
 *
 * Each test gets its own DB + mock — the integration test's value is
 * in the cross-module composition, but cross-test contamination would
 * obscure failures.
 */
async function startHarness(
  pipelineId = "jobseek-add-company",
): Promise<IntegrationHarness> {
  const mock = await startMockJobseek();

  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);

  const webhookFirstAttempts: Promise<void>[] = [];
  const app = buildHarnessApp(db, TEST_TOKEN_BUF, webhookFirstAttempts);

  const opts: BuildJobseekPipelineOptions = {
    apiBase: mock.origin,
    webhookUrl: `${mock.origin}/api/murmur/accept`,
    pipelineId,
  };
  const pipelineDef = buildJobseekPipeline(opts);

  // Seed the pipeline def directly into `pipelines` (the same path the
  // dispatcher's unit tests take in `src/dispatch/task_tool.test.ts`).
  // We deliberately bypass `POST /pipelines` here because:
  //
  //   - The M0 schema regex pins endpoints to `^POST https://` and the
  //     webhook to `^https://` (`docs/contracts/pipeline-def.schema.json`).
  //   - The mock-jobseek runs on plain `http://127.0.0.1:<port>` because
  //     opening a self-signed TLS cert in a test would balloon scope and
  //     a TLS handshake adds nothing to the wire-contract assertion the
  //     test cares about.
  //
  // The dispatcher reads `pipelines.def_json` verbatim, so seeding the
  // row directly preserves every M0 contract this test asserts on
  // (header casing, envelope shape, idempotency-key) — only the regex
  // gate at registration is sidestepped.
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO pipelines (id, version, def_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(pipelineId, 1, JSON.stringify(pipelineDef), now, now);

  return { db, app, mock, pipelineId, pipelineDef, webhookFirstAttempts };
}

/**
 * Block until every fire-and-forget first-attempt webhook delivery
 * AND every scheduled retry has settled. Combines the harness-tracked
 * first-attempt promises with the webhook module's
 * `awaitPendingWebhookDeliveries` (which only covers retries).
 */
async function drainWebhooks(harness: IntegrationHarness): Promise<void> {
  // First attempts that the harness's `deliverWebhookFn` started.
  await Promise.allSettled(harness.webhookFirstAttempts);
  // Then any retry that may have been scheduled.
  await awaitPendingWebhookDeliveries();
}

async function startRun(harness: IntegrationHarness): Promise<string> {
  const response = await harness.app.request(
    `/pipelines/${encodeURIComponent(harness.pipelineId)}/runs`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        initial_input: {
          company_name: "Example, Inc.",
          website: "https://example.com",
        },
      }),
    },
  );
  if (response.status !== 200) {
    const body = await response.text();
    throw new Error(`startRun: ${response.status}: ${body}`);
  }
  const env = (await response.json()) as EnvelopeResponse<{ run_id: string }>;
  if (!env.ok) {
    throw new Error(
      `startRun returned ok=false: ${JSON.stringify(env.errors)}`,
    );
  }
  const runId = env.data.run_id;

  // Insert `pending` rows for every static subtask whose `requires` is
  // non-empty. The publisher route only inserts the run-start ready set
  // (subtasks with no `requires` and not a spawn template); the
  // `markNextReady` lifecycle helper expects `pending` rows to exist
  // for it to flip to `ready` after their prerequisites complete.
  // The same pattern is used by `src/api/agent/agent.test.ts#seedRun`.
  const templates = new Set<string>();
  for (const s of harness.pipelineDef.subtasks) {
    if (s.spawns !== undefined) templates.add(s.spawns.template);
  }
  const insertPending = harness.db.prepare(
    `INSERT OR IGNORE INTO subtask_instances
       (id, run_id, subtask_id, status, input_json, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
  );
  let i = 0;
  const baseTime = Date.now();
  for (const sub of harness.pipelineDef.subtasks) {
    const reqs = sub.requires ?? [];
    if (reqs.length === 0) continue;
    if (templates.has(sub.id)) continue;
    // Stagger created_at by ms so FIFO order is deterministic.
    const ts = new Date(baseTime + i).toISOString();
    insertPending.run(
      `i_pending_${runId}_${sub.id}`,
      runId,
      sub.id,
      "{}",
      ts,
      ts,
    );
    i += 1;
  }
  return runId;
}

/* -------------------------------------------------------------------- */
/* Cleanup                                                               */
/* -------------------------------------------------------------------- */

let harness: IntegrationHarness | undefined;

beforeEach(() => {
  // Reset the webhook module's in-flight registry so a previous test's
  // detached retry can't leak into this one.
  resetPendingWebhookDeliveriesForTest();
});

afterEach(async () => {
  // Drain any in-flight first-attempts AND retries before closing
  // sockets so they don't explode against a closed mock.
  if (harness !== undefined) {
    await drainWebhooks(harness);
    harness.db.close();
    await harness.mock.close();
    harness = undefined;
  } else {
    await awaitPendingWebhookDeliveries();
  }
  // Close any pools the dispatcher cached so the next test gets a
  // fresh client (origin keepalive sockets to a closed mock would
  // surface as ECONNREFUSED on the next call otherwise).
  await closeAllPools();
});

afterAll(async () => {
  await closeAllPools();
});

/* -------------------------------------------------------------------- */
/* Helpers                                                               */
/* -------------------------------------------------------------------- */

const ENVELOPE_NEVER_HAS_ACCEPTED = (env: EnvelopeResponse<unknown>): void => {
  // Strict: serialise and ensure no `accepted` JSON key appears anywhere
  // in the body, no matter how nested. Issue #35 specifies this exact
  // assertion. (grep-no-accepted-key:allow — load-bearing assertion.)
  expect(JSON.stringify(env)).not.toMatch(/"accepted"/);
};

const ASSERT_M0_ENVELOPE = (
  env: EnvelopeResponse<unknown>,
  context: string,
): void => {
  // The envelope MUST be either { ok: true, data: ... } or
  // { ok: false, errors: [...] }. No other shape.
  if (env === null || typeof env !== "object") {
    throw new Error(`${context}: envelope is not an object`);
  }
  if (typeof env.ok !== "boolean") {
    throw new Error(`${context}: envelope.ok is not a boolean`);
  }
  if (env.ok) {
    expect(env, `${context}: ok envelope must have data`).toHaveProperty("data");
  } else {
    expect(env, `${context}: err envelope must have errors`).toHaveProperty(
      "errors",
    );
    expect(
      Array.isArray(env.errors),
      `${context}: errors must be an array`,
    ).toBe(true);
  }
  ENVELOPE_NEVER_HAS_ACCEPTED(env);
};

/**
 * Filter a {@link RecordedRequest} log down to the requests against a
 * specific URL path. Used to gate header-casing assertions to the
 * routes the test actually exercised.
 */
function requestsTo(
  log: ReadonlyArray<RecordedRequest>,
  pathPrefix: string,
): ReadonlyArray<RecordedRequest> {
  return log.filter((r) => r.url.startsWith(pathPrefix));
}

/* -------------------------------------------------------------------- */
/* Tests                                                                 */
/* -------------------------------------------------------------------- */

describe("integration: cross-repo full flow", () => {
  it("Happy path single-board run completes", async () => {
    harness = await startHarness();
    const runId = await startRun(harness);

    const taskToolCalls: TaskToolResponse[] = [];
    const murmurCalls: EnvelopeResponse<unknown>[] = [];

    const board: BoardSpec = {
      alias: "careers-en",
      url: "https://example.com/careers",
      provider: "greenhouse",
    };

    const result = await runScriptedAgent({
      app: harness.app,
      db: harness.db,
      bearer: TEST_TOKEN,
      boards: [board],
      taskToolCalls,
      murmurCalls,
    });

    expect(result.runId).toBe(runId);
    // Subtask order: pre-verify, list-boards, configure-board × 1.
    expect(result.claimedSubtaskOrder.map((c) => c.subtaskId)).toEqual([
      "pre-verify",
      "list-boards",
      "configure-board",
    ]);

    // Drain any scheduled webhook retry (there shouldn't be one — the
    // mock returns 200 — but wait anyway so the assertion is robust).
    await drainWebhooks(harness);

    // Run row reflects completion.
    const runRow = harness.db
      .prepare(`SELECT status, webhook_status FROM runs WHERE id = ?`)
      .get(runId) as { status: string; webhook_status: string | null };
    expect(
      runRow.status,
      "run status must flip to 'completed' after final submit",
    ).toBe("completed");
    expect(
      runRow.webhook_status,
      "webhook_status must be 'delivered' on a 2xx accept response",
    ).toBe("delivered");
  });

  it("3-board spawn run completes; all 3 children claimed in created_at order", async () => {
    harness = await startHarness();
    await startRun(harness);

    const boards: BoardSpec[] = [
      { alias: "careers-en", url: "https://example.com/en", provider: "greenhouse" },
      { alias: "careers-de", url: "https://example.com/de", provider: "greenhouse" },
      { alias: "careers-fr", url: "https://example.com/fr", provider: "lever" },
    ];

    const result = await runScriptedAgent({
      app: harness.app,
      db: harness.db,
      bearer: TEST_TOKEN,
      boards,
    });

    // pre-verify, list-boards, then 3 × configure-board in spawn order.
    expect(result.claimedSubtaskOrder.map((c) => c.subtaskId)).toEqual([
      "pre-verify",
      "list-boards",
      "configure-board",
      "configure-board",
      "configure-board",
    ]);

    // Each spawned child's `input.board` matches the corresponding
    // boards[] element (FIFO via `created_at` per M5).
    const configureClaims = result.claimedSubtaskOrder.filter(
      (c) => c.subtaskId === "configure-board",
    );
    expect(configureClaims).toHaveLength(3);
    for (let i = 0; i < boards.length; i += 1) {
      const inp = configureClaims[i]?.input as { board?: BoardSpec };
      expect(
        inp?.board?.alias,
        `configure-board #${i} must bind the matching board element under 'board'`,
      ).toBe(boards[i]?.alias);
    }

    // DB confirms all 3 spawn rows ended `done`.
    const childRows = harness.db
      .prepare(
        `SELECT status FROM subtask_instances
          WHERE subtask_id = 'configure-board'
       ORDER BY created_at ASC`,
      )
      .all() as ReadonlyArray<{ status: string }>;
    expect(childRows).toHaveLength(3);
    for (const r of childRows) {
      expect(r.status).toBe("done");
    }
  });

  it("task_tool envelope stays M0-shaped across all routes", async () => {
    harness = await startHarness();
    await startRun(harness);

    const taskToolCalls: TaskToolResponse[] = [];
    const murmurCalls: EnvelopeResponse<unknown>[] = [];

    await runScriptedAgent({
      app: harness.app,
      db: harness.db,
      bearer: TEST_TOKEN,
      boards: [
        { alias: "a", url: "https://example.com/a", provider: "greenhouse" },
        { alias: "b", url: "https://example.com/b", provider: "lever" },
      ],
      taskToolCalls,
      murmurCalls,
    });

    // Every dispatcher response is M0-shaped.
    expect(
      taskToolCalls.length,
      "expected at least one task_tool call across pre-verify + list-boards + configure-board",
    ).toBeGreaterThan(0);
    for (let i = 0; i < taskToolCalls.length; i += 1) {
      const call = taskToolCalls[i];
      if (call === undefined) continue;
      ASSERT_M0_ENVELOPE(call, `taskToolCalls[${i}]`);
    }
    for (let i = 0; i < murmurCalls.length; i += 1) {
      const call = murmurCalls[i];
      if (call === undefined) continue;
      ASSERT_M0_ENVELOPE(call, `murmurCalls[${i}]`);
    }
  });

  it("Header casing matches M0 constants on every proxied task_tool call", async () => {
    harness = await startHarness();
    await startRun(harness);

    await runScriptedAgent({
      app: harness.app,
      db: harness.db,
      bearer: TEST_TOKEN,
      boards: [
        { alias: "a", url: "https://example.com/a", provider: "greenhouse" },
      ],
    });

    const proxied = harness.mock.received.filter(
      (r) => r.url.startsWith("/api/murmur/") && r.url !== "/api/murmur/accept",
    );
    expect(
      proxied.length,
      "scripted agent should issue at least one task_tool proxied call",
    ).toBeGreaterThan(0);

    for (let i = 0; i < proxied.length; i += 1) {
      const req = proxied[i];
      if (req === undefined) continue;
      const ctx = `proxied[${i}] ${req.method} ${req.url}`;

      // Authorization header — exact M0 casing.
      const authz = findRawHeader(req.rawHeaders, MurmurHeaders.AUTHORIZATION);
      expect(authz, `${ctx}: missing Authorization header`).not.toBeNull();
      expect(
        authz?.nameOnWire,
        `${ctx}: Authorization header casing must match M0 constant`,
      ).toBe(MurmurHeaders.AUTHORIZATION);

      // X-Murmur-Subcommand — exact M0 casing.
      const sub = findRawHeader(
        req.rawHeaders,
        MurmurHeaders.X_MURMUR_SUBCOMMAND,
      );
      expect(sub, `${ctx}: missing X-Murmur-Subcommand header`).not.toBeNull();
      expect(
        sub?.nameOnWire,
        `${ctx}: X-Murmur-Subcommand header casing must match M0 constant`,
      ).toBe(MurmurHeaders.X_MURMUR_SUBCOMMAND);
      expect(
        sub?.value,
        `${ctx}: X-Murmur-Subcommand value must be a non-empty string`,
      ).toBeTruthy();

      // X-Murmur-Claim-Token — exact M0 casing.
      const claim = findRawHeader(
        req.rawHeaders,
        MurmurHeaders.X_MURMUR_CLAIM_TOKEN,
      );
      expect(
        claim,
        `${ctx}: missing X-Murmur-Claim-Token header`,
      ).not.toBeNull();
      expect(
        claim?.nameOnWire,
        `${ctx}: X-Murmur-Claim-Token header casing must match M0 constant`,
      ).toBe(MurmurHeaders.X_MURMUR_CLAIM_TOKEN);
      expect(
        claim?.value,
        `${ctx}: X-Murmur-Claim-Token must be a non-empty string`,
      ).toBeTruthy();
    }
  });

  it("Mock-jobseek receives bearer with MURMUR_TOKEN on proxied subcommand calls", async () => {
    harness = await startHarness();
    await startRun(harness);

    await runScriptedAgent({
      app: harness.app,
      db: harness.db,
      bearer: TEST_TOKEN,
      boards: [
        { alias: "a", url: "https://example.com/a", provider: "greenhouse" },
      ],
    });

    const proxied = harness.mock.received.filter(
      (r) => r.url.startsWith("/api/murmur/") && r.url !== "/api/murmur/accept",
    );
    expect(proxied.length).toBeGreaterThan(0);

    for (let i = 0; i < proxied.length; i += 1) {
      const req = proxied[i];
      if (req === undefined) continue;
      const ctx = `proxied[${i}] ${req.method} ${req.url}`;
      const authz = findRawHeader(req.rawHeaders, MurmurHeaders.AUTHORIZATION);
      expect(authz?.value, `${ctx}: bearer must be present`).toBe(
        `Bearer ${TEST_TOKEN}`,
      );
    }
  });

  it("Webhook delivery: bearer + Idempotency-Key visible in mock-jobseek's accept handler", async () => {
    harness = await startHarness();
    const runId = await startRun(harness);

    await runScriptedAgent({
      app: harness.app,
      db: harness.db,
      bearer: TEST_TOKEN,
      boards: [
        { alias: "a", url: "https://example.com/a", provider: "greenhouse" },
      ],
    });
    await drainWebhooks(harness);

    const accepts = requestsTo(harness.mock.received, "/api/murmur/accept");
    expect(
      accepts.length,
      "expected exactly one webhook delivery on first happy-path completion",
    ).toBe(1);

    const accept = accepts[0];
    if (accept === undefined) throw new Error("unreachable");

    // Bearer.
    const authz = findRawHeader(
      accept.rawHeaders,
      MurmurHeaders.AUTHORIZATION,
    );
    expect(authz?.value, "webhook bearer must equal MURMUR_TOKEN").toBe(
      `Bearer ${TEST_TOKEN}`,
    );

    // Idempotency-Key.
    const idem = findRawHeader(
      accept.rawHeaders,
      MurmurHeaders.IDEMPOTENCY_KEY,
    );
    expect(
      idem,
      "webhook MUST include Idempotency-Key header (M0 contract)",
    ).not.toBeNull();
    expect(
      idem?.value,
      "Idempotency-Key MUST equal run_id (M0 contract)",
    ).toBe(runId);

    // Body shape — Murmur's M10 webhook ships the composed `final_output`
    // directly as the JSON body (no `{ run_id, pipeline_id, ...,
    // final_output }` wrapper). The Idempotency-Key header carries the
    // run_id; the publisher-side dedupes on that. The body's content is
    // the §3.1 composed shape.
    const finalOutput = JSON.parse(accept.body) as Record<string, unknown>;
    // §3.1 composes:
    //   - pre-verify.canonical_*  → canonical_name + canonical_website
    //   - boards: list-boards.boards × configure-board.*
    expect(finalOutput).toMatchObject({
      canonical_name: "Example, Inc.",
      canonical_website: "https://example.com",
    });
    expect(
      Array.isArray(finalOutput.boards),
      "final_output.boards must be an array (§3.1 cartesian compose rule)",
    ).toBe(true);
    const boardsArr = finalOutput.boards as ReadonlyArray<
      Record<string, unknown>
    >;
    expect(boardsArr).toHaveLength(1);
    expect(boardsArr[0]).toMatchObject({
      alias: "a",
      outcome: "configured",
      monitor_type: "rss",
    });
  });

  it("Webhook replay (one retry): mock-jobseek receives 2 calls, applies side-effect once", async () => {
    harness = await startHarness();
    const runId = await startRun(harness);

    await runScriptedAgent({
      app: harness.app,
      db: harness.db,
      bearer: TEST_TOKEN,
      boards: [
        { alias: "a", url: "https://example.com/a", provider: "greenhouse" },
      ],
    });
    await drainWebhooks(harness);

    // Sanity: first delivery happened.
    expect(
      harness.mock.acceptApplyCount(),
      "first webhook delivery should have applied once",
    ).toBe(1);
    expect(harness.mock.seenIdempotencyKeys()).toEqual([runId]);

    const beforeReplay = requestsTo(harness.mock.received, "/api/murmur/accept")
      .length;

    // Simulate a Murmur retry: reset webhook_status to 'pending' so the
    // idempotency guard inside `deliverWebhook` does not short-circuit,
    // then re-invoke. We use a deterministic immediate-fire scheduler
    // so the (potential) one retry runs synchronously, but our mock
    // returns 200 first attempt so no retry will fire here either way.
    harness.db
      .prepare(`UPDATE runs SET webhook_status = 'pending' WHERE id = ?`)
      .run(runId);

    const fakeSetTimeout: WebhookSetTimeout = (cb, _ms) => {
      // Run sync — safe because we never throw inside cb in this test.
      cb();
      return 0;
    };
    // Wrap the default fetch via a thin pass-through so we don't have
    // to re-implement the undici call. The webhook module's default
    // transport is fine; we only need to control the scheduler here.
    const passThroughFetch: WebhookFetch = async (url, init) => {
      const { request } = await import("undici");
      const res = await request(url, {
        method: "POST",
        headers: init.headers,
        body: init.body,
      });
      // Drain.
      try {
        for await (const _ of res.body) void _;
      } catch {
        // ignore
      }
      return { status: res.statusCode };
    };

    await deliverWebhook(harness.db, runId, {
      bearer: TEST_TOKEN,
      setTimeoutFn: fakeSetTimeout,
      fetchImpl: passThroughFetch,
    });
    await drainWebhooks(harness);

    const afterReplay = requestsTo(harness.mock.received, "/api/murmur/accept")
      .length;
    expect(
      afterReplay - beforeReplay,
      "second deliverWebhook call must be visible to mock-jobseek",
    ).toBe(1);

    // Apply side-effect: still ONE distinct Idempotency-Key applied
    // (the publisher is idempotent on the writer side).
    expect(
      harness.mock.acceptApplyCount(),
      "duplicate Idempotency-Key must NOT increment the apply counter",
    ).toBe(1);
    expect(harness.mock.seenIdempotencyKeys()).toEqual([runId]);

    // Second delivery's Idempotency-Key matches the first.
    const accepts = requestsTo(harness.mock.received, "/api/murmur/accept");
    expect(accepts).toHaveLength(2);
    const idem0 = findRawHeader(
      accepts[0]!.rawHeaders,
      MurmurHeaders.IDEMPOTENCY_KEY,
    );
    const idem1 = findRawHeader(
      accepts[1]!.rawHeaders,
      MurmurHeaders.IDEMPOTENCY_KEY,
    );
    expect(idem0?.value).toBe(runId);
    expect(idem1?.value).toBe(runId);
  });

  it("No envelope ever carries an `accepted` key (strict M0 enforcement)", async () => {
    harness = await startHarness();
    await startRun(harness);

    const taskToolCalls: TaskToolResponse[] = [];
    const murmurCalls: EnvelopeResponse<unknown>[] = [];

    await runScriptedAgent({
      app: harness.app,
      db: harness.db,
      bearer: TEST_TOKEN,
      boards: [
        { alias: "a", url: "https://example.com/a", provider: "greenhouse" },
      ],
      taskToolCalls,
      murmurCalls,
    });
    await drainWebhooks(harness);

    // Every captured envelope.
    for (const env of [...taskToolCalls, ...murmurCalls]) {
      expect(JSON.stringify(env)).not.toMatch(/"accepted"/);
    }
    // Every body the mock received (Murmur-generated outbound traffic).
    for (const req of harness.mock.received) {
      expect(req.body).not.toMatch(/"accepted"/);
    }
  });
});
