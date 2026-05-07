/**
 * Tests for `src/webhook.ts` — webhook delivery (M10 / issue #15).
 *
 * Test bullets are taken verbatim from the issue's "Verification"
 * section. Every named bullet has an `it()` whose title quotes it.
 *
 * Strategy:
 *   - Each test gets a fresh in-memory SQLite. Fixtures seed a
 *     pipeline def with a single-subtask `composes: ['<subtask>.*']`
 *     so `composeFinalOutput` flattens the submitted output into the
 *     webhook body verbatim.
 *   - The transport is stubbed via `fetchImpl`. We capture every call's
 *     URL + headers + body so the bearer / Idempotency-Key / Content-Type
 *     and body shape can be asserted directly without standing up an
 *     HTTP server.
 *   - The retry timer is stubbed via `setTimeoutFn` with a manual
 *     stand-in (`makeManualScheduler`) that records the requested ms
 *     and exposes `runAll()` to deterministically fire the retry.
 *     Vitest's `vi.useFakeTimers()` would also work but the manual
 *     scheduler keeps the assertion "exactly 30s elapsed" trivial.
 *   - `awaitPendingWebhookDeliveries` is awaited between assertions
 *     and final teardown so module-scoped state doesn't bleed.
 */

import type Database from "better-sqlite3";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import type { PipelineDef } from "@murmur/contracts-types";

import { openDb } from "./db/index.js";
import { runMigrations } from "./db/migrate.js";
import {
  awaitPendingWebhookDeliveries,
  DEFAULT_WEBHOOK_RETRY_DELAY_MS,
  deliverWebhook,
  resetPendingWebhookDeliveriesForTest,
  scrubUrlForLog,
  type WebhookFetch,
  type WebhookHttpResponse,
} from "./webhook.js";

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

const PIPELINE_ID = "test-pipe";
const RUN_ID = "run-1";
const WEBHOOK_URL = "https://publisher.test/webhook";
const BEARER_TOKEN = "test-bearer-token";
const SEED_NOW = "2026-04-29T12:00:00.000Z";

interface PipelineDefForSeed extends PipelineDef {
  readonly final_output: {
    readonly composes: ReadonlyArray<string>;
    readonly webhook: string;
  };
}

const PIPELINE_DEF: PipelineDefForSeed = {
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

interface SeedOptions {
  /** Override the run's webhook_url. Default: `WEBHOOK_URL`. */
  readonly webhookUrl?: string;
  /** Override the run's webhook_status. Default: `null` (initial state). */
  readonly webhookStatus?: string | null;
  /** Override the submitted output. Default `{ ok: true }`. */
  readonly output?: unknown;
  /**
   * If `true`, omit the `subtask_results` row (simulating a still-
   * pending child). Used by the "does not fire while children pending"
   * test.
   */
  readonly skipResult?: boolean;
}

/**
 * Seed a single completed run with one done subtask + result, ready
 * for {@link deliverWebhook}.
 */
function seedRun(opts: SeedOptions = {}): Database.Database {
  const db = openDb(":memory:");
  runMigrations(db);

  db.prepare(
    `INSERT INTO pipelines (id, publisher_id, version, def_json, created_at, updated_at)
     VALUES (?, 'pub_demo_seed', ?, ?, ?, ?)`,
  ).run(PIPELINE_ID, 1, JSON.stringify(PIPELINE_DEF), SEED_NOW, SEED_NOW);

  db.prepare(
    `INSERT INTO runs
       (id, pipeline_id, pipeline_version, status, initial_input_json,
        webhook_url, webhook_status, created_at, completed_at)
     VALUES (?, ?, ?, 'completed', '{}', ?, ?, ?, ?)`,
  ).run(
    RUN_ID,
    PIPELINE_ID,
    1,
    opts.webhookUrl ?? WEBHOOK_URL,
    opts.webhookStatus ?? null,
    SEED_NOW,
    SEED_NOW,
  );

  db.prepare(
    `INSERT INTO subtask_instances
       (id, run_id, subtask_id, status, input_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, '{}', ?, ?)`,
  ).run(
    "inst-1",
    RUN_ID,
    "the-subtask",
    opts.skipResult === true ? "ready" : "done",
    SEED_NOW,
    SEED_NOW,
  );

  if (opts.skipResult !== true) {
    const output = opts.output ?? { ok: true };
    db.prepare(
      `INSERT INTO subtask_results (instance_id, output_json, submitted_at)
       VALUES (?, ?, ?)`,
    ).run("inst-1", JSON.stringify(output), SEED_NOW);
  }

  return db;
}

// --------------------------------------------------------------------------
// Test doubles
// --------------------------------------------------------------------------

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * Build a fetch stub that returns the given sequence of responses
 * (one per call), recording each call. After all canned responses are
 * exhausted, subsequent calls reject.
 */
function makeFetchStub(
  responses: ReadonlyArray<WebhookHttpResponse>,
): {
  readonly fetchImpl: WebhookFetch;
  readonly calls: ReadonlyArray<RecordedCall>;
} {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fetchImpl: WebhookFetch = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body,
    });
    if (i >= responses.length) {
      throw new Error(`fetch stub exhausted at call ${i + 1}`);
    }
    const r = responses[i] as WebhookHttpResponse;
    i += 1;
    return r;
  };
  return { fetchImpl, calls };
}

