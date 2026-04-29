/**
 * Cross-cutting audit-log tests for issue #17 ("M12: audit log writer").
 *
 * Scope: behavior that spans multiple call paths into `agent_actions`.
 * The two existing in-tree audit tests (in `src/dispatch/task_tool.test.ts`
 * and the implicit M5 coverage in `src/api/agent/agent.test.ts`) cover
 * the per-call paths individually — this file adds the cross-cutting
 * verification bullets the issue calls out:
 *
 *   - `task_tool` writes one audit row with kind, args, response.
 *   - `submit_result` writes one audit row with kind='submit_result',
 *     args=result+notes, response=acceptance.
 *   - Field >4 KB is truncated silently (no marker on the DB-side write).
 *   - Truncation happens at the JSON-string level (the args object is
 *     stringified BEFORE truncation, never after).
 *   - `GET /runs/{run_id}` returns `agent_actions[]` ordered by `ts ASC`.
 *   - 1000 audit-log writes do not bloat the DB unexpectedly (<5 MB).
 *
 * @see DESIGN.md §3.6 — audit log truncation
 * @see src/dispatch/audit.ts — canonical truncation helper
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  createServer as createHttpServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { AddressInfo } from "node:net";

import type Database from "better-sqlite3";

import type { EnvelopeResponse } from "@murmur/contracts-types";

import { createAgentApp } from "./api/agent/index.js";
import { mountRunRoutes } from "./api/publisher/runs.js";
import { Hono } from "hono";
import {
  AUDIT_PAYLOAD_LIMIT_BYTES,
  truncateForAudit,
} from "./dispatch/audit.js";
import { closeAllPools, dispatchTaskTool } from "./dispatch/task_tool.js";
import { openDb } from "./db/index.js";
import { runMigrations } from "./db/migrate.js";

/* -------------------------------------------------------------------- */
/* Stub publisher                                                        */
/* -------------------------------------------------------------------- */

interface StubServer {
  readonly origin: string;
  setHandler(h: (req: IncomingMessage, res: ServerResponse) => void): void;
  close(): Promise<void>;
}

