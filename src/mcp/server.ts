/**
 * MCP route mount — Streamable HTTP transport over Hono (DESIGN.md §3.4).
 *
 * The MCP TS SDK ships a `WebStandardStreamableHTTPServerTransport` that
 * accepts a Web-Standard `Request` and returns a Web-Standard `Response`.
 * Hono's `c.req.raw` is exactly that, so we wire the transport behind a
 * single `app.all('/', …)` handler. Bearer auth is enforced by the parent
 * app's `app.use('*', bearerAuth(…))` (mounted in `src/server.ts`); this
 * sub-app sees only authenticated requests.
 *
 * **Stateless mode.** We construct one fresh `McpServer` + transport per
 * request (`sessionIdGenerator: undefined`). For Murmur this is the right
 * choice:
 *
 *   - claims are bound to `claim_token`, not MCP session id (DESIGN.md
 *     §3.3) — the agent already passes `claim` explicitly to
 *     `task_tool` / `submit_result`, so we don't need session affinity;
 *   - it sidesteps the SDK's session-tracking memory model when the
 *     transport is exposed through Cloudflare Tunnel, which can rotate
 *     edges mid-stream;
 *   - reconnect is trivially handled — the next request rebuilds the
 *     server and re-runs `initialize`.
 *
 * **Keepalive.** The SDK's Streamable HTTP transport handles the SSE
 * keepalive heartbeat itself (per the 2025-03 spec); the underlying
 * `text/event-stream` response keeps comments flowing even when the
 * application has nothing to send. Murmur's deployment requirement of a
 * 25s keepalive (DESIGN.md §3.6) is met by the SDK's default cadence —
 * if that ever drifts we'd need to override it via the
 * `WebStandardStreamableHTTPServerTransport`'s options, but for the demo
 * the SDK's defaults are sufficient. Documented here so a future change
 * to the SDK is a known-known.
 *
 * **In-process delegation.** The three tool handlers call into M5's
 * `createAgentApp(...)` via `app.request(...)`. No extra HTTP socket;
 * the bearer header is forwarded so the agent sub-app's own auth
 * middleware re-validates as a defence-in-depth step.
 *
 * @see DESIGN.md §3.4 — MCP server (agent-facing)
 * @see src/api/agent — the wrapped HTTP routes
 * @see src/mcp/tools.ts — the tool registrations
 */

import { Hono } from "hono";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { registerMcpTools } from "./tools.js";

/**
 * Murmur server identity surfaced in the MCP `initialize` response.
 *
 * `name` is what the host displays in its tool catalog; `version` tracks
 * the demo milestone. Bumped when the protocol surface changes.
 */
export const MCP_SERVER_INFO = {
  name: "murmur",
  version: "0.1.0",
} as const;

/**
 * Options accepted by {@link createMcpRoute}.
 */
export interface CreateMcpRouteOptions {
  /**
   * The in-process agent Hono app (M5 — `src/api/agent`). Tool handlers
   * call this via `app.request(...)`. The factory does NOT take ownership;
   * callers are responsible for the underlying DB connection's lifecycle.
   *
   * Required: there is no MCP surface without the agent endpoints.
   */
  readonly agentApp: Hono;
}

/**
 * Build the Hono sub-app exposing Murmur's MCP transport.
 *
 * The returned app has a single route — `app.all('/', …)` — that hands
 * every method (POST / GET / DELETE) to a per-request stateless
 * Streamable HTTP transport. Mount it under `/mcp` in `src/server.ts`:
 *
 * ```ts
 * if (options.db !== undefined) {
 *   const agent = createAgentApp({ db: options.db });
 *   app.route('/work', agent);
 *   app.route('/mcp', createMcpRoute({ agentApp: agent }));
 * }
 * ```
 *
 * The factory is pure (no env reads, no socket creation) so it can be
 * exercised with `app.request('/mcp', …)` in unit tests.
 */
export function createMcpRoute(options: CreateMcpRouteOptions): Hono {
  const app = new Hono();

  app.all("/", async (c) => {
    // Build a fresh server + transport for this request. Stateless mode:
    // the SDK does not generate or validate session IDs, so reconnects
    // are trivially handled by the next request rebuilding the pair.
    const server = new McpServer(MCP_SERVER_INFO);
    registerMcpTools(server, { agentApp: options.agentApp });

    // Stateless mode: omit `sessionIdGenerator` entirely so the SDK does
    // not generate or validate session IDs. (We can't pass `undefined`
    // explicitly under TS's `exactOptionalPropertyTypes`.)
    const transport = new WebStandardStreamableHTTPServerTransport({});

    // Connect server → transport. Per the SDK's design the
    // `connect(...)` call attaches the server's onmessage handler to the
    // transport and is required before `handleRequest`.
    await server.connect(transport);

    // The SDK's `handleRequest` consumes the Web-Standard Request and
    // returns a Web-Standard Response. Hono's `c.req.raw` is the same
    // shape, so we hand it straight through.
    const response = await transport.handleRequest(c.req.raw);

    // Best-effort cleanup: in stateless mode the transport ties its
    // lifetime to the response stream; closing the server here is a
    // belt-and-braces step. We deliberately do NOT await this — the
    // response body may still be streaming and `close()` is safe to
    // schedule for after the body completes.
    void server.close().catch(() => {
      // Ignore — server.close() throws only if already closed, which
      // is harmless here.
    });

    return response;
  });

  return app;
}
