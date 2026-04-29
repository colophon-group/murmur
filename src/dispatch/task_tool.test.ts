/**
 * Tests for `src/dispatch/task_tool.ts` — the `task_tool` dispatcher
 * (DESIGN.md §3.4, §3.6).
 *
 * Test bullets are taken verbatim from issue #12's "Verification"
 * section. Every named bullet has at least one corresponding `it()`
 * below; the bullet text is included in the test title.
 *
 * The publisher is stubbed by a real `node:http` server so we can
 * observe socket-level behaviour (abort + close on timeout, abort +
 * close on response cap). MSW would also work but trades some control
 * over the stream lifetime.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

import type Database from "better-sqlite3";

import { MurmurHeaders } from "@murmur/contracts-types";

import { openDb } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";

import { closeAllPools, dispatchTaskTool, poolCount } from "./task_tool.js";
import { AUDIT_PAYLOAD_LIMIT_BYTES, truncateForAudit } from "./audit.js";

/* -------------------------------------------------------------------- */
/* Stub publisher server                                                 */
/* -------------------------------------------------------------------- */

interface StubServer {
  readonly origin: string;
  readonly received: Array<{
    readonly method: string;
    readonly path: string;
    readonly headers: Record<string, string | string[] | undefined>;
    readonly body: string;
  }>;
  /** Connections actually opened on this server. */
  readonly connections: { readonly closed: number; readonly opened: number };
  /** Set the next request handler. */
  setHandler(handler: (req: IncomingMessage, res: ServerResponse) => void): void;
  close(): Promise<void>;
}

