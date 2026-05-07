/**
 * Boot entry point for the Murmur server.
 *
 * - Reads `PORT` from `process.env`, refusing to start if the var is unset,
 *   empty, or not a finite positive integer (DESIGN.md §6.2 hard-requires
 *   `PORT` from compose).
 * - Reads `MURMUR_TOKEN` from `process.env`, refusing to start if the var is
 *   unset or empty (DESIGN.md §3.6 — demo-grade auth gate). Token is loaded
 *   once at boot and passed by value into `createServer`; the server module
 *   never re-reads `process.env`.
 * - Calls `createServer()` and binds it via `@hono/node-server`.
 * - When a DB handle is passed, starts a {@link ClaimSweeper} on a 30s
 *   `setInterval` (DESIGN.md §3.3) so expired claims return to the pool
 *   even when no agent traffic is hitting the server. The sweeper is
 *   stopped in `close()` so a graceful shutdown drains the timer.
 *   Wired here, NOT inside `createServer`, so the server factory remains
 *   pure — tests that spin up the app via `app.request(...)` don't get
 *   unwanted background timers.
 * - Logs the listen address (port + family) via the structured logger. The
 *   token value is NEVER logged (`grep-no-token-logged` enforces this).
 *
 * This module is invoked by `pnpm dev` (`tsx watch src/index.ts`) and by the
 * Docker image entrypoint in production.
 */

import { serve, type ServerType } from "@hono/node-server";

import type Database from "better-sqlite3";

import { readBootstrapTokenFromEnv } from "./auth/bootstrap_auth.js";
import { seedDemoPublisher } from "./db/bootstrap.js";
import { openDb } from "./db/index.js";
import { runMigrations } from "./db/migrate.js";
import { log } from "./logger.js";
import { createServer } from "./server.js";
import { ClaimSweeper } from "./sweeper.js";

/**
 * Read `MURMUR_JWT_SECRET` from the env. Optional — when unset, the
 * human-plane `/auth/*` routes are NOT mounted (any call gets a 404).
 * Production sets a 32-byte random secret. Generate with:
 *
 *   openssl rand -hex 32
 *
 * @returns the secret bytes, or `undefined` when unset.
 */
export function readJwtSecretFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): Buffer | undefined {
  const raw = env["MURMUR_JWT_SECRET"];
  if (!raw) return undefined;
  return Buffer.from(raw, "utf8");
}

const MAX_TCP_PORT = 65535;

/**
 * Read `PORT` from a `process.env`-shaped object, validating the format.
 *
 * @returns a finite positive integer port number in `[1, 65535]`.
 * @throws Error whose message includes `PORT` if the value is missing,
 *   empty, non-numeric, non-integer, or out of the valid TCP-port range.
 *
 * Pure function (takes `env` as input rather than reading `process.env`
 * directly) so that unit tests can exercise the parsing without mutating
 * the host process's environment.
 */
export function readPortFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env.PORT;
  if (raw === undefined || raw === "") {
    throw new Error(
      "PORT environment variable is required (DESIGN.md §6.2). " +
        "Set PORT to a TCP port in 1..65535.",
    );
  }

  // Reject anything that isn't a clean integer (e.g. "8080.5", "8080abc",
  // "0x1f90"). `Number()` is too permissive; we want strict integer parsing.
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(
      `PORT must be a positive integer in 1..65535; got ${JSON.stringify(raw)}.`,
    );
  }

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > MAX_TCP_PORT) {
    throw new Error(
      `PORT must be in 1..65535; got ${JSON.stringify(raw)}.`,
    );
  }

  return port;
}

/**
 * Read `MURMUR_TOKEN` from a `process.env`-shaped object and return it as a
 * UTF-8 `Buffer`.
 *
 * @returns the token bytes. The buffer is the wire-encoding form used by the
 *   bearer-auth middleware's `crypto.timingSafeEqual` comparison.
 * @throws Error whose message includes `MURMUR_TOKEN` if the value is missing
 *   or empty. The error message NEVER includes the token's value (verified by
 *   the `grep-no-token-logged` gate — only the variable name appears).
 *
 * Pure function (takes `env` as input rather than reading `process.env`
 * directly) so that unit tests can exercise the parsing without mutating the
 * host process's environment.
 */
export function readMurmurTokenFromEnv(env: NodeJS.ProcessEnv): Buffer {
  const raw = env.MURMUR_TOKEN;
  if (raw === undefined || raw === "") {
    // The error message MUST NOT include the variable's value. We only
    // reference the variable name so operators can diagnose without leaking
    // a partial token (DESIGN.md §3.6, `grep-no-token-logged`).
    throw new Error(
      "MURMUR_TOKEN environment variable is required (DESIGN.md §3.6). " +
        "Set MURMUR_TOKEN to the shared bearer token for this deployment.",
    );
  }
  return Buffer.from(raw, "utf8");
}

/**
 * Read `DATABASE_PATH` from a `process.env`-shaped object.
 *
 * @returns the path as a non-empty string, or `undefined` when the var is
 *   absent. An absent var is treated as "no DB" so the bare-bones smoke
 *   image (health-only) still boots — the publisher and agent sub-apps
 *   simply do not mount in that case.
 * @throws Error if the var is set to the empty string (operator typo —
 *   fail fast rather than silently disable the publisher routes).
 *
 * Pure function (takes `env` as input rather than reading `process.env`
 * directly) so unit tests can exercise the parsing without mutating the
 * host process's environment.
 */