async function startStub(): Promise<StubServer> {
  let handler: (req: IncomingMessage, res: ServerResponse) => void = (
    _req,
    res,
  ) => {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end("{}");
  };
  const server: Server = createHttpServer((req, res) => {
    // We don't inspect the body here — drain so node finishes the
    // request lifecycle and `end` fires.
    req.setEncoding("utf8");
    req.on("data", () => {
      // discarded
    });
    req.on("end", () => {
      handler(req, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${addr.port}`,
    setHandler(h) {
      handler = h;
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

/* -------------------------------------------------------------------- */
/* Pipeline + DB seeding                                                 */
/* -------------------------------------------------------------------- */

const PIPELINE_ID = "test-pipe";
const RUN_ID = "run-1";
const INSTANCE_ID = "inst-1";
const NOW = "2026-04-29T12:00:00.000Z";

interface SeededHarness {
  readonly db: Database.Database;
  readonly claimToken: string;
}

function seed(opts: {
  endpoint: string;
  outputSchema?: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
  /** TTL — `expiresAt = NOW + ttlMs`; default 10 min. */
  ttlMs?: number;
}): SeededHarness {
  const db = openDb(":memory:");
  runMigrations(db);

  const ttl = opts.ttlMs ?? 600_000;
  const expiresAt = new Date(Date.parse(NOW) + ttl).toISOString();

  const def = {
    id: PIPELINE_ID,
    subtasks: [
      {
        id: "the-subtask",
        instructions: "do it",
        output_schema: opts.outputSchema ?? {
          type: "object",
          properties: { score: { type: "integer" } },
          required: ["score"],
          additionalProperties: false,
        },
        subcommands: [
          {
            name: "probe",
            endpoint: opts.endpoint,
            input_schema: opts.inputSchema ?? { type: "object" },
          },
        ],
      },
    ],
  };

  db.prepare(
    `INSERT INTO pipelines (id, version, def_json, created_at, updated_at)
     VALUES (?, 1, ?, ?, ?)`,
  ).run(PIPELINE_ID, JSON.stringify(def), NOW, NOW);
  db.prepare(
    `INSERT INTO runs (id, pipeline_id, pipeline_version, status,
                       initial_input_json, webhook_url, created_at)
     VALUES (?, ?, 1, 'running', '{}', 'http://example/webhook', ?)`,
  ).run(RUN_ID, PIPELINE_ID, NOW);
  const claimToken = "c_test";
  db.prepare(
    `INSERT INTO subtask_instances
       (id, run_id, subtask_id, status, claim_token, expires_at,
        input_json, created_at, updated_at)
     VALUES (?, ?, 'the-subtask', 'claimed', ?, ?, '{}', ?, ?)`,
  ).run(INSTANCE_ID, RUN_ID, claimToken, expiresAt, NOW, NOW);

  return { db, claimToken };
}

/* -------------------------------------------------------------------- */
/* Stub lifecycle                                                        */
/* -------------------------------------------------------------------- */

let stub: StubServer | undefined;

beforeEach(async () => {
  stub = await startStub();
});

afterEach(async () => {
  await stub?.close();
  stub = undefined;
});

afterAll(async () => {
  await closeAllPools();
});

/* -------------------------------------------------------------------- */
/* Tests                                                                 */
/* -------------------------------------------------------------------- */

describe("audit writer — task_tool", () => {
  it("writes one row with kind='task_tool', args, response", async () => {
    stub!.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, value: 42 }));
    });
    const { db } = seed({ endpoint: `POST ${stub!.origin}/probe` });
    try {
      await dispatchTaskTool({
        db,
        claimToken: "c_test",
        subcommand: "probe",
        args: { kind: "tiny" },
        bearer: "TOK",
        nowFn: () => NOW,
      });

      const rows = db
        .prepare(
          `SELECT kind, subcommand, args_json, response_json, truncated
             FROM agent_actions WHERE instance_id = ?`,
        )
        .all(INSTANCE_ID) as Array<{
        kind: string;
        subcommand: string | null;
        args_json: string | null;
        response_json: string | null;
        truncated: number;
      }>;
      expect(rows.length).toBe(1);
      const r = rows[0]!;
      expect(r.kind).toBe("task_tool");
      expect(r.subcommand).toBe("probe");
      expect(JSON.parse(r.args_json!)).toEqual({ kind: "tiny" });
      expect(JSON.parse(r.response_json!)).toEqual({ ok: true, value: 42 });
      expect(r.truncated).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("audit writer — submit_result", () => {
  it("writes one row with kind='submit_result', args=result+notes, response=acceptance", async () => {
    const { db, claimToken } = seed({
      endpoint: `POST ${stub!.origin}/x`,
      outputSchema: {
        type: "object",
        properties: { score: { type: "integer" } },
        required: ["score"],
        additionalProperties: false,
      },
    });
    try {
      const app = createAgentApp({ db, nowFn: () => NOW });
      const submit = await app.request(`/${claimToken}/result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          result: { score: 11 },
          notes: "feels right",
        }),
      });
      const body = (await submit.json()) as EnvelopeResponse<{
        run_id: string;
      }>;
      if (!body.ok) throw new Error(`expected ok=true; got ${JSON.stringify(body)}`);

      const rows = db
        .prepare(
          `SELECT kind, args_json, response_json, truncated
             FROM agent_actions WHERE instance_id = ? AND kind = 'submit_result'`,
        )
        .all(INSTANCE_ID) as Array<{
        kind: string;
        args_json: string | null;
        response_json: string | null;
        truncated: number;
      }>;
      expect(rows.length).toBe(1);
      const r = rows[0]!;
      expect(r.kind).toBe("submit_result");
      const argsObj = JSON.parse(r.args_json!) as {
        result: unknown;
        notes?: string;
      };
      expect(argsObj.result).toEqual({ score: 11 });
      expect(argsObj.notes).toBe("feels right");
      // The submit-success response carries the run_id.
      expect(JSON.parse(r.response_json!)).toEqual({ run_id: RUN_ID });
      expect(r.truncated).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("audit writer — silent 4 KB truncation", () => {
  it("a >4 KB args field is silently truncated (no marker appended on the DB-side write)", async () => {
    // 8 KB args, 8 KB response — both will be cut. Endpoint is fine
    // because the input_schema defaults to `{type:'object'}` (any
    // object passes).
    const big = "X".repeat(8 * 1024);
    stub!.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ blob: big }));
    });

    const { db } = seed({ endpoint: `POST ${stub!.origin}/p` });
    try {
      await dispatchTaskTool({
        db,
        claimToken: "c_test",
        subcommand: "probe",
        args: { blob: big },
        bearer: "TOK",
        nowFn: () => NOW,
      });

      const r = db
        .prepare(
          `SELECT args_json, response_json, truncated FROM agent_actions
            WHERE kind = 'task_tool'`,
        )
        .get() as {
        args_json: string;
        response_json: string;
        truncated: number;
      };
      // The DB row's payload field MUST be ≤ 4 KB.
      expect(Buffer.byteLength(r.args_json, "utf8")).toBeLessThanOrEqual(
        AUDIT_PAYLOAD_LIMIT_BYTES,
      );
      expect(Buffer.byteLength(r.response_json, "utf8")).toBeLessThanOrEqual(
        AUDIT_PAYLOAD_LIMIT_BYTES,
      );
      // No "(truncated)" marker is written to the DB. (The read-time
      // helper `src/api/publisher/truncate.ts` is what appends a marker
      // for the run-status response — that's an orthogonal layer.)
      expect(r.args_json).not.toMatch(/truncated/i);
      expect(r.response_json).not.toMatch(/truncated/i);
      // The boolean flag carries the signal instead.
      expect(r.truncated).toBe(1);
    } finally {
      db.close();
    }
  });

  it("truncation operates at the JSON-string level (object stringified, then byte-cut)", () => {
    // White-box check on the canonical helper. The contract is: input
    // is a JSON string already; the helper returns the (possibly
    // clipped) JSON string. It does NOT take an object and re-stringify.
    const json = JSON.stringify({
      a: "x".repeat(2000),
      b: "y".repeat(4000),
    });
    expect(Buffer.byteLength(json, "utf8")).toBeGreaterThan(
      AUDIT_PAYLOAD_LIMIT_BYTES,
    );
    const result = truncateForAudit(json);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.text!, "utf8")).toBeLessThanOrEqual(
      AUDIT_PAYLOAD_LIMIT_BYTES,
    );
    // The output is a prefix of the JSON string (modulo trailing
    // partial-UTF-8 stripping); for an ASCII input there's no
    // multi-byte handling so it's exactly a byte prefix.
    expect(json.startsWith(result.text!)).toBe(true);
    // Sub-cap input is returned unchanged.
    const small = JSON.stringify({ a: 1 });
    const small2 = truncateForAudit(small);
    expect(small2.truncated).toBe(false);
    expect(small2.text).toBe(small);
    // null input returns null with truncated=false.
    const nullRes = truncateForAudit(null);
    expect(nullRes.text).toBeNull();
    expect(nullRes.truncated).toBe(false);
  });
});

