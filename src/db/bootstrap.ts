/**
 * Boot-time seed for the multi-tenant auth foundation (M1, issue #81).
 *
 * Runs ONCE at server start, AFTER `runMigrations` has applied
 * `0002_publishers_and_tokens.sql`. Idempotent — re-running the same
 * boot with the same `MURMUR_TOKEN` and `MURMUR_BOOTSTRAP_PUBLISHER_*`
 * env vars is a no-op (with one exception: see "MURMUR_TOKEN rotation"
 * below).
 *
 * Responsibilities:
 *
 *   1. **Update demo publisher slug + display_name.** The migration
 *      seeds `pub_demo_seed` with placeholder slug `"demo"` and name
 *      `"Demo Publisher"`. This step overrides them from
 *      `MURMUR_BOOTSTRAP_PUBLISHER_SLUG` / `_NAME` env vars (defaults
 *      kept if unset). Keeps the migration file generic — no jobseek
 *      vocabulary in `src/db/migrations/`.
 *
 *   2. **Grandfather `MURMUR_TOKEN` as the demo's admin+runner token.**
 *      The legacy single-bearer model triple-duty'd `MURMUR_TOKEN` for
 *      registration, run-trigger, and (via `task_tool` dispatch) the
 *      subcommand bearer. To keep the demo running through the M1
 *      transition, we hash `MURMUR_TOKEN` and insert ONE row in
 *      `publisher_tokens` with `kinds_json='["admin","runner"]'`. The
 *      auth middleware decodes the JSON array and treats the token as
 *      having both grants. Source: `env_grandfather`.
 *
 *      **MURMUR_TOKEN rotation.** If the operator rotates `MURMUR_TOKEN`
 *      between boots, the previous grandfather row's hash no longer
 *      matches `sha256(new_value)`. The seed detects this, revokes the
 *      stale grandfather row(s), and inserts a fresh one. The auth
 *      middleware sees the new token immediately on next request.
 *
 *      If `MURMUR_TOKEN` is unset, no grandfather row is created — the
 *      demo publisher exists but is unreachable via the legacy path.
 *      This is the correct behaviour for a fresh deployment that never
 *      had a demo to grandfather; operators bootstrap via
 *      `POST /publishers` instead.
 *
 *   3. **Seed `subcommand_bearer` to MURMUR_TOKEN value (demo only).**
 *      The legacy `task_tool` dispatcher forwarded `MURMUR_TOKEN` as the
 *      Authorization bearer to publisher subcommand endpoints; jobseek's
 *      shim verifies that exact value. To keep dispatch working without
 *      a synchronised env-var rotation in jobseek, the demo's
 *      `subcommand_bearer` is set to the MURMUR_TOKEN value. New
 *      publishers (registered via `POST /publishers`) get a freshly
 *      minted random subcommand_bearer instead.
 *
 *   4. **Seed `webhook_signing_secret` for the demo.** Generated once
 *      with 32 random bytes. Used by webhook delivery to sign
 *      `final_output` POSTs (additive `X-Murmur-Signature` header; the
 *      legacy `Authorization: Bearer` is retained for backward compat
 *      until M10 cutover).
 *
 * **What this module deliberately does NOT do:**
 *
 *   - It does not log secret values. `grep-no-token-logged` enforces
 *     this; we only emit prefixes (`mp_admin_…ABCDEFGH`) and counts.
 *   - It does not auto-rotate `subcommand_bearer` when MURMUR_TOKEN
 *     rotates — operators rotating MURMUR_TOKEN must explicitly call
 *     `POST /publishers/me/tokens/subcommand_bearer/rotate` if they
 *     want the value to follow.
 *   - It does not touch any publisher OTHER THAN the demo seed. New
 *     publishers go through `POST /publishers` with the bootstrap
 *     token; this module never minted-on-boot for them.
 *
 * @see DESIGN.md §3.6 — auth model
 * @see src/db/migrations/0002_publishers_and_tokens.sql — schema
 * @see src/auth/tokens.ts — hashing primitives
 */

import { randomBytes } from "node:crypto";

import type Database from "better-sqlite3";

import { hashToken, newRowId, visiblePrefix } from "../auth/tokens.js";
import { log } from "../logger.js";

/**
 * Hardcoded ID of the demo publisher seed row, planted by migration 0002.
 * No other code path may use this id; it's the boot-seed marker.
 */
export const DEMO_PUBLISHER_ID = "pub_demo_seed";

/**
 * Default slug applied to the demo publisher when
 * `MURMUR_BOOTSTRAP_PUBLISHER_SLUG` is unset. Generic on purpose — `demo`
 * is a publisher-agnostic placeholder; the issue's first publisher
 * (jobseek) sets the slug explicitly via env at deployment.
 */
export const DEFAULT_DEMO_SLUG = "demo";

/**
 * Default display name applied to the demo publisher when
 * `MURMUR_BOOTSTRAP_PUBLISHER_NAME` is unset.
 */
