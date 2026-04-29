/**
 * Concurrency tests — DoD verification for issue #7.
 *
 * The §3.3 atomic claim CAS in M5 relies on `BEGIN IMMEDIATE` actually
 * serializing writes against a WAL-mode SQLite database. This test pins
 * that contract so future changes (e.g. switching to deferred transactions
 * or a non-WAL journal mode) fail loudly.
 *
 * `better-sqlite3` is synchronous, but `BEGIN IMMEDIATE` against a busy
 * writer raises `SQLITE_BUSY` synchronously when `busy_timeout = 0`. We
 * exercise that path: open two connections to the same file, hold the
 * write lock on one, try `BEGIN IMMEDIATE` on the other, expect a
 * `SQLITE_BUSY` (or `SQLITE_BUSY_SNAPSHOT`) error.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb } from "./index.js";
import { runMigrations } from "./migrate.js";

interface SQLiteError extends Error {
  readonly code?: string;
}

describe("WAL concurrency: BEGIN IMMEDIATE serializes writers", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "murmur-concurrency-"));
    dbPath = join(dir, "test.db");
    // Migrate once via a temporary connection.
    const db = openDb(dbPath);
    runMigrations(db);
    db.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("a second BEGIN IMMEDIATE raises SQLITE_BUSY while the first is open", () => {
    const a = openDb(dbPath);
    const b = openDb(dbPath);

    // Disable both connections' busy-timeout so we don't have to wait.
    a.pragma("busy_timeout = 0");
    b.pragma("busy_timeout = 0");

    try {
      a.exec("BEGIN IMMEDIATE");
      // A is now holding the write lock. B's BEGIN IMMEDIATE must fail.
      let caught: SQLiteError | undefined;
      try {
        b.exec("BEGIN IMMEDIATE");
      } catch (err) {
        caught = err as SQLiteError;
      }
      expect(caught).toBeDefined();
      expect(caught?.code ?? "").toMatch(/^SQLITE_BUSY/);
    } finally {
      try {
        a.exec("ROLLBACK");
      } catch {
        // ignore
      }
      a.close();
      b.close();
    }
  });

  it("after the first transaction commits, the second BEGIN IMMEDIATE succeeds", () => {
    const a = openDb(dbPath);
    const b = openDb(dbPath);
    a.pragma("busy_timeout = 0");
    b.pragma("busy_timeout = 0");

    a.exec("BEGIN IMMEDIATE");
    a.exec("COMMIT");

    let succeeded = true;
    try {
      b.exec("BEGIN IMMEDIATE");
      b.exec("COMMIT");
    } catch {
      succeeded = false;
    }
    expect(succeeded).toBe(true);

    a.close();
    b.close();
  });
});
