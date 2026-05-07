# Murmur SQLite schema

**Authoritative reference.** This document lists every table, column,
and index in the Murmur SQLite database. The SQL in
`src/db/migrations/*.sql` MUST match. Tests in `migrations.test.ts`
compare the live `.schema` against the structure here.

## Conventions

- All timestamps are RFC 3339 / ISO 8601 strings in UTC, e.g.
  `"2026-04-29T12:34:56.000Z"`. SQLite has no native timestamp type;
  we standardise on text for portability and for unambiguous ordering.
- All JSON-bearing columns store a single JSON document as `TEXT`. The
  application encodes/decodes; SQLite is not asked to parse them.
- Identifiers (run id, instance id, claim token, pipeline id) are
  opaque strings — caller-generated. The schema does not enforce a
  format beyond non-NULL.
- All `*_at` columns are `NOT NULL` unless noted; they're populated by
  the application at write time.
- Foreign keys are enforced (`PRAGMA foreign_keys = ON` runs at every
  connection open in `openDb`). FK violations raise `SQLITE_CONSTRAINT`.

## Migration policy

**Forward-only.** Once a migration file in `src/db/migrations/` is
committed and applied to any environment (CI, dev, prod), it is
immutable. To change the schema, add a new file with the next version
number. Editing an applied migration is forbidden — the runner detects
applied versions by number, not by content hash, so an in-place edit
silently desyncs deployed databases from the source.

## Pragmas

Applied at every `openDb` call:

| Pragma | Value | Why |
| --- | --- | --- |
| `journal_mode` | `WAL` | Required for §3.3 atomic claim CAS; readers don't block writers (audit log + sweeper concurrent with claim flow). |
| `synchronous` | `NORMAL` (1) | Acceptable durability vs. throughput tradeoff for demo. |
| `foreign_keys` | `ON` | FK constraints are declared on the schema; SQLite leaves enforcement off by default. |

---

## `_migrations`

Records which migration versions have been applied. Created by the
migrations runner before applying anything else.

| Column | Type | NULL? | Notes |
| --- | --- | --- | --- |
| `version` | `INTEGER PRIMARY KEY` | NO | Numeric prefix from the filename. |
| `applied_at` | `TEXT NOT NULL` | NO | RFC 3339 timestamp the migration ran. |

---

## `pipelines`

One row per pipeline-def (`POST /pipelines` upsert; last-write-wins per
DESIGN.md §3.2). Stores the validated pipeline def as JSON for replay
and for live subcommand-endpoint resolution (§3.3).

| Column | Type | NULL? | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT PRIMARY KEY` | NO | Pipeline slug, kebab-case. |
| `version` | `INTEGER NOT NULL` | NO | Monotonically incremented per upsert; pinned to runs. |
| `def_json` | `TEXT NOT NULL` | NO | Validated pipeline-def document. |
| `created_at` | `TEXT NOT NULL` | NO | First insertion. |
| `updated_at` | `TEXT NOT NULL` | NO | Most recent upsert. |
| `publisher_id` | `TEXT` | YES (schema-level) | FK → `publishers.id`. Added by 0002. Back-filled to `pub_demo_seed` for existing rows. **NULL is forbidden by application invariant** — `mountPipelineRoutes` always supplies `publisher_id` from `c.var.publisher_id`. SQLite's `ALTER ADD COLUMN ... REFERENCES` with a non-NULL DEFAULT is rejected when existing rows are present (`foreign_keys=ON`); a future table-rebuild migration can lift this to schema-level NOT NULL once the migration runner supports `PRAGMA foreign_keys` toggle. |

Foreign key: `publisher_id` REFERENCES `publishers(id)`.

Indexes:
- `idx_pipelines_publisher` — non-unique on `publisher_id`. Drives the
  `WHERE publisher_id = ?` scope on every publisher-facing query.

Pipeline IDs are globally unique for v1 (PRIMARY KEY on `id`). Per-publisher
namespacing (composite `(publisher_id, id)`) is deferred until multiple
non-demo publishers exist; the UPSERT in `mountPipelineRoutes` is scoped
via `WHERE pipelines.publisher_id = ?` in its `ON CONFLICT … DO UPDATE`
clause so cross-publisher slug collisions surface as a 409, not a silent
overwrite.

---

## `runs`

One row per `POST /pipelines/{id}/runs`. Holds the run-level state and
the composed `final_output` once webhook delivery is in flight.

| Column | Type | NULL? | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT PRIMARY KEY` | NO | Run id (also the `Idempotency-Key` on the webhook). |
| `pipeline_id` | `TEXT NOT NULL` | NO | FK → `pipelines.id`. |
| `pipeline_version` | `INTEGER NOT NULL` | NO | Version pinned at run-start. |
| `status` | `TEXT NOT NULL` | NO | One of `running`, `completed`, `failed`, `webhook_failed`. |
| `initial_input_json` | `TEXT NOT NULL` | NO | The `initial_input` body posted by the publisher. |
| `final_output_json` | `TEXT` | YES | Composed `final_output`; populated when status becomes `completed`. |
| `webhook_url` | `TEXT NOT NULL` | NO | Materialized from the pipeline def at run-start (immune to def edits mid-run). |
| `webhook_status` | `TEXT` | YES | One of `pending`, `delivered`, `failed`; NULL until run completes. |
| `created_at` | `TEXT NOT NULL` | NO | Run creation timestamp. |
| `completed_at` | `TEXT` | YES | Set when status moves out of `running`. |