export function readDatabasePathFromEnv(
  env: NodeJS.ProcessEnv,
): string | undefined {
  const raw = env.DATABASE_PATH;
  if (raw === undefined) return undefined;
  if (raw === "") {
    throw new Error(
      "DATABASE_PATH environment variable must be a non-empty filesystem path " +
        "(or absent to run health-only). Got empty string.",
    );
  }
  return raw;
}

export interface ServerHandle {
  close(): Promise<void>;
}

/**
 * Boot the server on the given port with the given bearer token.
 *
 * @param port the TCP port to bind.
 * @param token the boot-loaded `MURMUR_TOKEN` buffer (see
 *   `readMurmurTokenFromEnv`). Passed by value into `createServer` so the
 *   server module is pure.
 * @param db optional open SQLite handle. When supplied, the publisher and
 *   agent sub-apps are mounted AND a {@link ClaimSweeper} is started on
 *   the default 30s cadence (DESIGN.md §3.3). When omitted (smoke tests),
 *   neither sub-apps nor the sweeper are wired.
 * @returns a handle whose `close()` resolves when the underlying socket
 *   has shut down AND the sweeper timer is cleared. Idempotent.
 */
export function startServer(
  port: number,
  token: Buffer,
  db?: Database.Database,
  bootstrapToken?: Buffer,
  jwtSecret?: Buffer,
): ServerHandle {
  // Build options inline; `exactOptionalPropertyTypes` rejects passing
  // `undefined` for unset optional fields, so the keys are added only
  // when supplied.
  const options: Parameters<typeof createServer>[0] = { token };
  if (db !== undefined) {
    Object.assign(options, { db });
    if (bootstrapToken !== undefined) {
      Object.assign(options, { bootstrapToken });
    }
    if (jwtSecret !== undefined) {
      Object.assign(options, { jwtSecret });
    }
  }
  const app = createServer(options);

  // `@hono/node-server` returns the underlying `http.Server`. We capture it
  // typed as `ServerType` (the package's exported alias) so we can call
  // `.close()` from the handle.
  const server: ServerType = serve({ fetch: app.fetch, port });

  // Start the background claim-expiry sweeper on the default 30s cadence
  // (DESIGN.md §3.3). Without it, an agent that crashes mid-claim would
  // hold the subtask hostage for 10 minutes. Only wire when a DB handle
  // exists — otherwise there is no `subtask_instances` table to sweep.
  const sweeper = db !== undefined ? new ClaimSweeper({ db }) : undefined;
  sweeper?.start();

  let closed = false;

  return {
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      // Stop the sweeper BEFORE closing the HTTP server: the sweeper is
      // synchronous so this is a no-yield op, but doing it first means
      // an in-flight tick can't race the DB close.
      sweeper?.stop();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}

/**
 * Top-level main. Reads `PORT` and `MURMUR_TOKEN`, starts the server, logs
 * once, returns the handle.
 *
 * Both env reads are fail-fast — if either var is unset or invalid, the
 * underlying parser throws and the self-invocation guard at the bottom of
 * this file catches the error, logs it, and `process.exit(1)`s. The token
 * value is NEVER included in any log line.
 */
export async function main(): Promise<ServerHandle> {
  const port = readPortFromEnv(process.env);
  const token = readMurmurTokenFromEnv(process.env);
  const dbPath = readDatabasePathFromEnv(process.env);

  // Open the SQLite handle and run forward-only migrations BEFORE binding
  // the port. The publisher/agent routes assume the schema is already in
  // place (see `createServer` JSDoc). Doing this synchronously up-front
  // means the server only starts answering requests once the DB is ready;
  // `process.exit(1)` on any failure keeps a half-migrated boot from
  // serving 5xxs forever.
  const env = process.env as NodeJS.ProcessEnv;
  const bootstrapToken = readBootstrapTokenFromEnv(env);
  const jwtSecret = readJwtSecretFromEnv(env);

  let db: Database.Database | undefined;
  if (dbPath !== undefined) {
    db = openDb(dbPath);
    const result = runMigrations(db);
    log.info("db.migrations_applied", {
      applied: result.applied.length,
      skipped: result.skipped.length,
    });
    seedDemoPublisher(db, env);
  }

  const handle = startServer(port, token, db, bootstrapToken, jwtSecret);
  log.info("server.listening", {
    port,
    db: dbPath !== undefined,
    bootstrap_enabled: bootstrapToken !== undefined,
    human_auth_enabled: jwtSecret !== undefined,
  });
  return handle;
}

// Self-invocation guard: only run `main()` when this module is executed
// directly (e.g. `tsx src/index.ts` or `node --import tsx src/index.ts`).
// Importing it from a test or another module must NOT bind a port.
//
// Node sets `import.meta.url` to the file URL; when run directly, that URL
// matches `process.argv[1]`'s file URL.
const invokedDirectly =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  import.meta.url === new URL(process.argv[1], "file://").href;

if (invokedDirectly) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    log.error("server.boot_failed", { error: message });
    process.exit(1);
  });
}
