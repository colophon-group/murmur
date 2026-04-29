/**
 * MCP tool registrations for Murmur's three static tools (DESIGN.md §3.4).
 *
 * The three tools are:
 *
 *   - `pull_task()` → wraps `GET /work/next` (DESIGN.md §3.3).
 *   - `submit_result(claim, result, notes?)` → wraps `POST /work/{claim}/result`.
 *   - `task_tool(subcommand, claim, args?)` → universal subcommand dispatcher.
 *     Handled by M7 (#12); for M6 the tool is registered with its full schema
 *     but its handler is a stub that returns the M0 envelope
 *     `{ ok: false, errors: ['not_implemented'] }`. M7 will replace the
 *     handler body — the registration itself, including the description and
 *     input schema, is final.
 *
 * Static descriptions come verbatim from DESIGN.md §3.4 — the host's tool
 * catalog displays them and the demo plan depends on the wording. Every
 * change to a description here MUST round-trip through DESIGN.md.
 *
 * **Envelope discipline.** All tool handlers return MCP `CallToolResult`
 * objects whose `structuredContent` is an `EnvelopeResponse<T>` (the M0
 * shape `{ ok, errors?, data? }` from `@murmur/contracts-types`). There is
 * no parallel `accepted: true` shape (grep-no-accepted-key:allow — prose).
 *
 * **Auth propagation.** Tool handlers receive the HTTP request's
 * `Authorization` header from the MCP `RequestHandlerExtra.requestInfo`
 * surface (the SDK's per-request auth path) and forward it to the
 * in-process agent app via `app.request(..., { headers: ... })`. The
 * caller (`createMcpRoute`) is responsible for ensuring the bearer-auth
 * middleware has already validated the header before the request reaches
 * this layer; the forwarded header lets the agent sub-app's own
 * middleware re-validate as a defence-in-depth step.
 *
 * @see DESIGN.md §3.3 — agent endpoints (the wrapped HTTP routes)
 * @see DESIGN.md §3.4 — MCP server surface (the static descriptions)
 * @see docs/contracts.md §4 — envelope shape
 */

import type { Hono } from "hono";
import { z } from "zod";

import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";

import type { EnvelopeResponse } from "@murmur/contracts-types";

/* -------------------------------------------------------------------------- */
/*  Static descriptions (DESIGN.md §3.4 — copy them verbatim)                 */
/* -------------------------------------------------------------------------- */

/**
 * `pull_task` description (DESIGN.md §3.4 first bullet).
 *
 * The §3.4 prose for `pull_task` is bare — the bullet specifies only the
 * shape, not a host-facing description. We use the canonical sentence from
 * the §3.5 worked example and the design's "atomically claim the oldest
 * unclaimed subtask" phrase from §3.3, joined into a single agent-readable
 * sentence. Stable for the demo; do not change without a DESIGN.md update.
 */
export const PULL_TASK_DESCRIPTION =
  "Atomically claim the oldest unclaimed subtask instance across all pipelines. Returns `{ instructions, input, output_schema, claim }` or `null` when the queue is empty. Use the returned `claim` for any subsequent `task_tool` and `submit_result` calls.";

/**
 * `submit_result` description (DESIGN.md §3.4 second bullet).
 */
export const SUBMIT_RESULT_DESCRIPTION =
  "Submit a structured `result` for the given `claim`. The optional `notes` is a free-text reflection persisted in the audit log alongside the structured `result`. Returns `{ accepted: true }` or `{ accepted: false, errors: [...] }` with per-field validation errors; this MCP wrapper preserves the underlying HTTP envelope (grep-no-accepted-key:allow — prose).";

/**
 * `task_tool` description — verbatim from DESIGN.md §3.4 (the static
 * description visible to the host's tool catalog).
 */
export const TASK_TOOL_DESCRIPTION =
  "Invoke a subcommand for the current claim. The subtask `instructions` will tell you which subcommands to use and when; `task_tool('<name>', '<claim>', {...})` invokes one. The `claim` value is what `pull_task` returned in its `claim` field.";

/* -------------------------------------------------------------------------- */
/*  Tool name constants — exported so tests can address them by symbol        */
/* -------------------------------------------------------------------------- */