async function startStubServer(): Promise<StubServer> {
  const received: Array<{
    method: string;
    path: string;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }> = [];
  const counts = { opened: 0, closed: 0 };
  let handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end("{}");
  };

  const server: Server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      received.push({
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        body,
      });
      handler(req, res);
    });
  });

  server.on("connection", (sock) => {
    counts.opened += 1;
    sock.on("close", () => {
      counts.closed += 1;
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${addr.port}`;

  return {
    origin,
    received,
    connections: counts,
    setHandler(h) {
      handler = h;
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        // Force-disconnect any kept-alive sockets so close() resolves promptly.
        server.closeAllConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

/* -------------------------------------------------------------------- */
/* Test harness — DB seeding helpers                                     */
/* -------------------------------------------------------------------- */

/**
 * Pinned "now" for the seeded fixture. The dispatcher uses `nowFn` for
 * both the `expires_at > ?` filter in the claim-resolution SQL and the
 * `agent_actions.ts` audit timestamp; if the test relies on the real
 * wall clock instead, every test that seeds the default 10-min TTL
 * fails as soon as the wall clock advances past `SEEDED_NOW + 10min`
 * (i.e. always, in CI). Pin a deterministic "now" inside the seeded
 * TTL window for every dispatch call.
 */
const SEEDED_NOW = "2026-04-29T12:00:00.000Z";
const seededNowFn = (): string => SEEDED_NOW;

interface SeededClaim {
  readonly db: Database.Database;
  readonly claimToken: string;
  readonly instanceId: string;
  readonly runId: string;
}

interface SeedOptions {
  /** Subcommand name; default `"probe"`. */
  readonly subcommand?: string;
  /** Endpoint; required so the test can point at the stub origin. */
  readonly endpoint: string;
  /** Subcommand input schema; default `{ type: "object" }` (any object). */
  readonly inputSchema?: Record<string, unknown>;
  /** Status of the claim row; default `"claimed"`. */
  readonly status?: string;
  /** TTL — `expiresAt = now + ttlMs`; default 10 min. */
  readonly ttlMs?: number;
  /** Override the claim token; default `"c_test"`. */
  readonly claimToken?: string;
}

function seedClaim(opts: SeedOptions): SeededClaim {
  const db = openDb(":memory:");
  runMigrations(db);

  const now = SEEDED_NOW;
  const ttl = opts.ttlMs ?? 600_000;
  const expiresAt = new Date(Date.parse(now) + ttl).toISOString();
  const claimToken = opts.claimToken ?? "c_test";

  const def = {
    id: "test-pipe",
    subtasks: [
      {
        id: "the-subtask",
        instructions: "do it",
        output_schema: { type: "object" },
        subcommands: [
          {
            name: opts.subcommand ?? "probe",
            endpoint: opts.endpoint,
            input_schema: opts.inputSchema ?? { type: "object" },
          },
          {
            name: "other-subcmd",
            endpoint: opts.endpoint,
          },
        ],
      },
    ],
  };

  db.prepare(
    `INSERT INTO pipelines (id, version, def_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("test-pipe", 1, JSON.stringify(def), now, now);

  const runId = "run-1";
  db.prepare(
    `INSERT INTO runs (id, pipeline_id, pipeline_version, status,
                       initial_input_json, webhook_url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(runId, "test-pipe", 1, "running", "{}", "http://example/webhook", now);

  const instanceId = "inst-1";
  db.prepare(
    `INSERT INTO subtask_instances
       (id, run_id, subtask_id, status, claim_token, expires_at,
        input_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    instanceId,
    runId,
    "the-subtask",
    opts.status ?? "claimed",
    claimToken,
    expiresAt,
    "{}",
    now,
    now,
  );

  return { db, claimToken, instanceId, runId };
}

/* -------------------------------------------------------------------- */
/* Pooling teardown                                                      */
/* -------------------------------------------------------------------- */

let stub: StubServer | undefined;

beforeEach(async () => {
  stub = await startStubServer();
});

afterEach(async () => {
  await closeAllPools();
  await stub?.close();
  stub = undefined;
});

afterAll(async () => {
  await closeAllPools();
});

/* -------------------------------------------------------------------- */
/* Tests                                                                 */
/* -------------------------------------------------------------------- */

describe("dispatchTaskTool — claim resolution", () => {
  it("Unknown claim → { ok: false, errors: ['claim_lost'] }", async () => {
    const { db } = seedClaim({ endpoint: `POST ${stub!.origin}/probe` });

    const result = await dispatchTaskTool({
      db,
      claimToken: "c_does_not_exist",
      subcommand: "probe",
      args: {},
      bearer: "TOK",
      nowFn: seededNowFn,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("claim_lost");
    }
  });

  it("Expired claim (expires_at in the past) → claim_lost", async () => {
    // Seed a claim that's already expired by setting ttl to a negative
    // value. We pass `nowFn` so the dispatcher's "now" comparison is
    // deterministic against the seeded `expires_at` regardless of
    // real wallclock.
    const { db } = seedClaim({
      endpoint: `POST ${stub!.origin}/probe`,
      ttlMs: -1000,
    });

    const result = await dispatchTaskTool({
      db,
      claimToken: "c_test",
      subcommand: "probe",
      args: {},
      bearer: "TOK",
      // Seeded "now" was 2026-04-29T12:00:00; expires_at = T11:59:59.
      // Pin "now" 1 ms after the seeded clock.
      nowFn: () => "2026-04-29T12:00:00.001Z",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("claim_lost");
    }
  });

  it("Done claim (status='done') → claim_lost", async () => {
    const { db } = seedClaim({
      endpoint: `POST ${stub!.origin}/probe`,
      status: "done",
    });

    const result = await dispatchTaskTool({
      db,
      claimToken: "c_test",
      subcommand: "probe",
      args: {},
      bearer: "TOK",
      nowFn: seededNowFn,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("claim_lost");
    }
  });
});

describe("dispatchTaskTool — subcommand resolution", () => {
  it("Unknown subcommand → { ok: false, errors: ['unknown_subcommand'], data: { available: [...] } }", async () => {
    const { db } = seedClaim({ endpoint: `POST ${stub!.origin}/probe` });

    const result = await dispatchTaskTool({
      db,
      claimToken: "c_test",
      subcommand: "no-such-subcmd",
      args: {},
      bearer: "TOK",
      nowFn: seededNowFn,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("unknown_subcommand");
    }
    // The unknown_subcommand path also returns the available list as
    // the `data` slot — this lets the agent self-correct without an
    // extra round-trip.
    expect("data" in result && result.data).toBeTruthy();
    if ("data" in result && result.data) {
      const avail = (result.data as { available: ReadonlyArray<string> }).available;
      expect(avail).toContain("probe");
      expect(avail).toContain("other-subcmd");
    }
  });
});

describe("dispatchTaskTool — args validation", () => {
  it("Args fail schema → { ok: false, errors: ['validation:/foo/bar:type mismatch'] }", async () => {
    const { db } = seedClaim({
      endpoint: `POST ${stub!.origin}/probe`,
      inputSchema: {
        type: "object",
        required: ["foo"],
        properties: {
          foo: {
            type: "object",
            required: ["bar"],
            properties: { bar: { type: "string" } },
          },
        },
      },
    });

    const result = await dispatchTaskTool({
      db,
      claimToken: "c_test",
      subcommand: "probe",
      args: { foo: { bar: 123 } },
      bearer: "TOK",
      nowFn: seededNowFn,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Ajv emits "validation:/foo/bar:must be string" — assert the
      // shape, not the exact wording (Ajv version drift).
      expect(
        result.errors.some(
          (e) => typeof e === "string" && e.startsWith("validation:/foo/bar:"),
        ),
      ).toBe(true);
    }
  });
});

describe("dispatchTaskTool — proxy success path", () => {
  it("Stub publisher 200 → forwarded body in data", async () => {
    stub!.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, postings_seen: 42 }));
    });

    const { db } = seedClaim({ endpoint: `POST ${stub!.origin}/probe` });

    const result = await dispatchTaskTool({
      db,
      claimToken: "c_test",
      subcommand: "probe",
      args: { board_url: "https://example.com" },
      bearer: "TOK",
      nowFn: seededNowFn,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ ok: true, postings_seen: 42 });
    }
  });

  it("Bearer header included in proxy request", async () => {
    stub!.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end("{}");
    });

    const { db } = seedClaim({ endpoint: `POST ${stub!.origin}/probe` });

    await dispatchTaskTool({
      db,
      claimToken: "c_test",
      subcommand: "probe",
      args: {},
      bearer: "TOKEN_VALUE",
      nowFn: seededNowFn,
    });

    expect(stub!.received[0]?.headers.authorization).toBe("Bearer TOKEN_VALUE");
  });

  it("X-Murmur-Subcommand and X-Murmur-Claim-Token headers present on proxy request", async () => {
    stub!.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end("{}");
    });

    const { db } = seedClaim({ endpoint: `POST ${stub!.origin}/probe` });

    await dispatchTaskTool({
      db,
      claimToken: "c_test",
      subcommand: "probe",
      args: {},
      bearer: "TOK",
      nowFn: seededNowFn,
    });

    const headers = stub!.received[0]!.headers;
    expect(headers[MurmurHeaders.X_MURMUR_SUBCOMMAND.toLowerCase()]).toBe(
      "probe",
    );
    expect(headers[MurmurHeaders.X_MURMUR_CLAIM_TOKEN.toLowerCase()]).toBe(
      "c_test",
    );
  });

  it("forwards the agent's args as the JSON body", async () => {
    stub!.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end("{}");
    });

    const { db } = seedClaim({ endpoint: `POST ${stub!.origin}/probe` });

    await dispatchTaskTool({
      db,
      claimToken: "c_test",
      subcommand: "probe",
      args: { board_url: "https://example.com", token: "abc" },
      bearer: "TOK",
      nowFn: seededNowFn,
    });

    const body = stub!.received[0]!.body;
    expect(JSON.parse(body)).toEqual({
      board_url: "https://example.com",
      token: "abc",
    });
  });
});