interface ManualScheduler {
  readonly setTimeoutFn: (cb: () => void, ms: number) => unknown;
  readonly delays: ReadonlyArray<number>;
  /** Fire all scheduled callbacks in FIFO order. */
  runAll(): Promise<void>;
}

/**
 * Manual replacement for `setTimeout` so we can assert "exactly 30s
 * elapsed" without sleeping. Each scheduled callback is queued; the
 * test calls `runAll()` to fire them in order. Fires are async so the
 * detached retry path's awaits resolve.
 */
function makeManualScheduler(): ManualScheduler {
  const queue: Array<() => void> = [];
  const delays: number[] = [];
  return {
    setTimeoutFn(cb, ms) {
      delays.push(ms);
      queue.push(cb);
      return delays.length;
    },
    get delays() {
      return delays;
    },
    async runAll() {
      // Drain in waves — a callback can schedule another timer.
      while (queue.length > 0) {
        const next = queue.shift();
        if (next === undefined) break;
        next();
        // Yield so any promise chains inside `next` settle before we
        // pull the next one.
        await Promise.resolve();
        await Promise.resolve();
      }
    },
  };
}

// --------------------------------------------------------------------------
// Setup / teardown
// --------------------------------------------------------------------------

beforeEach(() => {
  resetPendingWebhookDeliveriesForTest();
});

afterEach(async () => {
  await awaitPendingWebhookDeliveries();
  resetPendingWebhookDeliveriesForTest();
});

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe("deliverWebhook — success path", () => {
  it("Successful run → webhook fires with correct headers, body matches final_output", async () => {
    const db = seedRun({ output: { ok: true, count: 7 } });
    const { fetchImpl, calls } = makeFetchStub([{ status: 200 }]);
    const scheduler = makeManualScheduler();

    await deliverWebhook(db, RUN_ID, {
      bearer: BEARER_TOKEN,
      fetchImpl,
      setTimeoutFn: scheduler.setTimeoutFn,
    });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) throw new Error("expected one call");
    expect(call.url).toBe(WEBHOOK_URL);
    expect(call.method).toBe("POST");
    expect(call.headers["content-type"] ?? call.headers["Content-Type"]).toBe(
      "application/json",
    );
    expect(call.headers["authorization"] ?? call.headers["Authorization"]).toBe(
      `Bearer ${BEARER_TOKEN}`,
    );
    expect(
      call.headers["idempotency-key"] ?? call.headers["Idempotency-Key"],
    ).toBe(RUN_ID);
    // Body is the composed final_output, not the raw subtask result.
    // `the-subtask.*` flattens fields onto the top-level object.
    const parsed = JSON.parse(call.body) as { ok: boolean; count: number };
    expect(parsed).toEqual({ ok: true, count: 7 });
    db.close();
  });

  it("200 response → runs.webhook_status = 'delivered' and no retry", async () => {
    const db = seedRun();
    const { fetchImpl, calls } = makeFetchStub([{ status: 200 }]);
    const scheduler = makeManualScheduler();

    await deliverWebhook(db, RUN_ID, {
      bearer: BEARER_TOKEN,
      fetchImpl,
      setTimeoutFn: scheduler.setTimeoutFn,
    });
    await awaitPendingWebhookDeliveries();

    const row = db
      .prepare("SELECT webhook_status FROM runs WHERE id = ?")
      .get(RUN_ID) as { webhook_status: string };
    expect(row.webhook_status).toBe("delivered");
    expect(scheduler.delays).toEqual([]);
    expect(calls).toHaveLength(1);
    db.close();
  });

  it("Idempotency-Key header equals run_id", async () => {
    const db = seedRun();
    const { fetchImpl, calls } = makeFetchStub([{ status: 200 }]);

    await deliverWebhook(db, RUN_ID, {
      bearer: BEARER_TOKEN,
      fetchImpl,
      setTimeoutFn: makeManualScheduler().setTimeoutFn,
    });

    const call = calls[0];
    if (call === undefined) throw new Error("expected a call");
    expect(
      call.headers["idempotency-key"] ?? call.headers["Idempotency-Key"],
    ).toBe(RUN_ID);
    db.close();
  });

  it("Webhook is bearer-authed (test stub asserts Authorization header)", async () => {
    const db = seedRun();
    const { fetchImpl, calls } = makeFetchStub([{ status: 200 }]);

    await deliverWebhook(db, RUN_ID, {
      bearer: "secret-token",
      fetchImpl,
      setTimeoutFn: makeManualScheduler().setTimeoutFn,
    });

    const call = calls[0];
    if (call === undefined) throw new Error("expected a call");
    expect(
      call.headers["authorization"] ?? call.headers["Authorization"],
    ).toBe("Bearer secret-token");
    db.close();
  });
});

