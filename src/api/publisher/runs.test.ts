/**
 * `GET /runs` (list) tests — colophon-group/murmur#76.
 *
 * Drives the route end-to-end through `app.request(...)` against a
 * fresh in-memory SQLite (migrations applied per test). The fixture
 * pipeline is the same `jobseek-add-company` shape used by the other
 * publisher tests; runs are created via `POST /pipelines/{id}/runs` so
 * the rows exercise the real ingest path (status='running',
 * initial_input_json populated, created_at filled).
 */

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import type { EnvelopeResponse } from "@murmur/contracts-types";

import { seedDemoPublisher } from "../../db/bootstrap.js";
import { runMigrations } from "../../db/migrate.js";
import { createServer } from "../../server.js";
import type { RunListItem, RunListView } from "./runs.js";

const TEST_TOKEN = "test-murmur-token-secret";
const TEST_TOKEN_BUF = Buffer.from(TEST_TOKEN, "utf8");
const AUTH_HEADERS = { Authorization: `Bearer ${TEST_TOKEN}` };

const VALID_PIPELINE_YAML = `
id: jobseek-add-company
initial_input:
  type: object
  required: [company_name, website]
  properties:
    company_name: { type: string, minLength: 1 }
    website: { type: string, format: uri }
subtasks:
  - id: pre-verify
    instructions: |
      Confirm the company exists.
    output_schema:
      type: object
      required: [verified]
      properties:
        verified: { type: boolean }
final_output:
  composes:
    - "pre-verify.*"
  webhook: https://example.com/webhook
`;

const SECOND_PIPELINE_YAML = `
id: other-pipeline
initial_input:
  type: object
  required: [target]
  properties:
    target: { type: string, minLength: 1 }
subtasks:
  - id: only
    instructions: do
    output_schema:
      type: object
      required: [done]
      properties:
        done: { type: boolean }
final_output:
  composes:
    - "only.*"
  webhook: https://example.com/webhook2
`;

function freshServer(): {
  db: Database.Database;
  app: ReturnType<typeof createServer>;
} {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  // Grandfather TEST_TOKEN as the demo publisher's admin+runner so
  // POST /pipelines + POST /pipelines/{id}/runs accept the bearer.
  seedDemoPublisher(db, { MURMUR_TOKEN: TEST_TOKEN });
  const app = createServer({ token: TEST_TOKEN_BUF, db });
  return { db, app };
}

async function registerPipeline(
  app: ReturnType<typeof createServer>,
  yaml: string,
  id: string,
): Promise<void> {
  const r = await app.request("/pipelines", {
    method: "POST",
    headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ id, def_yaml: yaml }),
  });
  expect(r.status).toBe(200);
}

async function createRun(
  app: ReturnType<typeof createServer>,
  pipelineId: string,
  initialInput: Record<string, unknown>,
): Promise<string> {
  const r = await app.request(`/pipelines/${pipelineId}/runs`, {
    method: "POST",
    headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ initial_input: initialInput }),
  });
  expect(r.status).toBe(200);
  const body = (await r.json()) as EnvelopeResponse<{ run_id: string }>;
  if (body.ok !== true || body.data === undefined) {
    throw new Error("create-run failed");
  }
  return body.data.run_id;
}

/**
 * Direct SQL hatch: flip a run's status so we can exercise the
 * `status` filter without having to drive a full pipeline through
 * `submit_result` (which the M-tasks owning that loop haven't all
 * landed yet at the time this issue was scoped).
 */
function setRunStatus(
  db: Database.Database,
  runId: string,
  status: string,
): void {
  db.prepare("UPDATE runs SET status = ? WHERE id = ?").run(status, runId);
}

/**
 * Backdate `created_at` so DESC ordering is deterministic in the test.
 * Without this two runs minted in the same ms can flip order based on
 * insertion timing.
 */
function setRunCreatedAt(
  db: Database.Database,
  runId: string,
  createdAt: string,
): void {
  db.prepare("UPDATE runs SET created_at = ? WHERE id = ?").run(
    createdAt,
    runId,
  );
}

