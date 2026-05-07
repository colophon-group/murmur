-- 0004_skills: M5 skill registry foundation (issue #85).
--
-- Skills are publisher-authored content bundles delivered to agents via
-- MCP `resources/read`. A skill is identified by `(publisher_id, name,
-- version)` — versions are immutable once published; deprecation marks
-- a row as no-longer-recommended without deleting the data.
--
-- Numbering: M2 (#82) holds 0003 in PR #89. This migration takes 0004
-- so the two PRs can land in either order without renaming. The
-- migrations runner iterates in numeric prefix order; gaps are fine.

-- ---------------------------------------------------------------------------
-- skills — one row per `(publisher_id, name, version)` triple.
--
-- `manifest_json` holds the parsed `SKILL.md` frontmatter (loadable_by,
-- loads_on, on_demand) so the pipeline-binding validator + the MCP
-- resource server don't have to re-parse the markdown for every read.
-- ---------------------------------------------------------------------------
CREATE TABLE skills (
  id              TEXT PRIMARY KEY,
  publisher_id    TEXT NOT NULL REFERENCES publishers(id),
  name            TEXT NOT NULL,
  version         TEXT NOT NULL,
  description     TEXT NOT NULL,
  manifest_json   TEXT NOT NULL,
  deprecated_at   TEXT,
  created_at      TEXT NOT NULL
);

-- A `(publisher_id, name, version)` triple is fully pinned and unique.
-- Re-uploading the same triple returns 409 — version immutability is
-- the M5 contract.
CREATE UNIQUE INDEX idx_skills_triple
  ON skills(publisher_id, name, version);

-- Drives `GET /skills/{name}` (list versions of a named skill within
-- the caller's publisher).
CREATE INDEX idx_skills_pub_name
  ON skills(publisher_id, name);

-- ---------------------------------------------------------------------------
-- skill_files — flat-file content of a skill bundle.
--
-- One row per file in the bundle (SKILL.md, articles, examples, etc.).
-- `path` is the relative path inside the bundle (e.g. `SKILL.md`,
-- `_examples/foo.json`). `content` is UTF-8 text — markdown, YAML, JSON.
-- Binary files are out of scope for v1 (M5 Phase A spec is markdown +
-- JSON only).
-- ---------------------------------------------------------------------------
CREATE TABLE skill_files (
  id          TEXT PRIMARY KEY,
  skill_id    TEXT NOT NULL REFERENCES skills(id),
  path        TEXT NOT NULL,
  content     TEXT NOT NULL,
  byte_size   INTEGER NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_skill_files_skill_path
  ON skill_files(skill_id, path);

CREATE INDEX idx_skill_files_skill
  ON skill_files(skill_id);
