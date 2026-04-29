/**
 * Tests for `src/api/agent/work.ts` — `GET /work/next` and
 * `POST /work/{claim_token}/result` (DESIGN.md §3.3).
 *
 * Test bullets are taken verbatim from issue #10's "Verification" section.
 * Every named bullet has at least one corresponding `it()` below; the
 * bullet text is included in the test title so a reviewer can grep for it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import type Database from "better-sqlite3";

import type { EnvelopeResponse } from "@murmur/contracts-types";

import { openDb } from "../../db/index.js";
import { runMigrations } from "../../db/migrate.js";

import { createAgentApp } from "./index.js";
import type { NextWorkData, SubmitOkData } from "./work.js";

/**
 * A trivial pipeline def used by every test. Two subtasks; the second
 * `requires` the first. Both have permissive output schemas.
 *
 * Stored verbatim in `pipelines.def_json` so the route's payload-projection
 * code can read it back for `instructions` / `output_schema`.
 */
const TEST_PIPELINE_ID = "test-pipeline";
const TEST_PIPELINE_VERSION = 1;

interface TestPipelineDef {
  readonly id: string;
  readonly subtasks: ReadonlyArray<{
    readonly id: string;
    readonly instructions: string;
    readonly output_schema: Readonly<Record<string, unknown>>;
    readonly requires?: ReadonlyArray<string>;
  }>;
}

const TEST_PIPELINE_DEF: TestPipelineDef = {
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
    {
      id: "second",
      instructions: "Do the second thing, after first.",
      output_schema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
      requires: ["first"],
    },
  ],
};

interface TestHarness {
  readonly db: Database.Database;
  readonly app: ReturnType<typeof createAgentApp>;
  readonly nowFn: () => string;
  setNow(iso: string): void;
}

/**
 * Build a fresh in-memory test harness: open DB, run migrations, seed the
 * pipeline, return a Hono app. Each test gets its own DB so concurrency
 * tests don't bleed across cases.
 */
