-- 0002_publishers_and_tokens: M1 multi-tenant auth foundation (issue #81).
--
-- Adds the publisher namespace and the four-token model that replaces the
-- single shared MURMUR_TOKEN. The migration is forward-only — see
-- src/db/schema.md for the canonical reference; any change to this file is
-- forbidden once committed.
--
-- Order matters in this file:
--   1. CREATE the new tables.
--   2. INSERT the demo publisher row (pub_demo_seed). Hardcoded UUID so the
--      pipelines.publisher_id back-fill default below has something to point
--      at — without this row, the FK fails on every existing pipeline at
--      ALTER-time.
--   3. ALTER pipelines to add publisher_id with NOT NULL DEFAULT pointing
--      at the demo seed. Existing rows roll over to the demo publisher.
--   4. Indexes for the new tables.
--
-- The demo publisher's slug + display_name are NOT pinned here — the boot
-- seed step (src/db/bootstrap.ts) reads MURMUR_BOOTSTRAP_PUBLISHER_SLUG /
-- _NAME env vars (defaulting to "demo" / "Demo Publisher") and updates the
-- row. This keeps the migration generic; nothing in src/db/migrations
-- references "jobseek".
--
-- Statements are separated by `;` and executed in order. The migrations
-- runner wraps the whole file in BEGIN IMMEDIATE / COMMIT.

-- ---------------------------------------------------------------------------
-- publishers — the per-tenant namespace owning pipelines, runs, secrets.
-- ---------------------------------------------------------------------------
CREATE TABLE publishers (
  id           TEXT PRIMARY KEY,
  slug         TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- publisher_tokens — bearer tokens the publisher presents TO Murmur to gate
-- registration (admin) or run-trigger (runner) calls. Stored as SHA-256 of
-- the token bytes; high-entropy random tokens (32 random bytes) collapse
-- the salt-vs-no-salt argument — collision-resistant SHA-256 with 256 bits
-- of input entropy is sufficient.
--
-- One row per token. `kinds_json` is a JSON array of grant kinds the token
-- carries — e.g. `["admin"]`, `["runner"]`, or `["admin","runner"]` for the
-- demo publisher's grandfathered MURMUR_TOKEN. A single multi-kind row
-- avoids the aggregation hazard of "two rows, same hash, different kinds"
-- where the auth middleware risks collapsing kinds across publishers.
--
-- `prefix` is the operator-visible token prefix (e.g. last 8 chars of the
-- token) for displaying "active token" without leaking the full secret.
--
-- `source` distinguishes the env-grandfathered demo token from API-minted
-- tokens, so the boot seed can detect MURMUR_TOKEN rotation (hash mismatch
-- against the active grandfather row → revoke stale, insert new).
-- ---------------------------------------------------------------------------
CREATE TABLE publisher_tokens (
  id           TEXT PRIMARY KEY,
  publisher_id TEXT NOT NULL REFERENCES publishers(id),
  kinds_json   TEXT NOT NULL,
  secret_hash  TEXT NOT NULL,
  prefix       TEXT NOT NULL,
  source       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  revoked_at   TEXT
);

-- Active-token uniqueness: the same hash cannot point to two active tokens
-- across the entire deployment. Revoked tokens are excluded so the partial
-- index admits historical revocations whose hashes happen to match a future
-- mint. The auth middleware joins on this index.
CREATE UNIQUE INDEX idx_publisher_tokens_active_hash
  ON publisher_tokens(secret_hash)
  WHERE revoked_at IS NULL;

CREATE INDEX idx_publisher_tokens_pub
  ON publisher_tokens(publisher_id);

-- ---------------------------------------------------------------------------
-- publisher_secrets — outgoing-use secrets Murmur uses to call BACK into the
-- publisher. Stored plaintext because Murmur needs the cleartext to (a) sign
-- webhook bodies (HMAC-SHA256 over `t.body`) and (b) inject as Authorization
-- bearer to publisher subcommand endpoints. The SQLite file is treated as a
-- secret on par with MURMUR_TOKEN (operator runbook).
--
-- Same single-table pattern as publisher_tokens: one row per active secret;
-- rotation creates a new row and revokes the old (see /publishers/me/tokens
-- API). The lookup picks the most-recent non-revoked row of the requested
-- kind.
-- ---------------------------------------------------------------------------
CREATE TABLE publisher_secrets (
  id           TEXT PRIMARY KEY,
  publisher_id TEXT NOT NULL REFERENCES publishers(id),
  kind         TEXT NOT NULL,
  secret_value TEXT NOT NULL,
  prefix       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  revoked_at   TEXT
);

CREATE INDEX idx_publisher_secrets_active
  ON publisher_secrets(publisher_id, kind, created_at DESC)
  WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- publisher_audit_events — admin-action audit log (machine-plane).
--
-- Records token mints/rotations/revocations, publisher PATCH operations,
-- and bootstrap calls. `action` is a free string (no CHECK constraint) so
-- future kinds can be added without a migration. Convention is documented
-- in docs/auth.md.
-- ---------------------------------------------------------------------------
CREATE TABLE publisher_audit_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  publisher_id    TEXT NOT NULL REFERENCES publishers(id),
  ts              TEXT NOT NULL,
  action          TEXT NOT NULL,
  token_kind      TEXT,
  actor_user_id   TEXT,
  metadata_json   TEXT
);

CREATE INDEX idx_publisher_audit_pub_ts
  ON publisher_audit_events(publisher_id, ts);

-- ---------------------------------------------------------------------------
-- Demo publisher seed. Slug + display_name are placeholder values overridden
-- at boot from MURMUR_BOOTSTRAP_PUBLISHER_SLUG / _NAME env vars (or default
-- to "demo" / "Demo Publisher"). The id is a stable hardcoded UUID so the
-- ALTER below has a constant DEFAULT to point at; this is the seed marker —
-- no other code path may insert a publisher with this id.
-- ---------------------------------------------------------------------------
INSERT INTO publishers (id, slug, display_name, created_at, updated_at)
VALUES (
  'pub_demo_seed',
  'demo',
  'Demo Publisher',
  '1970-01-01T00:00:00.000Z',
  '1970-01-01T00:00:00.000Z'
);

-- ---------------------------------------------------------------------------
-- Add publisher_id to pipelines.
--
-- **SQLite caveat (cost of the M1 deploy outage on first attempt):**
-- when `foreign_keys=ON` AND any existing row exists in `pipelines`,
-- SQLite refuses to ALTER ADD COLUMN with a `REFERENCES` clause AND a
-- non-NULL DEFAULT in one shot — the rule is "REFERENCES added via
-- ALTER must default to NULL". Locally with a fresh `:memory:` table
-- (no rows) the ALTER passes; in production the row from the previous
-- demo deploy makes it fail with `Cannot add a REFERENCES column with
-- non-NULL default value`. See SQLite docs §"ALTER TABLE ADD COLUMN".
--
-- Workaround: add the column NULLable with a NULL default, then
-- back-fill in a separate UPDATE. The FK is enforced going forward
-- by the `foreign_keys=ON` pragma. The application layer (the INSERT
-- in `mountPipelineRoutes`) always supplies `publisher_id` from
-- `c.var.publisher_id`, so a NULL never appears in any post-migration
-- write — but the schema-level NOT NULL guarantee is traded for one
-- that lives at the application layer.
--
-- A future migration can rebuild the table to recover the NOT NULL
-- guarantee (table-rebuild requires `PRAGMA foreign_keys=OFF` outside
-- the transaction; the current migration runner wraps each file in a
-- single BEGIN IMMEDIATE / COMMIT, so the rebuild is its own concern
-- when a migration runner that toggles FKs lands).
-- ---------------------------------------------------------------------------
ALTER TABLE pipelines
  ADD COLUMN publisher_id TEXT REFERENCES publishers(id);

UPDATE pipelines
   SET publisher_id = 'pub_demo_seed'
 WHERE publisher_id IS NULL;

CREATE INDEX idx_pipelines_publisher
  ON pipelines(publisher_id);
