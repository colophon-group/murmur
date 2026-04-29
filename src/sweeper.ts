/**
 * Background claim-expiry sweeper (DESIGN.md §3.3, "background sweeper").
 *
 * The sweeper resets `subtask_instances` rows whose claim window has
 * lapsed (`status='claimed' AND expires_at <= now()`) back to
 * `claim_token=NULL, status='ready'` so they reappear in the
 * `GET /work/next` claim queue. Each reset writes one row to
 * `agent_actions` with `kind='claim_expired'` so operators can see why
 * a claim was returned to the pool.
 *
 * Behaviour invariants enforced by tests:
 *
 *   - **Periodic, no HTTP coupling.** The sweeper runs on `setInterval`
 *     (default 30s) so it ticks even when no agent traffic is hitting
 *     the server.
 *   - **Single-flight.** If a sweep is still in progress when the
 *     interval fires, the next tick is skipped (NOT queued). Prevents
 *     a slow DB from compounding sweeps.
 *   - **Atomic.** Reset + audit inserts run inside `BEGIN IMMEDIATE`
 *     so a crash mid-sweep cannot reset a row without recording it
 *     (or vice versa).
 *   - **Status-scoped.** Only `status='claimed'` rows are touched.
 *     `done`/`ready`/`pending`/`skipped`/`failed` rows are inert to
 *     the sweeper, even if they have stale `expires_at`.
 *   - **Strict TTL.** `expires_at <= now` is "expired" — the
 *     `<=` is intentional. The CAS path in M5 uses `expires_at > now`,
 *     so the boundary is consistent: a claim with `expires_at = now`
 *     is rejected by submit and reset by the sweeper.
 *
 * Lifecycle: started by `src/index.ts` at boot, stopped on graceful
 * shutdown. NOT mounted by `createServer` — keeping the server
 * factory free of background timers preserves test isolation
 * (`createServer` callers don't get unwanted timers).
 *
 * @see DESIGN.md §3.3 — claim semantics
 */

import type Database from "better-sqlite3";

/**
 * Default sweep cadence: 30 seconds (DESIGN.md §3.3, "every 30s").
 *
 * Tests override this to small values (e.g. 10ms) so the
 * setInterval-driven contract is exercisable without waiting.
 */
export const DEFAULT_SWEEP_INTERVAL_MS = 30_000;

/**
 * Options accepted by {@link ClaimSweeper}.
 */
export interface ClaimSweeperOptions {
  /** Open better-sqlite3 connection. The sweeper does not own its lifecycle. */
  readonly db: Database.Database;
  /**
   * Override the sweep interval in milliseconds. Default
   * {@link DEFAULT_SWEEP_INTERVAL_MS}. Tests use small values
   * (e.g. 10ms) with fake timers.
   */
  readonly intervalMs?: number;
  /**
   * Override the now-clock used for expiry comparison. Default
   * `() => new Date().toISOString()`. Tests inject a deterministic
   * clock so they can assert exact reset behaviour.
   */
  readonly nowFn?: () => string;
}

/**
 * Outcome of a single sweep tick.
 *
 *   - `resetCount`: how many rows were transitioned `claimed → ready`.
 *   - `skipped`: `true` iff this tick was suppressed by the
 *     single-flight gate (a previous tick was still running).
 */
export interface SweepResult {
  readonly resetCount: number;
  readonly skipped: boolean;
}

/**
 * Background sweeper. Construct, call `start()` to begin ticking,
 * `stop()` to halt. `runOnce()` exists for tests and for the
 * single-flight verification — it runs one sweep on the calling
 * thread (synchronous, since better-sqlite3 is sync) and returns
 * immediately.
 */
export class ClaimSweeper {
  private readonly db: Database.Database;
  private readonly intervalMs: number;
  private readonly nowFn: () => string;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight = false;

  /**
   * Build a sweeper. `db` and `nowFn` are the only fields used by
   * `runOnce()`; `intervalMs` only matters once `start()` is called.
   */
  constructor(options: ClaimSweeperOptions) {
    this.db = options.db;
    this.intervalMs = options.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.nowFn = options.nowFn ?? defaultNowFn;
  }

