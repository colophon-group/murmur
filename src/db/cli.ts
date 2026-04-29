/**
 * `pnpm migrate` entry point.
 *
 * Usage:
 *   pnpm migrate              # opens DATABASE_PATH (default ./murmur.db),
 *                             # applies pending migrations, prints a summary
 *   pnpm migrate --memory     # uses :memory: instead — for smoke-testing
 *                             # that the migration set is well-formed
 *
 * Exit codes:
 *   0 on success (including no-op runs)
 *   1 on any error (DB open failure, migration SQL error, malformed args)
 *
 * The CLI is deliberately thin — all the work is in `runMigrations` and
 * `openDb`. Keeping it thin keeps the path between unit tests and the real
 * CLI invocation short.
 */

import { log } from "../logger.js";

import { openDb } from "./index.js";
import { runMigrations } from "./migrate.js";

/**
 * Parse argv (excluding the node + script entries) into a config object.
 *
 * @param argv  the slice `process.argv.slice(2)`.
 * @param env   process.env (or a stub in tests).
 * @returns either a `{ path }` to open, or an `{ error }` describing the
 *   parse failure. Pure — no I/O.
 */
export function parseArgs(
  argv: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): { readonly path: string } | { readonly error: string } {
  let useMemory = false;
  for (const arg of argv) {
    if (arg === "--memory") {
      useMemory = true;
      continue;
    }
    return { error: `unknown argument: ${arg}` };
  }

  if (useMemory) return { path: ":memory:" };

  const fromEnv = env.DATABASE_PATH;
  if (fromEnv !== undefined && fromEnv !== "") {
    return { path: fromEnv };
  }
  return { path: "./murmur.db" };
}

/**
 * Run the CLI. Reads `process.argv` + `process.env`, opens the DB, applies
 * migrations, prints a summary line via the structured logger, returns the
 * exit code.
 *
 * @returns 0 on success, non-zero on error. Caller is expected to
 *   `process.exit(code)`.
 */
export async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2), process.env);
  if ("error" in parsed) {
    log.error("migrate.bad_args", { error: parsed.error });
    return 1;
  }

  let db;
  try {
    db = openDb(parsed.path);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("migrate.open_failed", { path: parsed.path, error: message });
    return 1;
  }

  try {
    const result = runMigrations(db);
    log.info("migrate.done", {
      path: parsed.path,
      applied: result.applied,
      skipped: result.skipped,
    });
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("migrate.failed", { path: parsed.path, error: message });
    return 1;
  } finally {
    db.close();
  }
}

// Self-invocation guard: only run `main()` when this module is executed
// directly. Importing it from tests must not trigger a CLI run.
const invokedDirectly =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  import.meta.url === new URL(process.argv[1], "file://").href;

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      log.error("migrate.unhandled", { error: message });
      process.exit(1);
    });
}
