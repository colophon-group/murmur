/**
 * Tests for `src/sweeper.ts` — the background claim-expiry sweeper
 * (DESIGN.md §3.3, "background sweeper").
 *
 * Verification bullets are taken verbatim from issue #17. Every named
 * bullet has a corresponding `it()` here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type Database from "better-sqlite3";

import { openDb } from "./db/index.js";
import { runMigrations } from "./db/migrate.js";
import {
  ClaimSweeper,
  DEFAULT_SWEEP_INTERVAL_MS,
  sweepOnce,
} from "./sweeper.js";

/* ---------------- Test harness ---------------- */

interface SweeperHarness {
  readonly db: Database.Database;
  /** Insert a run + a claimed subtask_instance row with the given expires_at. */
  seedClaimed(opts: {
    instanceId: string;
    runId?: string;
    expiresAt: string;
    createdAt?: string;
    status?: string;
  }): void;
  /** Read a single row's status + claim_token + expires_at by id. */
  readRow(instanceId: string): {
    status: string;
    claim_token: string | null;
    expires_at: string | null;
  };
  /** Read all `agent_actions` rows for a given instance, oldest first. */
  readActions(instanceId: string): ReadonlyArray<{
    kind: string;
    ts: string;
    args_json: string | null;
    response_json: string | null;
  }>;
}

const PIPELINE_ID = "test-pipeline";

function makeHarness(): SweeperHarness {
  const db = openDb(":memory:");
  runMigrations(db);

  // Seed pipeline + run rows so subtask_instances FKs are satisfied.
  const now = "2026-04-29T12:00:00.000Z";
  db.prepare(
    `INSERT INTO pipelines (id, version, def_json, created_at, updated_at)
     VALUES (?, 1, '{}', ?, ?)`,
  ).run(PIPELINE_ID, now, now);

  const runs = new Set<string>();

  return {
    db,
    seedClaimed(opts) {
      const runId = opts.runId ?? "run-default";
      if (!runs.has(runId)) {
        db.prepare(
          `INSERT INTO runs
             (id, pipeline_id, pipeline_version, status, initial_input_json,
              webhook_url, created_at)
           VALUES (?, ?, 1, 'running', '{}', 'https://example.test/webhook', ?)`,
        ).run(runId, PIPELINE_ID, now);
        runs.add(runId);
      }
      const status = opts.status ?? "claimed";
      const created = opts.createdAt ?? now;
      const claimToken = status === "claimed" ? `tok_${opts.instanceId}` : null;
      db.prepare(
        `INSERT INTO subtask_instances
           (id, run_id, subtask_id, status, claim_token, expires_at,
            input_json, created_at, updated_at)
         VALUES (?, ?, 'subtask-x', ?, ?, ?, '{}', ?, ?)`,
      ).run(
        opts.instanceId,
        runId,
        status,
        claimToken,
        opts.expiresAt,
        created,
        created,
      );
    },
    readRow(instanceId) {
      const row = db
        .prepare(
          `SELECT status, claim_token, expires_at
             FROM subtask_instances WHERE id = ?`,
        )
        .get(instanceId) as
        | { status: string; claim_token: string | null; expires_at: string | null }
        | undefined;
      if (row === undefined) {
        throw new Error(`row not found: ${instanceId}`);
      }
      return row;
    },
    readActions(instanceId) {
      return db
        .prepare(
          `SELECT kind, ts, args_json, response_json
             FROM agent_actions WHERE instance_id = ? ORDER BY id ASC`,
        )
        .all(instanceId) as ReadonlyArray<{
        kind: string;
        ts: string;
        args_json: string | null;
        response_json: string | null;
      }>;
    },
  };
}

/* ---------------- runOnce contract ---------------- */

