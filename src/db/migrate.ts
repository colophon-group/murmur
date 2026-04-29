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
  void dir;
  throw new Error("not implemented");
}

/**
 * Apply pending migrations to `db`. Creates `_migrations` if absent.
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
  void db;
  void migrations;
  throw new Error("not implemented");
}
