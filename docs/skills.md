# Skill registry (M5 Phase A)

**Status:** Phase A foundation. Schema + JSON-body upload + browse +
deprecation + pipeline-binding validator. Tarball / git-ref upload
forms, MCP `resources/list` + `resources/read` exposure, and
auto-load semantics ship in follow-ups.

A **skill** is a publisher-authored content bundle the agent loads to
gain a capability — domain knowledge, decision frameworks, schema
references, troubleshooting KBs. The agent never reads files from the
publisher's repo; Murmur stores content uploaded by the publisher and
serves it via API (and, in a follow-up, via MCP `resources/read`).

## Bundle shape

```
<skill-name>/
├── SKILL.md             # frontmatter + index + top-level overview (REQUIRED)
├── <article1>.md        # zero or more
├── <article2>.md
└── _examples/
    └── <example>.json
```

`SKILL.md` frontmatter (Phase A — minimum):

```yaml
---
name: <skill-name>           # kebab-case; matches the registry name
version: <semver>            # immutable once published
description: One-line summary
loadable_by: ["<pipeline-id>", ...]   # optional; default: any in same publisher
loads_on:
  - subtask: <id>             # auto-load into agent context for this subtask
on_demand: true               # also retrievable via skill_get / kb_search
---
```

The Phase A endpoint accepts the manifest as a separate JSON object;
the YAML frontmatter form is parsed by tooling on the publisher side
and posted as JSON. The follow-up tarball form will accept the YAML
verbatim and parse server-side.

## Phase-A interim upload form

Murmur accepts a JSON body — no tarball / git-ref handling yet:

```bash
curl -X POST https://murmur.example.org/skills \
  -H "Authorization: Bearer $ACME_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "add-company",
    "version": "1.0.0",
    "description": "Procedural guide for the add-company pipeline.",
    "manifest": {
      "loadable_by": ["jobseek-add-company"],
      "loads_on": [{"subtask": "pre-verify"}],
      "on_demand": true
    },
    "files": [
      { "path": "SKILL.md", "content": "---\nname: add-company\n..." },
      { "path": "duplicates.md", "content": "# Detecting duplicates ..." }
    ]
  }'
```

Response: `201` with the row id, name, version, file count, and total
byte size.

### Limits

| | Cap |
|---|---|
| Per-file size | 256 KB |
| Total bundle size | 4 MB |
| Files per bundle | 64 |
| File path | `^[A-Za-z0-9_][A-Za-z0-9_./-]*$` (no leading `/`, no `..`) |
| Skill name | `^[a-z][a-z0-9-]*[a-z0-9]$` |
| Version | `^[A-Za-z0-9.+_-]+$` |

`SKILL.md` MUST be present in `files`.

### Duplicate handling

`(publisher_id, name, version)` is UNIQUE. Re-uploading the same triple
returns `409 skill_triple_taken`. Bumping the version to publish a
correction is the supported workflow.

## Browse

```
GET /skills                          # all skills owned by the caller's publisher
GET /skills/{name}                   # versions of a named skill
GET /skills/{name}/{version}         # bundle metadata + parsed manifest
GET /skills/{name}/{version}/files   # list files in the bundle
GET /skills/{name}/{version}/files/{path}
                                     # read one file's content (UTF-8 text)
```

All gated by `publisherAuth(db)`; admin OR runner role suffices for
reads. Cross-publisher reads return `404 skill_not_found` (no
information leak about whether the slug exists in another tenant).

## Deprecation

```
DELETE /skills/{name}/{version}      # marks deprecated_at; admin-only
```

Deprecated bundles remain readable — in-flight runs continue, and
operators can still browse the content. A future M5-followup adds a
90-day retention sweeper that purges files (but not the row, for
audit). Re-deprecating already-deprecated returns `409
skill_already_deprecated`.

`name@latest` resolution skips deprecated versions when resolving.

## Pipeline binding (validator landed; consumer in M5-followup)

`validatePipelineSkillRefs(db, publisher_id, refs)` resolves a list of
`<publisher>/<name>@<version>` (or bare `<name>@<version>`) refs from a
pipeline def. Returns:

- `{ ok: true, resolved: Map<originalRef, canonicalRef> }` when every
  ref exists. `name@latest` resolves to the most-recent non-deprecated
  version at registration time and snapshots into the resolved set.
- `{ ok: false, errors: [...] }` with `validation:<path>:<reason>`
  strings on any miss.

Cross-publisher refs are rejected (`cross_publisher_skill_ref_unsupported`)
in v1 — Phase 1 scope is same-publisher skills only.

The pipeline-routes consumer wiring (i.e., calling the validator from
`POST /pipelines`) extends the M0 pipeline-def schema to include a
`skills` field, which is its own contract change. That lands in a
follow-up.

## Storage

Phase-A stores bundle files as flat rows in `skill_files` (UTF-8 text,
indexed by `(skill_id, path)`). One row per file. The follow-up
tarball / git-ref ingestion forms unpack into the same rows; the row
shape is the canonical store regardless of upload form.

## MCP resource exposure (follow-up)

The MCP `resources/list` + `resources/read` integration ships in a
follow-up. The URI scheme is fixed:

```
murmur://skills/<publisher>/<name>@<version>/SKILL.md
murmur://skills/<publisher>/<name>@<version>/<article>.md
```

When a run reaches a subtask whose bound skills declare
`loads_on.subtask: <id>`, Murmur will expose those skills' resources
with an `auto_load: true` flag in `resources/list` so cooperative agent
runtimes pre-load them.

## Phase 2

- Skill diffing in dashboard (M4)
- Lint rules on `SKILL.md` shape
- `kb_search` over skill content
- Cross-publisher skills (publisher_x consumes publisher_y/some-skill)

## Cross-references

- `src/db/migrations/0004_skills.sql` — schema
- `src/api/publisher/skills.ts` — endpoints + `validatePipelineSkillRefs`
- `src/api/publisher/skills.test.ts` — test matrix
