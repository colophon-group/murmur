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
 * Ajv instance used for registration-time schema-shape validation.
 *
 * `strict: true` rejects unknown keywords, unresolved `$ref`s,
 * mismatched types, etc. — exactly what we want when an operator
 * uploads a pipeline definition: typos like `requried` should be
 * caught at upload, not at the first runtime validation.
 *
 * `allErrors: true` is harmless here (compile-time errors are first-
 * fail anyway) but keeps both instances configured consistently.
 *
 * `ajv-formats` is loaded so format keywords like `format: "uri"`,
 * `format: "date-time"`, etc. are recognized — the §3.1 jobseek
 * pipeline uses `format: "uri"` on `canonical_website` and `board_url`.
 */
const registrationAjv = new Ajv2020({
  strict: true,
  allErrors: true,
});
addFormats(registrationAjv);

/**
 * Ajv instance used for runtime instance validation.
 *
 * `strict: 'log'` downgrades unknown-keyword errors to `console.warn`
 * rather than failing compilation. This matters because a schema may
 * be authored with forward-compatibility annotations (e.g. an
 * `x-internal` extension); we don't want such a schema to break a
 * submission. Schemas reach runtime only after passing
 * {@link validateJsonSchema}, so genuinely-broken schemas are already
 * filtered out by then.
 *
 * `allErrors: true` is the key behavior — we return EVERY validation
 * failure for an instance, not just the first.
 */
const runtimeAjv = new Ajv2020({
  strict: "log",
  allErrors: true,
});
addFormats(runtimeAjv);

/**
 * Cache of compiled validators, keyed by schema reference.
 * `WeakMap` so a schema that is no longer referenced is reclaimed
 * along with its compiled function.
 */
const compiledCache = new WeakMap<object, ValidateFunction>();

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
  // Reject obviously non-schema inputs up front. A JSON Schema is
  // always a JSON object in our world; `true`/`false` are technically
  // valid 2020-12 schemas but they're nonsensical as a pipeline
  // input/output schema and almost always indicate a configuration
  // error in the YAML. Treat them as invalid.
  if (
    schema === null ||
    typeof schema !== "object" ||
    Array.isArray(schema)
  ) {
    return {
      ok: false,
      error: `:schema must be a JSON object, got ${
        schema === null ? "null" : Array.isArray(schema) ? "array" : typeof schema
      }`,
    };
  }

  try {
    // Compile through the strict instance. Any unknown keyword,
    // unresolved $ref, or type-level malformation throws here.
    registrationAjv.compile(schema);
    return { ok: true };
  } catch (err) {
    // Ajv errors are strings/Errors. Surface a single-line message
    // suitable for the offending-path response.
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
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
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return {
      ok: false,
      errors: [
        `validation::schema must be a JSON object, got ${
          schema === null ? "null" : Array.isArray(schema) ? "array" : typeof schema
        }`,
      ],
    };
  }

  // Cache lookup — schemas are passed by reference from the pipelines
  // table; the same object identity recurs across many calls.
  let validate = compiledCache.get(schema);
  if (validate === undefined) {
    try {
      validate = runtimeAjv.compile(schema);
    } catch (err) {
      // Should not happen in production: schemas pass `validateJsonSchema`
      // at registration. If it does, surface the compile error so the
      // dispatch handler can return a 500-style envelope.
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, errors: [`validation::${message}`] };
    }
    compiledCache.set(schema, validate);
  }

  const valid = validate(instance);
  if (valid) {
    return { ok: true, value: instance as T };
  }

  // `validate.errors` is non-null when `valid` is false. Defensive `?? []`
  // for type narrowing only.
  const errors = (validate.errors ?? []).map(formatAjvError);
  // If Ajv somehow returned no error objects despite reporting invalid,
  // ensure we still emit a non-empty errors array (M0 contract).
  if (errors.length === 0) {
    return { ok: false, errors: ["validation::unspecified validation error"] };
  }
  return { ok: false, errors };
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
  // Ajv 2020 always populates `instancePath` (empty string at root).
  // `message` is normally present but typed `string | undefined`;
  // fall back to an empty string defensively.
  return `validation:${err.instancePath}:${err.message ?? ""}`;
}
