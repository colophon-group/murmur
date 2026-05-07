/**
 * Publisher API tests — `POST /pipelines`, `POST /pipelines/{id}/runs`,
 * `GET /runs/{run_id}`.
 *
 * Tests are driven through `app.request(...)` against a `createServer`
 * built with an in-memory SQLite (migrations applied at the start of
 * each test). The bearer token is the same constant across all tests,
 * applied via the `Authorization` header — auth is M3's responsibility,
 * but at least one test asserts the publisher routes inherit it.
 */

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import type { EnvelopeResponse } from "@murmur/contracts-types";

import { seedDemoPublisher } from "../../db/bootstrap.js";
import { runMigrations } from "../../db/migrate.js";
import { createServer } from "../../server.js";

// --- Test fixtures -----------------------------------------------------

const TEST_TOKEN = "test-murmur-token-secret";
const TEST_TOKEN_BUF = Buffer.from(TEST_TOKEN, "utf8");
const AUTH_HEADERS = { Authorization: `Bearer ${TEST_TOKEN}` };

/**
 * Minimum-viable valid pipeline def YAML, used as the green-path input
 * for `POST /pipelines`. Mirrors the §3.1 example shape but trimmed to
 * the fields required by the M0 schema.
 *
 * Note YAML's special handling of `*` — wildcard-prefix and wildcard
 * compose rules are quoted explicitly here so the YAML parser doesn't
 * interpret them as anchors.
 */
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
  - id: setup-metadata
    instructions: Pick metadata.
    requires: [pre-verify]
    output_schema:
      type: object
      required: [slug]
      properties:
        slug: { type: string }
  - id: list-boards
    instructions: Discover boards.
    requires: [pre-verify]
    output_schema:
      type: object
      required: [boards]
      properties:
        boards: { type: array }
    spawns: { for_each: boards, template: configure-board }
  - id: configure-board
    instructions: Per-board config.
    output_schema:
      type: object
      required: [outcome]
      properties:
        outcome: { enum: [configured, blocked] }
final_output:
  composes:
    - "pre-verify.*"
    - "setup-metadata.*"
  webhook: https://example.com/webhook
`;

/**
 * Build a fresh in-memory DB with migrations applied + a server bound
 * to it. Returned together so tests can both make HTTP calls and
 * inspect the underlying tables.
 */
function freshServer(): {
  db: Database.Database;
  app: ReturnType<typeof createServer>;
} {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  // Migrations live under `src/db/migrations/`; the migrate runner
  // resolves relative to `process.cwd()`, which under vitest is the
  // package root. That matches the directory layout in `package.json`.
  runMigrations(db);
  // Grandfather TEST_TOKEN as the demo publisher's admin+runner token
  // so the publisher API (POST /pipelines, /runs, etc.) accepts the
  // legacy bearer header used by these tests (M1, issue #81).
  seedDemoPublisher(db, { MURMUR_TOKEN: TEST_TOKEN });
  const app = createServer({ token: TEST_TOKEN_BUF, db });
  return { db, app };
}

// --- POST /pipelines ---------------------------------------------------

describe("POST /pipelines", () => {
  let server: ReturnType<typeof freshServer>;
  beforeEach(() => {
    server = freshServer();
  });

  it("with valid YAML returns 200 { id }", async () => {
    const response = await server.app.request("/pipelines", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "jobseek-add-company",
        def_yaml: VALID_PIPELINE_YAML,
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as EnvelopeResponse<{ id: string }>;
    expect(body).toEqual({ ok: true, data: { id: "jobseek-add-company" } });

    // Persisted to the DB.
    const row = server.db
      .prepare("SELECT id, version FROM pipelines WHERE id = ?")
      .get("jobseek-add-company") as { id: string; version: number };
    expect(row).toBeDefined();
    expect(row.id).toBe("jobseek-add-company");
    expect(row.version).toBe(1);
  });

  it("with malformed YAML returns 400 with parse error", async () => {
    const response = await server.app.request("/pipelines", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "broken",
        // Unclosed bracket — YAML parse failure.
        def_yaml: "id: broken\nsubtasks: [unclosed",
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as EnvelopeResponse<unknown>;
    expect(body.ok).toBe(false);
    if (body.ok === false) {
      expect(body.errors.length).toBeGreaterThan(0);
      // First error should reference YAML parsing.
      const first = body.errors[0];
      expect(typeof first === "string" && first.startsWith("yaml:")).toBe(true);
    }
  });

  it("with invalid pipeline-shape JSON Schema returns 400 with schema-error path", async () => {
    // Missing required `final_output` triggers a schema-shape failure
    // against `docs/contracts/pipeline-def.schema.json`.
    const response = await server.app.request("/pipelines", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "no-final-output",
        def_yaml:
          "id: no-final-output\ninitial_input: { type: object }\nsubtasks: [{ id: x, instructions: y, output_schema: { type: object } }]",
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as EnvelopeResponse<unknown>;
    expect(body.ok).toBe(false);
    if (body.ok === false) {
      // Every entry should be a `validation:<path>:<msg>` token.
      expect(body.errors.length).toBeGreaterThan(0);
      for (const err of body.errors) {
        expect(typeof err === "string" && err.startsWith("validation:")).toBe(
          true,
        );
      }
    }
  });

  it("with an inner JSON Schema that is itself malformed returns 400 with schema-error path", async () => {
    // `output_schema` here uses an unknown keyword `requried` (typo); the
    // pipeline def shape passes the outer schema, but our deeper
    // `validateJsonSchema` walk catches the malformed inner schema.
    const yaml = `
