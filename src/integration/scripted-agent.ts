/**
 * Scripted "agent" loop for the integration test.
 *
 * No LLM. The loop walks `pull_task` → optionally `task_tool` per
 * subtask's declared subcommands → `submit_result` until `pull_task`
 * returns `data: null`. For each subtask id, the loop knows what shape
 * to construct as a valid result so the M0 schema validator inside the
 * CAS submit handler accepts it.
 *
 * The MCP `task_tool` tool itself is still a stub (M6's
 * `not_implemented` placeholder). To exercise the cross-repo wire
 * contract under test by issue #35, we call `dispatchTaskTool` directly
 * with the same DB + bearer the production wiring uses. That keeps the
 * test focused on the wire-level contract (request headers + envelope
 * shape against the mock-jobseek) rather than tunnelling through MCP's
 * transport layer, which is covered separately by `src/mcp/server.test.ts`.
 *
 * The loop also asserts envelope shape on every response from the
 * agent app — every body MUST be `{ ok, errors?, data? }` with no
 * `accepted` key. The assertions live in the integration test file
 * itself (so a failure points at the test source, not this helper);
 * this module exposes the raw responses so the test can drive them.
 */

import type Database from "better-sqlite3";
import type { Hono } from "hono";

import type { EnvelopeResponse } from "@murmur/contracts-types";

import { dispatchTaskTool } from "../dispatch/task_tool.js";

/**
 * Result of one `pull_task` call. Mirrors the agent app's envelope.
 */
export type PullTaskResponse = EnvelopeResponse<PullTaskData | null>;

/**
 * Shape of `data` returned by `GET /work/next` on success. Subset of
 * `NextWorkData` from `src/api/agent/work.ts`.
 */
export interface PullTaskData {
  readonly instructions: string;
  readonly input: unknown;
  readonly output_schema: Readonly<Record<string, unknown>>;
  readonly claim: string;
}

/**
 * Result of a `task_tool` invocation, surfaced verbatim from the
 * dispatcher.
 */
export type TaskToolResponse = EnvelopeResponse<unknown>;

/**
 * Result of a `submit_result` call. Mirrors the agent app's envelope.
 */
export type SubmitResultResponse = EnvelopeResponse<{ run_id: string }>;

/**
 * Options accepted by {@link runScriptedAgent}.
 */
export interface RunScriptedAgentOptions {
  /** The Murmur Hono app — created via `createServer({ token, db })`. */
  readonly app: Hono;
  /** Open SQLite handle the app is bound to. The dispatcher needs this. */
  readonly db: Database.Database;
  /** The `MURMUR_TOKEN` value used as Bearer for both Murmur AND the proxy. */
  readonly bearer: string;
  /**
   * `boards` shape returned by `list-boards`. The 1-board test passes a
   * single-element array; the 3-board test passes three. Each element
   * must satisfy the pipeline's `boards` item schema (alias, url,
   * provider).
   */
  readonly boards: ReadonlyArray<BoardSpec>;
  /**
   * Optional record of every `task_tool` call made during the run.
   * Tests use it to assert each envelope's shape.
   */
  readonly taskToolCalls?: TaskToolResponse[];
  /**
   * Optional record of every `pull_task` and `submit_result` envelope.
   */
  readonly murmurCalls?: EnvelopeResponse<unknown>[];
}

/**
 * One board element returned by `list-boards`.
 */
export interface BoardSpec {
  readonly alias: string;
  readonly url: string;
  readonly provider: string;
}

/**
 * Outcome of {@link runScriptedAgent}. The `runId` is the run the agent
 * worked through (multiple runs would not happen in our tests, but we
 * surface the id so the caller can read `runs.final_output_json`
 * directly when needed).
 */
export interface RunScriptedAgentResult {
  readonly runId: string;
  readonly claimedSubtaskOrder: ReadonlyArray<{
    readonly subtaskId: string;
    readonly input: unknown;
  }>;
}

const AUTH_HEADER_NAME = "Authorization";

/**
 * Drive the scripted agent loop. Returns when `pull_task` reports an
 * empty queue (`data: null`). Throws on any envelope shape mismatch
 * (those are programmer-error against the agent app, not legitimate
 * agent failure paths) so the test's outer `await` surfaces a descriptive
 * stack.
 *
 * For each claim:
 *
 *   - **`pre-verify`** — invokes `task_tool('verify company')`, then
 *     submits `{ verified: true, canonical_name, canonical_website }`.
 *   - **`list-boards`** — invokes `task_tool('analyze hreflang')` once,
 *     then submits `{ boards: <opts.boards> }`.
 *   - **`configure-board`** — invokes `task_tool('probe monitor')`,
 *     `task_tool('select monitor')`, `task_tool('run monitor')`,
 *     `task_tool('feedback')` in order, then submits
 *     `{ outcome: 'configured', monitor_type: 'rss', ... }`.
 *
 * Every `task_tool` call is asserted to have `ok === true` (we use
 * stub publishers that always return 200). On unexpected envelope
 * shapes the loop throws with a message naming the violated contract
 * — the issue's quality gate "Failure messages say which contract was
 * violated" applies here.
 */
