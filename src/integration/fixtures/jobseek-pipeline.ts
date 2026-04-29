/**
 * §3.1 jobseek pipeline def, parameterised on `apiBase` (mock-jobseek
 * origin + path prefix) and `webhookUrl` so tests can wire it at the
 * mock instance running on a random port.
 *
 * The shape mirrors DESIGN.md §3.1's worked example, trimmed to the
 * three subtasks the demo exercises end-to-end:
 *
 *   - `pre-verify` — confirms the company exists; returns
 *     `{ verified, canonical_name, canonical_website }`.
 *   - `list-boards` — returns `{ boards: [...] }` and spawns one
 *     `configure-board` per element via `spawns: { for_each: boards,
 *     template: configure-board, bind_as: board }`.
 *   - `configure-board` — template; per-board outcome.
 *
 * The `final_output.composes` rules use:
 *   - `pre-verify.canonical_*`            — wildcard prefix.
 *   - `list-boards.boards × configure-board.*` — cartesian (one entry
 *     per spawned child).
 *
 * **Why constructed in TS, not loaded from YAML.** The publisher API
 * accepts YAML, but the test fixtures want full type-checking on the
 * pipeline shape (`PipelineDef` from `@murmur/contracts-types`) so
 * drift between this fixture and the contract types fails at `tsc`,
 * not at runtime. We serialise the resulting object back to YAML when
 * we hand it to `POST /pipelines`.
 */

import type { PipelineDef } from "@murmur/contracts-types";

/**
 * Options accepted by {@link buildJobseekPipeline}.
 *
 * `apiBase` is the mock-jobseek's root URL up to (but excluding) the
 * `/api/murmur` path the routes live under. The pipeline def appends
 * the per-route paths. Example: `http://127.0.0.1:54321`.
 *
 * `webhookUrl` is the full URL Murmur will POST `final_output` to.
 * Example: `http://127.0.0.1:54321/api/murmur/accept`.
 *
 * `pipelineId` lets a test register multiple pipelines in the same DB
 * without colliding on the upsert key.
 */
export interface BuildJobseekPipelineOptions {
  readonly apiBase: string;
  readonly webhookUrl: string;
  readonly pipelineId?: string;
}

/**
 * Return a complete `PipelineDef` matching DESIGN.md §3.1 with all
 * subcommand `endpoint` URLs and the `final_output.webhook` pointed at
 * `apiBase`/`webhookUrl`.
 *
 * The returned object is structurally compatible with the
 * `pipeline-def.schema.json` JSON Schema gating `POST /pipelines`. The
 * caller is responsible for stringifying it (we serialise via the YAML
 * lib for the publisher route's wire shape).
 */
export function buildJobseekPipeline(
  opts: BuildJobseekPipelineOptions,
): PipelineDef {
  const { apiBase, webhookUrl } = opts;
  const pipelineId = opts.pipelineId ?? "jobseek/add-company";

  return {
    id: pipelineId,
    initial_input: {
      type: "object",
      required: ["company_name", "website"],
      properties: {
        company_name: { type: "string", minLength: 1 },
        website: { type: "string", format: "uri" },
      },
      additionalProperties: false,
    },
    subtasks: [
      {
        id: "pre-verify",
        instructions:
          "Confirm this is a real, non-duplicate company with a careers page.",
        output_schema: {
          type: "object",
          required: ["verified", "canonical_name", "canonical_website"],
          properties: {
            verified: { type: "boolean" },
            canonical_name: { type: "string", minLength: 1 },
            canonical_website: { type: "string", format: "uri" },
          },
          additionalProperties: false,
        },
        subcommands: [
          {
            name: "verify company",
            endpoint: `POST ${apiBase}/api/murmur/companies/verify`,
            input_schema: {
              type: "object",
              required: ["website"],
              properties: { website: { type: "string", format: "uri" } },
              additionalProperties: false,
            },
          },
        ],
      },
      {
        id: "list-boards",
        instructions:
          "Discover all distinct boards. Cross-board reconciliation runs in the accept handler — do not dedupe yourself.",
        requires: ["pre-verify"],
        output_schema: {
          type: "object",
          required: ["boards"],
          properties: {
            boards: {
              type: "array",
              items: {
                type: "object",
                required: ["alias", "url", "provider"],
                properties: {
                  alias: { type: "string", minLength: 1 },
                  url: { type: "string", format: "uri" },
                  provider: { type: "string", minLength: 1 },
                },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
        spawns: {
          for_each: "boards",
          template: "configure-board",
          bind_as: "board",
        },
        subcommands: [
          {
            name: "analyze hreflang",
            endpoint: `POST ${apiBase}/api/murmur/probes/monitor`,
          },
        ],
      },
      {
        id: "configure-board",
        instructions:
          "Configure monitor and (when needed) scraper for this board.",
        output_schema: {
          type: "object",
          required: ["outcome"],
          properties: {
            outcome: {
              type: "string",
              enum: ["configured", "phantom", "parent-portal", "unsupported"],
            },
            monitor_type: { type: "string" },
            monitor_config: { type: "object" },
            scraper_type: { type: "string" },
            scraper_config: { type: "object" },
            verdict: { type: "string", enum: ["good", "acceptable", "bad"] },
          },
          additionalProperties: false,
        },
        subcommands: [
          {
            name: "probe monitor",
            endpoint: `POST ${apiBase}/api/murmur/probes/monitor`,
          },
          {
            name: "select monitor",
            endpoint: `POST ${apiBase}/api/murmur/select/monitor`,
          },
          {
            name: "run monitor",
            endpoint: `POST ${apiBase}/api/murmur/run/monitor`,
          },
          {
            name: "probe scraper",
            endpoint: `POST ${apiBase}/api/murmur/probes/scraper`,
          },
          {
            name: "select scraper",
            endpoint: `POST ${apiBase}/api/murmur/select/scraper`,
          },
          {
            name: "run scraper",
            endpoint: `POST ${apiBase}/api/murmur/run/scraper`,
          },
          {
            name: "feedback",
            endpoint: `POST ${apiBase}/api/murmur/feedback`,
          },
        ],
      },
    ],
    final_output: {
      composes: [
        "pre-verify.canonical_*",
        "boards: list-boards.boards × configure-board.*",
      ],
      webhook: webhookUrl,
    },
  };
}