id: typo-pipeline
initial_input: { type: object }
subtasks:
  - id: a
    instructions: x
    output_schema:
      type: object
      requried: [foo]
final_output:
  composes: ["a.*"]
  webhook: https://example.com/webhook
`;
    const response = await server.app.request("/pipelines", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ id: "typo-pipeline", def_yaml: yaml }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as EnvelopeResponse<unknown>;
    expect(body.ok).toBe(false);
    if (body.ok === false) {
      // At least one error references a path beneath a subtask's schema.
      const joined = body.errors.map((e) => (typeof e === "string" ? e : ""))
        .join("\n");
      expect(joined).toMatch(/^validation:/m);
    }
  });

  it("twice with same id - second one wins (last-write)", async () => {
    const first = await server.app.request("/pipelines", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "jobseek-add-company",
        def_yaml: VALID_PIPELINE_YAML,
      }),
    });
    expect(first.status).toBe(200);

    // Second upsert: change the webhook so we can verify the new def_json
    // landed.
    const updated = VALID_PIPELINE_YAML.replace(
      "https://example.com/webhook",
      "https://example.com/webhook2",
    );
    const second = await server.app.request("/pipelines", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "jobseek-add-company",
        def_yaml: updated,
      }),
    });
    expect(second.status).toBe(200);

    const row = server.db
      .prepare("SELECT version, def_json FROM pipelines WHERE id = ?")
      .get("jobseek-add-company") as { version: number; def_json: string };
    expect(row.version).toBe(2);
    const def = JSON.parse(row.def_json) as { final_output: { webhook: string } };
    expect(def.final_output.webhook).toBe("https://example.com/webhook2");
  });

  it("rejects bodies above the 5 MB cap with 413", async () => {
    // 5 MB + a bit. Use a deterministic filler that's valid YAML so a
    // permissive size check followed by parsing doesn't accidentally
    // succeed.
    const filler = "x".repeat(5 * 1024 * 1024 + 1);
    const response = await server.app.request("/pipelines", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ id: "too-big", def_yaml: filler }),
    });
    expect(response.status).toBe(413);
    const body = (await response.json()) as EnvelopeResponse<unknown>;
    expect(body.ok).toBe(false);
    if (body.ok === false) {
      expect(body.errors).toContain("payload_too_large");
    }
  });

  it("rejects non-string def_yaml with 400", async () => {
    const response = await server.app.request("/pipelines", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ id: "x", def_yaml: 42 }),
    });
    expect(response.status).toBe(400);
  });

  it("rejects YAML that parses to a non-object with 400", async () => {
    const response = await server.app.request("/pipelines", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
      // Parses to the bare string "scalar".
      body: JSON.stringify({ id: "x", def_yaml: "scalar" }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as EnvelopeResponse<unknown>;
    expect(body.ok).toBe(false);
  });

  it("rejects non-JSON request body with 400", async () => {
    const response = await server.app.request("/pipelines", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as EnvelopeResponse<unknown>;
    expect(body.ok).toBe(false);
  });

  it("returns 401 without an Authorization header (auth wired to publisher routes)", async () => {
    const response = await server.app.request("/pipelines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "x", def_yaml: VALID_PIPELINE_YAML }),
    });
    expect(response.status).toBe(401);
  });
});

// --- POST /pipelines/{id}/runs -----------------------------------------

describe("POST /pipelines/{id}/runs", () => {
  let server: ReturnType<typeof freshServer>;
  beforeEach(async () => {
    server = freshServer();
    // Pre-register a pipeline.
    const r = await server.app.request("/pipelines", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "jobseek-add-company",
        def_yaml: VALID_PIPELINE_YAML,
      }),
    });
    expect(r.status).toBe(200);
  });

  it("returns 404 when the pipeline id is unknown", async () => {
    const response = await server.app.request("/pipelines/unknown/runs", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ initial_input: {} }),
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as EnvelopeResponse<unknown>;
    expect(body.ok).toBe(false);
    if (body.ok === false) {
      expect(body.errors).toContain("pipeline_not_found");
    }
  });

  it("returns 400 with failed paths when initial_input violates the pipeline schema", async () => {
    const response = await server.app.request(
      "/pipelines/jobseek-add-company/runs",
      {
        method: "POST",
        headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
        // Missing both required fields; `website` malformed.
        body: JSON.stringify({ initial_input: { website: "not-a-uri" } }),
      },
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as EnvelopeResponse<unknown>;
    expect(body.ok).toBe(false);
    if (body.ok === false) {
      // At least one path should reference the missing required field.
      const joined = body.errors.map((e) => (typeof e === "string" ? e : ""))
        .join("\n");
      expect(joined).toMatch(/^validation:/m);
    }
  });

  it("returns 400 when the run body is not valid JSON", async () => {
    const response = await server.app.request(
      "/pipelines/jobseek-add-company/runs",
      {
        method: "POST",
        headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
        body: "{not json",
      },
    );
    expect(response.status).toBe(400);
  });

  it("returns 200 { run_id } and creates the right ready-set rows on valid input", async () => {
    const response = await server.app.request(
      "/pipelines/jobseek-add-company/runs",
      {
        method: "POST",
        headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({
          initial_input: {
            company_name: "ExampleCo",
            website: "https://example.co",
          },
        }),
      },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as EnvelopeResponse<{
      run_id: string;
    }>;
    expect(body.ok).toBe(true);
    if (body.ok !== true || body.data === undefined) {
      throw new Error("expected ok=true with data");
    }
    const runId = body.data.run_id;
    expect(typeof runId).toBe("string");
    expect(runId.length).toBeGreaterThan(0);

    // Run row inserted with status=running.
    const runRow = server.db
      .prepare("SELECT status, pipeline_id FROM runs WHERE id = ?")
      .get(runId) as { status: string; pipeline_id: string };
    expect(runRow.status).toBe("running");
    expect(runRow.pipeline_id).toBe("jobseek-add-company");

    // Ready-set: only static subtasks with empty `requires` AND that
    // are not the target of a `spawns.template`. In our fixture:
    //   - pre-verify         (no requires, not a spawn template) -> READY
    //   - setup-metadata     (requires: [pre-verify])            -> NOT in ready set
    //   - list-boards        (requires: [pre-verify])            -> NOT in ready set
    //   - configure-board    (no requires BUT spawn-template)    -> NOT in ready set
    const subtaskIds = server.db
      .prepare(
        "SELECT subtask_id, status, claim_token FROM subtask_instances WHERE run_id = ? ORDER BY subtask_id",
      )
      .all(runId) as Array<{
        subtask_id: string;
        status: string;
        claim_token: string | null;
      }>;
    expect(subtaskIds.map((r) => r.subtask_id)).toEqual(["pre-verify"]);
    for (const r of subtaskIds) {
      expect(r.status).toBe("ready");
      expect(r.claim_token).toBeNull();
    }
  });
});

// --- GET /runs/{run_id} ------------------------------------------------

describe("GET /runs/{run_id}", () => {
  let server: ReturnType<typeof freshServer>;
  beforeEach(async () => {
    server = freshServer();
    const r = await server.app.request("/pipelines", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "jobseek-add-company",
        def_yaml: VALID_PIPELINE_YAML,
      }),
    });
    expect(r.status).toBe(200);
  });

  it("returns 404 for an unknown run id", async () => {
    const response = await server.app.request("/runs/missing-run", {
      headers: AUTH_HEADERS,
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as EnvelopeResponse<unknown>;
    expect(body.ok).toBe(false);
    if (body.ok === false) {
      expect(body.errors).toContain("run_not_found");
    }
  });

  it("returns status='running' for an in-progress run", async () => {
    const created = await server.app.request(
      "/pipelines/jobseek-add-company/runs",
      {
        method: "POST",
        headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({
          initial_input: {
            company_name: "ExampleCo",
            website: "https://example.co",
          },
        }),
      },
    );
    const createdBody = (await created.json()) as EnvelopeResponse<{
      run_id: string;
    }>;
    if (createdBody.ok !== true || createdBody.data === undefined) {
      throw new Error("expected ok=true with data");
    }
    const runId = createdBody.data.run_id;

    const response = await server.app.request(`/runs/${runId}`, {
      headers: AUTH_HEADERS,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as EnvelopeResponse<{
      status: string;
      final_output?: unknown;
      agent_actions: ReadonlyArray<unknown>;
    }>;
    if (body.ok !== true || body.data === undefined) {
      throw new Error("expected ok=true with data");
    }
    expect(body.data.status).toBe("running");
    // No subtasks have submitted; final_output is omitted.
    expect(body.data.final_output).toBeUndefined();
    expect(body.data.agent_actions).toEqual([]);
  });

  it("returns final_output for a completed run", async () => {
    // Spin up a run, then mark it `completed` directly via SQL — the
    // run-loop hasn't landed yet (M6/M7), so we exercise the GET shape
    // by simulating the terminal state.
    const created = await server.app.request(
      "/pipelines/jobseek-add-company/runs",
      {
        method: "POST",
        headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({
          initial_input: {
            company_name: "ExampleCo",
            website: "https://example.co",
          },
        }),
      },
    );
    const createdBody = (await created.json()) as EnvelopeResponse<{
      run_id: string;
    }>;
    if (createdBody.ok !== true || createdBody.data === undefined) {
      throw new Error("expected ok=true with data");
    }
    const runId = createdBody.data.run_id;

    const finalOutput = { canonical_name: "ExampleCo", boards: [] };
    server.db
      .prepare(
        "UPDATE runs SET status = 'completed', final_output_json = ?, completed_at = ? WHERE id = ?",
      )
      .run(JSON.stringify(finalOutput), new Date().toISOString(), runId);

    const response = await server.app.request(`/runs/${runId}`, {
      headers: AUTH_HEADERS,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as EnvelopeResponse<{
      status: string;
      final_output?: unknown;
      agent_actions: ReadonlyArray<unknown>;
    }>;
    if (body.ok !== true || body.data === undefined) {
      throw new Error("expected ok=true with data");
    }
    expect(body.data.status).toBe("completed");
    expect(body.data.final_output).toEqual(finalOutput);
  });

  it("exposes webhook_status from runs.webhook_status (M10)", async () => {
    const created = await server.app.request(
      "/pipelines/jobseek-add-company/runs",
      {
        method: "POST",
        headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({
          initial_input: {
            company_name: "ExampleCo",
            website: "https://example.co",
          },
        }),
      },
    );
    const createdBody = (await created.json()) as EnvelopeResponse<{
      run_id: string;
    }>;
    if (createdBody.ok !== true || createdBody.data === undefined) {
      throw new Error("expected ok=true with data");
    }
    const runId = createdBody.data.run_id;

    // Initial state: webhook_status is NULL → exposed as null.
    let response = await server.app.request(`/runs/${runId}`, {
      headers: AUTH_HEADERS,
    });
    let body = (await response.json()) as EnvelopeResponse<{
      webhook_status: string | null;
    }>;
    if (body.ok !== true || body.data === undefined) {
      throw new Error("expected ok=true");
    }
    expect(body.data.webhook_status).toBeNull();

    // Flip via SQL (simulates a completed delivery) and confirm read-back.
    server.db
      .prepare("UPDATE runs SET webhook_status = 'delivered' WHERE id = ?")
      .run(runId);
    response = await server.app.request(`/runs/${runId}`, {
      headers: AUTH_HEADERS,
    });
    body = (await response.json()) as EnvelopeResponse<{
      webhook_status: string | null;
    }>;
    if (body.ok !== true || body.data === undefined) {
      throw new Error("expected ok=true");
    }
    expect(body.data.webhook_status).toBe("delivered");
  });

  it("truncates oversize agent_action payloads with a marker", async () => {
    // Seed a run + instance + an action whose args/response are well above
    // the 1 KB read-time cap.
    const created = await server.app.request(
      "/pipelines/jobseek-add-company/runs",
      {
        method: "POST",
        headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({
          initial_input: {
            company_name: "ExampleCo",
            website: "https://example.co",
          },
        }),
      },
    );
    const createdBody = (await created.json()) as EnvelopeResponse<{
      run_id: string;
    }>;
    if (createdBody.ok !== true || createdBody.data === undefined) {
      throw new Error("expected ok=true with data");
    }
    const runId = createdBody.data.run_id;

    // Pull the lone ready-set instance to attach an action.
    const instance = server.db
      .prepare("SELECT id FROM subtask_instances WHERE run_id = ? LIMIT 1")
      .get(runId) as { id: string };
    const big = "z".repeat(2048);
    server.db
      .prepare(
        `INSERT INTO agent_actions (instance_id, ts, kind, subcommand, args_json, response_json, truncated)
           VALUES (?, ?, 'task_tool', 'probe monitor', ?, ?, 0)`,
      )
      .run(instance.id, new Date().toISOString(), big, big);

    const response = await server.app.request(`/runs/${runId}`, {
      headers: AUTH_HEADERS,
    });
    const body = (await response.json()) as EnvelopeResponse<{
      agent_actions: ReadonlyArray<{
        args_json: string | null;
        response_json: string | null;
        truncated: boolean;
      }>;
    }>;
    if (body.ok !== true || body.data === undefined) {
      throw new Error("expected ok=true with data");
    }
    expect(body.data.agent_actions.length).toBe(1);
    const action = body.data.agent_actions[0];
    if (action === undefined) {
      throw new Error("expected one action");
    }
    expect(action.truncated).toBe(true);
    expect(action.args_json).not.toBeNull();
    expect(action.args_json?.length).toBeLessThan(big.length);
    expect(action.args_json).toMatch(/truncated/);
  });
});