function makeHarness(opts?: {
  ttlMs?: number;
  initialNow?: string;
  dbPath?: string;
}): TestHarness {
  const db = openDb(opts?.dbPath ?? ":memory:");
  runMigrations(db);

  const now = { value: opts?.initialNow ?? "2026-04-29T12:00:00.000Z" };
  const nowFn = (): string => now.value;

  // Seed the pipeline def.
  db.prepare(
    `INSERT INTO pipelines (id, version, def_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    TEST_PIPELINE_ID,
    TEST_PIPELINE_VERSION,
    JSON.stringify(TEST_PIPELINE_DEF),
    now.value,
    now.value,
  );

  let counter = 0;
  const claimTokenFn = (): string => {
    counter += 1;
    return `c_${counter.toString().padStart(8, "0")}`;
  };

  const app = createAgentApp(
    opts?.ttlMs !== undefined
      ? { db, ttlMs: opts.ttlMs, nowFn, claimTokenFn }
      : { db, nowFn, claimTokenFn },
  );

  return {
    db,
    app,
    nowFn,
    setNow(iso: string): void {
      now.value = iso;
    },
  };
}

/**
 * Insert a `runs` row + N `subtask_instances` rows. The first subtask
 * instance is `ready`; subsequent ones are `pending` and gain `requires`.
 */
function seedRun(
  db: Database.Database,
  runId: string,
  subtaskIds: ReadonlyArray<string>,
  now: string,
  options?: { readyIds?: ReadonlyArray<string> },
): void {
  db.prepare(
    `INSERT INTO runs
       (id, pipeline_id, pipeline_version, status, initial_input_json,
        webhook_url, created_at)
     VALUES (?, ?, ?, 'running', '{}', 'https://example.test/webhook', ?)`,
  ).run(runId, TEST_PIPELINE_ID, TEST_PIPELINE_VERSION, now);

  const readySet = new Set(options?.readyIds ?? [subtaskIds[0]]);

  let i = 0;
  for (const subtaskId of subtaskIds) {
    const status = readySet.has(subtaskId) ? "ready" : "pending";
    // Stagger created_at by 1 ms so FIFO order is deterministic.
    const created = new Date(new Date(now).getTime() + i).toISOString();
    db.prepare(
      `INSERT INTO subtask_instances
         (id, run_id, subtask_id, status, input_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, '{}', ?, ?)`,
    ).run(`${runId}-${subtaskId}`, runId, subtaskId, status, created, created);
    i += 1;
  }
}

async function getJson<T>(
  app: ReturnType<typeof createAgentApp>,
  path: string,
): Promise<{ status: number; body: EnvelopeResponse<T> }> {
  const response = await app.request(path, { method: "GET" });
  const body = (await response.json()) as EnvelopeResponse<T>;
  return { status: response.status, body };
}

async function postJson<T>(
  app: ReturnType<typeof createAgentApp>,
  path: string,
  body: unknown,
): Promise<{ status: number; body: EnvelopeResponse<T> }> {
  const response = await app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await response.json()) as EnvelopeResponse<T>;
  return { status: response.status, body: parsed };
}

/* ---------- GET /work/next ---------- */

describe("GET /work/next", () => {
  it("on empty queue → { ok: true, data: null }", async () => {
    const h = makeHarness();
    try {
      const { status, body } = await getJson<NextWorkData | null>(
        h.app,
        "/next",
      );
      // Body present, NOT 204 (issue #10 explicitly requires HTTP 200 + body).
      expect(status).toBe(200);
      expect(body).toEqual({ ok: true, data: null });
    } finally {
      h.db.close();
    }
  });

  it("on populated queue → { ok: true, data: { instructions, input, output_schema, claim } }", async () => {
    const h = makeHarness();
    try {
      seedRun(h.db, "run-A", ["first", "second"], h.nowFn());

      const { status, body } = await getJson<NextWorkData>(h.app, "/next");
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      if (!body.ok || body.data === undefined || body.data === null) {
        throw new Error("expected populated data");
      }
      expect(body.data.instructions).toBe("Do the first thing.");
      expect(body.data.output_schema).toMatchObject({ type: "object" });
      expect(typeof body.data.claim).toBe("string");
      expect(body.data.claim.length).toBeGreaterThan(0);
      expect(body.data.input).toEqual({});
    } finally {
      h.db.close();
    }
  });

  it("after a successful submit, the next GET /work/next returns the next ready subtask (integration)", async () => {
    const h = makeHarness();
    try {
      seedRun(h.db, "run-A", ["first", "second"], h.nowFn());

      const first = await getJson<NextWorkData>(h.app, "/next");
      if (!first.body.ok || !first.body.data) throw new Error("expected claim");
      const claimToken = first.body.data.claim;

      // Submit valid output for `first` to free `second` for claim.
      const submit = await postJson<SubmitOkData>(
        h.app,
        `/${claimToken}/result`,
        { result: { score: 7 } },
      );
      expect(submit.body.ok).toBe(true);

      const second = await getJson<NextWorkData>(h.app, "/next");
      if (!second.body.ok || !second.body.data) {
        throw new Error("expected second claim");
      }
      expect(second.body.data.instructions).toBe(
        "Do the second thing, after first.",
      );
    } finally {
      h.db.close();
    }
  });
});

/* ---------- Concurrency stress ---------- */

describe("Concurrency stress: atomic claim has no duplicates", () => {
  it("50 concurrent calls to /work/next against a 10-row queue produce 10 distinct claims, no duplicates", async () => {
    // Use a temp file-backed DB so WAL + BEGIN IMMEDIATE behave as in
    // production. better-sqlite3 serialises writes within a single
    // connection regardless, but the file-backed mode also exercises the
    // partial-unique-index constraint on `claim_token`.
    const dir = mkdtempSync(join(tmpdir(), "murmur-agent-stress-"));
    const dbPath = join(dir, "stress.db");

    try {
      const h = makeHarness({ dbPath });

      // Seed 10 ready subtasks, all on the same run for simplicity.
      const ids = Array.from({ length: 10 }, (_, i) => `t${i}`);

      // The default test pipeline only declares `first` and `second`;
      // for this test we install a parallel pipeline that declares
      // every t0..t9. The agent app reads pipelines by joining via
      // run_id, so we register a fresh pipeline + run.
      const stressPipelineId = "stress-pipeline";
      const stressDef = {
        id: stressPipelineId,
        subtasks: ids.map((id) => ({
          id,
          instructions: `do ${id}`,
          output_schema: {
            type: "object",
            properties: { ok: { type: "boolean" } },
            required: ["ok"],
            additionalProperties: false,
          },
        })),
      };
      h.db
        .prepare(
          `INSERT INTO pipelines (id, version, def_json, created_at, updated_at)
           VALUES (?, 1, ?, ?, ?)`,
        )
        .run(
          stressPipelineId,
          JSON.stringify(stressDef),
          h.nowFn(),
          h.nowFn(),
        );
      h.db
        .prepare(
          `INSERT INTO runs
             (id, pipeline_id, pipeline_version, status, initial_input_json,
              webhook_url, created_at)
           VALUES (?, ?, 1, 'running', '{}', 'https://example.test/webhook', ?)`,
        )
        .run("run-S", stressPipelineId, h.nowFn());

      let i = 0;
      for (const subtaskId of ids) {
        const created = new Date(
          new Date(h.nowFn()).getTime() + i,
        ).toISOString();
        h.db
          .prepare(
            `INSERT INTO subtask_instances
               (id, run_id, subtask_id, status, input_json, created_at, updated_at)
             VALUES (?, ?, ?, 'ready', '{}', ?, ?)`,
          )
          .run(`run-S-${subtaskId}`, "run-S", subtaskId, created, created);
        i += 1;
      }

      const calls: Promise<{
        status: number;
        body: EnvelopeResponse<NextWorkData | null>;
      }>[] = [];
      for (let i = 0; i < 50; i += 1) {
        calls.push(getJson<NextWorkData | null>(h.app, "/next"));
      }
      const results = await Promise.all(calls);

      const tokens: string[] = [];
      let nullCount = 0;
      for (const r of results) {
        expect(r.status).toBe(200);
        expect(r.body.ok).toBe(true);
        if (r.body.ok && r.body.data !== undefined && r.body.data !== null) {
          tokens.push(r.body.data.claim);
        } else {
          nullCount += 1;
        }
      }

      expect(tokens.length).toBe(10);
      expect(nullCount).toBe(40);
      // No duplicates.
      expect(new Set(tokens).size).toBe(10);

      h.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ---------- POST /work/{claim_token}/result ---------- */

describe("POST /work/{claim_token}/result", () => {
  it("with unknown claim → { ok: false, errors: ['claim_lost'] }", async () => {
    const h = makeHarness();
    try {
      const { body } = await postJson<SubmitOkData>(
        h.app,
        "/c_doesnotexist/result",
        { result: { score: 1 } },
      );
      expect(body.ok).toBe(false);
      if (body.ok) throw new Error("unreachable");
      expect(body.errors).toEqual(["claim_lost"]);
    } finally {
      h.db.close();
    }
  });

  it("with expired claim → { ok: false, errors: ['claim_lost'] }", async () => {
    // Use a short TTL and advance the clock past it before submitting.
    const h = makeHarness({
      ttlMs: 10,
      initialNow: "2026-04-29T12:00:00.000Z",
    });
    try {
      seedRun(h.db, "run-A", ["first", "second"], h.nowFn());

      const claim = await getJson<NextWorkData>(h.app, "/next");
      if (!claim.body.ok || !claim.body.data) throw new Error("expected claim");
      const token = claim.body.data.claim;

      // Advance the clock past the TTL.
      h.setNow("2026-04-29T12:00:01.000Z");

      const submit = await postJson<SubmitOkData>(
        h.app,
        `/${token}/result`,
        { result: { score: 7 } },
      );
      expect(submit.body.ok).toBe(false);
      if (submit.body.ok) throw new Error("unreachable");
      expect(submit.body.errors).toEqual(["claim_lost"]);
    } finally {
      h.db.close();
    }
  });

  it("with schema-invalid output → { ok: false, errors: ['validation:/...:...', ...] }", async () => {
    const h = makeHarness();
    try {
      seedRun(h.db, "run-A", ["first", "second"], h.nowFn());

      const claim = await getJson<NextWorkData>(h.app, "/next");
      if (!claim.body.ok || !claim.body.data) throw new Error("expected claim");
      const token = claim.body.data.claim;

      // `score` is required; submit something that fails the schema.
      const submit = await postJson<SubmitOkData>(
        h.app,
        `/${token}/result`,
        { result: { wrong: "field" } },
      );
      expect(submit.body.ok).toBe(false);
      if (submit.body.ok) throw new Error("unreachable");
      // At least one error string should start with `validation:`.
      const stringErrors = submit.body.errors.filter(
        (e): e is string => typeof e === "string",
      );
      expect(stringErrors.length).toBeGreaterThan(0);
      expect(stringErrors.every((e) => e.startsWith("validation:"))).toBe(true);

      // The row must NOT have been marked done — the schema-fail path
      // must reject before the CAS UPDATE runs (we never want a `done`
      // row without a valid result).
      const row = h.db
        .prepare(`SELECT status FROM subtask_instances WHERE claim_token = ?`)
        .get(token) as { status: string } | undefined;
      expect(row?.status).toBe("claimed");
    } finally {
      h.db.close();
    }
  });

  it("with valid output → { ok: true, data: { run_id } }, status='done'", async () => {
    const h = makeHarness();
    try {
      seedRun(h.db, "run-A", ["first", "second"], h.nowFn());

      const claim = await getJson<NextWorkData>(h.app, "/next");
      if (!claim.body.ok || !claim.body.data) throw new Error("expected claim");
      const token = claim.body.data.claim;

      const submit = await postJson<SubmitOkData>(
        h.app,
        `/${token}/result`,
        { result: { score: 9 } },
      );
      expect(submit.body.ok).toBe(true);
      if (!submit.body.ok || submit.body.data === undefined) {
        throw new Error("expected ok");
      }
      expect(submit.body.data.run_id).toBe("run-A");

      // Status flipped to done; claim_token cleared so the row no longer
      // surfaces in `/work/next`.
      const row = h.db
        .prepare(
          `SELECT status, claim_token FROM subtask_instances WHERE id = 'run-A-first'`,
        )
        .get() as { status: string; claim_token: string | null } | undefined;
      expect(row?.status).toBe("done");
      expect(row?.claim_token).toBeNull();

      // `subtask_results` row written.
      const result = h.db
        .prepare(
          `SELECT output_json, notes FROM subtask_results WHERE instance_id = 'run-A-first'`,
        )
        .get() as { output_json: string; notes: string | null } | undefined;
      expect(result).toBeDefined();
      expect(JSON.parse(result?.output_json ?? "null")).toEqual({ score: 9 });
      expect(result?.notes).toBeNull();
    } finally {
      h.db.close();
    }
  });

  it("notes parameter persisted to agent_actions, not to subtask_results", async () => {
    const h = makeHarness();
    try {
      seedRun(h.db, "run-A", ["first", "second"], h.nowFn());

      const claim = await getJson<NextWorkData>(h.app, "/next");
      if (!claim.body.ok || !claim.body.data) throw new Error("expected claim");
      const token = claim.body.data.claim;

      const NOTES = "I tried two configs and picked the simpler one.";
      const submit = await postJson<SubmitOkData>(
        h.app,
        `/${token}/result`,
        { result: { score: 3 }, notes: NOTES },
      );
      expect(submit.body.ok).toBe(true);

      // `subtask_results.notes` MUST be NULL (per DESIGN.md §3.1 last
      // bullet + issue #10).
      const result = h.db
        .prepare(
          `SELECT notes FROM subtask_results WHERE instance_id = 'run-A-first'`,
        )
        .get() as { notes: string | null } | undefined;
      expect(result?.notes).toBeNull();

      // `agent_actions` row recorded for the submit, with the notes
      // visible somewhere in args_json or response_json.
      const actions = h.db
        .prepare(
          `SELECT kind, args_json FROM agent_actions
            WHERE instance_id = 'run-A-first' AND kind = 'submit_result'`,
        )
        .all() as ReadonlyArray<{ kind: string; args_json: string | null }>;
      expect(actions.length).toBeGreaterThan(0);
      const persistedSomewhere = actions.some(
        (a) => (a.args_json ?? "").includes(NOTES),
      );
      expect(persistedSomewhere).toBe(true);
    } finally {
      h.db.close();
    }
  });

  it("idempotency: re-submitting against an already-done claim returns claim_lost", async () => {
    const h = makeHarness();
    try {
      seedRun(h.db, "run-A", ["first", "second"], h.nowFn());

      const claim = await getJson<NextWorkData>(h.app, "/next");
      if (!claim.body.ok || !claim.body.data) throw new Error("expected claim");
      const token = claim.body.data.claim;

      const first = await postJson<SubmitOkData>(
        h.app,
        `/${token}/result`,
        { result: { score: 1 } },
      );
      expect(first.body.ok).toBe(true);

      const second = await postJson<SubmitOkData>(
        h.app,
        `/${token}/result`,
        { result: { score: 2 } },
      );
      expect(second.body.ok).toBe(false);
      if (second.body.ok) throw new Error("unreachable");
      expect(second.body.errors).toEqual(["claim_lost"]);
    } finally {
      h.db.close();
    }
  });

  it("logs a 'claim' agent_action on a successful /work/next", async () => {
    const h = makeHarness();
    try {
      seedRun(h.db, "run-A", ["first", "second"], h.nowFn());

      const claim = await getJson<NextWorkData>(h.app, "/next");
      if (!claim.body.ok || !claim.body.data) throw new Error("expected claim");

      const actions = h.db
        .prepare(
          `SELECT kind FROM agent_actions WHERE instance_id = 'run-A-first'`,
        )
        .all() as ReadonlyArray<{ kind: string }>;
      expect(actions.some((a) => a.kind === "claim")).toBe(true);
    } finally {
      h.db.close();
    }
  });
});

/* ---------- Error envelope edge cases ---------- */

describe("POST /work/{claim_token}/result — input-shape edges", () => {
  it("with malformed JSON body → { ok: false, errors: ['bad_json'] }", async () => {
    const h = makeHarness();
    try {
      const response = await h.app.request("/c_anything/result", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      const parsed = (await response.json()) as EnvelopeResponse<unknown>;
      expect(response.status).toBe(400);
      expect(parsed).toEqual({ ok: false, errors: ["bad_json"] });
    } finally {
      h.db.close();
    }
  });

  it("with body missing `result` key → { ok: false, errors: ['bad_request'] }", async () => {
    const h = makeHarness();
    try {
      seedRun(h.db, "run-A", ["first", "second"], h.nowFn());
      const claim = await getJson<NextWorkData>(h.app, "/next");
      if (!claim.body.ok || !claim.body.data) throw new Error("expected claim");
      const token = claim.body.data.claim;

      const response = await h.app.request(`/${token}/result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: "no result key" }),
      });
      const parsed = (await response.json()) as EnvelopeResponse<unknown>;
      expect(response.status).toBe(400);
      expect(parsed).toEqual({ ok: false, errors: ["bad_request"] });
    } finally {
      h.db.close();
    }
  });
});

