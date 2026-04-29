/**
 * Payload truncation helper for `GET /runs/{run_id}`.
 *
 * Each `agent_actions` row carries `args_json` and `response_json` columns.
 * For the publisher-facing audit trail we cap each field at
 * {@link AGENT_ACTION_PAYLOAD_CAP_BYTES} bytes; oversize values are
 * clipped and a `…(truncated)` marker is appended so the consumer can
 * distinguish a clipped value from a value that happens to end at the
 * cap. The cap is per-field, not per-row, matching DESIGN.md §3.6's
 * audit-log payload truncation guidance.
 *
 * The unit is BYTES (UTF-8 length), not code points — JSON consumers
 * compare lengths in bytes, and a code-point cap would let four-byte
 * graphemes blow past the intended limit.
 *
 * @see DESIGN.md §3.6 — Audit log payload truncation
 */

/**
 * Per-payload byte cap used when serializing `agent_actions[*].args_json`
 * and `agent_actions[*].response_json` in `GET /runs/{run_id}`. The DB
 * already truncates writes to 4 KB (per §3.6); the read-time cap is
 * smaller (1 KB) so large audit trails stay scannable in a poll.
 */
export const AGENT_ACTION_PAYLOAD_CAP_BYTES = 1024;

/**
 * Marker appended to a truncated payload so callers can detect clipping.
 * Stable wire-format token — do not change without coordinating with
 * publisher-side log viewers.
 */
export const TRUNCATION_MARKER = "…(truncated)";

/**
 * Result of {@link truncatePayload}.
 *
 * - `text`: the (possibly clipped) string, or `null` if the input was `null`.
 * - `truncated`: `true` if and only if the input exceeded `capBytes`.
 */
export interface TruncatedPayload {
  readonly text: string | null;
  readonly truncated: boolean;
}

/**
 * Truncate a JSON-bearing string field to `capBytes` UTF-8 bytes,
 * appending {@link TRUNCATION_MARKER} when clipping occurred.
 *
 * Behaviour:
 *   - `null` input → `{ text: null, truncated: false }`. The DB column
 *     allows NULL for `args_json`/`response_json`; preserve it.
 *   - input within cap → returned unchanged, `truncated: false`.
 *   - input above cap → clipped to `capBytes` bytes (UTF-8 safe — never
 *     splits a multi-byte sequence) and the marker is appended.
 *     `truncated: true`.
 *
 * @param json the payload string from the DB (or `null`).
 * @param capBytes the maximum size in bytes; must be ≥ marker length.
 * @returns the (possibly clipped) text and a flag.
 */
export function truncatePayload(
  json: string | null,
  capBytes: number,
): TruncatedPayload {
  if (json === null) {
    return { text: null, truncated: false };
  }

  // Fast path: most rows are within cap. Use Buffer.byteLength to count
  // UTF-8 bytes without allocating an intermediate buffer.
  const byteLen = Buffer.byteLength(json, "utf8");
  if (byteLen <= capBytes) {
    return { text: json, truncated: false };
  }

  // Slow path: clip to exactly `capBytes` bytes, never splitting a
  // multi-byte UTF-8 sequence. We construct a Buffer view and decode
  // with `TextDecoder({ fatal: false })`; the decoder will replace a
  // dangling continuation byte with U+FFFD, but we want to drop trailing
  // partial sequences entirely. Easiest way: decode permissively, then
  // strip any trailing replacement char.
  const buf = Buffer.from(json, "utf8");
  const slice = buf.subarray(0, capBytes);
  // `TextDecoder` with `fatal: false` is the default; trailing partials
  // become U+FFFD. Trim them off.
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(slice);
  const cleaned = decoded.replace(/�+$/u, "");
  return { text: `${cleaned}${TRUNCATION_MARKER}`, truncated: true };
}