  /**
   * Begin periodic sweeping. Idempotent: a second `start()` while
   * already running is a no-op (tests rely on this so a re-spawn
   * doesn't double-tick).
   *
   * The interval timer is `unref()`ed so a pending tick never blocks
   * process exit — graceful shutdown should still call `stop()`,
   * but a forced exit won't hang on us.
   */
  start(): void {
    if (this.timer !== undefined) {
      return;
    }
    this.timer = setInterval(() => {
      this.runOnce();
    }, this.intervalMs);
    if (
      typeof (this.timer as unknown as { unref?: () => void }).unref ===
      "function"
    ) {
      (this.timer as unknown as { unref: () => void }).unref();
    }
  }

  /**
   * Halt periodic sweeping. Idempotent: calling `stop()` when not
   * running is a no-op. After `stop()`, `start()` may be called
   * again to resume.
   */
  stop(): void {
    if (this.timer === undefined) {
      return;
    }
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Run one sweep on the current thread.
   *
   * Single-flight: if `inFlight` is already set (i.e. a previous
   * `runOnce` is still executing on the call stack — possible only
   * via re-entrant timer firing during a long synchronous DB call),
   * returns `{ resetCount: 0, skipped: true }` immediately without
   * touching the DB.
   *
   * @returns `{ resetCount, skipped }`. `skipped: true` means this
   *   tick was a no-op due to the single-flight gate. `resetCount`
   *   is the number of rows transitioned from `claimed` to `ready`.
   */
  runOnce(): SweepResult {
    if (this.inFlight) {
      return { resetCount: 0, skipped: true };
    }
    this.inFlight = true;
    try {
      const now = this.nowFn();
      return sweepOnce(this.db, now);
    } finally {
      this.inFlight = false;
    }
  }
}

/**
 * SQL: reset every expired claim. `RETURNING id` lets us record one
 * audit row per reset without re-querying.
 *
 * Bound parameters (in order):
 *   1. updated_at (TEXT, RFC 3339 UTC; same `now` value used in step 3)
 *   2. now_iso    (TEXT, RFC 3339 UTC; the threshold for `expires_at`)
 */
const RESET_EXPIRED_SQL = `
  UPDATE subtask_instances
     SET claim_token = NULL,
         status      = 'ready',
         expires_at  = NULL,
         updated_at  = ?
   WHERE status      = 'claimed'
     AND expires_at <= ?
  RETURNING id
`;

/**
 * SQL: insert one `agent_actions` row per reset. `kind='claim_expired'`
 * marks it as a sweeper-driven event (vs. agent-driven `claim` /
 * `submit_result` / `task_tool` rows).
 *
 * Bound parameters:
 *   1. instance_id (TEXT)
 *   2. ts          (TEXT, same `now` used by the UPDATE)
 */
const INSERT_EXPIRED_AUDIT_SQL = `
  INSERT INTO agent_actions
    (instance_id, ts, kind, subcommand, args_json, response_json, truncated)
  VALUES (?, ?, 'claim_expired', NULL, NULL, NULL, 0)
`;

/**
 * Run one sweep against `db` using `now` as the expiry threshold.
 *
 * Wraps the UPDATE + audit INSERTs in `BEGIN IMMEDIATE` so a crash
 * cannot leave the DB with a reset row but no audit, or vice versa.
 *
 * Exported for tests so they can drive a single sweep on a synthetic
 * `now` without going through the `ClaimSweeper` lifecycle.
 *
 * @returns `{ resetCount, skipped: false }`. The function is the
 *   inner half of the single-flight gate; it itself does not skip.
 */
export function sweepOnce(
  db: Database.Database,
  now: string,
): SweepResult {
  const update = db.prepare(RESET_EXPIRED_SQL);
  const insertAudit = db.prepare(INSERT_EXPIRED_AUDIT_SQL);

  db.exec("BEGIN IMMEDIATE");
  let resetCount = 0;
  try {
    const rows = update.all(now, now) as ReadonlyArray<{ id: string }>;
    for (const row of rows) {
      insertAudit.run(row.id, now);
      resetCount += 1;
    }
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Suppress rollback failures so the original error surfaces.
    }
    throw err;
  }
  return { resetCount, skipped: false };
}

function defaultNowFn(): string {
  return new Date().toISOString();
}