describe("dispatchTaskTool — publisher failure modes", () => {
  it("Stub publisher 5xx → { ok: false, errors: ['publisher_5xx', '503'] }", async () => {
    stub!.setHandler((_req, res) => {
      res.statusCode = 503;
      res.end("upstream broken");
    });

    const { db } = seedClaim({ endpoint: `POST ${stub!.origin}/probe` });

    const result = await dispatchTaskTool({
      db,
      claimToken: "c_test",
      subcommand: "probe",
      args: {},
      bearer: "TOK",
      nowFn: seededNowFn,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("publisher_5xx");
      expect(result.errors).toContain("503");
    }
  });

  it("Stub publisher hangs > timeout → publisher_timeout AND outbound socket aborted", async () => {
    // The stub never finishes the response. We listen for the request's
    // 'close' event server-side: when the client aborts, Node emits
    // 'close' on the IncomingMessage. That's the canonical signal that
    // the upstream connection actually closed (vs. just the AbortController
    // firing client-side without affecting the wire).
    const sawServerSideClose = new Promise<void>((resolve) => {
      stub!.setHandler((req, _res) => {
        req.on("close", () => resolve());
      });
    });

    const { db } = seedClaim({ endpoint: `POST ${stub!.origin}/probe` });

    const result = await dispatchTaskTool({
      db,
      claimToken: "c_test",
      subcommand: "probe",
      args: {},
      bearer: "TOK",
      timeoutMs: 100,
      nowFn: seededNowFn,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("publisher_timeout");
    }

    // Server must observe the connection close as a result of the abort.
    // Race with a 1s safety timer so a regression doesn't hang the suite.
    const observed = await Promise.race([
      sawServerSideClose.then(() => "closed" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 1000)),
    ]);
    expect(observed).toBe("closed");
  });

  it("Stub publisher streams > cap → publisher_response_too_large AND read aborted", async () => {
    // Stream a body larger than `responseCapBytes`. We use a small cap
    // (2 KB) so the test runs fast. Server flushes 512-byte chunks
    // until the client closes.
    let chunksWritten = 0;
    let serverEnded = false;
    const sawServerSideClose = new Promise<void>((resolve) => {
      stub!.setHandler((_req, res) => {
        res.statusCode = 200;
        res.setHeader("content-type", "application/octet-stream");
        // Don't set content-length; chunked encoding.
        const interval = setInterval(() => {
          if (res.writableEnded || res.destroyed) {
            clearInterval(interval);
            return;
          }
          res.write(Buffer.alloc(512, 0x41));
          chunksWritten += 1;
          if (chunksWritten > 200) {
            clearInterval(interval);
            serverEnded = true;
            res.end();
          }
        }, 5);
        res.on("close", () => {
          clearInterval(interval);
          resolve();
        });
      });
    });

    const { db } = seedClaim({ endpoint: `POST ${stub!.origin}/probe` });

    const result = await dispatchTaskTool({
      db,
      claimToken: "c_test",
      subcommand: "probe",
      args: {},
      bearer: "TOK",
      responseCapBytes: 2 * 1024,
      nowFn: seededNowFn,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("publisher_response_too_large");
    }

    // Wait for the server-side close to fire as a result of the client
    // aborting — proves the abort actually closed the wire connection.
    const observed = await Promise.race([
      sawServerSideClose.then(() => "closed" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 1000)),
    ]);
    expect(observed).toBe("closed");

    // Sanity: chunks written when client cancelled is much less than the
    // 200-chunk full payload — proves we aborted mid-stream.
    expect(chunksWritten).toBeLessThan(200);
    expect(serverEnded).toBe(false);
  });
});

describe("dispatchTaskTool — audit log", () => {
  it("each call writes one row to agent_actions with truncated args_json and response_json", async () => {
    stub!.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ result: "x" }));
    });

    const { db, instanceId } = seedClaim({ endpoint: `POST ${stub!.origin}/probe` });

    await dispatchTaskTool({
      db,
      claimToken: "c_test",
      subcommand: "probe",
      args: { kind: "small" },
      bearer: "TOK",
      nowFn: seededNowFn,
    });

    const rows = db
      .prepare(
        `SELECT instance_id, kind, subcommand, args_json, response_json, truncated
           FROM agent_actions
          WHERE kind = 'task_tool'`,
      )
      .all() as Array<{
      instance_id: string;
      kind: string;
      subcommand: string | null;
      args_json: string | null;
      response_json: string | null;
      truncated: number;
    }>;

    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.instance_id).toBe(instanceId);
    expect(r.kind).toBe("task_tool");
    expect(r.subcommand).toBe("probe");
    expect(r.args_json).toBeTruthy();
    expect(r.response_json).toBeTruthy();
    expect(JSON.parse(r.args_json!)).toEqual({ kind: "small" });
    expect(JSON.parse(r.response_json!)).toEqual({ result: "x" });
    expect(r.truncated).toBe(0);
  });

  it("oversize args_json and response_json are truncated to 4 KB and the row is flagged", async () => {
    // 8 KB response.
    const big = "X".repeat(8 * 1024);
    stub!.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ blob: big }));
    });

    const { db } = seedClaim({
      endpoint: `POST ${stub!.origin}/probe`,
      // No input schema → 8 KB args pass through unvalidated.
    });

    const args = { blob: big };
    await dispatchTaskTool({
      db,
      claimToken: "c_test",
      subcommand: "probe",
      args,
      bearer: "TOK",
      nowFn: seededNowFn,
    });

    const r = db
      .prepare(
        `SELECT args_json, response_json, truncated FROM agent_actions WHERE kind='task_tool'`,
      )
      .get() as {
      args_json: string;
      response_json: string;
      truncated: number;
    };
    expect(Buffer.byteLength(r.args_json, "utf8")).toBeLessThanOrEqual(
      AUDIT_PAYLOAD_LIMIT_BYTES,
    );
    expect(Buffer.byteLength(r.response_json, "utf8")).toBeLessThanOrEqual(
      AUDIT_PAYLOAD_LIMIT_BYTES,
    );
    expect(r.truncated).toBe(1);
  });

  it("audit row is also written on publisher 5xx (so operators can diagnose)", async () => {
    stub!.setHandler((_req, res) => {
      res.statusCode = 503;
      res.end("oops");
    });

    const { db } = seedClaim({ endpoint: `POST ${stub!.origin}/probe` });

    await dispatchTaskTool({
      db,
      claimToken: "c_test",
      subcommand: "probe",
      args: { x: 1 },
      bearer: "TOK",
      nowFn: seededNowFn,
    });

    const rows = db
      .prepare(
        `SELECT response_json FROM agent_actions WHERE kind='task_tool'`,
      )
      .all() as Array<{ response_json: string }>;
    expect(rows).toHaveLength(1);
  });
});

