/**
 * Audit-log payload truncation for `task_tool` dispatch (DESIGN.md §3.6).
 *
 * `agent_actions.args_json` and `agent_actions.response_json` are capped
 * at 4 KB UTF-8 bytes. Truncation is silent — DESIGN.md §3.6 explicitly
 * cuts the per-field `_truncated` map for MVP. The single boolean
 * `agent_actions.truncated` column flags the row when EITHER field was
 * clipped, so the `GET /runs/{id}` consumer can flag the row in the UI.
 *
 * Why a separate file from `validation.ts`: the orchestrator note for
 * issue #12 instructs not to modify `validation.ts`. The truncation
 * helper is a dispatch-layer concern (the only consumer is the
 * `task_tool` audit row writer), so it lives next to the dispatcher.
 *
 * Why not import the `truncatePayload` helper at
 * `src/api/publisher/truncate.ts`: that helper has read-time semantics
 * (1 KB cap with a `…(truncated)` marker stitched onto the string), used
 * by `GET /runs/{id}` to keep audit polls scannable. The DB write-time
 * cap is 4 KB and the marker isn't part of the wire format. Keeping the
 * two helpers separate prevents a future tweak to the read-time helper
 * from accidentally changing what gets written to the DB.
 *
 * @see DESIGN.md §3.6 — Audit log payload truncation
 */

/**
 * Per-field byte cap on `agent_actions.args_json` and
 * `agent_actions.response_json`. UTF-8 bytes, not code points.
 */
export const AUDIT_PAYLOAD_LIMIT_BYTES = 4 * 1024;

/**
 * Result shape for {@link truncateForAudit}.
 *
 * - `text`: the (possibly clipped) JSON string, or `null` if input was `null`.
 * - `truncated`: `true` iff the input exceeded {@link AUDIT_PAYLOAD_LIMIT_BYTES}.
 */
export interface TruncatedAuditField {
  readonly text: string | null;
  readonly truncated: boolean;
}

/**
 * Truncate a JSON string field to {@link AUDIT_PAYLOAD_LIMIT_BYTES}
 * UTF-8 bytes for storage in the `agent_actions` table.
 *
 * Behaviour:
 *   - `null` input → `{ text: null, truncated: false }`. The DB columns
 *     are nullable; preserve nulls.
 *   - input within cap → returned unchanged, `truncated: false`.
 *   - input above cap → clipped on a UTF-8 boundary (never splits a
 *     multi-byte sequence; trailing partial bytes are dropped).
 *     `truncated: true`. NO marker is appended — DESIGN.md §3.6 says
 *     truncation is silent for MVP; the per-row `truncated` flag carries
 *     the signal.
 *
 * @param json - the candidate string from `JSON.stringify(value)` or
 *               `null` for "no value".
 * @returns the (possibly clipped) text and the truncated flag.
 */
export function truncateForAudit(json: string | null): TruncatedAuditField {
  throw new Error("not implemented");
}
