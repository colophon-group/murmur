/**
 * HTTP header name constants used across the Murmur ↔ jobseek boundary.
 *
 * **Casing is locked.** Both sides MUST emit and accept these exact strings.
 * HTTP header names are case-insensitive on the wire, but the constants
 * are the single source of truth for tests, docs, and code generators.
 *
 * @see docs/contracts.md §3 — Proxy header set
 * @see docs/contracts.md §6 — Webhook contract
 */

/**
 * `Authorization: Bearer <MURMUR_TOKEN>` — gates every Murmur endpoint
 * (publisher API + MCP transport) and every webhook delivered by Murmur
 * to a publisher.
 *
 * Format on the wire: `Bearer ` + the opaque MURMUR_TOKEN value.
 */
export const AUTHORIZATION = "Authorization";

/**
 * `X-Murmur-Subcommand: <name>` — set by Murmur on every proxied
 * `task_tool` call. Value is the subcommand name as declared in the
 * pipeline def (e.g. `"probe monitor"`, `"select scraper"`).
 */
export const X_MURMUR_SUBCOMMAND = "X-Murmur-Subcommand";

/**
 * `X-Murmur-Claim-Token: <claim_token>` — set by Murmur on every proxied
 * `task_tool` call. Publishers use this as the canonical session key for
 * claim-scoped state (probe → select → run → feedback flows).
 *
 * The publisher MUST treat this header (NOT the agent's MCP session ID)
 * as the session key. See DESIGN.md §3.3.
 */
export const X_MURMUR_CLAIM_TOKEN = "X-Murmur-Claim-Token";

/**
 * `Idempotency-Key: <run_id>` — set by Murmur on webhook POSTs to the
 * publisher's accept handler. Publishers MUST dedupe on this key; treat
 * already-applied keys as 2xx (idempotent success).
 *
 * Dedupe window: the publisher's writer-side UNIQUE constraint on its
 * catalog table is the durable boundary. Murmur retries once on non-2xx
 * after 30 seconds (DESIGN.md §3.6).
 */
export const IDEMPOTENCY_KEY = "Idempotency-Key";

/**
 * `X-Murmur-Signature: t=<unix>,v1=<hex>` — set by Murmur on every webhook
 * delivery (M1, issue #81). The publisher's accept handler verifies the
 * signature against its `webhook_signing_secret`.
 *
 * **Wire format.** Two comma-separated key=value pairs:
 *
 *   - `t=<unix-seconds>` — Murmur's wall-clock at sign time. Publishers
 *     enforce a freshness window (recommended: ≤300 s) to bound replay.
 *   - `v1=<hex-lowercase>` — HMAC-SHA256 over the UTF-8 bytes of
 *     `<unix-seconds>.<body>` (literal dot separator). Hex-encoded
 *     lowercase, 64 chars.
 *
 * Replay protection is "valid signature" + "fresh timestamp" + "unseen
 * `Idempotency-Key`". Publishers MUST persist applied keys for at least
 * `freshness_window + retry_delay` (Murmur retries once after 30 s, so
 * 6 minutes total is the minimum safe persistence).
 *
 * The `v1` prefix is the signature scheme version, NOT the API version.
 * A future `v2` (e.g. KDF change, key-binding) would coexist on the same
 * header as a second comma-separated pair.
 */
export const X_MURMUR_SIGNATURE = "X-Murmur-Signature";

/**
 * Bundled namespace export for ergonomic consumption:
 *   `import { MurmurHeaders } from "@murmur/contracts-types";`
 *   `headers[MurmurHeaders.X_MURMUR_SUBCOMMAND] = "probe monitor";`
 */
export const MurmurHeaders = {
  AUTHORIZATION,
  X_MURMUR_SUBCOMMAND,
  X_MURMUR_CLAIM_TOKEN,
  IDEMPOTENCY_KEY,
  X_MURMUR_SIGNATURE,
} as const;

/**
 * Literal union of every header name in the bundle. Useful for typed
 * record keys.
 */
export type MurmurHeaderName = (typeof MurmurHeaders)[keyof typeof MurmurHeaders];