describe("ClaimSweeper.runOnce", () => {
  it("resets a claim with TTL=100ms after fake-timer advance to status=ready, claim_token=NULL", () => {
    const h = makeHarness();
    try {
      // expires_at is exactly t0 + 100ms; "now" is t0 + 200ms → expired.
      h.seedClaimed({
        instanceId: "i-1",
        expiresAt: "2026-04-29T12:00:00.100Z",
      });

      const sweeper = new ClaimSweeper({
        db: h.db,
        nowFn: () => "2026-04-29T12:00:00.200Z",
      });
      const result = sweeper.runOnce();

      expect(result.skipped).toBe(false);
      expect(result.resetCount).toBe(1);
      const row = h.readRow("i-1");
      expect(row.status).toBe("ready");
      expect(row.claim_token).toBeNull();
      expect(row.expires_at).toBeNull();
    } finally {
      h.db.close();
    }
  });

  it("does not touch unexpired claims", () => {
    const h = makeHarness();
    try {
      // expires_at well in the future relative to `now`.
      h.seedClaimed({
        instanceId: "i-fresh",
        expiresAt: "2026-04-29T13:00:00.000Z",
      });

      const sweeper = new ClaimSweeper({
        db: h.db,
        nowFn: () => "2026-04-29T12:00:00.000Z",
      });
      const result = sweeper.runOnce();

      expect(result.resetCount).toBe(0);
      const row = h.readRow("i-fresh");
      expect(row.status).toBe("claimed");
      expect(row.claim_token).toBe("tok_i-fresh");
      expect(row.expires_at).toBe("2026-04-29T13:00:00.000Z");
    } finally {
      h.db.close();
    }
  });

  it("does not touch claims with status='done' (even if expires_at < now)", () => {
    const h = makeHarness();
    try {
      // A `done` row could have a stale expires_at from before submit
      // cleared it — confirm sweeper's status guard ignores such rows.
      // We bypass the seedClaimed status guard so claim_token is NULL,
      // which is the realistic shape of a done row post-CAS.
      h.db
        .prepare(
          `INSERT INTO runs
             (id, pipeline_id, pipeline_version, status, initial_input_json,
              webhook_url, created_at)
           VALUES ('run-done', ?, 1, 'running', '{}', 'https://example.test/webhook', ?)`,
        )
        .run(PIPELINE_ID, "2026-04-29T12:00:00.000Z");
      h.db
        .prepare(
          `INSERT INTO subtask_instances
             (id, run_id, subtask_id, status, claim_token, expires_at,
              input_json, created_at, updated_at)
           VALUES ('i-done', 'run-done', 'sx', 'done', NULL,
                   '2026-04-29T11:00:00.000Z', '{}',
                   '2026-04-29T11:00:00.000Z', '2026-04-29T11:30:00.000Z')`,
        )
        .run();

      const sweeper = new ClaimSweeper({
        db: h.db,
        nowFn: () => "2026-04-29T12:00:00.000Z",
      });
      const result = sweeper.runOnce();

      expect(result.resetCount).toBe(0);
      const row = h.readRow("i-done");
      expect(row.status).toBe("done");
    } finally {
      h.db.close();
    }
  });

  it("resets multiple expired claims in one sweep", () => {
    const h = makeHarness();
    try {
      h.seedClaimed({
        instanceId: "i-a",
        expiresAt: "2026-04-29T12:00:00.000Z",
      });
      h.seedClaimed({
        instanceId: "i-b",
        expiresAt: "2026-04-29T11:00:00.000Z",
      });
      h.seedClaimed({
        instanceId: "i-c",
        expiresAt: "2026-04-29T10:00:00.000Z",
      });
      // One that is NOT expired, to confirm it is left alone.
      h.seedClaimed({
        instanceId: "i-fresh",
        expiresAt: "2026-04-29T14:00:00.000Z",
      });

      const sweeper = new ClaimSweeper({
        db: h.db,
        nowFn: () => "2026-04-29T13:00:00.000Z",
      });
      const result = sweeper.runOnce();

      expect(result.resetCount).toBe(3);
      for (const id of ["i-a", "i-b", "i-c"]) {
        const row = h.readRow(id);
        expect(row.status).toBe("ready");
        expect(row.claim_token).toBeNull();
      }
      // The fresh row must remain claimed.
      expect(h.readRow("i-fresh").status).toBe("claimed");
    } finally {
      h.db.close();
    }
  });

  it("writes one agent_actions row per reset with kind='claim_expired'", () => {
    const h = makeHarness();
    try {
      h.seedClaimed({
        instanceId: "i-1",
        expiresAt: "2026-04-29T11:00:00.000Z",
      });
      h.seedClaimed({
        instanceId: "i-2",
        expiresAt: "2026-04-29T11:30:00.000Z",
      });

      const sweeper = new ClaimSweeper({
        db: h.db,
        nowFn: () => "2026-04-29T12:00:00.000Z",
      });
      const result = sweeper.runOnce();
      expect(result.resetCount).toBe(2);

      const a1 = h.readActions("i-1");
      expect(a1.length).toBe(1);
      expect(a1[0]?.kind).toBe("claim_expired");
      expect(a1[0]?.ts).toBe("2026-04-29T12:00:00.000Z");
      expect(a1[0]?.args_json).toBeNull();
      expect(a1[0]?.response_json).toBeNull();

      const a2 = h.readActions("i-2");
      expect(a2.length).toBe(1);
      expect(a2[0]?.kind).toBe("claim_expired");
    } finally {
      h.db.close();
    }
  });

  it("expires_at = now is treated as expired (boundary, <=)", () => {
    const h = makeHarness();
    try {
      h.seedClaimed({
        instanceId: "i-edge",
        expiresAt: "2026-04-29T12:00:00.000Z",
      });
      const sweeper = new ClaimSweeper({
        db: h.db,
        nowFn: () => "2026-04-29T12:00:00.000Z",
      });
      expect(sweeper.runOnce().resetCount).toBe(1);
      expect(h.readRow("i-edge").status).toBe("ready");
    } finally {
      h.db.close();
    }
  });

  it("audit reset is atomic: a failing audit insert rolls back the row reset", () => {
    // Drop the agent_actions table so the audit insert raises. The
    // UPDATE+INSERT are wrapped in BEGIN IMMEDIATE — a failure mid-txn
    // must roll back so the row stays `claimed`.
    const h = makeHarness();
    try {
      h.seedClaimed({
        instanceId: "i-tx",
        expiresAt: "2026-04-29T11:00:00.000Z",
      });
      h.db.exec("DROP TABLE agent_actions");

      expect(() =>
        sweepOnce(h.db, "2026-04-29T12:00:00.000Z"),
      ).toThrow();

      const row = h.readRow("i-tx");
      expect(row.status).toBe("claimed");
      expect(row.claim_token).toBe("tok_i-tx");
    } finally {
      h.db.close();
    }
  });
});

