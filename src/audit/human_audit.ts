/**
 * Human-plane audit log writer (M2, issue #82).
 *
 * Records every action a human takes on Murmur — sign-in success /
 * failure, session refresh, role changes, HITL decisions (M3). Mirrors
 * `src/audit/publisher_audit.ts` but with a different vocabulary and
 * an `ip_address` / `user_agent` pair for forensics.
 *
 * Vocabulary is closed at the type level; the DB column has no CHECK
 * constraint so future actions can land without a migration.
 */

import type Database from "better-sqlite3";

/**
 * Closed v1 action vocabulary for `human_audit.action`.
 */
export type HumanAuditAction =
  | "sign_in_success"
  | "sign_in_oauth_failed"
  | "sign_in_no_membership"
  | "sign_in_disabled"
  | "session_refreshed"
  | "session_revoked"
  | "member_added"
  | "member_revoked"
  | "member_role_changed"
  | "hitl_decision";

/**
 * Inputs to {@link recordHumanAudit}.
 */
export interface RecordHumanAuditOptions {
  /** Authenticated user_id; NULL for pre-user sign-in failures. */
  readonly userId?: string | null;
  /** Publisher scope; NULL for user-global actions. */
  readonly publisherId?: string | null;
  /** What happened. Closed vocabulary. */
  readonly action: HumanAuditAction;
  /** Optional context object. Serialised verbatim; do NOT include secrets. */
  readonly payload?: Readonly<Record<string, unknown>>;
  /** Caller IP (best-effort — proxy chain may obscure). */
  readonly ipAddress?: string | null;
  /** Caller user-agent. */
  readonly userAgent?: string | null;
  /** Override now() for deterministic tests. */
  readonly nowFn?: () => string;
}

/**
 * Insert one row into `human_audit`. Throws on DB failure — caller
 * decides whether to swallow.
 */
export function recordHumanAudit(
  db: Database.Database,
  opts: RecordHumanAuditOptions,
): void {
  const ts = (opts.nowFn ?? defaultNowFn)();
  db.prepare(
    `INSERT INTO human_audit
       (user_id, publisher_id, action, payload_json, ip_address, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.userId ?? null,
    opts.publisherId ?? null,
    opts.action,
    opts.payload !== undefined ? JSON.stringify(opts.payload) : null,
    opts.ipAddress ?? null,
    opts.userAgent ?? null,
    ts,
  );
}

function defaultNowFn(): string {
  return new Date().toISOString();
}