export const TOOL_PULL_TASK = "pull_task";
export const TOOL_SUBMIT_RESULT = "submit_result";
export const TOOL_TASK_TOOL = "task_tool";

/* -------------------------------------------------------------------------- */
/*  Tool input schemas (Zod, surfaces as JSON Schema in tools/list)           */
/* -------------------------------------------------------------------------- */

/**
 * `pull_task` takes no parameters. The SDK's `registerTool` accepts an
 * `inputSchema` of `undefined` for zero-arg tools; we keep this exported so
 * tests can assert "no params" explicitly.
 */
export const PULL_TASK_INPUT_SHAPE = undefined;

/**
 * `submit_result` requires `claim` and `result`; `notes` is optional.
 *
 * `result` is `unknown` because the actual schema is per-subtask
 * (publishers declare it). We document it as a JSON-serialisable object;
 * Zod `.passthrough()` accepts arbitrary nested shapes.
 */
export const SUBMIT_RESULT_INPUT_SHAPE = {
  claim: z
    .string()
    .min(1)
    .describe(
      "The opaque claim token returned by `pull_task` for the subtask whose result you are submitting.",
    ),
  result: z
    .unknown()
    .describe(
      "The structured result. Validated against the subtask's `output_schema`; per-field errors are returned in the response envelope on failure.",
    ),
  notes: z
    .string()
    .optional()
    .describe(
      "Optional free-text reflection persisted in the audit log alongside the structured `result` (DESIGN.md §3.1).",
    ),
} as const;

/**
 * `task_tool` requires `subcommand` and `claim`; `args` is optional.
 *
 * The schema is final for M6 — M7 (#12) only replaces the handler body.
 */
export const TASK_TOOL_INPUT_SHAPE = {
  subcommand: z
    .string()
    .min(1)
    .describe(
      "The publisher-declared subcommand to invoke (e.g. `'probe monitor'`, `'select monitor'`). Names are scoped to the claim's subtask def; `task_tool('help')` lists valid names when subcommand resolution fails.",
    ),
  claim: z
    .string()
    .min(1)
    .describe(
      "The opaque claim token returned by `pull_task`. Required (no session-based fallback in MVP).",
    ),
  args: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Subcommand arguments, validated by Murmur against the subcommand's `input_schema` before being proxied to the publisher.",
    ),
} as const;

/* -------------------------------------------------------------------------- */
/*  Public surface                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Options for {@link registerMcpTools}.
 */
export interface RegisterMcpToolsOptions {
  /**
   * The in-process Hono app implementing `GET /work/next` and
   * `POST /work/{claim}/result` (M5 — `src/api/agent`). Tool handlers
   * call this via `agentApp.request(...)` rather than crossing the
   * network — same node, same DB handle, no extra TLS / cloudflared hop.
   */
  readonly agentApp: Hono;
}

/**
 * Register Murmur's three static MCP tools on the supplied server.
 *
 * @returns nothing; mutates the server's tool registry.
 */
export function registerMcpTools(
  server: McpServer,
  options: RegisterMcpToolsOptions,
): void {
  registerPullTask(server, options.agentApp);
  registerSubmitResult(server, options.agentApp);
  registerTaskTool(server);
}

/* -------------------------------------------------------------------------- */
/*  Internal: tool handlers                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Extract the bearer header from the MCP request handler's per-request
 * extra. The SDK exposes the underlying HTTP request's headers via
 * `extra.requestInfo.headers` when the transport is one of the HTTP
 * variants. For the in-memory transport (used in tests that don't exercise
 * auth) this is `undefined`, in which case we forward an empty header set
 * — the agent sub-app's own bearer-auth middleware will short-circuit the
 * request as unauthorised, and the test harness either avoids the agent
 * app or wraps it without auth.
 */
function authHeaderFromExtra(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
): string | undefined {
  const headers = extra.requestInfo?.headers;
  if (headers === undefined) return undefined;
  const value = headers["authorization"];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length > 0) return value[0];
  return undefined;
}

