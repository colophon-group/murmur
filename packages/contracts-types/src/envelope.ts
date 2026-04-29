/**
 * Canonical response envelope for all Murmur agent endpoints and all
 * jobseek subcommand routes.
 *
 * Single shape — no `accepted: true` parallel envelope (grep-no-accepted-key:allow — prose).
 * Enforced repo-wide via the `grep:no-accepted-key` gate on `packages/`,
 * `apps/`, `src/`, `test/` (the legacy carve-out is `_legacy/`).
 *
 * @see docs/contracts.md §4 — `task_tool` request/response envelope
 * @see docs/contracts.md §5 — `submit_result` validation-error shape
 */

/**
 * Successful envelope. `data` is optional so endpoints with no payload
 * (e.g., a successful `submit_result`) can return `{ ok: true }` alone.
 */
export interface Ok<T> {
  readonly ok: true;
  readonly data?: T;
}

/**
 * Failed envelope. `errors` is REQUIRED and non-empty in spirit
 * (the type allows `[]`, but emitters MUST populate at least one entry).
 *
 * Each entry is either a short token (e.g. `"publisher_timeout"`,
 * `"claim_lost"`, `"validation_failed"`) or a structured `ValidationError`
 * for per-field schema failures (see `submit_result` contract).
 */
export interface Err {
  readonly ok: false;
  readonly errors: ReadonlyArray<string | ValidationError>;
}

/**
 * Discriminated union — `ok` is the discriminator. Consumers MUST narrow
 * before reading `data` or `errors`.
 *
 * Type-level invariant: `EnvelopeResponse<T>` is structurally exclusive
 * of `{ accepted: boolean, ... }` (grep-no-accepted-key:allow — prose).
 * The package's tests assert that an `accepted`-shaped object does not
 * satisfy this type.
 */
export type EnvelopeResponse<T = unknown> = Ok<T> | Err;

/**
 * Per-field validation error. Used inside `Err.errors[]` when
 * `submit_result`'s `result` fails the subtask's `output_schema`,
 * and for `task_tool` arg validation failures.
 *
 * `path` is a JSON Pointer per RFC 6901 (e.g. `"/per_field/title/selector"`).
 * Empty string `""` denotes the document root.
 *
 * `code` is an optional machine-readable token (e.g. `"required"`,
 * `"type"`, `"enum"`). When present, `code` is a stable identifier;
 * `message` is human-readable and may change.
 */
export interface ValidationError {
  readonly path: string;
  readonly message: string;
  readonly code?: string;
}

/**
 * Type guard: narrow an `EnvelopeResponse<T>` to its `Ok<T>` branch.
 */
export function isOk<T>(response: EnvelopeResponse<T>): response is Ok<T> {
  return response.ok === true;
}

/**
 * Type guard: narrow an `EnvelopeResponse<T>` to its `Err` branch.
 */
export function isErr<T>(response: EnvelopeResponse<T>): response is Err {
  return response.ok === false;
}
