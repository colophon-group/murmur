/**
 * Tests for `src/api/agent/spawns.ts` and the spawn wiring through
 * `src/api/agent/lifecycle.ts` + `src/api/agent/work.ts` (DESIGN.md §3.1,
 * issue #13 / M8).
 *
 * Test bullets are taken verbatim from issue #13's "Verification" section.
 * Every named bullet has at least one corresponding `it()` below; the
 * bullet text is included in the test title so a reviewer can grep for it.
 */

import { describe, expect, it } from "vitest";

import type Database from "better-sqlite3";

import type { EnvelopeResponse, SubtaskDef } from "@murmur/contracts-types";

import { openDb } from "../../db/index.js";
import { runMigrations } from "../../db/migrate.js";

import { createAgentApp } from "./index.js";
import {
  applySpawns,
  bindChildInput,
  extractForEachArray,
} from "./spawns.js";
import type { NextWorkData, SubmitOkData } from "./work.js";

/**
 * Look up a subtask def by id from a pipeline-def-shaped object. Throws
 * (rather than returning `undefined`) so the test's typecheck stays
 * strict — every test that uses this expects the def to exist.
 */
function findSubtask(
  def: { subtasks: ReadonlyArray<SubtaskDef> },
  id: string,
): SubtaskDef {
  const found = def.subtasks.find((s) => s.id === id);
  if (found === undefined) {
    throw new Error(`subtask def not found: ${id}`);
  }
  return found;
}

/**
 * Pipeline def used by spawn tests. `list-boards` declares
 * `spawns: { for_each, template, bind_as }`; `configure-board` is the
 * spawn template. Schemas are deliberately permissive but require the
 * spawn-relevant fields (so a malformed parent submit can't pass).
 */
const SPAWN_PIPELINE_ID = "spawn-pipeline";
const SPAWN_PIPELINE_VERSION = 1;

interface PipelineDefForTest {
  readonly id: string;
  readonly initial_input: Readonly<Record<string, unknown>>;
  readonly subtasks: ReadonlyArray<SubtaskDef>;
  readonly final_output: {
    readonly composes: ReadonlyArray<string>;
    readonly webhook: string;
  };
}

const SPAWN_PIPELINE_DEF: PipelineDefForTest = {
  id: SPAWN_PIPELINE_ID,
  initial_input: { type: "object" },
  subtasks: [
    {
      id: "list-boards",
      instructions: "List the company's boards.",
      output_schema: {
        type: "object",
        properties: {
          boards: { type: "array" },
        },
        required: ["boards"],
        additionalProperties: false,
      },
      spawns: {
        for_each: "boards",
        template: "configure-board",
        bind_as: "board",
      },
    },
    {
      id: "configure-board",
      instructions: "Configure this board.",
      output_schema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
    },
  ],
  final_output: {
    composes: ["list-boards.*"],
    webhook: "https://example.test/webhook",
  },
};

/**
 * Pipeline def for the "no spawn directive" path. Two subtasks, one
 * `requires` the other, no `spawns:`.
 */
const NO_SPAWN_PIPELINE_ID = "no-spawn-pipeline";
const NO_SPAWN_PIPELINE_DEF: PipelineDefForTest = {
  id: NO_SPAWN_PIPELINE_ID,
  initial_input: { type: "object" },
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
  final_output: {
    composes: ["first.*"],
    webhook: "https://example.test/webhook",
  },
};

/* ---------- Harness ---------- */

interface SpawnHarness {
  readonly db: Database.Database;
  readonly app: ReturnType<typeof createAgentApp>;
  readonly nowFn: () => string;
  /** Counter for deterministic claim tokens. */
  setNow(iso: string): void;
}

/**
 * Build a fresh in-memory test harness, seed both pipelines, and return
 * a Hono app whose `/work/next` and `/work/{token}/result` routes are
 * mounted.
 */