describe("dispatchTaskTool — connection pooling", () => {
  it("100 concurrent calls resolve and don't blow open 100 sockets", async () => {
    let inflight = 0;
    let peakInflight = 0;
    stub!.setHandler((_req, res) => {
      inflight += 1;
      peakInflight = Math.max(peakInflight, inflight);
      // Tiny delay so concurrency is observable.
      setTimeout(() => {
        inflight -= 1;
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end("{}");
      }, 10);
    });

    const { db } = seedClaim({ endpoint: `POST ${stub!.origin}/probe` });

    const calls = Array.from({ length: 100 }, () =>
      dispatchTaskTool({
        db,
        claimToken: "c_test",
        subcommand: "probe",
        args: {},
        bearer: "TOK",
        nowFn: seededNowFn,
      }),
    );

    const results = await Promise.all(calls);
    expect(results.every((r) => r.ok)).toBe(true);

    // Hard cap is 50 per origin per the issue's quality gate. With 100
    // concurrent calls the peak in-flight at the publisher must be ≤ 50.
    expect(peakInflight).toBeLessThanOrEqual(50);

    // Pool cache should have exactly one entry — one origin reused.
    expect(poolCount()).toBe(1);

    // After all are done, give sockets a tick to settle then ensure
    // server has closed at least as many as it opened minus the
    // keep-alive idles still open inside the pool.
    await new Promise((r) => setTimeout(r, 50));
    expect(stub!.connections.opened).toBeLessThanOrEqual(50);
  });
});

