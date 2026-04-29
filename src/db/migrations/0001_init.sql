-- 0001_init: Initial Murmur SQLite schema.
--
-- See src/db/schema.md for the canonical reference. Any change to this
-- file is forbidden once committed — ship a new migration instead.
--
-- Statements are separated by `;` and executed in order. The migrations
-- runner wraps the whole file in BEGIN IMMEDIATE / COMMIT.

CREATE TABLE pipelines (
  id          TEXT PRIMARY KEY,
  version     INTEGER NOT NULL,
  def_json    TEXT    NOT NULL,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);

CREATE TABLE runs (
  id                  TEXT PRIMARY KEY,
  pipeline_id         TEXT NOT NULL REFERENCES pipelines(id),
  pipeline_version    INTEGER NOT NULL,
  status              TEXT NOT NULL,
  initial_input_json  TEXT NOT NULL,
  final_output_json   TEXT,
  webhook_url         TEXT NOT NULL,
  webhook_status      TEXT,
  created_at          TEXT NOT NULL,
  completed_at        TEXT
);

CREATE TABLE subtask_instances (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL REFERENCES runs(id),
  subtask_id          TEXT NOT NULL,
  parent_instance_id  TEXT REFERENCES subtask_instances(id),
  spawn_index         INTEGER,
  status              TEXT NOT NULL,
  claim_token         TEXT,
  expires_at          TEXT,
  input_json          TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_subtask_instances_claim_token
  ON subtask_instances(claim_token)
  WHERE claim_token IS NOT NULL;

CREATE INDEX idx_subtask_instances_ready
  ON subtask_instances(status, created_at);

CREATE TABLE subtask_results (
  instance_id   TEXT PRIMARY KEY REFERENCES subtask_instances(id),
  output_json   TEXT NOT NULL,
  notes         TEXT,
  submitted_at  TEXT NOT NULL
);

CREATE TABLE agent_actions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id    TEXT NOT NULL REFERENCES subtask_instances(id),
  ts             TEXT NOT NULL,
  kind           TEXT NOT NULL,
  subcommand     TEXT,
  args_json      TEXT,
  response_json  TEXT,
  truncated      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_agent_actions_instance_ts
  ON agent_actions(instance_id, ts);