Foreign key: `pipeline_id` REFERENCES `pipelines(id)`.

No secondary indexes for MVP; reads are by primary key (`GET /runs/{id}`).

---

## `subtask_instances`

One row per concrete subtask to be claimed. Spawned children get their
own row with `parent_instance_id` set. The atomic claim CAS in §3.3
operates on this table.

| Column | Type | NULL? | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT PRIMARY KEY` | NO | Instance id (opaque). |
| `run_id` | `TEXT NOT NULL` | NO | FK → `runs.id`. |
| `subtask_id` | `TEXT NOT NULL` | NO | The pipeline-def subtask id (e.g., `configure-board`). |
| `parent_instance_id` | `TEXT` | YES | FK → `subtask_instances.id`; set on spawned children. |
| `spawn_index` | `INTEGER` | YES | Index into the parent's `for_each` array (0-based); NULL for non-spawned. |
| `status` | `TEXT NOT NULL` | NO | One of `pending`, `ready`, `claimed`, `done`, `skipped`, `failed`. |
| `claim_token` | `TEXT` | YES | Set when claimed; NULL otherwise. |
| `expires_at` | `TEXT` | YES | RFC 3339; set with `claim_token`, NULL otherwise. |
| `input_json` | `TEXT NOT NULL` | NO | Resolved input document for this instance (per `inputs:`). |
| `created_at` | `TEXT NOT NULL` | NO | Row insertion. |
| `updated_at` | `TEXT NOT NULL` | NO | Most recent state change. |

Foreign keys:
- `run_id` REFERENCES `runs(id)`
- `parent_instance_id` REFERENCES `subtask_instances(id)`

Indexes:
- `idx_subtask_instances_claim_token` — `UNIQUE` on `claim_token`,
  partial: `WHERE claim_token IS NOT NULL`. Guarantees one live claim
  per token across the entire pool. The partial predicate keeps NULLs
  out of the index so multiple unclaimed rows coexist.
- `idx_subtask_instances_ready` — non-unique on `(status, created_at)`.
  Drives `GET /work/next`'s `WHERE status='ready' ORDER BY created_at`
  scan (§3.3).

---

## `subtask_results`

One row per submitted result. Split from `subtask_instances` so that
the result write is a single insert rather than an `UPDATE` on the
already-busy claim row, and so audit traversal can join cheaply.

| Column | Type | NULL? | Notes |
| --- | --- | --- | --- |
| `instance_id` | `TEXT PRIMARY KEY` | NO | FK → `subtask_instances.id`. One row per instance. |
| `output_json` | `TEXT NOT NULL` | NO | Schema-validated `submit_result.result`. |
| `notes` | `TEXT` | YES | Optional free-text reflection (DESIGN.md §3.1, last bullet). |
| `submitted_at` | `TEXT NOT NULL` | NO | RFC 3339. |

Foreign key: `instance_id` REFERENCES `subtask_instances(id)`.

No secondary indexes; lookups are by `instance_id` (PK).

---

## `agent_actions`

Audit log. One row per `task_tool` call's args + response (DESIGN.md
§3.6, "Audit log payload truncation"). Used by `GET /runs/{id}` for
the per-subtask `agent_actions[]` array.

| Column | Type | NULL? | Notes |
| --- | --- | --- | --- |
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | NO | Surrogate; ordering hint. |
| `instance_id` | `TEXT NOT NULL` | NO | FK → `subtask_instances.id`. |
| `ts` | `TEXT NOT NULL` | NO | RFC 3339, time the action was logged. |
| `kind` | `TEXT NOT NULL` | NO | One of `task_tool`, `submit_result`, `claim`, `claim_lost`, `webhook`. |
| `subcommand` | `TEXT` | YES | `task_tool` subcommand name; NULL otherwise. |
| `args_json` | `TEXT` | YES | JSON of args (truncated to 4 KB per §3.6). |
| `response_json` | `TEXT` | YES | JSON of response (truncated to 4 KB). |
| `truncated` | `INTEGER NOT NULL DEFAULT 0` | NO | `1` if either `args_json` or `response_json` was truncated. |

Foreign key: `instance_id` REFERENCES `subtask_instances(id)`.

Indexes:
- `idx_agent_actions_instance_ts` — non-unique on `(instance_id, ts)`.
  Drives ordered traversal of a subtask's audit trail in run-status
  responses.

---

---

## `publishers`

One row per tenant. The publisher namespace owns pipelines, runs, audit
events, and the four-token model that gates machine-plane access (M1,
issue #81).

| Column | Type | NULL? | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT PRIMARY KEY` | NO | Opaque publisher id. The demo seed is `pub_demo_seed` (hardcoded by 0002 so the `pipelines.publisher_id` back-fill default has something to point at). |
| `slug` | `TEXT UNIQUE NOT NULL` | NO | Kebab-case publisher slug. Operator-visible; the demo's slug is overridden at boot via `MURMUR_BOOTSTRAP_PUBLISHER_SLUG`. |
| `display_name` | `TEXT NOT NULL` | NO | Operator-visible name. |
| `created_at` | `TEXT NOT NULL` | NO | Row creation. |
| `updated_at` | `TEXT NOT NULL` | NO | Most recent PATCH. |