describe("truncateForAudit", () => {
  it("returns null for null input", () => {
    expect(truncateForAudit(null)).toEqual({ text: null, truncated: false });
  });

  it("returns input unchanged when within cap", () => {
    const r = truncateForAudit("hello");
    expect(r).toEqual({ text: "hello", truncated: false });
  });

  it("clips inputs above cap and flags truncated", () => {
    const big = "X".repeat(AUDIT_PAYLOAD_LIMIT_BYTES + 100);
    const r = truncateForAudit(big);
    expect(r.truncated).toBe(true);
    expect(r.text).not.toBeNull();
    expect(Buffer.byteLength(r.text!, "utf8")).toBeLessThanOrEqual(
      AUDIT_PAYLOAD_LIMIT_BYTES,
    );
  });

  it("clips on a UTF-8 boundary (no half-character at the cut)", () => {
    // Build a string of 4-byte UTF-8 characters (an emoji) such that
    // the byte cap falls in the middle of one.
    const emoji = "\u{1F600}"; // 4 bytes in UTF-8
    const count = Math.floor(AUDIT_PAYLOAD_LIMIT_BYTES / 4) + 5;
    const big = emoji.repeat(count);
    const r = truncateForAudit(big);
    expect(r.truncated).toBe(true);
    expect(r.text).not.toBeNull();
    // The clipped text should be valid UTF-8 with no replacement char.
    expect(r.text).not.toMatch(/�/);
  });
});
