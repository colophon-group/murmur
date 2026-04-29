/**
 * Boot entry point for the Murmur server.
 *
 * - Reads `PORT` from `process.env`, refusing to start if the var is unset,
 *   empty, or not a finite positive integer (DESIGN.md §6.2 hard-requires
 *   `PORT` from compose).
 * - Calls `createServer()` and binds it via `@hono/node-server`.
 * - Logs the listen address (port + family) via the structured logger.
 *
 * This module is invoked by `pnpm dev` (`tsx watch src/index.ts`) and by the
 * Docker image entrypoint in production. It deliberately does NOT define a
 * graceful-shutdown hook here — that lands with M2's lifecycle work.
 */

/**
 * Read `PORT` from `process.env`, validating the format.
 *
 * @returns a finite positive integer port number.
 * @throws Error with code `port_missing` if `PORT` is unset or empty.
 * @throws Error with code `port_invalid` if `PORT` is not a finite positive integer.
 */
export declare function readPortFromEnv(env: NodeJS.ProcessEnv): number;

/**
 * Boot the server on the given port.
 *
 * @returns a handle whose `close()` resolves when the underlying socket has shut down.
 */
export declare function startServer(port: number): {
  close(): Promise<void>;
};

/**
 * Top-level main. Reads `PORT`, starts the server, logs once, returns the handle.
 *
 * Intentionally not auto-invoked at module load; the boot script at the bottom
 * of this file calls it under an `import.meta.main`-style guard so that test
 * imports of `readPortFromEnv` / `startServer` don't accidentally bind a port.
 */
export declare function main(): Promise<{ close(): Promise<void> }>;
