/**
 * JSON Schema validation utilities for the dispatch layer.
 *
 * These are pure utilities — they do NOT wire themselves into HTTP
 * routes. The consumers are:
 *   - `POST /pipelines` (M4 / #9): calls {@link validateJsonSchema}
 *     against `inputs`, `outputs`, and each subcommand's
 *     `input_schema` / `output_schema` to reject malformed pipeline
 *     definitions at registration time.
 *   - `submit_result` (M5 / #10): calls {@link validateAgainst} with
 *     the active subtask's `output_schema` and the submitted result.
 *   - `task_tool` dispatch (M7 / #12): calls {@link validateAgainst}
 *     with the subcommand's `input_schema` and the request `args`.
 *
 * Two Ajv instances are used:
 *   - `registrationAjv` — `strict: true`. Rejects unknown keywords and
 *     unresolved `$ref`s. This is the right behavior for accepting
 *     pipeline definitions from operators: a typo in `requried` (sic)
 *     should be flagged at register-time, not silently ignored at
 *     runtime. JSON Schema draft 2020-12 meta-schema is loaded by the
 *     `Ajv2020` import.
 *   - `runtimeAjv` — `strict: 'log'`. Validates instances against
 *     already-accepted schemas; we do NOT want a forward-compatibility
 *     unknown-keyword to fail a submission, so we downgrade to a log.
 *
 * Both instances share `allErrors: true` so a single validation call
 * returns every offending path, not just the first.
 *
 * Error format for {@link validateAgainst} matches the M0 envelope's
 * `Err.errors[]` string form: `validation:<json-pointer>:<message>`.
 * The JSON Pointer is Ajv's `instancePath` (RFC 6901). When the error
 * is at the document root, `instancePath` is the empty string, which
 * yields `validation::<message>`. This is intentional — see the M0
 * fixture in `docs/contracts/fixtures/all-seven.json` §5.
 *
 * Compiled validators are cached per schema-object identity using a
 * `WeakMap<object, ValidateFunction>`. This matters: a hot dispatch
 * loop validates the same schema thousands of times per run. Note the
 * cache is keyed by reference, not by structural equality — callers
 * are expected to hold their schemas stably (M4 stores them in the
 * pipelines table, so this holds).
 *
 * @see DESIGN.md §3.1 — schema fields on subtasks/subcommands
 * @see DESIGN.md §4.1 step 1 — schema validation at run start
 * @see docs/contracts/fixtures/all-seven.json §5 — `validation_error_envelope`
 */

import Ajv2020, { type ValidateFunction, type ErrorObject } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

/**
 * Result of registration-time JSON Schema shape validation.
 *
 * A successful result carries no payload — the caller already holds
 * the schema. A failure carries a single human-readable `error`
 * string of the form `<json-pointer>:<message>` so the route handler
 * can return a 400 with the offending path.
 */
export type ValidateSchemaResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

/**
 * Result of runtime instance validation.
 *
 * On success, `value` is the (untouched) instance, narrowed to `T`.
 * On failure, `errors` is a non-empty array of strings, each formatted
 * as `validation:<json-pointer>:<message>`. Multiple errors are all
 * returned (Ajv configured with `allErrors: true`).
 */
export type ValidateAgainstResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: ReadonlyArray<string> };

/**
 * Validate that the given value is a structurally valid JSON Schema
 * (draft 2020-12). Used by `POST /pipelines` to reject malformed
 * pipeline definitions before they enter the run loop.
 *
 * Specifically, this:
 *   - rejects schemas containing unknown keywords (Ajv `strict: true`),
 *   - rejects schemas with unresolved `$ref`s (compile-time failure),
 *   - rejects non-object inputs (a JSON Schema is always an object;
 *     `true`/`false` are technically valid 2020-12 but are nonsensical
 *     here and indicate a configuration error).
 *
 * Compilation is the test: if Ajv can compile it, it's a valid schema.
 * The error returned is the first compile-time error; this is fine for
 * registration because operators iterate.
 *
 * @param schema - A JSON value that the caller believes is a JSON Schema.
 * @returns `{ ok: true }` on success, `{ ok: false, error }` on failure.
 *          Never throws — Ajv's compile errors are caught and converted.
 */
export function validateJsonSchema(schema: unknown): ValidateSchemaResult {
  throw new Error("not implemented");
}

/**
 * Validate `instance` against `schema` using a runtime-tolerant Ajv
 * instance. Used by `submit_result` (output schema) and `task_tool`
 * dispatch (input schema).
 *
 * Behaviour:
 *   - Returns ALL errors, not just the first.
 *   - Errors include JSON-Pointer paths (RFC 6901). Root errors yield
 *     an empty path — the formatted string is `validation::<message>`.
 *   - Extra unknown fields on objects are accepted unless the schema
 *     itself sets `additionalProperties: false`. Ajv default behavior;
 *     do not override.
 *   - Compiled validators are cached by schema reference.
 *
 * Caller responsibilities:
 *   - The schema MUST already have passed {@link validateJsonSchema}
 *     at registration. This function does not re-validate the schema
 *     shape — it only validates the instance.
 *   - The generic `T` is a convenience for the caller; this function
 *     does not narrow the type at runtime beyond Ajv's checks.
 *
 * @param schema - The JSON Schema to validate against.
 * @param instance - The value to validate.
 * @returns `{ ok: true, value }` on success;
 *          `{ ok: false, errors }` with one or more `validation:<path>:<msg>`
 *          strings on failure.
 *          On schema compile failure (which should not happen in production
 *          because schemas pass {@link validateJsonSchema} first), returns
 *          `{ ok: false, errors: [<the compile error>] }`.
 */
export function validateAgainst<T = unknown>(
  schema: unknown,
  instance: unknown,
): ValidateAgainstResult<T> {
  throw new Error("not implemented");
}

/**
 * Internal: format a single Ajv error as the M0 envelope string token.
 * Exported for testing only. The format is intentionally stable —
 * downstream consumers parse it.
 *
 * @param err - An Ajv error object.
 * @returns `validation:<instancePath>:<message>` — `instancePath` may be
 *          the empty string for root-level errors.
 */
export function formatAjvError(err: ErrorObject): string {
  throw new Error("not implemented");
}