export const DEFAULT_DEMO_DISPLAY_NAME = "Demo Publisher";

/**
 * Environment subset consumed by {@link seedDemoPublisher}. Pure input —
 * the helper is called with `process.env` from `src/index.ts` but unit
 * tests pass a synthetic record so they can exercise rotation without
 * touching the host environment.
 *
 * Typed as a generic `Record<string, string | undefined>` rather than a
 * named-key shape so it accepts `process.env` directly (NodeJS.ProcessEnv
 * is structurally `Record<string, string | undefined>` but the named
 * subset breaks under `exactOptionalPropertyTypes`).
 */
export type BootstrapEnv = Readonly<Record<string, string | undefined>>;

/**
 * Optional injection seam for deterministic tests. Production callers
 * pass `nowFn = () => new Date().toISOString()`.
 */
export interface SeedDemoPublisherOptions {
  /** Override now() for deterministic timestamps. */
  readonly nowFn?: () => string;
  /** Override the random secret generator (for tests). 32-byte buffer. */
  readonly randomBytesFn?: (n: number) => Buffer;
  /** Override the row-id factory (for tests). */
  readonly newRowIdFn?: () => string;
}

/**
 * Result of one {@link seedDemoPublisher} call. Used by tests to assert
 * the steady-state shape; `src/index.ts` logs a redacted summary.
 */
export interface SeedDemoPublisherResult {
  /** Publisher slug after the seed (post-override). */
  readonly slug: string;
  /** Publisher display_name after the seed. */
  readonly display_name: string;
  /** True iff a fresh `env_grandfather` token row was inserted on this run. */
  readonly grandfatherTokenInserted: boolean;
  /** True iff a previous grandfather row was revoked because MURMUR_TOKEN rotated. */
  readonly grandfatherTokenRotated: boolean;
  /** True iff a `subcommand_bearer` row was inserted on this run. */
  readonly subcommandBearerInserted: boolean;
  /** True iff a `webhook_signing` row was inserted on this run. */
  readonly webhookSigningSecretInserted: boolean;
}

/**
 * Run the boot-time seed for the demo publisher. Idempotent.
 *
 * Behaviour matrix:
 *
 *   - Demo publisher slug/display_name are UPSERT-ed from env (defaults
 *     `demo` / `Demo Publisher`).
 *   - If `MURMUR_TOKEN` is set: ensure exactly one active
 *     `env_grandfather` token row exists in `publisher_tokens` whose
 *     hash matches `sha256(MURMUR_TOKEN)`. If a stale grandfather row
 *     exists with a different hash, revoke it.
 *   - If `MURMUR_TOKEN` is set AND no active `subcommand_bearer` row
 *     exists for the demo: insert one with `secret_value = MURMUR_TOKEN`.
 *   - If no active `webhook_signing` row exists for the demo: generate
 *     32 random bytes, base64url-encode, insert.
 *
 * @returns a {@link SeedDemoPublisherResult} describing what changed.
 *   Tests assert on this; production logs a redacted summary.
 */
