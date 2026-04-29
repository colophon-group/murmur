/**
 * SQLite connection helper.
 *
 * Murmur uses `better-sqlite3` for all server-side persistence — synchronous
 * queries simplify the atomic-claim CAS in M5 (`/work/next`) since there's no
 * await between `BEGIN IMMEDIATE` and the `UPDATE … RETURNING`. The DB lives
 * at `DATABASE_PATH` (env-configured); tests pass `:memory:`.
 *
 * Every connection MUST run the same pragmas at open:
 *
 *   - `journal_mode = WAL`        — reader-doesn't-block-writer for the
 *     audit/sweeper traffic; required for the §3.3 CAS to be live in M5.
 *   - `synchronous  = NORMAL`     — durable enough for demo, fast enough
 *     for sub-100ms claim turnaround. (`FULL` is overkill given Hetzner's
 *     SSD + WAL checkpointing; `OFF` would risk WAL corruption.)
 *   - `foreign_keys = ON`         — schema declares FKs (e.g.
 *     `subtask_results.instance_id` → `subtask_instances.id`); they must be
 *     enforced. SQLite defaults this OFF for back-compat — every connection
 *     must opt in.
 *
 * @see DESIGN.md §3.3 — atomic claim CAS rationale
 * @see src/db/schema.md — canonical schema
 */

import type Database from "better-sqlite3";

/**
 * Open a SQLite connection at `path` with Murmur's standard pragmas applied.
 *
 * @param path filesystem path to the SQLite file, or `":memory:"` for an
 *   ephemeral in-process DB. Must not be empty.
 * @returns a `better-sqlite3` Database handle. Caller owns lifecycle —
 *   `db.close()` when done.
 * @throws Error if `path` is empty or if SQLite fails to open the file.
 *
 * Pragmas applied (in order): `journal_mode = WAL`, `synchronous = NORMAL`,
 * `foreign_keys = ON`. The `journal_mode` PRAGMA is no-op for `:memory:`
 * databases (SQLite forces `memory` journal mode there) — the helper still
 * issues it for parity with file-backed paths.
 */
export function openDb(path: string): Database.Database {
  void path;
  throw new Error("not implemented");
}