/* ---------------- setInterval lifecycle ---------------- */

describe("ClaimSweeper start/stop (setInterval)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs even with no live HTTP traffic — fires on its own setInterval cadence", () => {
    const h = makeHarness();
    try {
      h.seedClaimed({
        instanceId: "i-bg",
        expiresAt: "2026-04-29T11:00:00.000Z",
      });

      const sweeper = new ClaimSweeper({
        db: h.db,
        intervalMs: 50,
        nowFn: () => "2026-04-29T12:00:00.000Z",
      });
      sweeper.start();
      try {
        expect(h.readRow("i-bg").status).toBe("claimed");
        // Advance past one tick — the timer should fire and the sweep
        // should reset the row, with NO HTTP traffic having occurred.
        vi.advanceTimersByTime(60);
        expect(h.readRow("i-bg").status).toBe("ready");
      } finally {
        sweeper.stop();
      }
    } finally {
      h.db.close();
    }
  });

  it("start() is idempotent (a second call does not double-tick)", () => {
    const h = makeHarness();
    try {
      const sweeper = new ClaimSweeper({
        db: h.db,
        intervalMs: 100,
        nowFn: () => "2026-04-29T12:00:00.000Z",
      });
      // Spy on the prototype's runOnce so we can count invocations.
      const spy = vi.spyOn(sweeper, "runOnce");

      sweeper.start();
      sweeper.start(); // second call — must not register a second interval.
      try {
        vi.advanceTimersByTime(250);
        // 250 / 100 = 2 ticks, NOT 4.
        expect(spy.mock.calls.length).toBe(2);
      } finally {
        sweeper.stop();
      }
    } finally {
      h.db.close();
    }
  });

  it("stop() halts the timer", () => {
    const h = makeHarness();
    try {
      const sweeper = new ClaimSweeper({
        db: h.db,
        intervalMs: 50,
        nowFn: () => "2026-04-29T12:00:00.000Z",
      });
      const spy = vi.spyOn(sweeper, "runOnce");

      sweeper.start();
      vi.advanceTimersByTime(60); // 1 tick
      sweeper.stop();
      vi.advanceTimersByTime(500); // 0 further ticks
      expect(spy.mock.calls.length).toBe(1);
    } finally {
      h.db.close();
    }
  });

  it("DEFAULT_SWEEP_INTERVAL_MS matches DESIGN.md §3.3 (30s)", () => {
    expect(DEFAULT_SWEEP_INTERVAL_MS).toBe(30_000);
  });
});

