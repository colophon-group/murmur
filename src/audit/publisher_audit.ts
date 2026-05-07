/**
 * Publisher audit log writer (M1, issue #81).
 *
 * One thin helper that INSERTs a row into `publisher_audit_events`.
 * Centralised so the schema column list lives in exactly one place; the
 * admin API, bootstrap handler, and (future) PATCH paths all call this.
 *
 * **What's an audit-worthy event.** Machine-plane admin actions:
 * publisher_created, publisher_updated, token_minted, token_rotated,
 * token_revoked, secret_rotated, bootstrap_invoked. NOT every
 * authenticated request — `last_used_at` is deliberately not tracked
 * (writer-lock concern; see `src/auth/publisher_auth.ts` jsdoc).
 *
 * **Vocabulary discipline.** `action` is a free string in the schema
 * (no CHECK constraint) but {@link PublisherAuditAction} pins the v1
 * vocabulary. Adding a kind requires extending the union; the schema
 * stays open for future kinds.
 *
 * @see src/db/schema.md — `publisher_audit_events` columns
 * @see DESIGN.md §3.6 — auth model
 * @see docs/auth.md — operator-facing audit semantics
 */

import type Database from "better-sqlite3";

/**
 * Closed v1 action vocabulary for `publisher_audit_events.action`.
 * Adding a new kind: extend the union, add it here, document in
 * `docs/auth.md`. The DB column has no CHECK constraint so older
 * deployments tolerate writers from newer code without a migration.
 */
export type PublisherAuditAction =
  | "publisher_created"
  | "publisher_updated"
  | "token_minted"
  | "token_rotated"
  | "token_revoked"
  | "secret_rotated"
  | "secret_revoked"
  | "bootstrap_invoked";

/**
 * Closed v1 vocabulary for the `token_kind` column. Mirrors `TokenKind`
 * + secret kinds + a sentinel for actions that target the publisher row
 * itself (no kind).
 */
export type AuditTokenKind =
  | "admin"
  | "runner"
  | "webhook_signing"
  | "subcommand_bearer";

/**
 * Inputs to {@link recordPublisherAudit}.
 */
export interface RecordPublisherAuditOptions {
  /** Publisher this action affected. */
  readonly publisherId: string;
  /** What happened (closed vocabulary). */
  readonly action: PublisherAuditAction;
  /** Token kind operated on, if applicable. NULL when the action targets the publisher row itself. */
  readonly tokenKind?: AuditTokenKind;
  /** Human-plane actor user id (M2). NULL for machine-plane / system actions. */
  readonly actorUserId?: string;
  /** Optional JSON-able context object. Serialised verbatim; do NOT include secret values. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Override `now()` for deterministic tests. */
  readonly nowFn?: () => string;
}

/**
 * Insert one row into `publisher_audit_events`.
 *
 * The function is fire-and-forget at the call site — failures throw
 * (caller decides whether to swallow or propagate). For most admin
 * paths we want failures to propagate so a buggy audit write surfaces
 * via 500 rather than silently dropping records.
 *
 * @param db open `better-sqlite3` connection. Caller owns the lifecycle.
 * @param opts see {@link RecordPublisherAuditOptions}.
 */
export function recordPublisherAudit(
  db: Database.Database,
  opts: RecordPublisherAuditOptions,
): void {
  const ts = (opts.nowFn ?? defaultNowFn)();
  const metadataJson =
    opts.metadata !== undefined ? JSON.stringify(opts.metadata) : null;

  db.prepare(
    `INSERT INTO publisher_audit_events
       (publisher_id, ts, action, token_kind, actor_user_id, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.publisherId,
    ts,
    opts.action,
    opts.tokenKind ?? null,
    opts.actorUserId ?? null,
    metadataJson,
  );
}

/**
 * Read recent audit events for a publisher, newest first. Used by
 * `GET /publishers/me/audit`.
 *
 * @param db open `better-sqlite3` connection.
 * @param publisherId scope the read to this publisher.
 * @param limit cap the result set. Hard ceiling 200 — beyond that,
 *   operators paginate (M2 introduces a cursor).
 * @returns the rows, newest-first by `ts` then `id`.
 */
export function readPublisherAudit(
  db: Database.Database,
  publisherId: string,
  limit = 50,
): ReadonlyArray<PublisherAuditRow> {
  const cap = Math.min(Math.max(1, limit), 200);
  const rows = db
    .prepare(
      `SELECT id, publisher_id, ts, action, token_kind, actor_user_id, metadata_json
         FROM publisher_audit_events
        WHERE publisher_id = ?
        ORDER BY ts DESC, id DESC
        LIMIT ?`,
    )
    .all(publisherId, cap) as ReadonlyArray<PublisherAuditRow>;
  return rows;
}

/**
 * Shape returned by {@link readPublisherAudit}. Mirrors the column list.
 */
export interface PublisherAuditRow {
  readonly id: number;
  readonly publisher_id: string;
  readonly ts: string;
  readonly action: string;
  readonly token_kind: string | null;
  readonly actor_user_id: string | null;
  readonly metadata_json: string | null;
}

function defaultNowFn(): string {
  return new Date().toISOString();
}
