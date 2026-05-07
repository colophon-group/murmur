/**
 * `src/auth` — legacy bearer-auth barrel.
 *
 * Re-exports the legacy `bearerAuth(envToken)` factory consumed by
 * `src/server.ts` and the integration-test harness for the agent
 * surface (`/work`, `/mcp`). The M1 multi-tenant `publisherAuth(db)`
 * and the bootstrap-token gate `bootstrapAuth(token)` are NOT
 * re-exported here — every consumer imports them from the leaf path
 * directly so module-level dependencies stay explicit and ts-prune
 * doesn't flag the barrel as a dead-letter office.
 */

export { bearerAuth } from "./middleware.js";
