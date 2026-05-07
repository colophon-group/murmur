/**
 * Forward-only migrations runner.
 *
 * Reads `*.sql` files from `src/db/migrations/` (or a caller-supplied dir),
 * orders by leading numeric prefix, and applies any whose `version` is not
 * yet recorded in the `_migrations` table. Each migration runs inside its
 * own `BEGIN IMMEDIATE` … `COMMIT` so a partial failure doesn't half-apply.
 *
 * **Idempotency.** Running the runner twice on the same DB applies zero
 * migrations the second time — every applied version is recorded in
 * `_migrations`, and the runner skips entries that already exist.
 *
 * **Forward-only.** There are no down-migrations and no in-place edits to
 * applied SQL files. The README and `src/db/schema.md` make this explicit.
 * If a migration needs to be undone, ship a new forward migration that
 * undoes it.
 *
 * @see src/db/schema.md
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import type Database from "better-sqlite3";

/**
 * One migration file parsed off disk (or supplied inline by tests).
 */
export interface MigrationFile {
  /** Numeric prefix from the filename, e.g. `0001` → `1`. */
  readonly version: number;
  /** Filename stem after the version, e.g. `init`. Used in logs. */
  readonly name: string;
  /** Raw SQL body. May contain multiple statements separated by `;`. */
  readonly sql: string;
}

/**
 * Outcome of a `runMigrations` invocation.
 */
export interface MigrationResult {
  /** Versions applied this call (in ascending order). Empty on no-op. */
  readonly applied: ReadonlyArray<number>;
  /** Versions that were already in `_migrations` and therefore skipped. */
  readonly skipped: ReadonlyArray<number>;
}

/**
 * Default location of the migrations directory, relative to the package root.
 * Exported so the CLI and tests share one source of truth.
 */
export const DEFAULT_MIGRATIONS_DIR = "src/db/migrations";

const MIGRATION_FILENAME = /^(\d+)_([a-z0-9_-]+)\.sql$/;

/**
 * Load migrations from `dir`. Files MUST match the pattern
 * `^(\d+)_([a-z0-9_-]+)\.sql$`. The numeric prefix is the version (parsed
 * as decimal); duplicate versions throw.
 *
 * @returns migrations sorted ascending by `version`.
 * @throws Error if the directory cannot be read, a filename is malformed,
 *   or two files share the same version.
 */
export function loadMigrations(dir: string): ReadonlyArray<MigrationFile> {
  const absDir = resolve(process.cwd(), dir);
  const entries = readdirSync(absDir);

  const files: MigrationFile[] = [];
  const seen = new Set<number>();

  for (const entry of entries) {
    if (!entry.endsWith(".sql")) continue;
    const match = MIGRATION_FILENAME.exec(entry);
    if (match === null) {
      throw new Error(
        `loadMigrations: malformed filename ${JSON.stringify(entry)} ` +
          `in ${dir}; expected /^(\\d+)_([a-z0-9_-]+)\\.sql$/`,
      );
    }
    const versionRaw = match[1];
    const name = match[2];
    if (versionRaw === undefined || name === undefined) {
      // Defensive — regex above guarantees both groups, but the index access
      // is widened by `noUncheckedIndexedAccess`.
      throw new Error(
        `loadMigrations: regex group missing for ${JSON.stringify(entry)}`,
      );
    }
    const version = Number(versionRaw);
    if (!Number.isInteger(version) || version < 1) {
      throw new Error(
        `loadMigrations: version must be a positive integer; ` +
          `got ${JSON.stringify(versionRaw)} in ${entry}`,
      );
    }
    if (seen.has(version)) {
      throw new Error(
        `loadMigrations: duplicate version ${version} in ${dir}`,
      );
    }
    seen.add(version);

    const sql = readFileSync(resolve(absDir, entry), "utf8");
    files.push({ version, name, sql });
  }

  files.sort((a, b) => a.version - b.version);
  return files;
}

function ensureMigrationsTable(db: Database.Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
       version    INTEGER PRIMARY KEY,
       applied_at TEXT NOT NULL
     )`,
  );
}

/**
 * Apply pending migrations to `db`. Creates `_migrations` if absent.
 *
 * **Concurrency contract (#88).** The applied-versions check happens
 * INSIDE each migration's `BEGIN IMMEDIATE` transaction, not before
 * the loop. Pre-fix, two processes racing `runMigrations` against the
 * same DB file (e.g., `scripts/deploy.sh`'s `pnpm migrate` step + the
 * container's startup `runMigrations` call) would both pre-read
 * `_migrations` as `[1]`, both decide to apply 0002, then race for
 * the writer lock — the loser would run `m.sql` against a DB whose
 * schema had already been changed and fail with `table publishers
 * already exists`. That was visible in M1's deploy: the deploy step
 * reported `failure` even though Docker's restart policy brought up a
 * second container that found `_migrations=[1,2]` and came up healthy.
 *
 * Post-fix: the per-migration `IS_APPLIED_SQL` check inside the lock
 * sees the freshly-committed row from any racing process; the loser
 * skips and the runner reports `skipped: [version]` cleanly. No
 * exceptions, no deploy false-failures.
 *
 * @param db an open `better-sqlite3` connection. The runner does NOT close it.
 * @param migrations the migration set to apply. If omitted, the runner
 *   loads from `DEFAULT_MIGRATIONS_DIR` relative to the project root.
 * @returns the lists of applied and skipped versions.
 * @throws Error if SQL execution fails. On failure the failing migration's
 *   transaction is rolled back; previous migrations stay applied.
 */
export function runMigrations(
  db: Database.Database,
  migrations?: ReadonlyArray<MigrationFile>,
): MigrationResult {
  const set = migrations ?? loadMigrations(DEFAULT_MIGRATIONS_DIR);

  ensureMigrationsTable(db);

  const applied: number[] = [];
  const skipped: number[] = [];

  const recordStmt = db.prepare(
    "INSERT INTO _migrations (version, applied_at) VALUES (?, ?)",
  );
  const isAppliedStmt = db.prepare(
    "SELECT 1 AS one FROM _migrations WHERE version = ?",
  );

  for (const m of set) {
    // BEGIN IMMEDIATE acquires the RESERVED lock up front. Concurrent
    // runners block here; whichever wins re-checks `_migrations` under
    // the lock and runs the migration if still pending; the loser
    // re-checks, sees the freshly-committed row, and skips cleanly.
    db.exec("BEGIN IMMEDIATE");
    try {
      const alreadyApplied = isAppliedStmt.get(m.version) !== undefined;
      if (alreadyApplied) {
        db.exec("COMMIT");
        skipped.push(m.version);
        continue;
      }
      db.exec(m.sql);
      recordStmt.run(m.version, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Ignore — the original error is what matters.
      }
      throw err;
    }
    applied.push(m.version);
  }

  return { applied, skipped };
}
