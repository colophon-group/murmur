-- 0003_users_and_members: M2 human auth foundation (issue #82).
--
-- Adds the human-plane identity model: global users (one per OAuth
-- identity), per-publisher role grants, refresh tokens for session
-- continuity, and a human-action audit log.
--
-- The machine-plane (M1, migration 0002) and the human-plane (this
-- migration) are deliberately separate tables. A user is global —
-- one identity across publishers; a publisher token is per-publisher
-- by construction. The two planes never share keys.

-- ---------------------------------------------------------------------------
-- users — global identity (one row per OAuth identity).
--
-- A user is created on first OAuth sign-in. Subsequent sign-ins update
-- email / display_name / avatar_url from the latest OAuth claims so the
-- dashboard always shows current values without a separate refresh.
--
-- `oauth_provider` + `oauth_subject` are jointly unique — that's the
-- canonical identity key. `email` is NOT unique on its own (a user can
-- legitimately have a GitHub identity and a Google identity that share
-- an email but are distinct users until M4 introduces account merging).
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id              TEXT PRIMARY KEY,
  oauth_provider  TEXT NOT NULL,        -- 'github' | 'google' (open enum)
  oauth_subject   TEXT NOT NULL,        -- provider-stable id (string)
  email           TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  avatar_url      TEXT,
  disabled_at     TEXT,                 -- soft-disable; sign-in 401 when set
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_users_oauth_identity
  ON users(oauth_provider, oauth_subject);

CREATE INDEX idx_users_email
  ON users(email);

-- ---------------------------------------------------------------------------
-- publisher_members — per-publisher role grant.
--
-- A user belongs to zero publishers until granted a role. Roles:
--   - 'admin'    full publisher config + member management + reviewer rights
--   - 'reviewer' approve / reject / amend HITL items + view runs
--   - 'viewer'   read-only access to runs + history
--
-- `granted_by` links to the user_id of the admin who granted the role.
-- For the bootstrap-publisher's first admin (set up via CLI) this can
-- be NULL — operator action with no human-plane actor.
-- ---------------------------------------------------------------------------
CREATE TABLE publisher_members (
  id            TEXT PRIMARY KEY,
  publisher_id  TEXT NOT NULL REFERENCES publishers(id),
  user_id       TEXT NOT NULL REFERENCES users(id),
  role          TEXT NOT NULL,          -- 'admin' | 'reviewer' | 'viewer'
  granted_by    TEXT REFERENCES users(id),
  granted_at    TEXT NOT NULL,
  revoked_at    TEXT
);

CREATE UNIQUE INDEX idx_publisher_members_active
  ON publisher_members(publisher_id, user_id)
  WHERE revoked_at IS NULL;

CREATE INDEX idx_publisher_members_user
  ON publisher_members(user_id)
  WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- refresh_tokens — opaque tokens that swap for fresh JWTs.
--
-- Hashed at rest (SHA-256 hex; 32-byte random input ⇒ collision-
-- resistant without salt). One row per issued refresh token. Rotation:
-- /auth/refresh issues a new row + revokes the presented one in a
-- single transaction (CSRF-safe + replay-safe).
-- ---------------------------------------------------------------------------
CREATE TABLE refresh_tokens (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  token_hash    TEXT NOT NULL,
  issued_at     TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT,
  user_agent    TEXT,                   -- for the audit trail; not load-bearing
  ip_address    TEXT
);

CREATE UNIQUE INDEX idx_refresh_tokens_active_hash
  ON refresh_tokens(token_hash)
  WHERE revoked_at IS NULL;

CREATE INDEX idx_refresh_tokens_user
  ON refresh_tokens(user_id);

-- ---------------------------------------------------------------------------
-- human_audit — append-only log of human-plane actions.
--
-- Sign-in success / failure, role changes, HITL decisions (M3),
-- session refresh, sign-out. Retention: 1 year (M8 sweeper).
-- ---------------------------------------------------------------------------
CREATE TABLE human_audit (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         TEXT REFERENCES users(id),  -- NULL for pre-user sign-in failures
  publisher_id    TEXT REFERENCES publishers(id), -- NULL for user-global actions
  action          TEXT NOT NULL,
  payload_json    TEXT,
  ip_address      TEXT,
  user_agent      TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX idx_human_audit_user_ts
  ON human_audit(user_id, created_at);

CREATE INDEX idx_human_audit_pub_ts
  ON human_audit(publisher_id, created_at);
