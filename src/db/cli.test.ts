/**
 * Tests for the `pnpm migrate` CLI entry point. The CLI is a thin wrapper
 * around `openDb` + `runMigrations`; we exercise its argv parsing and an
 * end-to-end smoke against a tempfile.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseArgs } from "./cli.js";

describe("parseArgs", () => {
  it("uses DATABASE_PATH when no argv is given", () => {
    const result = parseArgs([], { DATABASE_PATH: "/tmp/foo.db" });
    expect(result).toEqual({ path: "/tmp/foo.db" });
  });

  it("falls back to ./murmur.db when DATABASE_PATH is unset", () => {
    const result = parseArgs([], {});
    expect(result).toEqual({ path: "./murmur.db" });
  });

  it("--memory selects :memory:", () => {
    const result = parseArgs(["--memory"], { DATABASE_PATH: "/ignored.db" });
    expect(result).toEqual({ path: ":memory:" });
  });

  it("rejects unknown flags", () => {
    const result = parseArgs(["--no-such-flag"], {});
    expect("error" in result).toBe(true);
  });
});

describe("pnpm migrate (end-to-end smoke)", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "murmur-migrate-cli-"));
    dbPath = join(dir, "test.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("`pnpm migrate:memory` exits 0", () => {
    // Run from the repo root so the CLI finds the migrations dir.
    const cwd = resolve(process.cwd());
    let ok = true;
    try {
      execFileSync("pnpm", ["migrate:memory"], {
        cwd,
        stdio: "pipe",
        env: { ...process.env },
      });
    } catch {
      ok = false;
    }
    expect(ok).toBe(true);
  });

  it("`pnpm migrate` against a tempfile applies the schema", async () => {
    const cwd = resolve(process.cwd());
    let ok = true;
    try {
      execFileSync("pnpm", ["migrate"], {
        cwd,
        stdio: "pipe",
        env: { ...process.env, DATABASE_PATH: dbPath },
      });
    } catch {
      ok = false;
    }
    expect(ok).toBe(true);

    // The DB file should exist and contain the expected tables.
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(dbPath, { readonly: true });
    try {
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
        "publisher_audit_events",
        "publisher_secrets",
        "publisher_tokens",
        "publishers",
        "runs",
        "skill_files",
        "skills",
        "subtask_instances",
        "subtask_results",
      ]);
    } finally {
      db.close();
    }
  });
});
