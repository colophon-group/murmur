/**
 * Tiny structured logger. Writes one JSON object per line to stderr.
 *
 * The lint config bans `console.log` in production code (see `eslint.config.js`),
 * so this module is the single sanctioned route for runtime logging. We log to
 * stderr only — stdout is reserved for tooling that may need to consume the
 * server's stdout (e.g. when run under a process supervisor that parses it).
 *
 * `console.error` is whitelisted in this file via the ESLint config's
 * file-scoped override. This is the documented "small logger module" required
 * by the M1 quality gates.
 */

export type LogFields = Record<string, unknown>;

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

type Level = "info" | "warn" | "error";

function emit(level: Level, message: string, fields?: LogFields): void {
  const record: Record<string, unknown> = {
    level,
    time: new Date().toISOString(),
    msg: message,
    ...fields,
  };

  let line: string;
  try {
    line = JSON.stringify(record);
  } catch {
    // Fields contained a circular reference or a non-serializable value.
    // Fall back to a structurally-identical record without the offending fields.
    line = JSON.stringify({
      level,
      time: record.time,
      msg: message,
      _logger: "fields_unserializable",
    });
  }

  // The single sanctioned use of `console.error` in production code.
  // The `no-console` rule is disabled for this file via `eslint.config.js`.
  console.error(line);
}

/**
 * Singleton logger instance. Import as `import { log } from "./logger.js"`.
 *
 * Format: `{ "level": "info", "time": "2026-04-29T12:34:56.000Z", "msg": "...", ...fields }`.
 *
 * Logger swallows serialization errors and falls back to a stripped-down record.
 */
export const log: Logger = {
  info(message, fields) {
    emit("info", message, fields);
  },
  warn(message, fields) {
    emit("warn", message, fields);
  },
  error(message, fields) {
    emit("error", message, fields);
  },
};