async function listRuns(
  app: ReturnType<typeof createServer>,
  query: string,
  authed = true,
): Promise<{ status: number; body: EnvelopeResponse<RunListView> }> {
  const url = `/runs${query.length > 0 ? `?${query}` : ""}`;
  const headers = authed ? AUTH_HEADERS : {};
  const response = await app.request(url, { headers });
  return {
    status: response.status,
    body: (await response.json()) as EnvelopeResponse<RunListView>,
  };
}

describe("GET /runs", () => {
  let server: ReturnType<typeof freshServer>;

  beforeEach(async () => {
    server = freshServer();
    await registerPipeline(
      server.app,
      VALID_PIPELINE_YAML,
      "jobseek-add-company",
    );
    await registerPipeline(server.app, SECOND_PIPELINE_YAML, "other-pipeline");
  });

  it("returns 401 without an Authorization header", async () => {
    const { status } = await listRuns(server.app, "", false);
    expect(status).toBe(401);
  });

  it("returns 200 with empty runs[] when no rows match (NOT 404)", async () => {
    const { status, body } = await listRuns(
      server.app,
      "status=running&pipeline_id=does-not-exist",
    );
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    if (body.ok !== true || body.data === undefined) throw new Error("ok");
    expect(body.data.runs).toEqual([]);
  });

  it("?status=running returns only running runs ordered by created_at DESC", async () => {
    const r1 = await createRun(server.app, "jobseek-add-company", {
      company_name: "Alpha",
      website: "https://alpha.example",
    });
    const r2 = await createRun(server.app, "jobseek-add-company", {
      company_name: "Bravo",
      website: "https://bravo.example",
    });
    const r3 = await createRun(server.app, "jobseek-add-company", {
      company_name: "Charlie",
      website: "https://charlie.example",
    });

    // Backdate created_at: r1 oldest, r3 newest.
    setRunCreatedAt(server.db, r1, "2026-01-01T00:00:00.000Z");
    setRunCreatedAt(server.db, r2, "2026-01-02T00:00:00.000Z");
    setRunCreatedAt(server.db, r3, "2026-01-03T00:00:00.000Z");

    // Mark r2 as completed; r1 + r3 stay running.
    setRunStatus(server.db, r2, "completed");

    const { status, body } = await listRuns(server.app, "status=running");
    expect(status).toBe(200);
    if (body.ok !== true || body.data === undefined) throw new Error("ok");
    const ids = body.data.runs.map((r) => r.run_id);
    expect(ids).toEqual([r3, r1]);
    for (const r of body.data.runs) expect(r.status).toBe("running");
  });

  it("?pipeline_id=...&status=running AND-combines filters", async () => {
    const a1 = await createRun(server.app, "jobseek-add-company", {
      company_name: "Alpha",
      website: "https://alpha.example",
    });
    const a2 = await createRun(server.app, "jobseek-add-company", {
      company_name: "Bravo",
      website: "https://bravo.example",
    });
    const b1 = await createRun(server.app, "other-pipeline", {
      target: "x",
    });
    const b2 = await createRun(server.app, "other-pipeline", {
      target: "y",
    });

    // Mark one of each pipeline as completed; one of each stays running.
    setRunStatus(server.db, a2, "completed");
    setRunStatus(server.db, b2, "completed");

    const { status, body } = await listRuns(
      server.app,
      "status=running&pipeline_id=jobseek-add-company",
    );
    expect(status).toBe(200);
    if (body.ok !== true || body.data === undefined) throw new Error("ok");
    const ids = body.data.runs.map((r) => r.run_id).sort();
    expect(ids).toEqual([a1].sort());

    // Also confirm the other-pipeline filter works on its own.
    const second = await listRuns(
      server.app,
      "status=running&pipeline_id=other-pipeline",
    );
    if (second.body.ok !== true || second.body.data === undefined)
      throw new Error("ok");
    expect(second.body.data.runs.map((r) => r.run_id)).toEqual([b1]);
  });

  it("?initial_input.<field>=<value> matches runs whose initial_input has that field equal to that value", async () => {
    const stripeRun = await createRun(server.app, "jobseek-add-company", {
      company_name: "Stripe",
      website: "https://stripe.com",
    });
    await createRun(server.app, "jobseek-add-company", {
      company_name: "Plaid",
      website: "https://plaid.com",
    });

    const { status, body } = await listRuns(
      server.app,
      "initial_input.company_name=Stripe",
    );
    expect(status).toBe(200);
    if (body.ok !== true || body.data === undefined) throw new Error("ok");
    expect(body.data.runs.map((r) => r.run_id)).toEqual([stripeRun]);
    const item = body.data.runs[0] as RunListItem;
    // initial_input is rehydrated as the original JSON object.
    expect(item.initial_input).toEqual({
      company_name: "Stripe",
      website: "https://stripe.com",
    });
  });

  it("?limit=5&offset=10 paginates", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const id = await createRun(server.app, "jobseek-add-company", {
        company_name: `Co-${i}`,
        website: `https://co-${i}.example`,
      });
      // Stagger created_at so DESC order is deterministic and matches
      // creation order: i=0 oldest, i=19 newest.
      setRunCreatedAt(
        server.db,
        id,
        `2026-01-${(i + 1).toString().padStart(2, "0")}T00:00:00.000Z`,
      );
      ids.push(id);
    }

    const { status, body } = await listRuns(server.app, "limit=5&offset=10");
    expect(status).toBe(200);
    if (body.ok !== true || body.data === undefined) throw new Error("ok");
    expect(body.data.runs).toHaveLength(5);
    // DESC order: id at index 19 is row 0; offset 10 skips ids[19..10],
    // returning ids[9..5] inclusive (5 rows).
    const expected = [ids[9], ids[8], ids[7], ids[6], ids[5]];
    expect(body.data.runs.map((r) => r.run_id)).toEqual(expected);
  });

  it("clamps limit at 100 server-side regardless of caller value", async () => {
    // Seed 105 runs so we can prove we get back at most 100.
    for (let i = 0; i < 105; i++) {
      await createRun(server.app, "jobseek-add-company", {
        company_name: `Co-${i}`,
        website: `https://co-${i}.example`,
      });
    }
    const { status, body } = await listRuns(server.app, "limit=10000");
    expect(status).toBe(200);
    if (body.ok !== true || body.data === undefined) throw new Error("ok");
    expect(body.data.runs.length).toBe(100);
  });

  it("rejects non-integer limit with 400", async () => {
    const { status, body } = await listRuns(server.app, "limit=abc");
    expect(status).toBe(400);
    expect(body.ok).toBe(false);
  });

  it("rejects negative offset with 400", async () => {
    const { status, body } = await listRuns(server.app, "offset=-1");
    expect(status).toBe(400);
    expect(body.ok).toBe(false);
  });

  it("rejects an initial_input.<field> name that has special characters", async () => {
    // `initial_input.bad-field` would interpolate `-` into the
    // JSON_EXTRACT path; we whitelist `[A-Za-z0-9_]+` to keep that
    // surface clean.
    const { status, body } = await listRuns(
      server.app,
      "initial_input.bad-field=x",
    );
    expect(status).toBe(400);
    expect(body.ok).toBe(false);
  });

  it("returns the documented row shape with all required fields", async () => {
    const runId = await createRun(server.app, "jobseek-add-company", {
      company_name: "Stripe",
      website: "https://stripe.com",
    });
    const { status, body } = await listRuns(
      server.app,
      "pipeline_id=jobseek-add-company",
    );
    expect(status).toBe(200);
    if (body.ok !== true || body.data === undefined) throw new Error("ok");
    const item = body.data.runs.find((r) => r.run_id === runId);
    expect(item).toBeDefined();
    if (item === undefined) return;
    expect(item.pipeline_id).toBe("jobseek-add-company");
    expect(item.status).toBe("running");
    expect(item.webhook_status).toBeNull();
    expect(typeof item.created_at).toBe("string");
    expect(item.initial_input).toEqual({
      company_name: "Stripe",
      website: "https://stripe.com",
    });
  });
});
