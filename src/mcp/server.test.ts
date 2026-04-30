/**
 * Tests for `src/mcp/server.ts` and `src/mcp/tools.ts` — Murmur's MCP
 * surface (DESIGN.md §3.4).
 *
 * Test layers:
 *
 *   1. **JSON-RPC behaviour** — exercised through the SDK's
 *      `InMemoryTransport.createLinkedPair()` so `initialize`, `tools/list`,
 *      and `tools/call` are tested end-to-end without going through HTTP.
 *      Bearer auth is N/A on this transport; tool handlers see
 *      `extra.requestInfo === undefined` and forward no Authorization
 *      header — the wrapped agent app is constructed without the auth
 *      middleware in this layer (tests pass the agent sub-app directly
 *      from `createAgentApp`, which has no app-level auth).
 *
 *   2. **HTTP transport + bearer auth** — exercised through the full
 *      `createServer({ token, db })` with the MCP route mounted under
 *      `/mcp`. We assert that requests without/with-bad bearer tokens
 *      fail at the parent app's auth middleware before ever reaching
 *      the SDK transport.
 *
 *   3. **Reconnect** — close the in-memory client transport, build a
 *      fresh client, and verify `initialize` succeeds again. (This is
 *      the in-process analogue of the cloudflared idle-drop path; for
 *      stateless mode any new request rebuilds the server.)
 *
 * Test bullets are taken verbatim from issue #11's "Verification"
 * section. Every named bullet has at least one corresponding `it()`
 * below; the bullet text is included in the test title so a reviewer
 * can grep for it.
 */

import { describe, expect, it } from "vitest";

import type Database from "better-sqlite3";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { EnvelopeResponse } from "@murmur/contracts-types";

import { openDb } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { createAgentApp } from "../api/agent/index.js";
import { createServer } from "../server.js";

import {
  PULL_TASK_DESCRIPTION,
  SUBMIT_RESULT_DESCRIPTION,
  TASK_TOOL_DESCRIPTION,
  TOOL_PULL_TASK,
  TOOL_SUBMIT_RESULT,
  TOOL_TASK_TOOL,
  registerMcpTools,
} from "./tools.js";

/* -------------------------------------------------------------------------- */
/*  Shared fixtures                                                            */
/* -------------------------------------------------------------------------- */

const TEST_PIPELINE_ID = "test-pipeline";
const TEST_PIPELINE_VERSION = 1;
const TEST_PIPELINE_DEF = {
  id: TEST_PIPELINE_ID,
  subtasks: [
    {
      id: "first",
      instructions: "Do the first thing.",
      output_schema: {
        type: "object",
        properties: { score: { type: "integer" } },
        required: ["score"],
        additionalProperties: false,
      },
    },
  ],
};

interface DbFixture {
  readonly db: Database.Database;
}