describe("/work/next pipeline-def drift", () => {
  it("returns 500 pipeline_not_found if the run's pipeline def is missing the subtask", async () => {
    const h = makeHarness();
    try {
      // Insert a run pointing at a pipeline whose def lacks the subtask we
      // queue. This simulates schema drift between run-start and now.
      const driftDef = { id: "drift", subtasks: [] };
      h.db
        .prepare(
          `INSERT INTO pipelines (id, version, def_json, created_at, updated_at)
           VALUES (?, 1, ?, ?, ?)`,
        )
        .run("drift", JSON.stringify(driftDef), h.nowFn(), h.nowFn());
      h.db
        .prepare(
          `INSERT INTO runs
             (id, pipeline_id, pipeline_version, status, initial_input_json,
              webhook_url, created_at)
           VALUES ('run-D', 'drift', 1, 'running', '{}',
                   'https://example.test/webhook', ?)`,
        )
        .run(h.nowFn());
      h.db
        .prepare(
          `INSERT INTO subtask_instances
             (id, run_id, subtask_id, status, input_json, created_at, updated_at)
           VALUES ('run-D-x', 'run-D', 'unknown-subtask', 'ready', '{}', ?, ?)`,
        )
        .run(h.nowFn(), h.nowFn());

      const response = await h.app.request("/next", { method: "GET" });
      expect(response.status).toBe(500);
      const body = (await response.json()) as EnvelopeResponse<unknown>;
      expect(body).toEqual({ ok: false, errors: ["pipeline_not_found"] });
    } finally {
      h.db.close();
    }
  });
});