describe("deliverWebhook — retry path", () => {
  it("500 response → retry after 30s; if second 500 → webhook_status = 'failed'", async () => {
    const db = seedRun();
    const { fetchImpl, calls } = makeFetchStub([
      { status: 500 },
      { status: 500 },
    ]);
    const scheduler = makeManualScheduler();

    await deliverWebhook(db, RUN_ID, {
      bearer: BEARER_TOKEN,
      fetchImpl,
      setTimeoutFn: scheduler.setTimeoutFn,
    });

    // After the first attempt, status stays `pending` (retry queued).
    let row = db
      .prepare("SELECT webhook_status FROM runs WHERE id = ?")
      .get(RUN_ID) as { webhook_status: string };
    expect(row.webhook_status).toBe("pending");
    expect(scheduler.delays).toEqual([DEFAULT_WEBHOOK_RETRY_DELAY_MS]);

    // Fire the retry deterministically.
    await scheduler.runAll();
    await awaitPendingWebhookDeliveries();

    row = db
      .prepare("SELECT webhook_status FROM runs WHERE id = ?")
      .get(RUN_ID) as { webhook_status: string };
    expect(row.webhook_status).toBe("failed");
    expect(calls).toHaveLength(2);
    // Retry MUST NOT schedule another timer — at most ONE retry.
    expect(scheduler.delays).toEqual([DEFAULT_WEBHOOK_RETRY_DELAY_MS]);
    db.close();
  });

  it("200 on retry → webhook_status = 'delivered'", async () => {
    const db = seedRun();
    const { fetchImpl, calls } = makeFetchStub([
      { status: 502 },
      { status: 200 },
    ]);
    const scheduler = makeManualScheduler();

    await deliverWebhook(db, RUN_ID, {
      bearer: BEARER_TOKEN,
      fetchImpl,
      setTimeoutFn: scheduler.setTimeoutFn,
    });
    await scheduler.runAll();
    await awaitPendingWebhookDeliveries();

    const row = db
      .prepare("SELECT webhook_status FROM runs WHERE id = ?")
      .get(RUN_ID) as { webhook_status: string };
    expect(row.webhook_status).toBe("delivered");
    expect(calls).toHaveLength(2);
    db.close();
  });

  it("Retry timing uses fake timers; assert exactly 30s elapsed", async () => {
    const db = seedRun();
    const { fetchImpl } = makeFetchStub([{ status: 503 }, { status: 200 }]);
    const scheduler = makeManualScheduler();

    await deliverWebhook(db, RUN_ID, {
      bearer: BEARER_TOKEN,
      fetchImpl,
      setTimeoutFn: scheduler.setTimeoutFn,
    });

    // Exactly one timer scheduled, and at exactly 30 000 ms.
    expect(scheduler.delays).toEqual([30_000]);
    expect(scheduler.delays.length).toBe(1);
    await scheduler.runAll();
    await awaitPendingWebhookDeliveries();
    db.close();
  });

  it("transport error on first attempt is treated as non-2xx and retries", async () => {
    const db = seedRun();
    const calls: RecordedCall[] = [];
    let i = 0;
    const fetchImpl: WebhookFetch = async (url, init) => {
      calls.push({
        url,
        method: init.method,
        headers: init.headers,
        body: init.body,
      });
      if (i === 0) {
        i += 1;
        throw new Error("ECONNREFUSED");
      }
      i += 1;
      return { status: 200 };
    };
    const scheduler = makeManualScheduler();

    await deliverWebhook(db, RUN_ID, {
      bearer: BEARER_TOKEN,
      fetchImpl,
      setTimeoutFn: scheduler.setTimeoutFn,
    });
    expect(scheduler.delays).toEqual([DEFAULT_WEBHOOK_RETRY_DELAY_MS]);
    await scheduler.runAll();
    await awaitPendingWebhookDeliveries();

    const row = db
      .prepare("SELECT webhook_status FROM runs WHERE id = ?")
      .get(RUN_ID) as { webhook_status: string };
    expect(row.webhook_status).toBe("delivered");
    expect(calls).toHaveLength(2);
    db.close();
  });
});