describe("GET /runs/{run_id} ordering", () => {
  it("returns agent_actions[] ordered by ts ASC", async () => {
    const { db } = seed({ endpoint: `POST ${stub!.origin}/p` });
    try {
      // Insert three actions out of order (by id) but with monotonic ts.
      // Because the sqlite autoincrement assigns the bigger id second,
      // ordering by id ASC vs ts ASC can give different sequences if
      // the inserter writes them with bigger ts first.
      const insert = db.prepare(
        `INSERT INTO agent_actions
           (instance_id, ts, kind, subcommand, args_json, response_json, truncated)
         VALUES (?, ?, ?, NULL, NULL, NULL, 0)`,
      );
      insert.run(INSTANCE_ID, "2026-04-29T12:00:03.000Z", "k_third");
      insert.run(INSTANCE_ID, "2026-04-29T12:00:01.000Z", "k_first");
      insert.run(INSTANCE_ID, "2026-04-29T12:00:02.000Z", "k_second");

      const app = new Hono();
      mountRunRoutes(app, db);
      const response = await app.request(`/runs/${RUN_ID}`);
      const body = (await response.json()) as EnvelopeResponse<{
        agent_actions: ReadonlyArray<{ kind: string; ts: string }>;
      }>;
      if (!body.ok || body.data === undefined) {
        throw new Error("expected ok=true with data");
      }
      const kinds = body.data.agent_actions.map((a) => a.kind);
      expect(kinds).toEqual(["k_first", "k_second", "k_third"]);
    } finally {
      db.close();
    }
  });
});

