/**
 * Public surface for the agent-facing HTTP routes (DESIGN.md §3.3).
 *
 * The factory `createAgentApp` builds the `/work` sub-app and is mounted
 * by `src/server.ts` when a database handle is supplied to `createServer`.
 * Tests build the same sub-app directly and exercise it via Hono's
 * `app.request(...)` without binding a port.
 *
 * @see src/api/agent/work.ts — route handlers and their atomicity comments
 */

import type { Hono } from "hono";

import {
  createWorkRoutes,
  type CreateWorkRoutesOptions,
} from "./work.js";

/**
 * Options for {@link createAgentApp}. Identical to {@link CreateWorkRoutesOptions}
 * for now — re-exported so `src/server.ts` can import a single type.
 */
export type CreateAgentAppOptions = CreateWorkRoutesOptions;

/**
 * Build the agent sub-app. Currently delegates to {@link createWorkRoutes};
 * additional agent-facing routes (e.g. M7's `task_tool` proxy) will mount
 * here as they land.
 */
export function createAgentApp(options: CreateAgentAppOptions): Hono {
  return createWorkRoutes(options);
}

export type {
  CasOkRow,
  ClaimedRow,
  NextWorkData,
  SubmitBody,
  SubmitOkData,
} from "./work.js";