describe("deliverWebhook — guards", () => {
  it("idempotent on a row already in delivered/failed state — no fetch", async () => {
    const db = seedRun({ webhookStatus: "delivered" });
    const { fetchImpl, calls } = makeFetchStub([]);

    await deliverWebhook(db, RUN_ID, {
      bearer: BEARER_TOKEN,
      fetchImpl,
      setTimeoutFn: makeManualScheduler().setTimeoutFn,
    });
    expect(calls).toEqual([]);
    db.close();
  });

  it("missing run id is logged and resolves without throwing", async () => {
    const db = seedRun();
    const { fetchImpl, calls } = makeFetchStub([]);

    await deliverWebhook(db, "no-such-run", {
      bearer: BEARER_TOKEN,
      fetchImpl,
      setTimeoutFn: makeManualScheduler().setTimeoutFn,
    });
    expect(calls).toEqual([]);
    db.close();
  });
});

describe("Webhook does not fire while spawned children are still pending", () => {
  /**
   * The CAS submit handler invokes `deliverWebhook` only when
   * `maybeFinaliseRun` returned `true`. With a child still pending,
   * that finaliser returns `false` and `deliverWebhook` is never
   * called, so this test exercises the integration boundary by way of
   * the agent app (not just the function in isolation).
   */
  it("agent submit on parent with still-pending child does NOT call the webhook hook", async () => {
    // Lazy import to avoid cycles at top-level.
    const { createAgentApp } = await import("./api/agent/index.js");
    const db = openDb(":memory:");
    runMigrations(db);

    // Pipeline: subtask `parent` with a child `child` that requires it.
    const def = {
      id: PIPELINE_ID,
      initial_input: { type: "object" },
      subtasks: [
        {
          id: "parent",
          instructions: "p",
          output_schema: {
            type: "object",
            properties: { ok: { type: "boolean" } },
            required: ["ok"],
            additionalProperties: false,
          },
        },
        {
          id: "child",
          instructions: "c",
          output_schema: { type: "object" },
          requires: ["parent"],
        },
      ],
      final_output: {
        composes: ["parent.*"],
        webhook: WEBHOOK_URL,
      },
    };
    db.prepare(
      `INSERT INTO pipelines (id, publisher_id, version, def_json, created_at, updated_at)
       VALUES (?, 'pub_demo_seed', ?, ?, ?, ?)`,
    ).run(PIPELINE_ID, 1, JSON.stringify(def), SEED_NOW, SEED_NOW);
    db.prepare(
      `INSERT INTO runs
         (id, pipeline_id, pipeline_version, status, initial_input_json,
          webhook_url, created_at)
       VALUES (?, ?, ?, 'running', '{}', ?, ?)`,
    ).run(RUN_ID, PIPELINE_ID, 1, WEBHOOK_URL, SEED_NOW);
    db.prepare(
      `INSERT INTO subtask_instances
         (id, run_id, subtask_id, status, input_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, '{}', ?, ?)`,
    ).run("inst-parent", RUN_ID, "parent", "ready", SEED_NOW, SEED_NOW);
    db.prepare(
      `INSERT INTO subtask_instances
         (id, run_id, subtask_id, status, input_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, '{}', ?, ?)`,
    ).run("inst-child", RUN_ID, "child", "pending", SEED_NOW, SEED_NOW);

    const fired: string[] = [];
    const app = createAgentApp({
      db,
      nowFn: () => SEED_NOW,
      claimTokenFn: () => "c_xyz",
      deliverWebhookFn: (runId) => {
        fired.push(runId);
      },
    });

    // Claim parent.
    const claimRes = await app.request("/next", { method: "GET" });
    expect(claimRes.status).toBe(200);

    // Submit parent.
    const submit = await app.request("/c_xyz/result", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ result: { ok: true } }),
    });
    expect(submit.status).toBe(200);

    // Child still pending → run not yet completed → webhook MUST NOT fire.
    expect(fired).toEqual([]);

    // Sanity: the run is still `running`, child is still ready.
    const runRow = db
      .prepare("SELECT status FROM runs WHERE id = ?")
      .get(RUN_ID) as { status: string };
    expect(runRow.status).toBe("running");
    db.close();
  });
});

describe("scrubUrlForLog", () => {
  it("returns just the host (no path / query) for a real URL", () => {
    expect(scrubUrlForLog("https://publisher.test/secret/path?token=zzz")).toBe(
      "publisher.test",
    );
  });

  it("returns a safe placeholder for an unparseable URL", () => {
    expect(scrubUrlForLog("not a url")).toBe("<unparseable>");
  });
});