export async function runScriptedAgent(
  options: RunScriptedAgentOptions,
): Promise<RunScriptedAgentResult> {
  const claimed: Array<{ subtaskId: string; input: unknown }> = [];
  let runId = "";

  // Loop bound: a 3-board run goes pre-verify (1) + list-boards (1) +
  // configure-board × 3 = 5 claims. We bound at 32 to catch infinite
  // loops without trusting the test's expected count.
  for (let iter = 0; iter < 32; iter += 1) {
    const claim = await pullTask(options.app, options.bearer);
    if (options.murmurCalls !== undefined) {
      options.murmurCalls.push(claim);
    }
    if (!claim.ok) {
      throw new Error(
        `pull_task envelope was not ok at iteration ${iter}: errors=${JSON.stringify(claim.errors)}`,
      );
    }
    if (claim.data === null) {
      // Empty queue → loop is done.
      return { runId, claimedSubtaskOrder: claimed };
    }

    const data = claim.data;

    // Resolve the claim row to learn the subtask_id (the data envelope
    // doesn't carry it directly — `instructions` is a free-text field).
    // We look it up on the DB by claim_token; this is purely a test
    // affordance, not part of the contract.
    const lookup = options.db
      .prepare(
        `SELECT subtask_id, run_id FROM subtask_instances WHERE claim_token = ?`,
      )
      .get(data.claim) as
      | { subtask_id: string; run_id: string }
      | undefined;
    if (lookup === undefined) {
      throw new Error(
        `claim_token ${data.claim} did not resolve to a subtask_instance row`,
      );
    }
    runId = lookup.run_id;
    const subtaskId = lookup.subtask_id;
    claimed.push({ subtaskId, input: data.input });

    // Per-subtask: invoke the appropriate subcommands then submit.
    let result: unknown;
    switch (subtaskId) {
      case "pre-verify": {
        const verify = await taskTool(
          options.db,
          options.bearer,
          data.claim,
          "verify company",
          { website: "https://example.com" },
        );
        if (options.taskToolCalls !== undefined) {
          options.taskToolCalls.push(verify);
        }
        if (!verify.ok) {
          throw new Error(
            `task_tool('verify company') was not ok: ${JSON.stringify(verify.errors)}`,
          );
        }
        result = {
          verified: true,
          canonical_name: "Example, Inc.",
          canonical_website: "https://example.com",
        };
        break;
      }
      case "list-boards": {
        const probe = await taskTool(
          options.db,
          options.bearer,
          data.claim,
          "analyze hreflang",
          { website: "https://example.com" },
        );
        if (options.taskToolCalls !== undefined) {
          options.taskToolCalls.push(probe);
        }
        if (!probe.ok) {
          throw new Error(
            `task_tool('analyze hreflang') was not ok: ${JSON.stringify(probe.errors)}`,
          );
        }
        result = { boards: options.boards };
        break;
      }
      case "configure-board": {
        for (const sub of [
          ["probe monitor", { board_url: "x", expected_count: 10 }] as const,
          ["select monitor", { type: "rss", name: "cfg-1", config: {} }] as const,
          ["run monitor", { config: "cfg-1" }] as const,
          ["feedback", { verdict: "good", per_field: {} }] as const,
        ]) {
          const r = await taskTool(
            options.db,
            options.bearer,
            data.claim,
            sub[0],
            sub[1],
          );
          if (options.taskToolCalls !== undefined) {
            options.taskToolCalls.push(r);
          }
          if (!r.ok) {
            throw new Error(
              `task_tool('${sub[0]}') was not ok: ${JSON.stringify(r.errors)}`,
            );
          }
        }
        result = {
          outcome: "configured",
          monitor_type: "rss",
          monitor_config: { url: "https://example.com/rss" },
          verdict: "good",
        };
        break;
      }
      default:
        throw new Error(`scripted agent has no script for subtask ${subtaskId}`);
    }

    const submit = await submitResult(
      options.app,
      options.bearer,
      data.claim,
      result,
    );
    if (options.murmurCalls !== undefined) {
      options.murmurCalls.push(submit);
    }
    if (!submit.ok) {
      throw new Error(
        `submit_result for ${subtaskId} was not ok: ${JSON.stringify(submit.errors)}`,
      );
    }
  }

  throw new Error(
    "scripted agent ran for 32 iterations without exhausting the queue — likely a loop bug",
  );
}

/**
 * Issue `GET /work/next` against the in-process Murmur app. Returns
 * the parsed envelope verbatim.
 */
export async function pullTask(
  app: Hono,
  bearer: string,
): Promise<PullTaskResponse> {
  const response = await app.request("/work/next", {
    method: "GET",
    headers: { [AUTH_HEADER_NAME]: `Bearer ${bearer}` },
  });
  return (await response.json()) as PullTaskResponse;
}

/**
 * Issue `POST /work/{claim}/result` against the in-process Murmur app.
 */
export async function submitResult(
  app: Hono,
  bearer: string,
  claim: string,
  result: unknown,
  notes?: string,
): Promise<SubmitResultResponse> {
  const body: { result: unknown; notes?: string } = { result };
  if (notes !== undefined) body.notes = notes;
  const response = await app.request(
    `/work/${encodeURIComponent(claim)}/result`,
    {
      method: "POST",
      headers: {
        [AUTH_HEADER_NAME]: `Bearer ${bearer}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  return (await response.json()) as SubmitResultResponse;
}

/**
 * Invoke a `task_tool` subcommand against the dispatcher directly.
 * Production routes the same call through the MCP transport, but the
 * dispatcher itself is the seam under test by the cross-repo wire
 * contract — it is what emits the `Authorization` /
 * `X-Murmur-Subcommand` / `X-Murmur-Claim-Token` headers the integration
 * test asserts on against the mock-jobseek.
 */
export async function taskTool(
  db: Database.Database,
  bearer: string,
  claimToken: string,
  subcommand: string,
  args: unknown,
): Promise<TaskToolResponse> {
  return dispatchTaskTool({
    db,
    bearer,
    claimToken,
    subcommand,
    args,
  });
}
