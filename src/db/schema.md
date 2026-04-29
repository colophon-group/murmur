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

No secondary indexes — primary key is the only access path for MVP.

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

## Summary

Tables: `_migrations`, `pipelines`, `runs`, `subtask_instances`,
`subtask_results`, `agent_actions` (six total — five domain tables
plus the migrations bookkeeping table).

Domain indexes:
- `subtask_instances` × `claim_token` (UNIQUE, partial)
- `subtask_instances` × `(status, created_at)`
- `agent_actions` × `(instance_id, ts)`