/**
 * Build a `CallToolResult` whose `structuredContent` is the supplied
 * envelope. Also emits a textual rendering for hosts that ignore the
 * structured slot (e.g. plain-text loggers) — the `text` field is the
 * JSON-serialised envelope, byte-identical to what `structuredContent`
 * carries. Setting `isError` reflects the envelope's `ok` discriminator.
 */
function envelopeResult(envelope: EnvelopeResponse<unknown>): CallToolResult {
  const text = JSON.stringify(envelope);
  return {
    content: [{ type: "text", text }],
    structuredContent: envelope as Record<string, unknown>,
    isError: !envelope.ok,
  };
}

/**
 * Forward an in-process call to the agent app and return its parsed
 * envelope. Body is `null` for GET and a JSON object for POST.
 */
async function callAgentApp(
  agentApp: Hono,
  method: "GET" | "POST",
  path: string,
  authorization: string | undefined,
  body?: unknown,
): Promise<EnvelopeResponse<unknown>> {
  const headers: Record<string, string> = {};
  if (authorization !== undefined) headers["authorization"] = authorization;
  if (method === "POST") headers["content-type"] = "application/json";

  const response = await agentApp.request(path, {
    method,
    headers,
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
  });

  // The agent app always emits JSON. We swallow non-JSON / non-envelope
  // bodies into a structured failure rather than letting them throw — this
  // keeps the tool contract single-shape.
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { ok: false, errors: ["bad_response"] };
  }

  if (!isEnvelope(parsed)) {
    return { ok: false, errors: ["bad_response"] };
  }
  return parsed;
}

/**
 * Type-guard for the M0 envelope. Restricts the agent-app response to a
 * shape we can safely surface to MCP without leaking arbitrary objects.
 */
function isEnvelope(value: unknown): value is EnvelopeResponse<unknown> {
  if (value === null || typeof value !== "object") return false;
  const ok = (value as { ok?: unknown }).ok;
  if (ok === true) return true;
  if (ok === false) {
    const errors = (value as { errors?: unknown }).errors;
    return Array.isArray(errors);
  }
  return false;
}

/* ---------------------------- pull_task ---------------------------------- */

function registerPullTask(server: McpServer, agentApp: Hono): void {
  server.registerTool(
    TOOL_PULL_TASK,
    {
      description: PULL_TASK_DESCRIPTION,
      // No inputSchema: zero-argument tool.
    },
    async (_args, extra) => {
      const auth = authHeaderFromExtra(extra);
      const env = await callAgentApp(agentApp, "GET", "/work/next", auth);
      return envelopeResult(env);
    },
  );
}

/* --------------------------- submit_result ------------------------------- */

function registerSubmitResult(server: McpServer, agentApp: Hono): void {
  server.registerTool(
    TOOL_SUBMIT_RESULT,
    {
      description: SUBMIT_RESULT_DESCRIPTION,
      inputSchema: SUBMIT_RESULT_INPUT_SHAPE,
    },
    async (args, extra) => {
      const auth = authHeaderFromExtra(extra);
      const path = `/work/${encodeURIComponent(args.claim)}/result`;
      const body: { result: unknown; notes?: string } = { result: args.result };
      if (args.notes !== undefined) body.notes = args.notes;
      const env = await callAgentApp(agentApp, "POST", path, auth, body);
      return envelopeResult(env);
    },
  );
}

/* ----------------------------- task_tool --------------------------------- */

function registerTaskTool(server: McpServer): void {
  server.registerTool(
    TOOL_TASK_TOOL,
    {
      description: TASK_TOOL_DESCRIPTION,
      inputSchema: TASK_TOOL_INPUT_SHAPE,
    },
    // TODO(#12, M7): replace this stub with the dispatch implementation.
    // Until M7 lands the tool registers cleanly (so `tools/list` shape is
    // stable from M6 onward) but every call returns the M0
    // `not_implemented` envelope. The SDK still validates `args` against
    // TASK_TOOL_INPUT_SHAPE before invoking the handler.
    () => {
      const env: EnvelopeResponse<never> = {
        ok: false,
        errors: ["not_implemented"],
      };
      return Promise.resolve(envelopeResult(env));
    },
  );
}
