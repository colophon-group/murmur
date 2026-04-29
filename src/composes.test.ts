/**
 * `composes` runtime tests.
 *
 * Layered:
 *   1. `parseComposeRule` — the six grammar shapes round-trip to AST.
 *   2. `validateComposes` — registration-time gate for unknown subtask
 *      ids and unparseable rules.
 *   3. `composeFinalOutput` — runtime evaluation against a real
 *      better-sqlite3 in-memory DB seeded with `subtask_instances` +
 *      `subtask_results` rows. Each rule shape gets unit coverage; the
 *      final block runs the §3.1 jobseek-add-company shape end-to-end.
 *
 * Test DB strategy: one fresh `:memory:` SQLite per test, full migrations
 * applied. We INSERT directly rather than going through the API surface
 * so the tests are decoupled from M4/M5/M8 (which we don't want to
 * couple this PR to).
 *
 * Logger expectations: the runtime evaluator logs `warn` lines on missing
 * subtasks / fields. Tests that need to assert "logged-not-thrown" silence
 * stderr via a spy on `console.error` (the logger's underlying sink), then
 * inspect the spy.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PipelineDef } from "@murmur/contracts-types";

import {
  composeFinalOutput,
  parseComposeRule,
  validateComposes,
  type ComposeAst,
} from "./composes.js";
import { openDb } from "./db/index.js";
import { runMigrations } from "./db/migrate.js";

// --------------------------------------------------------------------------
// DB helpers
// --------------------------------------------------------------------------

/** Open a fresh in-memory DB with the full migrations applied. */
function freshDb(): Database.Database {
  const db = openDb(":memory:");
  runMigrations(db);
  return db;
}

interface SeedSubmission {
  readonly subtaskId: string;
  /** ISO timestamp; just used for ORDER BY tie-breaking. */
  readonly createdAt?: string;
  /** Spawn index (NULL for non-spawn). */
  readonly spawnIndex?: number | null;
  /** Optional explicit instance id; auto-derived if omitted. */
  readonly instanceId?: string;
  /** The submitted `result` (will be JSON.stringified into output_json). */
  readonly output: unknown;
}

/**
 * Seed a run with one or more submissions. Inserts a `pipelines` and
 * `runs` row to satisfy the FK constraints, then a `subtask_instances`
 * row + a `subtask_results` row per submission.
 *
 * `runId` and `pipelineId` are caller-supplied; the function returns the
 * `runId` for convenience.
 */