No secondary indexes; lookups are by `id` (PK) or `slug` (UNIQUE).

---

## `publisher_tokens`

Bearer tokens the publisher presents TO Murmur (admin / runner). Stored as
SHA-256 hex of the token bytes — high-entropy random tokens (256 bits of
input entropy) collapse the salt argument; collision-resistant SHA-256 is
sufficient.

| Column | Type | NULL? | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT PRIMARY KEY` | NO | Opaque token row id. Returned alongside the new secret on rotate so operators can later target this row for `DELETE`. |
| `publisher_id` | `TEXT NOT NULL` | NO | FK → `publishers.id`. |
| `kinds_json` | `TEXT NOT NULL` | NO | JSON array of grant kinds — e.g. `["admin"]`, `["runner"]`, `["admin","runner"]`. Single multi-kind row avoids the cross-publisher aggregation hazard of "two rows, same hash, different kinds". |
| `secret_hash` | `TEXT NOT NULL` | NO | SHA-256 hex of the token bytes. |
| `prefix` | `TEXT NOT NULL` | NO | Operator-visible prefix (last 8 chars). For display only — never used in auth comparison. |
| `source` | `TEXT NOT NULL` | NO | Provenance: `env_grandfather` for the demo's MURMUR_TOKEN-derived row; `api` for tokens minted via `/publishers/me/tokens/*/rotate`; `bootstrap` for the first admin token created with `POST /publishers`. |
| `created_at` | `TEXT NOT NULL` | NO | Mint timestamp. |
| `revoked_at` | `TEXT` | YES | RFC 3339 when revoked; NULL while active. |

Foreign key: `publisher_id` REFERENCES `publishers(id)`.

Indexes:
- `idx_publisher_tokens_active_hash` — UNIQUE on `secret_hash`, partial:
  `WHERE revoked_at IS NULL`. The auth middleware joins on this index;
  the partial predicate admits historical revocations whose hash happens
  to match a future mint.
- `idx_publisher_tokens_pub` — non-unique on `publisher_id`.

---

## `publisher_secrets`

Outgoing-use secrets Murmur uses to call BACK into the publisher:
`webhook_signing` (HMAC key for signing `final_output` POSTs) and
`subcommand_bearer` (Authorization bearer the publisher's shim verifies on
`task_tool` proxy calls). Stored plaintext because Murmur needs the
cleartext to sign / inject; the SQLite file is treated as a secret on par
with `MURMUR_TOKEN` (operator runbook).

| Column | Type | NULL? | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT PRIMARY KEY` | NO | Opaque secret row id. |
| `publisher_id` | `TEXT NOT NULL` | NO | FK → `publishers.id`. |
| `kind` | `TEXT NOT NULL` | NO | One of `webhook_signing`, `subcommand_bearer`. |
| `secret_value` | `TEXT NOT NULL` | NO | Plaintext secret. Read by webhook delivery (HMAC) and `task_tool` dispatch (Authorization bearer). |
| `prefix` | `TEXT NOT NULL` | NO | Operator-visible prefix (last 8 chars) for display. |
| `created_at` | `TEXT NOT NULL` | NO | Mint timestamp. |
| `revoked_at` | `TEXT` | YES | RFC 3339 when revoked; NULL while active. |

Foreign key: `publisher_id` REFERENCES `publishers(id)`.

Indexes:
- `idx_publisher_secrets_active` — non-unique on
  `(publisher_id, kind, created_at DESC) WHERE revoked_at IS NULL`.
  Drives the "most recent active secret of this kind" lookup used by
  webhook delivery and `task_tool` dispatch.

---

## `publisher_audit_events`

Machine-plane admin audit log. Records token mint/rotate/revoke,
publisher-config PATCH, and bootstrap operations.

| Column | Type | NULL? | Notes |
| --- | --- | --- | --- |
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | NO | Surrogate id for ordering. |
| `publisher_id` | `TEXT NOT NULL` | NO | FK → `publishers.id`. |
| `ts` | `TEXT NOT NULL` | NO | RFC 3339. |
| `action` | `TEXT NOT NULL` | NO | Free string — convention documented in `docs/auth.md`. No CHECK constraint so future kinds add without a migration. |
| `token_kind` | `TEXT` | YES | The token kind operated on, if applicable (e.g. `admin`, `runner`, `webhook_signing`, `subcommand_bearer`). |
| `actor_user_id` | `TEXT` | YES | User id for human-plane actions (M2). NULL for machine-plane / system actions. |
| `metadata_json` | `TEXT` | YES | Optional JSON blob with action-specific context. |

Foreign key: `publisher_id` REFERENCES `publishers(id)`.

Indexes:
- `idx_publisher_audit_pub_ts` — non-unique on `(publisher_id, ts)`.
  Drives `GET /publishers/me/audit` ordered traversal.

---

## Summary

Tables: `_migrations`, `pipelines`, `runs`, `subtask_instances`,
`subtask_results`, `agent_actions`, `publishers`, `publisher_tokens`,
`publisher_secrets`, `publisher_audit_events` (ten total — nine domain
tables plus the migrations bookkeeping table).

Domain indexes:
- `subtask_instances` × `claim_token` (UNIQUE, partial)
- `subtask_instances` × `(status, created_at)`
- `agent_actions` × `(instance_id, ts)`
- `pipelines` × `publisher_id`
- `publisher_tokens` × `secret_hash` (UNIQUE, partial: `WHERE revoked_at IS NULL`)
- `publisher_tokens` × `publisher_id`
- `publisher_secrets` × `(publisher_id, kind, created_at DESC)` partial
- `publisher_audit_events` × `(publisher_id, ts)`
