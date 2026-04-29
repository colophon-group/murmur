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

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Resolve `docs/contracts/pipeline-def.schema.json` relative to the
 * package root. This file lives at `src/api/publisher/schema.ts`, so
 * three `..` segments climb out to the package root.
 */
function schemaPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..", "docs", "contracts", "pipeline-def.schema.json");
}

/**
 * Internal loader — exported only for testing. Reads
 * `docs/contracts/pipeline-def.schema.json` from disk. Throws if the
 * file is missing or malformed (boot fails fast — these would be a
 * deployment misconfiguration).
 */
export function loadPipelineDefSchema(): Readonly<Record<string, unknown>> {
  const raw = readFileSync(schemaPath(), "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `loadPipelineDefSchema: ${schemaPath()} did not parse to a JSON object`,
    );
  }
  return parsed as Readonly<Record<string, unknown>>;
}

/**
 * The parsed pipeline-def JSON Schema document. Stable reference; the
 * runtime cache in `src/dispatch/validation.ts` is keyed by reference,
 * so re-loading on every request would defeat the cache.
 */
export const PIPELINE_DEF_SCHEMA: Readonly<Record<string, unknown>> =
  loadPipelineDefSchema();
