/**
 * Prepared-statement SQL for the agent claim/CAS endpoints (DESIGN.md §3.3).
 *
 * Two atomic single-statement updates form the contract:
 *
 *   1. **Claim** (`/work/next`). Picks the oldest `ready` subtask whose
 *      `claim_token` is NULL, marks it `claimed`, and returns it — all in
 *      one `UPDATE … RETURNING` round-trip wrapped in `BEGIN IMMEDIATE`.
 *      The subselect's `LIMIT 1` is the only row touched; the partial
 *      unique index on `claim_token` guarantees a token cannot be reused
 *      across rows even under a hypothetical inner-engine race.
 *
 *   2. **CAS submit** (`/work/{claim_token}/result`). Atomically transitions
 *      a row from `claimed` → `done` only if `(claim_token, status='claimed',
 *      expires_at > now)` still holds. Failure means the claim was lost
 *      (TTL expired, swept, or already submitted) and the agent's payload
 *      is discarded with `claim_lost`.
 *
 * Why each clause matters in CLAIM_SQL:
 *   - `WHERE id = (SELECT id … LIMIT 1)` — the subselect pins the row by
 *     primary key BEFORE the UPDATE runs, so the UPDATE never has to scan
 *     `subtask_instances` itself. The selector uses
 *     `(status='ready', created_at)` which matches `idx_subtask_instances_ready`.
 *   - `claim_token IS NULL AND status='ready'` — `ready` rows that are not
 *     currently claimed. Expired claims are reset back to `ready` by the
 *     sweeper (DESIGN.md §3.3) before they re-appear here.
 *   - `ORDER BY created_at LIMIT 1` — FIFO across the ready pool.
 *     `created_at` is indexed in the same composite index as `status`.
 *   - `RETURNING …` — single round-trip; we read the row we just claimed.
 *     Inside `BEGIN IMMEDIATE`, this is atomic against any other writer.
 *
 * Why each clause matters in CAS_SQL:
 *   - `claim_token = ?` — pin the exact row by the agent's token. The
 *     partial unique index makes this an O(1) lookup.
 *   - `status = 'claimed'` — refuse to double-submit (the row is already
 *     `done` if a previous submit landed) or to submit against a
 *     swept-back-to-`ready` row.
 *   - `expires_at > ?` — refuse to submit after the TTL elapsed; the
 *     sweeper may not have run yet, but the contract is "expired claims
 *     are dead". Comparison uses lexicographic ordering on RFC 3339 UTC
 *     strings, which is correct iff the format is canonicalised
 *     (Z-suffixed, no offset, millisecond precision). Callers MUST format
 *     `now` consistently with the column writer (see `nowIso()` in
 *     `src/api/agent/work.ts`).
 *   - `RETURNING id, run_id, subtask_id` — non-empty result set is the
 *     CAS-success signal. `claim_token=NULL` after the UPDATE so the
 *     partial unique index keeps allowing inserts (and stops surfacing
 *     this row in subsequent claim queries).
 *
 * @see DESIGN.md §3.3 — atomic claim CAS rationale
 * @see src/db/schema.md — `subtask_instances` columns
 */

/**
 * Atomic claim. Inside `BEGIN IMMEDIATE`. Bound parameters:
 *   1. claim_token (TEXT, fresh, opaque, NOT NULL)
 *   2. expires_at  (TEXT, RFC 3339 UTC; now + ttlMs)
 *   3. updated_at  (TEXT, RFC 3339 UTC; now)
 *
 * Returns at most one row with the freshly-claimed instance, or zero rows
 * if no `ready` subtask exists.
 */
export const CLAIM_SQL = `
UPDATE subtask_instances
   SET claim_token = ?,
       expires_at  = ?,
       status      = 'claimed',
       updated_at  = ?
 WHERE id = (
   SELECT id FROM subtask_instances
    WHERE claim_token IS NULL AND status = 'ready'
    ORDER BY created_at LIMIT 1
 )
RETURNING id, run_id, subtask_id, input_json, claim_token, expires_at
`;

/**
 * Atomic CAS submit. Bound parameters:
 *   1. updated_at  (TEXT, RFC 3339 UTC; now)
 *   2. claim_token (TEXT, the agent-supplied token)
 *   3. now_iso     (TEXT, RFC 3339 UTC; same `now` used for `updated_at`)
 *
 * Returns at most one row identifying the run/subtask if the CAS succeeded,
 * or zero rows if the claim was lost (token unknown, expired, already done,
 * or status was reset by the sweeper).
 */
export const CAS_SQL = `
UPDATE subtask_instances
   SET status      = 'done',
       updated_at  = ?,
       claim_token = NULL,
       expires_at  = NULL
 WHERE claim_token = ?
   AND status      = 'claimed'
   AND expires_at  > ?
RETURNING id, run_id, subtask_id
`;

/**
 * Insert one `subtask_results` row. Bound parameters:
 *   1. instance_id  (TEXT, PK; the claim's `subtask_instances.id`)
 *   2. output_json  (TEXT, the validated result payload as JSON string)
 *   3. submitted_at (TEXT, RFC 3339 UTC; now)
 *
 * `notes` is intentionally NOT written here — DESIGN.md §3.1 (last
 * bullet) and issue #10 both require `notes` to live in `agent_actions`
 * only, not in the schema-validated result.
 */
export const INSERT_RESULT_SQL = `
INSERT INTO subtask_results (instance_id, output_json, submitted_at)
VALUES (?, ?, ?)
`;

/**
 * Insert one `agent_actions` audit row. Bound parameters:
 *   1. instance_id   (TEXT)
 *   2. ts            (TEXT, RFC 3339 UTC; now)
 *   3. kind          (TEXT, one of 'claim' | 'submit_result' | 'claim_lost' …)
 *   4. subcommand    (TEXT | NULL)
 *   5. args_json     (TEXT | NULL, ≤4 KB per §3.6 truncation rule — the
 *                     truncation itself is the caller's responsibility)
 *   6. response_json (TEXT | NULL, ≤4 KB)
 *   7. truncated     (INTEGER, 0 or 1)
 */
export const INSERT_AGENT_ACTION_SQL = `
INSERT INTO agent_actions
  (instance_id, ts, kind, subcommand, args_json, response_json, truncated)
VALUES (?, ?, ?, ?, ?, ?, ?)
`;
