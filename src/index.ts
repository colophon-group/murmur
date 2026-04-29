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
 * - Logs the listen address (port + family) via the structured logger. The
 *   token value is NEVER logged (`grep-no-token-logged` enforces this).
 *
 * This module is invoked by `pnpm dev` (`tsx watch src/index.ts`) and by the
 * Docker image entrypoint in production. It deliberately does NOT define a
 * graceful-shutdown hook here — that lands with M2's lifecycle work.
 */

import { serve, type ServerType } from "@hono/node-server";

import { log } from "./logger.js";
import { createServer } from "./server.js";

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
  // Marker line for unimplemented interface; not executable.
  if (env) {
    throw new Error("not implemented");
  }
  throw new Error("not implemented");
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
 * @returns a handle whose `close()` resolves when the underlying socket has
 *   shut down. Idempotent: calling `close()` twice is safe (the second call
 *   resolves immediately).
 */
export function startServer(port: number, token: Buffer): ServerHandle {
  const app = createServer({ token });

  // `@hono/node-server` returns the underlying `http.Server`. We capture it
  // typed as `ServerType` (the package's exported alias) so we can call
  // `.close()` from the handle.
  const server: ServerType = serve({ fetch: app.fetch, port });

  let closed = false;

  return {
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
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
  const handle = startServer(port, token);
  log.info("server.listening", { port });
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
