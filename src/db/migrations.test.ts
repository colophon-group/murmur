/**
 * Tests for the SQLite schema and the migrations runner.
 *
 * Per issue #7's "Verification" block:
 *   - applies all migrations from a fresh DB
 *   - is idempotent (running twice succeeds)
 *   - WAL mode + synchronous=NORMAL
 *   - _migrations table records applied versions
 *   - the 5 domain tables exist with the columns documented in schema.md
 *   - subtask_instances has a UNIQUE partial index on claim_token
 *   - subtask_instances has an index on (status, created_at)
 *   - agent_actions has an index on (instance_id, ts)
 *   - pnpm migrate against :memory: exits 0  (covered by cli.test.ts)
 *   - schema matches src/db/schema.md
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type Database from "better-sqlite3";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { openDb } from "./index.js";
import { loadMigrations, runMigrations, DEFAULT_MIGRATIONS_DIR } from "./migrate.js";

interface ColumnRow {
  readonly cid: number;
  readonly name: string;
  readonly type: string;
  readonly notnull: 0 | 1;
  readonly dflt_value: string | null;
  readonly pk: 0 | 1;
}

interface IndexRow {
  readonly seq: number;
  readonly name: string;
  readonly unique: 0 | 1;
  readonly origin: string;
  readonly partial: 0 | 1;
}

interface IndexInfoRow {
  readonly seqno: number;
  readonly cid: number;
  readonly name: string;
}

interface MasterRow {
  readonly name: string;
  readonly sql: string | null;
}

function tableColumns(db: Database.Database, table: string): ColumnRow[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as ColumnRow[];
}

function tableIndexes(db: Database.Database, table: string): IndexRow[] {
  return db.prepare(`PRAGMA index_list(${table})`).all() as IndexRow[];
}

function indexInfo(db: Database.Database, indexName: string): IndexInfoRow[] {
  return db.prepare(`PRAGMA index_info(${indexName})`).all() as IndexInfoRow[];
}

describe("openDb", () => {
  let db: Database.Database;

  afterEach(() => {
    db.close();
  });

  it("opens an in-memory database", () => {
    db = openDb(":memory:");
    expect(db.open).toBe(true);
  });

  it("applies WAL journal_mode (file-backed)", () => {
    // :memory: forces journal_mode=memory, so verify against a tempfile.
    const tmpPath = resolve(process.cwd(), `node_modules/.test-wal-${Date.now()}.db`);
    db = openDb(tmpPath);
    const mode = db.pragma("journal_mode", { simple: true }) as string;
    expect(mode.toLowerCase()).toBe("wal");
    db.close();
    // Re-open via an inert handle for the afterEach close (cheap dummy).
    db = openDb(":memory:");
  });

  it("applies synchronous=NORMAL (1)", () => {
    db = openDb(":memory:");
    const sync = db.pragma("synchronous", { simple: true }) as number;
    expect(sync).toBe(1);
  });

  it("enables foreign keys", () => {
    db = openDb(":memory:");
    const fk = db.pragma("foreign_keys", { simple: true }) as number;
    expect(fk).toBe(1);
  });

  it("rejects an empty path", () => {
    expect(() => openDb("")).toThrow();
    db = openDb(":memory:"); // for afterEach
  });
});

describe("loadMigrations", () => {
  it("loads at least the 0001_init migration from the default dir", () => {
    const migrations = loadMigrations(DEFAULT_MIGRATIONS_DIR);
    expect(migrations.length).toBeGreaterThanOrEqual(1);
    const first = migrations[0];
    expect(first).toBeDefined();
    expect(first?.version).toBe(1);
    expect(first?.name).toBe("init");
    expect(first?.sql).toContain("CREATE TABLE pipelines");
  });

  it("returns migrations sorted by ascending version", () => {
    const migrations = loadMigrations(DEFAULT_MIGRATIONS_DIR);
    for (let i = 1; i < migrations.length; i++) {
      const prev = migrations[i - 1];
      const cur = migrations[i];
      expect(prev).toBeDefined();
      expect(cur).toBeDefined();
      expect(cur!.version).toBeGreaterThan(prev!.version);
    }
  });
});

describe("runMigrations", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("applies all migrations from a fresh DB", () => {
    const result = runMigrations(db);
    expect(result.applied.length).toBeGreaterThanOrEqual(1);
    expect(result.applied).toContain(1);
    expect(result.skipped).toEqual([]);
  });

  it("is idempotent — running twice succeeds", () => {
    const first = runMigrations(db);
    const second = runMigrations(db);
    expect(first.applied.length).toBeGreaterThanOrEqual(1);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual([...first.applied]);
  });

  it("creates the _migrations table and records applied versions", () => {
    runMigrations(db);
    const cols = tableColumns(db, "_migrations");
    const colNames = cols.map((c) => c.name).sort();
    expect(colNames).toEqual(["applied_at", "version"]);

    const versionCol = cols.find((c) => c.name === "version");
    expect(versionCol?.pk).toBe(1);
    expect(versionCol?.type).toBe("INTEGER");

    const rows = db
      .prepare("SELECT version, applied_at FROM _migrations ORDER BY version")
      .all() as Array<{ version: number; applied_at: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const firstRow = rows[0];
    expect(firstRow).toBeDefined();
    expect(firstRow?.version).toBe(1);
    expect(typeof firstRow?.applied_at).toBe("string");
    // Loose ISO 8601 sanity: starts with 4 digits + dash.
    expect(firstRow?.applied_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("creates all 5 domain tables plus _migrations", () => {
    runMigrations(db);
    const rows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    const names = rows.map((r) => r.name);
    expect(names).toEqual([
      "_migrations",
      "agent_actions",
      "pipelines",
      "runs",
      "subtask_instances",
      "subtask_results",
    ]);
  });

  describe("table column checks (vs schema.md)", () => {
    beforeEach(() => {
      runMigrations(db);
    });

    it("pipelines has the documented columns", () => {
      const cols = tableColumns(db, "pipelines");
      const byName = new Map(cols.map((c) => [c.name, c]));
      expect([...byName.keys()].sort()).toEqual([
        "created_at",
        "def_json",
        "id",
        "updated_at",
        "version",
      ]);
      expect(byName.get("id")?.pk).toBe(1);
      expect(byName.get("id")?.type).toBe("TEXT");
      expect(byName.get("version")?.type).toBe("INTEGER");
      expect(byName.get("version")?.notnull).toBe(1);
      expect(byName.get("def_json")?.notnull).toBe(1);
      expect(byName.get("created_at")?.notnull).toBe(1);
      expect(byName.get("updated_at")?.notnull).toBe(1);
    });

    it("runs has the documented columns", () => {
      const cols = tableColumns(db, "runs");
      const byName = new Map(cols.map((c) => [c.name, c]));
      const expected = [
        "completed_at",
        "created_at",
        "final_output_json",
        "id",
        "initial_input_json",
        "pipeline_id",
        "pipeline_version",
        "status",
        "webhook_status",
        "webhook_url",
      ];
      expect([...byName.keys()].sort()).toEqual(expected);
      expect(byName.get("id")?.pk).toBe(1);
      expect(byName.get("pipeline_id")?.notnull).toBe(1);
      expect(byName.get("pipeline_version")?.type).toBe("INTEGER");
      expect(byName.get("status")?.notnull).toBe(1);
      // nullable
      expect(byName.get("final_output_json")?.notnull).toBe(0);
      expect(byName.get("webhook_status")?.notnull).toBe(0);
      expect(byName.get("completed_at")?.notnull).toBe(0);
    });

    it("subtask_instances has the documented columns", () => {
      const cols = tableColumns(db, "subtask_instances");
      const byName = new Map(cols.map((c) => [c.name, c]));
      expect([...byName.keys()].sort()).toEqual([
        "claim_token",
        "created_at",
        "expires_at",
        "id",
        "input_json",
        "parent_instance_id",
        "run_id",
        "spawn_index",
        "status",
        "subtask_id",
        "updated_at",
      ]);
      expect(byName.get("id")?.pk).toBe(1);
      expect(byName.get("run_id")?.notnull).toBe(1);
      expect(byName.get("subtask_id")?.notnull).toBe(1);
      expect(byName.get("status")?.notnull).toBe(1);
      expect(byName.get("input_json")?.notnull).toBe(1);
      // nullable claim columns
      expect(byName.get("claim_token")?.notnull).toBe(0);
      expect(byName.get("expires_at")?.notnull).toBe(0);
      expect(byName.get("parent_instance_id")?.notnull).toBe(0);
      expect(byName.get("spawn_index")?.notnull).toBe(0);
      expect(byName.get("spawn_index")?.type).toBe("INTEGER");
    });

    it("subtask_results has the documented columns", () => {
      const cols = tableColumns(db, "subtask_results");
      const byName = new Map(cols.map((c) => [c.name, c]));
      expect([...byName.keys()].sort()).toEqual([
        "instance_id",
        "notes",
        "output_json",
        "submitted_at",
      ]);
      expect(byName.get("instance_id")?.pk).toBe(1);
      expect(byName.get("output_json")?.notnull).toBe(1);
      expect(byName.get("submitted_at")?.notnull).toBe(1);
      expect(byName.get("notes")?.notnull).toBe(0);
    });

    it("agent_actions has the documented columns", () => {
      const cols = tableColumns(db, "agent_actions");
      const byName = new Map(cols.map((c) => [c.name, c]));
      expect([...byName.keys()].sort()).toEqual([
        "args_json",
        "id",
        "instance_id",
        "kind",
        "response_json",
        "subcommand",
        "truncated",
        "ts",
      ]);
      expect(byName.get("id")?.pk).toBe(1);
      expect(byName.get("id")?.type).toBe("INTEGER");
      expect(byName.get("instance_id")?.notnull).toBe(1);
      expect(byName.get("ts")?.notnull).toBe(1);
      expect(byName.get("kind")?.notnull).toBe(1);
      expect(byName.get("truncated")?.notnull).toBe(1);
      expect(byName.get("truncated")?.dflt_value).toBe("0");
    });

    it("agent_actions.id is AUTOINCREMENT", () => {
      const row = db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_actions'",
        )
        .get() as MasterRow;
      expect(row.sql ?? "").toMatch(/AUTOINCREMENT/i);
    });
  });

  describe("indexes", () => {
    beforeEach(() => {
      runMigrations(db);
    });

    it("subtask_instances has a UNIQUE partial index on claim_token", () => {
      const indexes = tableIndexes(db, "subtask_instances");
      const ix = indexes.find((i) => i.name === "idx_subtask_instances_claim_token");
      expect(ix).toBeDefined();
      expect(ix?.unique).toBe(1);
      expect(ix?.partial).toBe(1);
      const cols = indexInfo(db, "idx_subtask_instances_claim_token").map((c) => c.name);
      expect(cols).toEqual(["claim_token"]);

      // Verify the partial predicate via sqlite_master SQL text.
      const row = db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='index' AND name=?",
        )
        .get("idx_subtask_instances_claim_token") as MasterRow;
      expect(row.sql ?? "").toMatch(/WHERE\s+claim_token\s+IS\s+NOT\s+NULL/i);
    });

    it("subtask_instances has an index on (status, created_at)", () => {
      const indexes = tableIndexes(db, "subtask_instances");
      const ix = indexes.find((i) => i.name === "idx_subtask_instances_ready");
      expect(ix).toBeDefined();
      expect(ix?.unique).toBe(0);
      const cols = indexInfo(db, "idx_subtask_instances_ready").map((c) => c.name);
      expect(cols).toEqual(["status", "created_at"]);
    });

    it("agent_actions has an index on (instance_id, ts)", () => {
      const indexes = tableIndexes(db, "agent_actions");
      const ix = indexes.find((i) => i.name === "idx_agent_actions_instance_ts");
      expect(ix).toBeDefined();
      expect(ix?.unique).toBe(0);
      const cols = indexInfo(db, "idx_agent_actions_instance_ts").map((c) => c.name);
      expect(cols).toEqual(["instance_id", "ts"]);
    });
  });

  describe("foreign keys", () => {
    beforeEach(() => {
      runMigrations(db);
    });

    it("foreign keys are enforced", () => {
      // Inserting a subtask_instance with an unknown run_id MUST fail.
      const insert = (): void => {
        db.prepare(
          `INSERT INTO subtask_instances
             (id, run_id, subtask_id, status, input_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run("i1", "no-such-run", "s1", "pending", "{}", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
      };
      expect(insert).toThrow(/FOREIGN KEY/i);
    });
  });

  describe("schema.md cross-check", () => {
    it("every table mentioned in schema.md exists", () => {
      runMigrations(db);
      const docPath = resolve(process.cwd(), "src/db/schema.md");
      const doc = readFileSync(docPath, "utf8");

      // schema.md uses `## <table>` headings for each domain table.
      const tableHeadings = ["_migrations", "pipelines", "runs", "subtask_instances", "subtask_results", "agent_actions"];
      for (const t of tableHeadings) {
        expect(doc).toContain(`## \`${t}\``);
        const exists = db
          .prepare("SELECT 1 AS one FROM sqlite_master WHERE type='table' AND name=?")
          .get(t) as { one: number } | undefined;
        expect(exists).toBeDefined();
      }
    });
  });
});
