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
  void argv;
  void env;
  throw new Error("not implemented");
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
  throw new Error("not implemented");
}