function setupDb(): DbFixture {
  const db = openDb(":memory:");
  runMigrations(db);
  const now = "2026-04-29T12:00:00.000Z";
  db.prepare(
    `INSERT INTO pipelines (id, version, def_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    TEST_PIPELINE_ID,
    TEST_PIPELINE_VERSION,
    JSON.stringify(TEST_PIPELINE_DEF),
    now,
    now,
  );
  return { db };
}

function seedReadyRun(db: Database.Database, runId: string): void {
  const now = "2026-04-29T12:00:00.000Z";
  db.prepare(
    `INSERT INTO runs
       (id, pipeline_id, pipeline_version, status, initial_input_json,
        webhook_url, created_at)
     VALUES (?, ?, ?, 'running', '{}', 'https://example.test/webhook', ?)`,
  ).run(runId, TEST_PIPELINE_ID, TEST_PIPELINE_VERSION, now);
  db.prepare(
    `INSERT INTO subtask_instances
       (id, run_id, subtask_id, status, input_json, created_at, updated_at)
     VALUES (?, ?, ?, 'ready', '{}', ?, ?)`,
  ).run(`${runId}-first`, runId, "first", now, now);
}

/**
 * Build a fresh in-memory MCP client/server pair wired to a freshly
 * seeded DB and agent app. Returns the connected client + a cleanup hook.
 */
async function makeInMemoryHarness(): Promise<{
  client: Client;
  db: Database.Database;
  cleanup(): Promise<void>;
}> {
  const fixture = setupDb();
  seedReadyRun(fixture.db, "run-A");

  const agentApp = createAgentApp({ db: fixture.db });
  const server = new McpServer({ name: "murmur-test", version: "0.0.0" });
  registerMcpTools(server, { agentApp });

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client(
    { name: "murmur-test-client", version: "0.0.0" },
    { capabilities: {} },
  );
  await client.connect(clientTransport);

  return {
    client,
    db: fixture.db,
    async cleanup() {
      await client.close();
      await server.close();
      fixture.db.close();
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Layer 1 — JSON-RPC behaviour via the in-memory transport pair             */
/* -------------------------------------------------------------------------- */

describe("MCP server — initialize and tools/list", () => {
  it("MCP `initialize` succeeds; `tools/list` returns exactly 3 tools with correct descriptions", async () => {
    const h = await makeInMemoryHarness();
    try {
      // `initialize` ran inside `client.connect`; verify the server's
      // capabilities surface includes `tools`.
      const caps = h.client.getServerCapabilities();
      expect(caps?.tools).toBeDefined();

      const result = await h.client.listTools();
      expect(result.tools).toHaveLength(3);

      const byName = new Map(result.tools.map((t) => [t.name, t]));
      expect(byName.get(TOOL_PULL_TASK)?.description).toBe(
        PULL_TASK_DESCRIPTION,
      );
      expect(byName.get(TOOL_SUBMIT_RESULT)?.description).toBe(
        SUBMIT_RESULT_DESCRIPTION,
      );
      expect(byName.get(TOOL_TASK_TOOL)?.description).toBe(
        TASK_TOOL_DESCRIPTION,
      );
    } finally {
      await h.cleanup();
    }
  });

  it("Tool schemas: pull_task has no params; submit_result requires `claim` + `result`; task_tool requires `subcommand` + `claim`", async () => {
    const h = await makeInMemoryHarness();
    try {
      const result = await h.client.listTools();
      const byName = new Map(result.tools.map((t) => [t.name, t]));

      // `pull_task` — no params. The SDK still emits an inputSchema
      // object (JSON-Schema requires `type: 'object'`); what matters is
      // that there are no required fields.
      const pull = byName.get(TOOL_PULL_TASK);
      expect(pull).toBeDefined();
      const pullSchema = pull!.inputSchema as {
        type: string;
        properties?: Record<string, unknown>;
        required?: string[];
      };
      expect(pullSchema.type).toBe("object");
      expect(pullSchema.required ?? []).toEqual([]);

      // `submit_result` — requires `claim` + `result`; `notes` optional.
      const submit = byName.get(TOOL_SUBMIT_RESULT);
      expect(submit).toBeDefined();
      const submitSchema = submit!.inputSchema as {
        type: string;
        required?: string[];
        properties: Record<string, unknown>;
      };
      expect(submitSchema.type).toBe("object");
      expect(new Set(submitSchema.required ?? [])).toEqual(
        new Set(["claim", "result"]),
      );
      expect(submitSchema.properties).toHaveProperty("notes");

      // `task_tool` — requires `subcommand` + `claim`; `args` optional.
      const taskTool = byName.get(TOOL_TASK_TOOL);
      expect(taskTool).toBeDefined();
      const taskToolSchema = taskTool!.inputSchema as {
        type: string;
        required?: string[];
        properties: Record<string, unknown>;
      };
      expect(taskToolSchema.type).toBe("object");
      expect(new Set(taskToolSchema.required ?? [])).toEqual(
        new Set(["subcommand", "claim"]),
      );
      expect(taskToolSchema.properties).toHaveProperty("args");
    } finally {
      await h.cleanup();
    }
  });
});

describe("MCP server — pull_task delegates to /work/next", () => {
  it("`pull_task` MCP call delegates to `/work/next` and returns the same shape (envelope intact)", async () => {
    const h = await makeInMemoryHarness();
    try {
      // Pass `arguments: {}` so the SDK's input-schema validator accepts
      // the call (issue #75 added an optional `run_id` to the schema; the
      // SDK requires `arguments` to be an object even when all fields
      // are optional — passing `{}` is semantically identical to omitting
      // arguments and exercises the same legacy global-FIFO path).
      const result = await h.client.callTool({
        name: TOOL_PULL_TASK,
        arguments: {},
      });
      // The handler emits both a structuredContent (envelope) and a
      // matching textual rendering. We assert against the structured
      // form — that's the contract the host actually consumes.
      const envelope = result.structuredContent as EnvelopeResponse<{
        instructions: string;
        input: unknown;
        output_schema: Record<string, unknown>;
        claim: string;
      }>;
      expect(envelope.ok).toBe(true);
      if (!envelope.ok || envelope.data === undefined) {
        throw new Error("expected populated data");
      }
      expect(envelope.data?.instructions).toBe("Do the first thing.");
      expect(envelope.data?.claim.length).toBeGreaterThan(0);
    } finally {
      await h.cleanup();
    }
  });

  it("`pull_task` on an empty queue returns `{ ok: true, data: null }`", async () => {
    // Build a fresh harness with no seeded run.
    const fixture = setupDb();
    const agentApp = createAgentApp({ db: fixture.db });
    const server = new McpServer({ name: "murmur-test", version: "0.0.0" });
    registerMcpTools(server, { agentApp });

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client(
      { name: "murmur-test-client", version: "0.0.0" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    try {
      // See note above about `arguments: {}` and the optional `run_id`.
      const result = await client.callTool({
        name: TOOL_PULL_TASK,
        arguments: {},
      });
      const envelope = result.structuredContent as EnvelopeResponse<unknown>;
      expect(envelope.ok).toBe(true);
      if (!envelope.ok) throw new Error("unreachable");
      expect(envelope.data).toBeNull();
    } finally {
      await client.close();
      await server.close();
      fixture.db.close();
    }
  });
});

describe("MCP server — submit_result delegates to /work/{claim}/result", () => {
  it("`submit_result` MCP call delegates to `/work/{claim}/result` (envelope intact)", async () => {
    const h = await makeInMemoryHarness();
    try {
      // First claim a task to obtain a claim token.
      const pull = await h.client.callTool({
        name: TOOL_PULL_TASK,
        arguments: {},
      });
      const pullEnv = pull.structuredContent as EnvelopeResponse<{
        claim: string;
      }>;
      if (!pullEnv.ok || pullEnv.data === undefined || pullEnv.data === null) {
        throw new Error("expected claim");
      }
      const claim = pullEnv.data.claim;

      const result = await h.client.callTool({
        name: TOOL_SUBMIT_RESULT,
        arguments: {
          claim,
          result: { score: 7 },
        },
      });
      const envelope = result.structuredContent as EnvelopeResponse<{
        run_id: string;
      }>;
      expect(envelope.ok).toBe(true);
      if (!envelope.ok || envelope.data === undefined) {
        throw new Error("expected run_id");
      }
      expect(envelope.data?.run_id).toBe("run-A");
    } finally {
      await h.cleanup();
    }
  });

  it("`submit_result` with an unknown claim returns `claim_lost` (envelope intact)", async () => {
    const h = await makeInMemoryHarness();
    try {
      const result = await h.client.callTool({
        name: TOOL_SUBMIT_RESULT,
        arguments: {
          claim: "c_does_not_exist",
          result: { score: 7 },
        },
      });
      const envelope = result.structuredContent as EnvelopeResponse<unknown>;
      expect(envelope.ok).toBe(false);
      if (envelope.ok) throw new Error("unreachable");
      expect(envelope.errors).toContain("claim_lost");
    } finally {
      await h.cleanup();
    }
  });
});

describe("MCP server — pull_task with run_id filter (issue #75)", () => {
  /**
   * Build a harness that seeds two ready runs: an older "run-OLD" and a
   * newer "run-NEW", both on the default test pipeline (so the projected
   * payload is the same `Do the first thing.`). Without `run_id`, the
   * legacy global FIFO would pick run-OLD; with `run_id: 'run-NEW'`, the
   * agent must skip run-OLD and claim run-NEW's row.
   */
  async function makeTwoRunHarness(): Promise<{
    client: Client;
    db: Database.Database;
    cleanup(): Promise<void>;
  }> {
    const fixture = setupDb();
    const oldNow = "2026-04-29T11:59:00.000Z";
    const newNow = "2026-04-29T12:00:00.000Z";

    function seed(runId: string, createdAt: string): void {
      fixture.db
        .prepare(
          `INSERT INTO runs
             (id, pipeline_id, pipeline_version, status, initial_input_json,
              webhook_url, created_at)
           VALUES (?, ?, ?, 'running', '{}', 'https://example.test/webhook', ?)`,
        )
        .run(runId, TEST_PIPELINE_ID, TEST_PIPELINE_VERSION, createdAt);
      fixture.db
        .prepare(
          `INSERT INTO subtask_instances
             (id, run_id, subtask_id, status, input_json, created_at, updated_at)
           VALUES (?, ?, ?, 'ready', '{}', ?, ?)`,
        )
        .run(`${runId}-first`, runId, "first", createdAt, createdAt);
    }
    seed("run-OLD", oldNow);
    seed("run-NEW", newNow);

    const agentApp = createAgentApp({ db: fixture.db });
    const server = new McpServer({ name: "murmur-test", version: "0.0.0" });
    registerMcpTools(server, { agentApp });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const client = new Client(
      { name: "murmur-test-client", version: "0.0.0" },
      { capabilities: {} },
    );
    await client.connect(c);
    return {
      client,
      db: fixture.db,
      async cleanup() {
        await client.close();
        await server.close();
        fixture.db.close();
      },
    };
  }

  it("`pull_task({ run_id: 'run-NEW' })` claims only that run's work, skipping older rows from other runs", async () => {
    const h = await makeTwoRunHarness();
    try {
      const result = await h.client.callTool({
        name: TOOL_PULL_TASK,
        arguments: { run_id: "run-NEW" },
      });
      const envelope = result.structuredContent as EnvelopeResponse<{
        instructions: string;
        claim: string;
      }>;
      expect(envelope.ok).toBe(true);
      if (!envelope.ok || envelope.data === undefined || envelope.data === null) {
        throw new Error("expected claim");
      }
      // Verify by reading back from the DB which run was claimed.
      const claimed = h.db
        .prepare(
          `SELECT run_id FROM subtask_instances WHERE claim_token = ?`,
        )
        .get(envelope.data.claim) as { run_id: string };
      expect(claimed.run_id).toBe("run-NEW");

      // run-OLD's row remains ready — not picked up despite being older.
      const oldRow = h.db
        .prepare(
          `SELECT status FROM subtask_instances WHERE id = 'run-OLD-first'`,
        )
        .get() as { status: string };
      expect(oldRow.status).toBe("ready");
    } finally {
      await h.cleanup();
    }
  });

  it("`pull_task({ run_id: 'r_unknown' })` returns null even when the global queue is non-empty", async () => {
    const h = await makeTwoRunHarness();
    try {
      const result = await h.client.callTool({
        name: TOOL_PULL_TASK,
        arguments: { run_id: "r_unknown" },
      });
      const envelope = result.structuredContent as EnvelopeResponse<unknown>;
      expect(envelope.ok).toBe(true);
      if (!envelope.ok) throw new Error("unreachable");
      expect(envelope.data).toBeNull();
    } finally {
      await h.cleanup();
    }
  });
});

describe("MCP server — task_tool stub (M7 stand-in)", () => {
  it("`task_tool` returns `{ ok: false, errors: ['not_implemented'] }` until M7 lands", async () => {
    const h = await makeInMemoryHarness();
    try {
      const result = await h.client.callTool({
        name: TOOL_TASK_TOOL,
        arguments: {
          subcommand: "probe monitor",
          claim: "c_irrelevant_for_stub",
          args: { board_url: "https://example.test" },
        },
      });
      const envelope = result.structuredContent as EnvelopeResponse<unknown>;
      expect(envelope.ok).toBe(false);
      if (envelope.ok) throw new Error("unreachable");
      expect(envelope.errors).toEqual(["not_implemented"]);
    } finally {
      await h.cleanup();
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Layer 2 — HTTP transport with bearer auth                                  */
/* -------------------------------------------------------------------------- */

describe("MCP transport — bearer auth", () => {
  const tokenStr = "test-token-7777";
  const token = Buffer.from(tokenStr, "utf8");

  /**
   * A representative MCP `initialize` JSON-RPC envelope. We don't go
   * through the SDK client here — the test is about the auth gate, not
   * the transport. A literal POST body suffices and keeps the test
   * deterministic.
   */
  function initBody(): string {
    return JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test-client", version: "0.0.0" },
      },
    });
  }

  it("Bearer auth enforced on the MCP transport — missing header → 401", async () => {
    const fixture = setupDb();
    try {
      const app = createServer({ token, db: fixture.db });
      const response = await app.request("/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: initBody(),
      });
      expect(response.status).toBe(401);
      const body = (await response.json()) as EnvelopeResponse<unknown>;
      expect(body.ok).toBe(false);
      if (body.ok) throw new Error("unreachable");
      expect(body.errors).toContain("unauthorized");
    } finally {
      fixture.db.close();
    }
  });

  it("Bearer auth enforced on the MCP transport — wrong token → 401", async () => {
    const fixture = setupDb();
    try {
      const app = createServer({ token, db: fixture.db });
      const response = await app.request("/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer not-the-right-token",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: initBody(),
      });
      expect(response.status).toBe(401);
      const body = (await response.json()) as EnvelopeResponse<unknown>;
      expect(body.ok).toBe(false);
    } finally {
      fixture.db.close();
    }
  });

  it("Bearer auth enforced on the MCP transport — same `MURMUR_TOKEN` admits an `initialize` request", async () => {
    const fixture = setupDb();
    try {
      const app = createServer({ token, db: fixture.db });
      const response = await app.request("/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokenStr}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: initBody(),
      });
      // The SDK responds 200 with an SSE/JSON body on a successful
      // initialize. We don't parse the body — passing the auth gate is
      // what this test asserts.
      expect(response.status).toBe(200);
    } finally {
      fixture.db.close();
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Layer 3 — reconnect after a forced disconnect                             */
/* -------------------------------------------------------------------------- */

describe("MCP transport — reconnect", () => {
  it("Reconnect after a forced disconnect re-issues `initialize` cleanly", async () => {
    const fixture = setupDb();
    seedReadyRun(fixture.db, "run-A");
    try {
      const agentApp = createAgentApp({ db: fixture.db });

      // First server + client pair.
      const server1 = new McpServer({ name: "murmur-test", version: "0.0.0" });
      registerMcpTools(server1, { agentApp });
      const [c1, s1] = InMemoryTransport.createLinkedPair();
      await server1.connect(s1);
      const client1 = new Client(
        { name: "murmur-test-client", version: "0.0.0" },
        { capabilities: {} },
      );
      await client1.connect(c1);

      // Verify the first session works.
      const list1 = await client1.listTools();
      expect(list1.tools).toHaveLength(3);

      // Forced disconnect — close the client and the server.
      await client1.close();
      await server1.close();

      // Build a fresh server + client (mirrors what the Hono /mcp route
      // does on every request in stateless mode).
      const server2 = new McpServer({ name: "murmur-test", version: "0.0.0" });
      registerMcpTools(server2, { agentApp });
      const [c2, s2] = InMemoryTransport.createLinkedPair();
      await server2.connect(s2);
      const client2 = new Client(
        { name: "murmur-test-client", version: "0.0.0" },
        { capabilities: {} },
      );
      // This is the "re-issues `initialize` cleanly" check — `connect`
      // performs the initialize round-trip; it MUST succeed.
      await client2.connect(c2);
      const list2 = await client2.listTools();
      expect(list2.tools).toHaveLength(3);

      await client2.close();
      await server2.close();
    } finally {
      fixture.db.close();
    }
  });
});