/* ---------- Audit truncation ---------- */

describe("audit log truncation (DESIGN.md §3.6, 4 KB cap)", () => {
  it("agent_actions row is marked truncated=1 when args_json > 4 KB", async () => {
    // Use a permissive output schema that accepts large payloads.
    const db = openDb(":memory:");
    runMigrations(db);
    const def = {
      id: "big-pipeline",
      subtasks: [
        {
          id: "first",
          instructions: "go",
          // No `additionalProperties: false` so a huge `pad` field is accepted.
          output_schema: { type: "object" },
        },
      ],
    };
    const now = "2026-04-29T12:00:00.000Z";
    db.prepare(
      `INSERT INTO pipelines (id, version, def_json, created_at, updated_at)
       VALUES (?, 1, ?, ?, ?)`,
    ).run("big-pipeline", JSON.stringify(def), now, now);
    db.prepare(
      `INSERT INTO runs
         (id, pipeline_id, pipeline_version, status, initial_input_json,
          webhook_url, created_at)
       VALUES ('run-B', 'big-pipeline', 1, 'running', '{}',
               'https://example.test/webhook', ?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO subtask_instances
         (id, run_id, subtask_id, status, input_json, created_at, updated_at)
       VALUES ('run-B-first', 'run-B', 'first', 'ready', '{}', ?, ?)`,
    ).run(now, now);

    const app = createAgentApp({ db, nowFn: () => now });
    try {
      const claim = await getJson<NextWorkData>(app, "/next");
      if (!claim.body.ok || !claim.body.data) throw new Error("expected claim");
      const token = claim.body.data.claim;

      // Build a result whose JSON encoding exceeds the 4 KB cap.
      const padding = "x".repeat(8 * 1024);
      const submit = await postJson<SubmitOkData>(
        app,
        `/${token}/result`,
        { result: { pad: padding } },
      );
      expect(submit.body.ok).toBe(true);

      const action = db
        .prepare(
          `SELECT truncated FROM agent_actions
             WHERE instance_id = 'run-B-first' AND kind = 'submit_result'`,
        )
        .get() as { truncated: number } | undefined;
      expect(action?.truncated).toBe(1);
    } finally {
      db.close();
    }
  });
});

