/**
 * Pipeline-def JSON Schema loader.
 *
 * `POST /pipelines` validates incoming pipeline definitions against
 * `docs/contracts/pipeline-def.schema.json` (the M0 boundary contract).
 * The schema is loaded once at module import and reused across requests.
 *
 * Loading happens via `fs.readFileSync` rather than `import ... assert`
 * so the path is robust to the bundler/runtime mode (`tsx`, native ESM,
 * tests run from various CWDs). The path is resolved relative to this
 * source file, not the process CWD.
 *
 * @see docs/contracts/pipeline-def.schema.json
 * @see DESIGN.md §3.2 — POST /pipelines
 */

/**
 * The parsed pipeline-def JSON Schema document. Stable reference; the
 * runtime cache in `src/dispatch/validation.ts` is keyed by reference,
 * so re-loading on every request would defeat the cache.
 *
 * Type is `object` because the schema has many nested fields the
 * publisher API does not depend on directly — Ajv consumes it as a
 * generic JSON Schema document.
 */
export const PIPELINE_DEF_SCHEMA: Readonly<Record<string, unknown>> =
  loadPipelineDefSchema();

/**
 * Internal loader — exported only for testing. Reads
 * `docs/contracts/pipeline-def.schema.json` from disk. Throws if the
 * file is missing or malformed (boot fails fast — these would be a
 * deployment misconfiguration).
 */
export function loadPipelineDefSchema(): Readonly<Record<string, unknown>> {
  throw new Error("not implemented");
}