function makeHarness(opts?: {
  initialNow?: string;
  pipelineDef?: typeof SPAWN_PIPELINE_DEF;
  pipelineId?: string;
  /** Force `instanceIdFn` to a deterministic counter for spawn ids. */
  instanceIdSeed?: string;
}): SpawnHarness {
  const db = openDb(":memory:");
  runMigrations(db);

  const now = { value: opts?.initialNow ?? "2026-04-29T12:00:00.000Z" };
  const nowFn = (): string => now.value;

  // Seed both pipelines so each test can choose which to drive.
  for (const [id, def] of [
    [SPAWN_PIPELINE_ID, SPAWN_PIPELINE_DEF],
    [NO_SPAWN_PIPELINE_ID, NO_SPAWN_PIPELINE_DEF],
  ] as const) {
    db.prepare(
      `INSERT INTO pipelines (id, version, def_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, SPAWN_PIPELINE_VERSION, JSON.stringify(def), now.value, now.value);
  }

  let claimCounter = 0;
  const claimTokenFn = (): string => {
    claimCounter += 1;
    return `c_${claimCounter.toString().padStart(8, "0")}`;
  };

  let instCounter = 0;
  const instanceIdFn = (): string => {
    instCounter += 1;
    return `${opts?.instanceIdSeed ?? "spawn"}_${instCounter
      .toString()
      .padStart(4, "0")}`;
  };

  const app = createAgentApp({
    db,
    nowFn,
    claimTokenFn,
    instanceIdFn,
  });

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
 * Insert a `runs` row and one parent `subtask_instances` row in `ready`.
 * The parent's input is `{}` — tests don't drive `inputs:` resolution
 * here. Returns the parent instance id.
 */
function seedRunWithParent(
  db: Database.Database,
  runId: string,
  pipelineId: string,
  parentSubtaskId: string,
  parentInstanceId: string,
  now: string,
): void {
  db.prepare(
    `INSERT INTO runs
       (id, pipeline_id, pipeline_version, status, initial_input_json,
        webhook_url, created_at)
     VALUES (?, ?, ?, 'running', '{}', 'https://example.test/webhook', ?)`,
  ).run(runId, pipelineId, SPAWN_PIPELINE_VERSION, now);
  db.prepare(
    `INSERT INTO subtask_instances
       (id, run_id, subtask_id, status, input_json, created_at, updated_at)
     VALUES (?, ?, ?, 'ready', '{}', ?, ?)`,
  ).run(parentInstanceId, runId, parentSubtaskId, now, now);
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

/* ---------- Pure helpers ---------- */

describe("extractForEachArray", () => {
  it("returns the array for a present field", () => {
    expect(extractForEachArray({ boards: ["a", "b"] }, "boards")).toEqual([
      "a",
      "b",
    ]);
  });

  it("returns empty array for an empty for_each field (no spawn fires path keeps shape)", () => {
    expect(extractForEachArray({ boards: [] }, "boards")).toEqual([]);
  });

  it("returns null when the field is missing", () => {
    expect(extractForEachArray({ other: 1 }, "boards")).toBeNull();
  });

  it("returns null when the field is not an array", () => {
    expect(extractForEachArray({ boards: "nope" }, "boards")).toBeNull();
  });

  it("returns null when the output is not an object", () => {
    expect(extractForEachArray(null, "boards")).toBeNull();
    expect(extractForEachArray(["x"], "boards")).toBeNull();
    expect(extractForEachArray("x", "boards")).toBeNull();
  });
});

describe("bindChildInput", () => {
  it("wraps the element under `bind_as` when set", () => {
    expect(
      bindChildInput(
        { for_each: "boards", template: "x", bind_as: "board" },
        { alias: "careers-de" },
      ),
    ).toEqual({ board: { alias: "careers-de" } });
  });

  it("returns the element verbatim when bind_as is omitted", () => {
    expect(
      bindChildInput(
        { for_each: "boards", template: "x" },
        { alias: "careers-de" },
      ),
    ).toEqual({ alias: "careers-de" });
  });
});

/* ---------- applySpawns (unit-level) ---------- */

describe("applySpawns", () => {
  it("inserts one row per element with bind_as wrapping", () => {
    const h = makeHarness();
    try {
      seedRunWithParent(
        h.db,
        "run-A",
        SPAWN_PIPELINE_ID,
        "list-boards",
        "p_parent",
        h.nowFn(),
      );
      let i = 0;
      const ids = applySpawns(
        h.db,
        "p_parent",
        "run-A",
        findSubtask(SPAWN_PIPELINE_DEF, "list-boards"),
        { boards: [{ alias: "a" }, { alias: "b" }, { alias: "c" }] },
        h.nowFn(),
        () => {
          i += 1;
          return `child_${i}`;
        },
      );
      expect(ids).toEqual(["child_1", "child_2", "child_3"]);

      const rows = h.db
        .prepare(
          `SELECT id, run_id, subtask_id, parent_instance_id, spawn_index,
                  status, input_json
             FROM subtask_instances
            WHERE parent_instance_id = ?
            ORDER BY spawn_index`,
        )
        .all("p_parent") as ReadonlyArray<{
        id: string;
        run_id: string;
        subtask_id: string;
        parent_instance_id: string;
        spawn_index: number;
        status: string;
        input_json: string;
      }>;
      expect(rows.length).toBe(3);
      expect(rows.map((r) => r.id)).toEqual(["child_1", "child_2", "child_3"]);
      expect(rows.every((r) => r.run_id === "run-A")).toBe(true);
      expect(rows.every((r) => r.subtask_id === "configure-board")).toBe(true);
      expect(rows.map((r) => r.spawn_index)).toEqual([0, 1, 2]);
      expect(rows.every((r) => r.status === "ready")).toBe(true);
      expect(rows.map((r) => JSON.parse(r.input_json))).toEqual([
        { board: { alias: "a" } },
        { board: { alias: "b" } },
        { board: { alias: "c" } },
      ]);
    } finally {
      h.db.close();
    }
  });

  it("returns [] when the parent has no spawns directive", () => {
    const h = makeHarness();
    try {
      seedRunWithParent(
        h.db,
        "run-N",
        NO_SPAWN_PIPELINE_ID,
        "first",
        "p_first",
        h.nowFn(),
      );
      const ids = applySpawns(
        h.db,
        "p_first",
        "run-N",
        findSubtask(NO_SPAWN_PIPELINE_DEF, "first"),
        { score: 1 },
        h.nowFn(),
        () => "child_x",
      );
      expect(ids).toEqual([]);
      const rows = h.db
        .prepare(`SELECT COUNT(*) AS c FROM subtask_instances WHERE run_id = ?`)
        .get("run-N") as { c: number };
      expect(rows.c).toBe(1); // just the parent
    } finally {
      h.db.close();
    }
  });

  it("inserts duplicate-bind children when the for_each array has duplicates (no dedup)", () => {
    const h = makeHarness();
    try {
      seedRunWithParent(
        h.db,
        "run-D",
        SPAWN_PIPELINE_ID,
        "list-boards",
        "p_parent",
        h.nowFn(),
      );
      let i = 0;
      applySpawns(
        h.db,
        "p_parent",
        "run-D",
        findSubtask(SPAWN_PIPELINE_DEF, "list-boards"),
        { boards: [{ alias: "dup" }, { alias: "dup" }] },
        h.nowFn(),
        () => {
          i += 1;
          return `dup_${i}`;
        },
      );
      const rows = h.db
        .prepare(
          `SELECT input_json FROM subtask_instances
            WHERE parent_instance_id = ? ORDER BY spawn_index`,
        )
        .all("p_parent") as ReadonlyArray<{ input_json: string }>;
      expect(rows.length).toBe(2);
      expect(rows.map((r) => JSON.parse(r.input_json))).toEqual([
        { board: { alias: "dup" } },
        { board: { alias: "dup" } },
      ]);
    } finally {
      h.db.close();
    }
  });

  it("inserts nothing when the for_each field is missing in output", () => {
    const h = makeHarness();
    try {
      seedRunWithParent(
        h.db,
        "run-M",
        SPAWN_PIPELINE_ID,
        "list-boards",
        "p_parent",
        h.nowFn(),
      );
      const ids = applySpawns(
        h.db,
        "p_parent",
        "run-M",
        findSubtask(SPAWN_PIPELINE_DEF, "list-boards"),
        // Note: schema would reject this in production. Defence-in-depth.
        { other: "data" },
        h.nowFn(),
        () => "should_not_be_called",
      );
      expect(ids).toEqual([]);
      const rows = h.db
        .prepare(
          `SELECT COUNT(*) AS c FROM subtask_instances
            WHERE parent_instance_id = ?`,
        )
        .get("p_parent") as { c: number };
      expect(rows.c).toBe(0);
    } finally {
      h.db.close();
    }
  });

  it("inserts nothing for an empty for_each array", () => {
    const h = makeHarness();
    try {
      seedRunWithParent(
        h.db,
        "run-E",
        SPAWN_PIPELINE_ID,
        "list-boards",
        "p_parent",
        h.nowFn(),
      );
      const ids = applySpawns(
        h.db,
        "p_parent",
        "run-E",
        findSubtask(SPAWN_PIPELINE_DEF, "list-boards"),
        { boards: [] },
        h.nowFn(),
        () => "should_not_be_called",
      );
      expect(ids).toEqual([]);
    } finally {
      h.db.close();
    }
  });
});

/* ---------- End-to-end through the CAS submit ---------- */

describe("M8 spawns runtime — end-to-end through submit", () => {
  it("Pipeline with list-boards + boards: [a, b, c] submission → exactly 3 rows with bind set to a/b/c", async () => {
    const h = makeHarness();
    try {
      seedRunWithParent(
        h.db,
        "run-A",
        SPAWN_PIPELINE_ID,
        "list-boards",
        "p_parent",
        h.nowFn(),
      );

      // The parent is ready; claim it.
      const claim = await getJson<NextWorkData>(h.app, "/next");
      if (!claim.body.ok || !claim.body.data) throw new Error("expected claim");
      const token = claim.body.data.claim;

      // Submit the parent's output containing the boards array.
      const submit = await postJson<SubmitOkData>(
        h.app,
        `/${token}/result`,
        { result: { boards: [{ alias: "a" }, { alias: "b" }, { alias: "c" }] } },
      );
      expect(submit.body.ok).toBe(true);

      const children = h.db
        .prepare(
          `SELECT subtask_id, status, parent_instance_id, spawn_index, input_json
             FROM subtask_instances
            WHERE parent_instance_id = 'p_parent'
            ORDER BY spawn_index`,
        )
        .all() as ReadonlyArray<{
        subtask_id: string;
        status: string;
        parent_instance_id: string;
        spawn_index: number;
        input_json: string;
      }>;
      expect(children.length).toBe(3);
      expect(children.every((r) => r.subtask_id === "configure-board")).toBe(
        true,
      );
      expect(children.every((r) => r.status === "ready")).toBe(true);
      expect(children.every((r) => r.parent_instance_id === "p_parent")).toBe(
        true,
      );
      expect(children.map((r) => JSON.parse(r.input_json))).toEqual([
        { board: { alias: "a" } },
        { board: { alias: "b" } },
        { board: { alias: "c" } },
      ]);
    } finally {
      h.db.close();
    }
  });

  it("Empty boards array → no rows inserted; agent_actions records the no-op (the parent's submit_result row IS the audit)", async () => {
    const h = makeHarness();
    try {
      seedRunWithParent(
        h.db,
        "run-E",
        SPAWN_PIPELINE_ID,
        "list-boards",
        "p_parent",
        h.nowFn(),
      );
      const claim = await getJson<NextWorkData>(h.app, "/next");
      if (!claim.body.ok || !claim.body.data) throw new Error("expected claim");
      const token = claim.body.data.claim;

      const submit = await postJson<SubmitOkData>(
        h.app,
        `/${token}/result`,
        { result: { boards: [] } },
      );
      expect(submit.body.ok).toBe(true);

      const children = h.db
        .prepare(
          `SELECT COUNT(*) AS c FROM subtask_instances
            WHERE parent_instance_id = 'p_parent'`,
        )
        .get() as { c: number };
      expect(children.c).toBe(0);

      // The parent's submit_result audit row is recorded — that IS the
      // no-op record; we do not want a separate "spawn fired 0 children"
      // row that bloats the audit log.
      const actions = h.db
        .prepare(
          `SELECT kind FROM agent_actions
            WHERE instance_id = 'p_parent' AND kind = 'submit_result'`,
        )
        .all() as ReadonlyArray<{ kind: string }>;
      expect(actions.length).toBeGreaterThan(0);
    } finally {
      h.db.close();
    }
  });

  it("Children all have status='ready' and are claimable via /work/next", async () => {
    const h = makeHarness();
    try {
      seedRunWithParent(
        h.db,
        "run-A",
        SPAWN_PIPELINE_ID,
        "list-boards",
        "p_parent",
        h.nowFn(),
      );
      const claim = await getJson<NextWorkData>(h.app, "/next");
      if (!claim.body.ok || !claim.body.data) throw new Error("expected claim");
      const token = claim.body.data.claim;
      const submit = await postJson<SubmitOkData>(h.app, `/${token}/result`, {
        result: { boards: [{ alias: "a" }, { alias: "b" }] },
      });
      expect(submit.body.ok).toBe(true);

      // Two children should now be claimable in order.
      const c1 = await getJson<NextWorkData>(h.app, "/next");
      if (!c1.body.ok || !c1.body.data) throw new Error("expected child claim 1");
      expect(c1.body.data.instructions).toBe("Configure this board.");
      expect(c1.body.data.input).toEqual({ board: { alias: "a" } });

      const c2 = await getJson<NextWorkData>(h.app, "/next");
      if (!c2.body.ok || !c2.body.data) throw new Error("expected child claim 2");
      expect(c2.body.data.input).toEqual({ board: { alias: "b" } });

      const c3 = await getJson<NextWorkData | null>(h.app, "/next");
      // No third child.
      expect(c3.body.ok).toBe(true);
      if (c3.body.ok) expect(c3.body.data).toBeNull();
    } finally {
      h.db.close();
    }
  });

  it("parent_instance_id is set correctly", async () => {
    const h = makeHarness();
    try {
      seedRunWithParent(
        h.db,
        "run-A",
        SPAWN_PIPELINE_ID,
        "list-boards",
        "p_parent",
        h.nowFn(),
      );
      const claim = await getJson<NextWorkData>(h.app, "/next");
      if (!claim.body.ok || !claim.body.data) throw new Error("expected claim");
      const token = claim.body.data.claim;
      await postJson<SubmitOkData>(h.app, `/${token}/result`, {
        result: { boards: [{ alias: "x" }] },
      });

      const child = h.db
        .prepare(
          `SELECT parent_instance_id FROM subtask_instances
            WHERE subtask_id = 'configure-board'`,
        )
        .get() as { parent_instance_id: string | null } | undefined;
      expect(child?.parent_instance_id).toBe("p_parent");
    } finally {
      h.db.close();
    }
  });

  it("After all children submit, run is marked complete (no spawn re-fires)", async () => {
    const h = makeHarness();
    try {
      seedRunWithParent(
        h.db,
        "run-A",
        SPAWN_PIPELINE_ID,
        "list-boards",
        "p_parent",
        h.nowFn(),
      );

      // Parent submit → spawns 2 children.
      const parent = await getJson<NextWorkData>(h.app, "/next");
      if (!parent.body.ok || !parent.body.data) throw new Error("expected claim");
      await postJson<SubmitOkData>(h.app, `/${parent.body.data.claim}/result`, {
        result: { boards: [{ alias: "a" }, { alias: "b" }] },
      });

      // Drain both children.
      for (let i = 0; i < 2; i += 1) {
        const c = await getJson<NextWorkData>(h.app, "/next");
        if (!c.body.ok || !c.body.data) throw new Error("expected child claim");
        const r = await postJson<SubmitOkData>(
          h.app,
          `/${c.body.data.claim}/result`,
          { result: { ok: true } },
        );
        expect(r.body.ok).toBe(true);
      }

      // Run flipped to completed.
      const run = h.db
        .prepare(
          `SELECT status, completed_at FROM runs WHERE id = 'run-A'`,
        )
        .get() as { status: string; completed_at: string | null } | undefined;
      expect(run?.status).toBe("completed");
      expect(typeof run?.completed_at).toBe("string");

      // No additional rows beyond parent + 2 children appeared.
      const total = h.db
        .prepare(`SELECT COUNT(*) AS c FROM subtask_instances WHERE run_id = 'run-A'`)
        .get() as { c: number };
      expect(total.c).toBe(3);
    } finally {
      h.db.close();
    }
  });

  it("Pipeline without spawns directive → no extra rows", async () => {
    const h = makeHarness();
    try {
      // Use the no-spawn pipeline and seed two ready+pending instances.
      h.db.prepare(
        `INSERT INTO runs
           (id, pipeline_id, pipeline_version, status, initial_input_json,
            webhook_url, created_at)
         VALUES (?, ?, ?, 'running', '{}', 'https://example.test/webhook', ?)`,
      ).run("run-N", NO_SPAWN_PIPELINE_ID, SPAWN_PIPELINE_VERSION, h.nowFn());
      h.db.prepare(
        `INSERT INTO subtask_instances
           (id, run_id, subtask_id, status, input_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, '{}', ?, ?)`,
      ).run("p_first", "run-N", "first", "ready", h.nowFn(), h.nowFn());
      h.db.prepare(
        `INSERT INTO subtask_instances
           (id, run_id, subtask_id, status, input_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, '{}', ?, ?)`,
      ).run(
        "p_second",
        "run-N",
        "second",
        "pending",
        new Date(new Date(h.nowFn()).getTime() + 1).toISOString(),
        h.nowFn(),
      );

      const claim = await getJson<NextWorkData>(h.app, "/next");
      if (!claim.body.ok || !claim.body.data) throw new Error("expected claim");
      await postJson<SubmitOkData>(
        h.app,
        `/${claim.body.data.claim}/result`,
        { result: { score: 1 } },
      );

      const total = h.db
        .prepare(`SELECT COUNT(*) AS c FROM subtask_instances WHERE run_id = 'run-N'`)
        .get() as { c: number };
      // No spawn ⇒ exactly the two seeded rows.
      expect(total.c).toBe(2);
    } finally {
      h.db.close();
    }
  });

  it("bind is the canonical input shape passed to the child's pull_task payload (verified end-to-end)", async () => {
    const h = makeHarness();
    try {
      seedRunWithParent(
        h.db,
        "run-A",
        SPAWN_PIPELINE_ID,
        "list-boards",
        "p_parent",
        h.nowFn(),
      );
      const claim = await getJson<NextWorkData>(h.app, "/next");
      if (!claim.body.ok || !claim.body.data) throw new Error("expected claim");
      await postJson<SubmitOkData>(
        h.app,
        `/${claim.body.data.claim}/result`,
        {
          result: {
            boards: [{ alias: "careers-de", url: "https://x.test/de" }],
          },
        },
      );

      // Pull the child task; verify the agent-facing input is the bound element.
      const child = await getJson<NextWorkData>(h.app, "/next");
      if (!child.body.ok || !child.body.data) {
        throw new Error("expected child claim");
      }
      expect(child.body.data.input).toEqual({
        board: { alias: "careers-de", url: "https://x.test/de" },
      });
    } finally {
      h.db.close();
    }
  });
});

/* ---------- Atomicity ---------- */

describe("M8 spawns runtime — atomicity", () => {
  it("a forced error mid-spawn rolls back: no spawn rows persist and parent stays claimed", async () => {
    const h = makeHarness();
    try {
      seedRunWithParent(
        h.db,
        "run-A",
        SPAWN_PIPELINE_ID,
        "list-boards",
        "p_parent",
        h.nowFn(),
      );
      const claim = await getJson<NextWorkData>(h.app, "/next");
      if (!claim.body.ok || !claim.body.data) throw new Error("expected claim");
      const token = claim.body.data.claim;

      // Patch JSON.stringify to throw the second time it's called inside
      // spawn-row insertion. We can't easily mock the prepared statement
      // through the Hono request, so we sabotage one of the row's
      // input_json encodings — which sits inside the txn AFTER the parent
      // CAS UPDATE. The expected outcome: the whole txn rolls back, the
      // parent goes back to `claimed` (NOT `done`), and zero spawn rows
      // exist.
      //
      // Implementation: wrap better-sqlite3's INSERT for the spawn child
      // and force it to throw on the SECOND call (the first call inserts
      // child #0 successfully; the throw on #1 must roll back #0).
      let calls = 0;
      const originalPrepare = h.db.prepare.bind(h.db);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test seam: the harness wraps better-sqlite3's prepare to inject a fault on the spawn insert; wrapping is generic and the (...args: any[]) bridge mirrors the underlying API surface that we don't fully model here.
      (h.db as any).prepare = (sql: string) => {
        const stmt = originalPrepare(sql);
        if (sql.includes("INSERT INTO subtask_instances") && sql.includes("parent_instance_id")) {
          const realRun = stmt.run.bind(stmt);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          stmt.run = ((...args: any[]) => {
            calls += 1;
            if (calls === 2) {
              throw new Error("synthetic mid-spawn failure");
            }
            return realRun(...args);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          }) as any;
        }
        return stmt;
      };

      // Submit; the route's outer try/catch surfaces the thrown error
      // as an unhandled error → Hono returns 500. We don't assert on the
      // shape of the 500; we assert on the DB state.
      let threw = false;
      try {
        await postJson<SubmitOkData>(h.app, `/${token}/result`, {
          result: { boards: [{ alias: "x" }, { alias: "y" }, { alias: "z" }] },
        });
      } catch {
        threw = true;
      }
      // Hono catches the throw and turns it into a 500; the request
      // promise resolves with that response, so `threw` is usually false.
      // The atomicity assertion that follows is what matters.
      void threw;

      const parent = h.db
        .prepare(`SELECT status FROM subtask_instances WHERE id = 'p_parent'`)
        .get() as { status: string } | undefined;
      // CAS UPDATE rolled back → parent is still `claimed` (the CAS that
      // flipped it to `done` was inside the same txn).
      expect(parent?.status).toBe("claimed");

      const spawned = h.db
        .prepare(
          `SELECT COUNT(*) AS c FROM subtask_instances
            WHERE parent_instance_id = 'p_parent'`,
        )
        .get() as { c: number };
      expect(spawned.c).toBe(0);

      // Run still running.
      const run = h.db
        .prepare(`SELECT status FROM runs WHERE id = 'run-A'`)
        .get() as { status: string } | undefined;
      expect(run?.status).toBe("running");
    } finally {
      h.db.close();
    }
  });
});