export function seedDemoPublisher(
  db: Database.Database,
  env: BootstrapEnv,
  options: SeedDemoPublisherOptions = {},
): SeedDemoPublisherResult {
  const nowFn = options.nowFn ?? (() => new Date().toISOString());
  const randomBytesFn = options.randomBytesFn ?? randomBytes;
  const newRowIdFn = options.newRowIdFn ?? newRowId;

  // 1. Upsert slug + display_name. Migration seeded placeholders; env
  //    overrides them. We always run this so an operator changing the
  //    env between boots takes effect.
  const slug = env["MURMUR_BOOTSTRAP_PUBLISHER_SLUG"] ?? DEFAULT_DEMO_SLUG;
  const display_name =
    env["MURMUR_BOOTSTRAP_PUBLISHER_NAME"] ?? DEFAULT_DEMO_DISPLAY_NAME;
  const now = nowFn();

  db.prepare(
    `UPDATE publishers
        SET slug = ?, display_name = ?, updated_at = ?
      WHERE id = ?`,
  ).run(slug, display_name, now, DEMO_PUBLISHER_ID);

  // 2. Grandfather MURMUR_TOKEN as admin+runner.
  const murmurToken = env["MURMUR_TOKEN"];
  let grandfatherTokenInserted = false;
  let grandfatherTokenRotated = false;

  if (murmurToken !== undefined && murmurToken.length > 0) {
    const newHash = hashToken(murmurToken);

    interface GrandfatherRow {
      readonly id: string;
      readonly secret_hash: string;
    }
    const existing = db
      .prepare(
        `SELECT id, secret_hash
           FROM publisher_tokens
          WHERE publisher_id = ?
            AND source = 'env_grandfather'
            AND revoked_at IS NULL`,
      )
      .all(DEMO_PUBLISHER_ID) as ReadonlyArray<GrandfatherRow>;

    const matching = existing.find((r) => r.secret_hash === newHash);
    if (matching === undefined) {
      // Either no grandfather row yet, OR MURMUR_TOKEN was rotated and
      // the existing row's hash is stale. Revoke any stale rows, then
      // insert a fresh one.
      const revokeStmt = db.prepare(
        `UPDATE publisher_tokens SET revoked_at = ? WHERE id = ?`,
      );
      for (const r of existing) {
        revokeStmt.run(now, r.id);
        grandfatherTokenRotated = true;
      }
      db.prepare(
        `INSERT INTO publisher_tokens
           (id, publisher_id, kinds_json, secret_hash, prefix, source, created_at)
         VALUES (?, ?, ?, ?, ?, 'env_grandfather', ?)`,
      ).run(
        newRowIdFn(),
        DEMO_PUBLISHER_ID,
        JSON.stringify(["admin", "runner"]),
        newHash,
        visiblePrefix(murmurToken),
        now,
      );
      grandfatherTokenInserted = true;
    }
  }

  // 3. Seed subcommand_bearer (demo only) to MURMUR_TOKEN value. The
  //    seed mirrors the grandfather-token rotation logic: if any active
  //    `subcommand_bearer` row holds a value other than the current
  //    MURMUR_TOKEN, revoke it and insert a fresh row. Otherwise (value
  //    matches OR no active row), insert only on first boot.
  //
  //    This keeps `task_tool` dispatch in lockstep with MURMUR_TOKEN
  //    rotation: jobseek's shim verifies the bearer = MURMUR_TOKEN; if
  //    we leave the stale value in place, dispatch would 401 against
  //    the post-rotation jobseek shim. The grandfather token rotation
  //    above and this rotation MUST move together.
  //
  //    Skipped if MURMUR_TOKEN is unset — a fresh deployment without a
  //    legacy bearer simply has no subcommand bearer until an operator
  //    rotates one in (or bootstraps a new publisher with `POST
  //    /publishers`).
  let subcommandBearerInserted = false;
  if (murmurToken !== undefined && murmurToken.length > 0) {
    interface ScRow {
      readonly id: string;
      readonly secret_value: string;
    }
    const existingScRows = db
      .prepare(
        `SELECT id, secret_value FROM publisher_secrets
          WHERE publisher_id = ?
            AND kind = 'subcommand_bearer'
            AND revoked_at IS NULL`,
      )
      .all(DEMO_PUBLISHER_ID) as ReadonlyArray<ScRow>;

    const matching = existingScRows.find((r) => r.secret_value === murmurToken);
    if (matching === undefined) {
      // Either no active row, OR the active row holds a stale value —
      // revoke any active rows and insert a fresh one.
      const revokeStmt = db.prepare(
        `UPDATE publisher_secrets SET revoked_at = ? WHERE id = ?`,
      );
      for (const r of existingScRows) {
        revokeStmt.run(now, r.id);
      }
      db.prepare(
        `INSERT INTO publisher_secrets
           (id, publisher_id, kind, secret_value, prefix, created_at)
         VALUES (?, ?, 'subcommand_bearer', ?, ?, ?)`,
      ).run(
        newRowIdFn(),
        DEMO_PUBLISHER_ID,
        murmurToken,
        visiblePrefix(murmurToken),
        now,
      );
      subcommandBearerInserted = true;
    }
  }

  // 4. Generate webhook_signing_secret if none active. Always runs (no
  //    MURMUR_TOKEN dependency) so HMAC signing can begin on any
  //    deployment, not just the legacy demo.
  let webhookSigningSecretInserted = false;
  const existingWs = db
    .prepare(
      `SELECT 1 FROM publisher_secrets
        WHERE publisher_id = ?
          AND kind = 'webhook_signing'
          AND revoked_at IS NULL
        LIMIT 1`,
    )
    .get(DEMO_PUBLISHER_ID);
  if (existingWs === undefined) {
    const secret = randomBytesFn(32).toString("base64url");
    db.prepare(
      `INSERT INTO publisher_secrets
         (id, publisher_id, kind, secret_value, prefix, created_at)
       VALUES (?, ?, 'webhook_signing', ?, ?, ?)`,
    ).run(
      newRowIdFn(),
      DEMO_PUBLISHER_ID,
      secret,
      visiblePrefix(secret),
      now,
    );
    webhookSigningSecretInserted = true;
  }

  // Telemetry: log only counts + slug. Never the secrets themselves.
  log.info("bootstrap.demo_publisher_seeded", {
    slug,
    grandfather_token_inserted: grandfatherTokenInserted,
    grandfather_token_rotated: grandfatherTokenRotated,
    subcommand_bearer_inserted: subcommandBearerInserted,
    webhook_signing_secret_inserted: webhookSigningSecretInserted,
  });

  return {
    slug,
    display_name,
    grandfatherTokenInserted,
    grandfatherTokenRotated,
    subcommandBearerInserted,
    webhookSigningSecretInserted,
  };
}