describe("audit-log stress: 1000 writes don't bloat the DB", () => {
  it("writes 1000 audit rows in <5 MB on a fresh in-memory DB", async () => {
    // We insert directly (rather than running 1000 dispatchTaskTool
    // calls) because the contract is about per-row size, not about
    // how the rows arrive. Each row carries a sub-4 KB args + response.
    const db = openDb(":memory:");
    runMigrations(db);
    try {
      db.prepare(
        `INSERT INTO pipelines (id, version, def_json, created_at, updated_at)
         VALUES (?, 1, '{}', ?, ?)`,
      ).run(PIPELINE_ID, NOW, NOW);
      db.prepare(
        `INSERT INTO runs (id, pipeline_id, pipeline_version, status,
                           initial_input_json, webhook_url, created_at)
         VALUES (?, ?, 1, 'running', '{}', 'http://example/webhook', ?)`,
      ).run(RUN_ID, PIPELINE_ID, NOW);
      db.prepare(
        `INSERT INTO subtask_instances
           (id, run_id, subtask_id, status, input_json, created_at, updated_at)
         VALUES (?, ?, 'sx', 'claimed', '{}', ?, ?)`,
      ).run(INSTANCE_ID, RUN_ID, NOW, NOW);

      // Each row's args_json + response_json is JSON-stringified and
      // capped at 4 KB. We use a realistic 1 KB args + 1 KB response
      // — typical demo traffic, not the truncation worst case.
      const args = JSON.stringify({ blob: "a".repeat(1024) });
      const resp = JSON.stringify({ blob: "b".repeat(1024) });
      const insert = db.prepare(
        `INSERT INTO agent_actions
           (instance_id, ts, kind, subcommand, args_json, response_json, truncated)
         VALUES (?, ?, 'task_tool', 'probe', ?, ?, 0)`,
      );
      const startBytes = (db.prepare("PRAGMA page_count").get() as {
        page_count: number;
      }).page_count;
      const pageSize = (db.prepare("PRAGMA page_size").get() as {
        page_size: number;
      }).page_size;

      const txn = db.transaction(() => {
        for (let i = 0; i < 1000; i += 1) {
          insert.run(
            INSTANCE_ID,
            new Date(Date.parse(NOW) + i).toISOString(),
            args,
            resp,
          );
        }
      });
      txn();

      const endBytes = (db.prepare("PRAGMA page_count").get() as {
        page_count: number;
      }).page_count;
      const grew = (endBytes - startBytes) * pageSize;

      // 1 KB args + 1 KB resp + overhead, ×1000 rows ≈ 2.x MB. Cap at 5 MB.
      expect(grew).toBeLessThan(5 * 1024 * 1024);

      const count = db
        .prepare("SELECT COUNT(*) AS n FROM agent_actions")
        .get() as { n: number };
      expect(count.n).toBe(1000);
    } finally {
      db.close();
    }
  });
});