/* ---------- Default seams (no clock/RNG override) ---------- */

describe("default seams", () => {
  it("createAgentApp without nowFn/claimTokenFn uses real defaults and still issues claims", async () => {
    // Exercises the default-fallback branches for `nowFn` and
    // `claimTokenFn` (i.e. `freshClaimToken` + `nowIso`).
    const db = openDb(":memory:");
    runMigrations(db);
    db.prepare(
      `INSERT INTO pipelines (id, version, def_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      TEST_PIPELINE_ID,
      TEST_PIPELINE_VERSION,
      JSON.stringify(TEST_PIPELINE_DEF),
      new Date().toISOString(),
      new Date().toISOString(),
    );
    const app = createAgentApp({ db });
    seedRun(db, "run-default", ["first", "second"], new Date().toISOString());
    try {
      const response = await app.request("/next", { method: "GET" });
      expect(response.status).toBe(200);
      const body = (await response.json()) as EnvelopeResponse<NextWorkData>;
      expect(body.ok).toBe(true);
      if (body.ok && body.data) {
        // The default `freshClaimToken` prefixes with `c_`.
        expect(body.data.claim.startsWith("c_")).toBe(true);
        expect(body.data.claim.length).toBeGreaterThan(8);
      }
    } finally {
      db.close();
    }
  });
});

/* ---------- Envelope grep gate ---------- */

describe("envelope grep gate", () => {
  it("`pnpm grep-no-accepted-key` is empty across the agent module", () => {
    // Run the gate from the worktree root. Exits 0 on no matches; non-zero
    // on any match. Spawning the script (rather than re-implementing it in
    // JS) keeps a single source of truth for the gate's grep semantics.
    let failed = false;
    try {
      execFileSync(
        "bash",
        ["scripts/grep-no-accepted-key.sh"],
        { stdio: "pipe" },
      );
    } catch {
      failed = true;
    }
    expect(failed).toBe(false);
  });
});
