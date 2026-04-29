/**
 * Tiny structured logger. Writes one JSON object per line to stderr.
 *
 * The lint config bans `console.log` in production code (see `eslint.config.js`),
 * so this module is the single sanctioned route for runtime logging. We log to
 * stderr only — stdout is reserved for tooling that may need to consume the
 * server's stdout (e.g. when run under a process supervisor that parses it).
 *
 * `console.error` is whitelisted in this file via an inline ESLint disable. This
 * is the documented "small logger module" required by the M1 quality gates.
 */

export type LogFields = Record<string, unknown>;

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/**
 * Singleton logger instance. Import as `import { log } from "./logger.js"`.
 *
 * Format: `{ "level": "info", "time": "2026-04-29T12:34:56.000Z", "msg": "...", ...fields }`.
 *
 * @throws never — logger swallows serialization errors and falls back to a string.
 */
export declare const log: Logger;