function seedRun(
  db: Database.Database,
  opts: {
    runId: string;
    pipelineId: string;
    submissions: ReadonlyArray<SeedSubmission>;
  },
): string {
  const { runId, pipelineId, submissions } = opts;
  const now = "2026-04-29T10:00:00Z";
  db.prepare(
    `INSERT INTO pipelines (id, version, def_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(pipelineId, 1, "{}", now, now);
  db.prepare(
    `INSERT INTO runs
       (id, pipeline_id, pipeline_version, status,
        initial_input_json, webhook_url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(runId, pipelineId, 1, "running", "{}", "https://x.test/hook", now);

  let i = 0;
  for (const s of submissions) {
    const instanceId = s.instanceId ?? `inst-${runId}-${i++}`;
    db.prepare(
      `INSERT INTO subtask_instances
         (id, run_id, subtask_id, spawn_index, status,
          input_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      instanceId,
      runId,
      s.subtaskId,
      s.spawnIndex ?? null,
      "succeeded",
      "{}",
      s.createdAt ?? now,
      s.createdAt ?? now,
    );
    db.prepare(
      `INSERT INTO subtask_results
         (instance_id, output_json, submitted_at)
       VALUES (?, ?, ?)`,
    ).run(instanceId, JSON.stringify(s.output), s.createdAt ?? now);
  }
  return runId;
}

/**
 * Build a minimal pipeline def with the given subtask ids and composes.
 * Schemas are not validated here (we don't go through the API surface);
 * only the shape `composeFinalOutput` and `validateComposes` read is
 * required.
 */
function makeDef(
  subtaskIds: ReadonlyArray<string>,
  composes: ReadonlyArray<string>,
): PipelineDef {
  return {
    id: "test-pipeline",
    initial_input: { type: "object" },
    subtasks: subtaskIds.map((id) => ({
      id,
      instructions: "noop",
      output_schema: { type: "object" },
    })),
    final_output: {
      composes,
      webhook: "https://x.test/hook",
    },
  };
}

// --------------------------------------------------------------------------
// 1. parseComposeRule — grammar
// --------------------------------------------------------------------------

describe("parseComposeRule", () => {
  it("parses a wildcard rule", () => {
    const ast = parseComposeRule("setup-metadata.*");
    expect(ast).toEqual<ComposeAst>({ kind: "wildcard", subtask: "setup-metadata" });
  });

  it("parses a wildcard-prefix rule", () => {
    const ast = parseComposeRule("pre-verify.canonical_*");
    expect(ast).toEqual<ComposeAst>({
      kind: "wildcard_prefix",
      subtask: "pre-verify",
      prefix: "canonical",
    });
  });

  it("parses a rename-field rule", () => {
    const ast = parseComposeRule("slug: setup-metadata.canonical_slug");
    expect(ast).toEqual<ComposeAst>({
      kind: "rename_field",
      key: "slug",
      subtask: "setup-metadata",
      field: "canonical_slug",
    });
  });

  it("parses a rename-whole rule", () => {
    const ast = parseComposeRule("metadata: setup-metadata.*");
    expect(ast).toEqual<ComposeAst>({
      kind: "rename_whole",
      key: "metadata",
      subtask: "setup-metadata",
    });
  });

  it("parses a cartesian rule", () => {
    const ast = parseComposeRule("boards: list-boards.boards × configure-board.*");
    expect(ast).toEqual<ComposeAst>({
      kind: "cartesian",
      key: "boards",
      listSubtask: "list-boards",
      listField: "boards",
      spawnSubtask: "configure-board",
    });
  });

  it("parses a flatten rule", () => {
    const ast = parseComposeRule(
      "kb_entries: flatten([pre-verify, setup-metadata, list-boards, configure-board].kb_entries)",
    );
    expect(ast).toEqual<ComposeAst>({
      kind: "flatten",
      key: "kb_entries",
      subtasks: ["pre-verify", "setup-metadata", "list-boards", "configure-board"],
      field: "kb_entries",
    });
  });

  it("rejects an unparseable rule with a stable prefix", () => {
    expect(() => parseComposeRule("not a rule")).toThrow(/^compose_rule_unparseable:/);
  });

  it("rejects empty string", () => {
    expect(() => parseComposeRule("")).toThrow(/compose_rule_unparseable/);
  });
});

// --------------------------------------------------------------------------
// 2. validateComposes — registration-time
// --------------------------------------------------------------------------

describe("validateComposes", () => {
  it("returns ok when every referenced subtask exists", () => {
    const def = makeDef(
      ["pre-verify", "setup-metadata", "list-boards", "configure-board"],
      [
        "pre-verify.canonical_*",
        "setup-metadata.*",
        "boards: list-boards.boards × configure-board.*",
        "kb_entries: flatten([pre-verify, setup-metadata, list-boards, configure-board].kb_entries)",
      ],
    );
    expect(validateComposes(def)).toEqual({ ok: true });
  });

  it("flags reference to nonexistent subtask id (rename)", () => {
    const def = makeDef(["a"], ["x: ghost.field"]);
    const result = validateComposes(def);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/compose_rule_unknown_subtask/);
      expect(result.error).toContain("ghost");
    }
  });

  it("flags reference to nonexistent subtask id (wildcard)", () => {
    const def = makeDef(["a"], ["ghost.*"]);
    const result = validateComposes(def);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("ghost");
    }
  });

  it("flags reference to nonexistent subtask id (cartesian)", () => {
    const def = makeDef(["parent"], ["x: parent.items × ghost.*"]);
    const result = validateComposes(def);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("ghost");
    }
  });

  it("flags reference to nonexistent subtask id inside flatten", () => {
    const def = makeDef(["a"], ["xs: flatten([a, ghost].items)"]);
    const result = validateComposes(def);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("ghost");
    }
  });

  it("flags an unparseable rule string", () => {
    const def = makeDef(["a"], ["not a rule"]);
    const result = validateComposes(def);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/compose_rule_unparseable/);
    }
  });

  it("is pure (same input → same output)", () => {
    const def = makeDef(["a", "b"], ["a.*", "x: b.field"]);
    const r1 = validateComposes(def);
    const r2 = validateComposes(def);
    expect(r1).toEqual(r2);
  });
});

// --------------------------------------------------------------------------
// 3. composeFinalOutput — runtime evaluation
// --------------------------------------------------------------------------

describe("composeFinalOutput", () => {
  let db: Database.Database;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    db = freshDb();
    // Logger writes via console.error; silence + capture for assertions.
    consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    db.close();
  });

  it("rename-field selects one field from a subtask's output", () => {
    seedRun(db, {
      runId: "r1",
      pipelineId: "p1",
      submissions: [
        {
          subtaskId: "setup-metadata",
          output: { canonical_slug: "exampleco", description: "ignored" },
        },
      ],
    });
    const def = makeDef(["setup-metadata"], ["slug: setup-metadata.canonical_slug"]);
    const out = composeFinalOutput(db, "r1", def);
    expect(out).toEqual({ slug: "exampleco" });
  });

  it("wildcard-prefix selects all matching fields and only those", () => {
    seedRun(db, {
      runId: "r1",
      pipelineId: "p1",
      submissions: [
        {
          subtaskId: "pre-verify",
          output: {
            canonical_name: "ExampleCo",
            canonical_website: "https://example.co",
            verified: true,
            kb_entries: [{ x: 1 }],
          },
        },
      ],
    });
    const def = makeDef(["pre-verify"], ["pre-verify.canonical_*"]);
    const out = composeFinalOutput(db, "r1", def) as Record<string, unknown>;
    expect(out).toEqual({
      canonical_name: "ExampleCo",
      canonical_website: "https://example.co",
    });
    expect(out).not.toHaveProperty("verified");
    expect(out).not.toHaveProperty("kb_entries");
  });

  it("`.*` passthrough returns the full subtask output", () => {
    const full = {
      slug: "exampleco",
      description: "...",
      industry_ids: ["software", "saas"],
    };
    seedRun(db, {
      runId: "r1",
      pipelineId: "p1",
      submissions: [{ subtaskId: "setup-metadata", output: full }],
    });
    const def = makeDef(["setup-metadata"], ["setup-metadata.*"]);
    const out = composeFinalOutput(db, "r1", def);
    expect(out).toEqual(full);
  });

  it("rename-whole places the entire output under a key", () => {
    const full = { a: 1, b: 2 };
    seedRun(db, {
      runId: "r1",
      pipelineId: "p1",
      submissions: [{ subtaskId: "setup-metadata", output: full }],
    });
    const def = makeDef(["setup-metadata"], ["meta: setup-metadata.*"]);
    const out = composeFinalOutput(db, "r1", def);
    expect(out).toEqual({ meta: full });
  });

  describe("cartesian", () => {
    it("3 parent items + 3 spawned children → array of 3 merged objects in spawn order", () => {
      seedRun(db, {
        runId: "r1",
        pipelineId: "p1",
        submissions: [
          {
            subtaskId: "list-boards",
            output: {
              boards: [
                { alias: "careers", url: "https://example.co/careers" },
                { alias: "eng", url: "https://example.co/eng" },
                { alias: "ops", url: "https://example.co/ops" },
              ],
            },
          },
          // Spawned children, intentionally inserted out of natural order
          // to prove ORDER BY spawn_index ASC is what governs pairing.
          {
            subtaskId: "configure-board",
            spawnIndex: 2,
            output: { outcome: "configured", scraper_type: "rss" },
          },
          {
            subtaskId: "configure-board",
            spawnIndex: 0,
            output: { outcome: "configured", scraper_type: "greenhouse" },
          },
          {
            subtaskId: "configure-board",
            spawnIndex: 1,
            output: { outcome: "skipped", scraper_type: null },
          },
        ],
      });
      const def = makeDef(
        ["list-boards", "configure-board"],
        ["boards: list-boards.boards × configure-board.*"],
      );
      const out = composeFinalOutput(db, "r1", def) as { boards: unknown[] };
      expect(out.boards).toEqual([
        {
          alias: "careers",
          url: "https://example.co/careers",
          outcome: "configured",
          scraper_type: "greenhouse",
        },
        {
          alias: "eng",
          url: "https://example.co/eng",
          outcome: "skipped",
          scraper_type: null,
        },
        {
          alias: "ops",
          url: "https://example.co/ops",
          outcome: "configured",
          scraper_type: "rss",
        },
      ]);
    });

    it("listItem fields take precedence on key collision (§7.1)", () => {
      // Both parent listItem AND spawn child have `provider` — listItem wins.
      seedRun(db, {
        runId: "r1",
        pipelineId: "p1",
        submissions: [
          {
            subtaskId: "list-boards",
            output: { boards: [{ alias: "careers", provider: "greenhouse" }] },
          },
          {
            subtaskId: "configure-board",
            spawnIndex: 0,
            output: { provider: "lever-overridden", outcome: "configured" },
          },
        ],
      });
      const def = makeDef(
        ["list-boards", "configure-board"],
        ["boards: list-boards.boards × configure-board.*"],
      );
      const out = composeFinalOutput(db, "r1", def) as { boards: Array<Record<string, unknown>> };
      expect(out.boards[0]?.provider).toBe("greenhouse");
      expect(out.boards[0]?.alias).toBe("careers");
      expect(out.boards[0]?.outcome).toBe("configured");
    });

    it("missing spawn child for an index logs warn and emits listItem alone", () => {
      seedRun(db, {
        runId: "r1",
        pipelineId: "p1",
        submissions: [
          {
            subtaskId: "list-boards",
            output: { boards: [{ alias: "a" }, { alias: "b" }] },
          },
          {
            subtaskId: "configure-board",
            spawnIndex: 0,
            output: { outcome: "configured" },
          },
          // No child for index 1.
        ],
      });
      const def = makeDef(
        ["list-boards", "configure-board"],
        ["boards: list-boards.boards × configure-board.*"],
      );
      const out = composeFinalOutput(db, "r1", def) as { boards: Array<Record<string, unknown>> };
      expect(out.boards).toEqual([
        { alias: "a", outcome: "configured" },
        { alias: "b" },
      ]);
      const logged = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("compose_cartesian_missing_spawn");
    });

    it("missing parent subtask logs warn and returns empty array under the key", () => {
      seedRun(db, {
        runId: "r1",
        pipelineId: "p1",
        submissions: [
          {
            subtaskId: "configure-board",
            spawnIndex: 0,
            output: { outcome: "configured" },
          },
        ],
      });
      const def = makeDef(
        ["list-boards", "configure-board"],
        ["boards: list-boards.boards × configure-board.*"],
      );
      const out = composeFinalOutput(db, "r1", def) as { boards: unknown[] };
      expect(out.boards).toEqual([]);
      const logged = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("compose_subtask_missing");
    });
  });

  describe("flatten", () => {
    it("concatenates arrays across subtasks, skipping null and missing, preserving order", () => {
      seedRun(db, {
        runId: "r1",
        pipelineId: "p1",
        submissions: [
          { subtaskId: "a", output: { kb_entries: [{ k: 1 }, { k: 2 }] } },
          { subtaskId: "b", output: { kb_entries: null } },
          { subtaskId: "c", output: { kb_entries: [{ k: 3 }] } },
          { subtaskId: "d", output: {} }, // missing key
        ],
      });
      const def = makeDef(
        ["a", "b", "c", "d"],
        ["kb_entries: flatten([a, b, c, d].kb_entries)"],
      );
      const out = composeFinalOutput(db, "r1", def);
      expect(out).toEqual({ kb_entries: [{ k: 1 }, { k: 2 }, { k: 3 }] });
    });

    it("missing key on every subtask returns empty array (not null)", () => {
      seedRun(db, {
        runId: "r1",
        pipelineId: "p1",
        submissions: [
          { subtaskId: "a", output: { other: 1 } },
          { subtaskId: "b", output: {} },
        ],
      });
      const def = makeDef(["a", "b"], ["xs: flatten([a, b].kb_entries)"]);
      const out = composeFinalOutput(db, "r1", def);
      expect(out).toEqual({ xs: [] });
    });

    it("flattens across all spawned instances of the same subtask id", () => {
      seedRun(db, {
        runId: "r1",
        pipelineId: "p1",
        submissions: [
          {
            subtaskId: "configure-board",
            spawnIndex: 0,
            output: { kb_entries: [{ k: "from-0" }] },
          },
          {
            subtaskId: "configure-board",
            spawnIndex: 1,
            output: { kb_entries: [{ k: "from-1" }] },
          },
          {
            subtaskId: "configure-board",
            spawnIndex: 2,
            output: { kb_entries: null },
          },
        ],
      });
      const def = makeDef(
        ["configure-board"],
        ["kb_entries: flatten([configure-board].kb_entries)"],
      );
      const out = composeFinalOutput(db, "r1", def);
      expect(out).toEqual({ kb_entries: [{ k: "from-0" }, { k: "from-1" }] });
    });

    it("non-array values for the named field are skipped and logged", () => {
      seedRun(db, {
        runId: "r1",
        pipelineId: "p1",
        submissions: [
          { subtaskId: "a", output: { kb_entries: "not-an-array" } },
          { subtaskId: "b", output: { kb_entries: [{ k: 1 }] } },
        ],
      });
      const def = makeDef(["a", "b"], ["xs: flatten([a, b].kb_entries)"]);
      const out = composeFinalOutput(db, "r1", def);
      expect(out).toEqual({ xs: [{ k: 1 }] });
      const logged = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("compose_flatten_non_array");
    });

    it("subtask never submitted is logged and skipped", () => {
      seedRun(db, {
        runId: "r1",
        pipelineId: "p1",
        submissions: [{ subtaskId: "a", output: { kb_entries: [{ k: 1 }] } }],
      });
      const def = makeDef(["a", "b"], ["xs: flatten([a, b].kb_entries)"]);
      const out = composeFinalOutput(db, "r1", def);
      expect(out).toEqual({ xs: [{ k: 1 }] });
      const logged = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("compose_subtask_missing");
    });
  });

  describe("missing field at runtime", () => {
    it("rename-field on missing field is logged, key omitted from output", () => {
      seedRun(db, {
        runId: "r1",
        pipelineId: "p1",
        submissions: [{ subtaskId: "a", output: { other: 1 } }],
      });
      const def = makeDef(["a"], ["x: a.missing"]);
      const out = composeFinalOutput(db, "r1", def);
      expect(out).toEqual({});
      const logged = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("compose_field_missing");
    });

    it("wildcard on missing subtask is logged, no keys added", () => {
      seedRun(db, {
        runId: "r1",
        pipelineId: "p1",
        submissions: [],
      });
      const def = makeDef(["a"], ["a.*"]);
      const out = composeFinalOutput(db, "r1", def);
      expect(out).toEqual({});
      const logged = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("compose_subtask_missing");
    });

    it("wildcard-prefix on missing subtask is logged, no keys added", () => {
      seedRun(db, { runId: "r1", pipelineId: "p1", submissions: [] });
      const def = makeDef(["a"], ["a.canonical_*"]);
      const out = composeFinalOutput(db, "r1", def);
      expect(out).toEqual({});
      const logged = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("compose_subtask_missing");
    });

    it("rename-field on missing subtask is logged, key omitted", () => {
      seedRun(db, { runId: "r1", pipelineId: "p1", submissions: [] });
      const def = makeDef(["a"], ["x: a.field"]);
      const out = composeFinalOutput(db, "r1", def);
      expect(out).toEqual({});
      const logged = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("compose_subtask_missing");
    });

    it("rename-whole on missing subtask is logged, key omitted", () => {
      seedRun(db, { runId: "r1", pipelineId: "p1", submissions: [] });
      const def = makeDef(["a"], ["meta: a.*"]);
      const out = composeFinalOutput(db, "r1", def);
      expect(out).toEqual({});
      const logged = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("compose_subtask_missing");
    });

    it("cartesian on listField-not-array is logged, key set to empty array", () => {
      seedRun(db, {
        runId: "r1",
        pipelineId: "p1",
        submissions: [
          { subtaskId: "list-boards", output: { boards: "not-an-array" } },
        ],
      });
      const def = makeDef(
        ["list-boards", "configure-board"],
        ["boards: list-boards.boards × configure-board.*"],
      );
      const out = composeFinalOutput(db, "r1", def) as { boards: unknown[] };
      expect(out.boards).toEqual([]);
      const logged = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("compose_field_missing");
    });

    it("runtime-unparseable rule (post-validation tampering) is logged and skipped", () => {
      // Build a def that bypasses validation — composeFinalOutput trusts
      // the def per contract, but defends against unparseable rules.
      seedRun(db, {
        runId: "r1",
        pipelineId: "p1",
        submissions: [{ subtaskId: "a", output: { x: 1 } }],
      });
      const def = makeDef(["a"], ["not a rule", "a.*"]);
      const out = composeFinalOutput(db, "r1", def);
      // Second rule still applied; first logged as warn and skipped.
      expect(out).toEqual({ x: 1 });
      const logged = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("compose_rule_unparseable_at_runtime");
    });
  });

  describe("purity", () => {
    it("same DB state and def produce the same output", () => {
      seedRun(db, {
        runId: "r1",
        pipelineId: "p1",
        submissions: [
          { subtaskId: "a", output: { x: 1, y: 2 } },
          { subtaskId: "b", output: { z: 3 } },
        ],
      });
      const def = makeDef(["a", "b"], ["a.*", "z: b.z"]);
      const out1 = composeFinalOutput(db, "r1", def);
      const out2 = composeFinalOutput(db, "r1", def);
      expect(out1).toEqual(out2);
    });

    it("rules apply in order; later rules can overwrite earlier ones", () => {
      seedRun(db, {
        runId: "r1",
        pipelineId: "p1",
        submissions: [
          { subtaskId: "a", output: { name: "first" } },
          { subtaskId: "b", output: { name: "second" } },
        ],
      });
      const def = makeDef(["a", "b"], ["a.*", "b.*"]);
      const out = composeFinalOutput(db, "r1", def);
      expect(out).toEqual({ name: "second" });
    });
  });

  describe("corrupt output_json", () => {
    it("logs warn and treats as null", () => {
      // Bypass JSON.stringify to inject malformed output_json.
      const now = "2026-04-29T10:00:00Z";
      db.prepare(
        `INSERT INTO pipelines (id, version, def_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run("p1", 1, "{}", now, now);
      db.prepare(
        `INSERT INTO runs
           (id, pipeline_id, pipeline_version, status,
            initial_input_json, webhook_url, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run("r1", "p1", 1, "running", "{}", "https://x.test/hook", now);
      db.prepare(
        `INSERT INTO subtask_instances
           (id, run_id, subtask_id, status, input_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run("inst-x", "r1", "a", "succeeded", "{}", now, now);
      db.prepare(
        `INSERT INTO subtask_results (instance_id, output_json, submitted_at)
         VALUES (?, ?, ?)`,
      ).run("inst-x", "{not json", now);

      const def = makeDef(["a"], ["a.*"]);
      const out = composeFinalOutput(db, "r1", def);
      expect(out).toEqual({});
      const logged = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("compose_output_json_corrupt");
    });
  });

  // ----------------------------------------------------------------------
  // 4. End-to-end §3.1 jobseek-add-company shape
  // ----------------------------------------------------------------------

  describe("end-to-end (DESIGN.md §3.1 jobseek-add-company)", () => {
    it("composes the canonical worked example", () => {
      const preVerify = {
        canonical_name: "ExampleCo",
        canonical_website: "https://example.co",
        verified: true,
        kb_entries: [{ source: "pre-verify", note: "domain confirmed" }],
        case_studies: [],
      };
      const setupMetadata = {
        slug: "exampleco",
        description: "Example, Inc. — a placeholder.",
        industry_ids: ["software", "saas"],
        kb_entries: [],
        case_studies: [{ title: "naming pattern", body: "..." }],
      };
      const listBoardsOut = {
        boards: [
          { alias: "careers", board_url: "https://job-boards.greenhouse.io/exampleco" },
        ],
        kb_entries: [],
        case_studies: [],
      };
      const configureBoard0 = {
        alias: "careers", // collision with parent listItem — listItem wins
        provider: "greenhouse",
        outcome: "configured",
        monitor_type: "greenhouse",
        monitor_config: { token: "exampleco" },
        scraper_type: "greenhouse",
        scraper_config: { foo: "bar" },
        verdict: "ok",
        per_field: { token: { ok: true } },
        kb_entries: [{ source: "configure-board", note: "ATS detected" }],
        case_studies: null,
      };

      seedRun(db, {
        runId: "r-jobseek",
        pipelineId: "jobseek-add-company",
        submissions: [
          { subtaskId: "pre-verify", output: preVerify },
          { subtaskId: "setup-metadata", output: setupMetadata },
          { subtaskId: "list-boards", output: listBoardsOut },
          { subtaskId: "configure-board", spawnIndex: 0, output: configureBoard0 },
        ],
      });

      const def = makeDef(
        ["pre-verify", "setup-metadata", "list-boards", "configure-board"],
        [
          "pre-verify.canonical_*",
          "setup-metadata.*",
          "boards: list-boards.boards × configure-board.*",
          "kb_entries: flatten([pre-verify, setup-metadata, list-boards, configure-board].kb_entries)",
          "case_studies: flatten([pre-verify, setup-metadata, list-boards, configure-board].case_studies)",
        ],
      );
      // validateComposes should pass.
      expect(validateComposes(def)).toEqual({ ok: true });

      const out = composeFinalOutput(db, "r-jobseek", def) as Record<string, unknown>;

      // From `pre-verify.canonical_*`:
      expect(out.canonical_name).toBe("ExampleCo");
      expect(out.canonical_website).toBe("https://example.co");
      expect(out).not.toHaveProperty("verified");

      // From `setup-metadata.*`:
      expect(out.slug).toBe("exampleco");
      expect(out.description).toBe("Example, Inc. — a placeholder.");
      expect(out.industry_ids).toEqual(["software", "saas"]);

      // Cartesian boards: parent listItem keys win on collision (alias).
      expect(out.boards).toEqual([
        {
          alias: "careers",
          board_url: "https://job-boards.greenhouse.io/exampleco",
          provider: "greenhouse",
          outcome: "configured",
          monitor_type: "greenhouse",
          monitor_config: { token: "exampleco" },
          scraper_type: "greenhouse",
          scraper_config: { foo: "bar" },
          verdict: "ok",
          per_field: { token: { ok: true } },
          kb_entries: [{ source: "configure-board", note: "ATS detected" }],
          case_studies: null,
        },
      ]);

      // Flattens — order is by subtask order then spawn order; nulls skipped.
      expect(out.kb_entries).toEqual([
        { source: "pre-verify", note: "domain confirmed" },
        { source: "configure-board", note: "ATS detected" },
      ]);
      expect(out.case_studies).toEqual([
        { title: "naming pattern", body: "..." },
      ]);
    });
  });
});