/* ---------------- Single-flight ---------------- */

describe("ClaimSweeper single-flight", () => {
  it("a long-running sweep does not let another sweep queue behind it", () => {
    // We fake the inner sweep by stubbing `runOnce` is not enough — we
    // need the gate around it. Instead, hand the sweeper a `db` whose
    // `prepare` call stalls long enough to hold the inFlight flag while
    // we manually invoke runOnce again.
    const h = makeHarness();
    try {
      const sweeper = new ClaimSweeper({
        db: h.db,
        intervalMs: 1_000,
        nowFn: () => "2026-04-29T12:00:00.000Z",
      });

      // Drive the gate via re-entrant call: run runOnce inside a
      // synchronous nowFn that itself calls runOnce. The outer call
      // sets inFlight=true; the inner call must observe that and bail.
      let innerResult: ReturnType<ClaimSweeper["runOnce"]> | undefined;
      let nowCalls = 0;
      const reentrantSweeper = new ClaimSweeper({
        db: h.db,
        nowFn: () => {
          nowCalls += 1;
          if (nowCalls === 1) {
            // Re-enter while the outer call holds the gate.
            innerResult = reentrantSweeper.runOnce();
          }
          return "2026-04-29T12:00:00.000Z";
        },
      });

      const outer = reentrantSweeper.runOnce();
      expect(innerResult).toBeDefined();
      expect(innerResult?.skipped).toBe(true);
      expect(innerResult?.resetCount).toBe(0);
      // Outer ran a real sweep (no rows seeded → resetCount = 0).
      expect(outer.skipped).toBe(false);

      // After the outer returns, the gate is released and a fresh
      // call works as normal.
      const after = sweeper.runOnce();
      expect(after.skipped).toBe(false);
    } finally {
      h.db.close();
    }
  });
});

/* ---------------- Stress ---------------- */

describe("Sweeper stress: many expired claims at once", () => {
  it("resets 200 expired claims in one sweep", () => {
    const h = makeHarness();
    try {
      for (let i = 0; i < 200; i += 1) {
        h.seedClaimed({
          instanceId: `i-${i.toString().padStart(3, "0")}`,
          expiresAt: "2026-04-29T11:00:00.000Z",
        });
      }
      const sweeper = new ClaimSweeper({
        db: h.db,
        nowFn: () => "2026-04-29T12:00:00.000Z",
      });
      const result = sweeper.runOnce();
      expect(result.resetCount).toBe(200);

      const stillClaimed = h.db
        .prepare(
          `SELECT COUNT(*) AS n FROM subtask_instances WHERE status = 'claimed'`,
        )
        .get() as { n: number };
      expect(stillClaimed.n).toBe(0);

      const auditCount = h.db
        .prepare(
          `SELECT COUNT(*) AS n FROM agent_actions WHERE kind = 'claim_expired'`,
        )
        .get() as { n: number };
      expect(auditCount.n).toBe(200);
    } finally {
      h.db.close();
    }
  });
});
