# Boundary contracts

This document is the single source of truth for the seven cross-repo
boundary contracts between **Murmur** (`colophon-group/murmur`) and
**jobseek** (`colophon-group/jobseek`). Both sides reference this file
when implementing.

Authoritative artefacts:

- This document — prose + canonical examples.
- [`docs/contracts/pipeline-def.schema.json`](./contracts/pipeline-def.schema.json) — JSON Schema (draft 2020-12) for pipeline-def upserts.
- [`docs/contracts.py`](./contracts.py) — Python typed dataclasses for jobseek's crawler refactor.
- [`packages/contracts-types/`](../packages/contracts-types) — TypeScript types package consumed by Murmur core and jobseek's TS surface (`apps/web`).
- [`docs/contracts/fixtures/all-seven.json`](./contracts/fixtures/all-seven.json) — single fixture exercising every contract; both runtimes parse it without errors.

> **Casing is locked.** The header-name string constants in this document
> are exported verbatim from `@murmur/contracts-types/headers.ts` and
> `docs/contracts.py`. HTTP headers are case-insensitive on the wire, but
> the constants are the single source of truth for tests, docs, and
> generated code.

> **Envelope is locked.** Every Murmur agent-facing endpoint and every
> jobseek subcommand route returns the envelope `{ ok, errors?, data? }`
> defined in §4. There is no parallel `{ accepted: ... }` shape.
> Enforced by `scripts/grep-no-accepted-key.sh` (gate name:
> `grep:no-accepted-key`).

---

## 1. Pipeline-def YAML schema

A pipeline def is published to Murmur via authenticated `POST /pipelines`.
The body is YAML or JSON; Murmur converts YAML → JSON and validates against
[`docs/contracts/pipeline-def.schema.json`](./contracts/pipeline-def.schema.json).

> JSON Schema is written **directly** in YAML. There is **no shorthand
> preprocessor**. (DESIGN.md §3.1.)

### 1.1 Top-level shape

```yaml
id: <slug>                          # required, kebab-case
version: <int>                      # set by Murmur on upsert; clients omit
initial_input:                      # required, JSON Schema
  type: object
  properties: { ... }
subtasks:                           # required, ≥1
  - id: <slug>
    instructions: <string>
    inputs:                         # optional; default = previous subtask's output
      - from: <subtask-id>
        path: <json-pointer>        # optional; default = whole output
    output_schema:                  # required, JSON Schema
      type: object
      properties: { ... }
    subcommands:                    # optional
      - name: <subcommand name>
        endpoint: POST <url>        # METHOD + space + URL
        input_schema: { ... }       # JSON Schema, optional
    spawns:                         # optional; for dynamic instantiation
      for_each: <field-on-output>
      template: <subtask-id>
      bind_as: <input-key>          # optional; child sees { [bind_as]: element }
    requires: [<subtask-id>, ...]   # optional; explicit DAG edges
    skip_if: { ... }                # optional; JSONLogic-style — DEFERRED for MVP
final_output:
  composes: [<rule>, ...]           # see §7
  webhook: <https-url>
```

### 1.2 Constraints

- Subtask `id` values are unique within a pipeline.
- Subcommand `name` values are unique within a subtask.
- `endpoint` MUST be `POST <https-url>` (HTTPS required; HTTP rejected).
- `webhook` MUST be `https://...`.
- `output_schema` is required on every subtask. `submit_result` validates
  the agent's submission against it; failures fail the run (no retry).

### 1.3 Canonical example

See [`docs/contracts/fixtures/all-seven.json`](./contracts/fixtures/all-seven.json) (`pipeline_def` section)
for the demo pipeline `jobseek-add-company` with all four demo-path
subtasks declared.

---

## 2. `MURMUR_TOKEN` format and lifetime

A single shared bearer token, used by every Murmur boundary.

### 2.1 Format

- Opaque ASCII string.
- Length **≥ 32 characters**.
- Characters from the URL-safe base64 alphabet only: `[A-Za-z0-9_-]`.
- Recommended issuer: `crypto.randomBytes(32).toString("base64url")`.

### 2.2 Use

Required on every request as `Authorization: Bearer <MURMUR_TOKEN>`:

- Agents → Murmur (MCP transport + publisher API).
- Publishers → Murmur (`POST /pipelines`, `POST /pipelines/{id}/runs`, `GET /runs/{id}`).
- Murmur → publisher subcommand endpoints (proxied `task_tool` calls).
- Murmur → publisher webhook URL.

### 2.3 Comparison

Server-side comparison MUST be timing-safe (`crypto.timingSafeEqual` in
Node, `hmac.compare_digest` in Python). Naked `==` is forbidden by the
`grep:no-naked-eq-in-auth` gate.

### 2.4 Lifetime

- Rotated **per deployment**. There is no expiry encoded in the token.
- Single active token at a time. Multiple concurrent tokens are not
  supported in MVP.
- Stored in env var `MURMUR_TOKEN` on the server box; never logged
  (gate: `grep:no-secrets-logged`).

### 2.5 Canonical request

```
POST /pipelines/jobseek-add-company/runs HTTP/1.1
Host: murmur.colophon-group.org
Authorization: Bearer Z2hzX01VUk1VUl9ERU1PXzAxX1RPS0VOX1ZBTFVF
Content-Type: application/json

{ "initial_input": { "company_name": "Example Co", "website": "https://example.co" } }
```

---

## 3. Proxy header set: `X-Murmur-Subcommand` + `X-Murmur-Claim-Token`

When the agent calls `task_tool('<subcommand>', '<claim>', args)`, Murmur
proxies a `POST` to the subcommand's `endpoint`. Two custom headers ride
along.

### 3.1 Header names (exact casing)

| Constant                    | Header on the wire        |
|-----------------------------|---------------------------|
| `AUTHORIZATION`             | `Authorization`           |
| `X_MURMUR_SUBCOMMAND`       | `X-Murmur-Subcommand`     |
| `X_MURMUR_CLAIM_TOKEN`      | `X-Murmur-Claim-Token`    |
| `IDEMPOTENCY_KEY`           | `Idempotency-Key`         |

These exact strings are exported from
[`packages/contracts-types/src/headers.ts`](../packages/contracts-types/src/headers.ts)
and [`docs/contracts.py`](./contracts.py). Tests pin both against the
strings above (see §3.4).

### 3.2 Semantics

- **`X-Murmur-Subcommand`**: subcommand name as declared in the pipeline
  def (e.g. `probe monitor`, `select scraper`, `feedback`).
- **`X-Murmur-Claim-Token`**: the canonical session key publishers MUST
  use to keep claim-scoped state across subcommand calls. **NOT** the
  agent's MCP session ID. Load-bearing for ws-style flows where
  `select monitor --as cfg-1`, `run monitor --config cfg-1`, and
  `feedback` all share state. (DESIGN.md §3.3.)

### 3.3 Canonical proxied request

```
POST /api/murmur/probes/monitor HTTP/1.1
Host: jobseek.colophon-group.org
Authorization: Bearer Z2hzX01VUk1VUl9ERU1PXzAxX1RPS0VOX1ZBTFVF
X-Murmur-Subcommand: probe monitor
X-Murmur-Claim-Token: c_a1b2c3d4e5f6
Content-Type: application/json

{ "board_url": "https://job-boards.greenhouse.io/exampleco", "expected_count": 47 }
```

### 3.4 Phase A test (smoke)

Both sides import the constants from the contracts artefact and assert
they equal the strings in §3.1 verbatim (TypeScript: `expect(MurmurHeaders.X_MURMUR_SUBCOMMAND).toBe("X-Murmur-Subcommand")`;
Python: `assert HEADER_X_MURMUR_SUBCOMMAND == "X-Murmur-Subcommand"`).

---

## 4. `task_tool` request/response envelope

The same envelope is used by:

- `pull_task` (agent → Murmur)
- `submit_result` (agent → Murmur)
- `task_tool` (agent → Murmur → publisher subcommand → back)
- All built-in subcommands (`help`, `kb search`, `kb view`, `blocked`, `status`).
- All publisher subcommand routes hosted by jobseek under `/api/murmur/...`.

### 4.1 Shape

```ts
type EnvelopeResponse<T = unknown> =
  | { ok: true;  data?: T }
  | { ok: false; errors: Array<string | ValidationError> };
```

- `ok` is the discriminator. Consumers MUST narrow before reading `data` or `errors`.
- `data` is optional; an OK response with no payload is `{ "ok": true }`.
- `errors` is required on the failure branch and SHOULD be non-empty. Each
  entry is either a short token (e.g. `"publisher_timeout"`,
  `"claim_lost"`, `"validation_failed"`) or a `ValidationError` for
  per-field schema failures (see §5).

### 4.2 Canonical OK response

```json
{
  "ok": true,
  "data": {
    "monitor_type": "greenhouse",
    "monitor_config": { "token": "exampleco" },
    "live_count": 47
  }
}
```

### 4.3 Canonical error responses

```json
{ "ok": false, "errors": ["claim_lost"] }
```

```json
{ "ok": false, "errors": ["publisher_timeout"] }
```

```json
{ "ok": false, "errors": ["publisher_5xx", "503"] }
```

### 4.4 Single-envelope rule

There is no `{ "accepted": true, ... }` parallel envelope. The
`grep:no-accepted-key` gate fails CI if `\baccepted:\s` appears in source
or test files outside `_legacy/`. The gate covers TS/JS file extensions
under `src/`, `packages/*/src/`, `apps/*/src/`, and the matching `test/`
trees. (DESIGN.md §3.4 mentions `{ accepted: true | false }` for the
old `submit_result` shape; that text is **superseded by this contract**
and will be reconciled when DESIGN.md is next revised.)

---

## 5. `submit_result` validation-error shape

When the agent's `result` fails the subtask's `output_schema`, Murmur
returns the failure envelope from §4 with one `ValidationError` per
failing field.

### 5.1 Shape

```ts
interface ValidationError {
  path: string;     // JSON Pointer per RFC 6901; "" denotes the root
  message: string;  // human-readable; may change between versions
  code?: string;    // stable token: "required" | "type" | "enum" | …
}
```

### 5.2 JSON Pointer rules

- Empty string `""` denotes the document root.
- Tokens separated by `/` (e.g. `/per_field/title/selector`).
- Array indices use the integer (e.g. `/boards/0/board_url`).
- The `/` and `~` characters in a token are escaped as `~1` and `~0`
  respectively (RFC 6901 §3).

### 5.3 Canonical error response

```json
{
  "ok": false,
  "errors": [
    { "path": "/monitor_config/token", "message": "must be string", "code": "type" },
    { "path": "/per_field/title", "message": "required field missing", "code": "required" }
  ]
}
```

---

## 6. Webhook contract

When all subtasks of a run complete, Murmur POSTs the composed
`final_output` to the publisher's webhook URL.

### 6.1 Request

The HTTP body **is** the composed `final_output` — no envelope, no
wrapper around it. Per-run metadata travels in headers:

- `Authorization: Bearer <MURMUR_TOKEN>` — same token as everywhere else.
- `Idempotency-Key: <run_id>` — stable run identifier; the publisher
  dedupes on this key (see §6.3).
- `Content-Type: application/json`.

```
POST /api/murmur/accept HTTP/1.1
Host: jobseek.colophon-group.org
Authorization: Bearer Z2hzX01VUk1VUl9ERU1PXzAxX1RPS0VOX1ZBTFVF
Idempotency-Key: r_8a91d4
Content-Type: application/json

{ /* the composed final_output — see §7 for the composition rules and
     a worked example. Keys are pipeline-specific. */ }
```

The TS type `WebhookPayload` (in `@murmur/contracts-types`) names the
body as `Readonly<Record<string, unknown>>` — its concrete shape is
determined by the pipeline def's `final_output.composes`. If future
publishers need additional metadata (pipeline id, version, completion
timestamp), surface it as `X-Murmur-*` headers — never nest it inside
the body.

### 6.2 Auth

`Authorization: Bearer <MURMUR_TOKEN>`. Same token as everywhere else.
The publisher MUST verify the bearer (timing-safe) before reading the
body.

### 6.3 Idempotency

- Header `Idempotency-Key` carries the run id.
- Publisher MUST treat this key as a transactional dedupe key, backed by
  a UNIQUE constraint on the writer's catalog table (DESIGN.md §3.6,
  §4.1).
- Already-applied keys MUST return 2xx (idempotent success); the body is
  ignored by Murmur.

### 6.4 Dedupe window

Demo-grade: **durable on the writer side**, no expiring cache. The
constant `WEBHOOK_DEDUPE_WINDOW_MS` is `null` in the TS package and
`None` in the Python module to encode this explicitly.

### 6.5 Retry policy

- Murmur retries **exactly once** on non-2xx, after **30 seconds**.
- After the retry, the run is marked `webhook_failed`; the publisher
  reconciles via `GET /runs/{run_id}`.
- Constants: `WEBHOOK_RETRY_COUNT = 1`, `WEBHOOK_RETRY_DELAY_MS = 30_000`.

### 6.6 Response

Body content is ignored. Publishers SHOULD return `{ "ok": true }` for
symmetry with §4 but it is not required.

---

## 7. `final_output.composes` flattening rules

The pipeline def's `final_output.composes` is an ordered array of rule
strings that produce `final_output` from subtask outputs.

### 7.1 Rule grammar

Four primitives. A rule is one of:

1. **Wildcard expansion** — `<subtask>.*`
   Copies every top-level field of `<subtask>`'s output into
   `final_output` at the same key.

2. **Field rename** — `<key>: <subtask>.<field>` or `<key>: <subtask>.*`
   Places the subtask's field (or whole output) at `final_output[<key>]`.

3. **Cartesian product** — `<key>: <list_subtask>.<list_field> × <spawn_subtask>.*`
   Pairs each element of `<list_field>` with the corresponding spawned
   instance's output. Pairing is **by index** (the order in which Murmur
   instantiated children from the parent's array). Each output element is
   `{ ...listItem, ...spawnOutput }` — listItem fields take precedence on
   key collision; spawnOutput overwrites only fields not already set by
   the listItem.

4. **Flatten** — `<key>: flatten([<subtask>, ...].<field>)`
   Collects the array `<field>` from each named subtask's output (or, if
   the subtask uses `spawns`, from every spawned instance) and
   concatenates the arrays into `final_output[<key>]`. Order: by subtask
   list order, then by spawn instance order.

### 7.2 Resolution

- Rules apply in array order; later rules can overwrite earlier ones.
- A missing source subtask is an error (run fails) unless the rule reads
  an optional field, in which case the field is omitted.
- Wildcards (`.*`) skip undefined values.

### 7.3 Canonical example (jobseek-add-company)

Pipeline def:

```yaml
final_output:
  composes:
    - pre-verify.canonical_*
    - setup-metadata.*
    - "boards: list-boards.boards × configure-board.*"
    - "kb_entries: flatten([pre-verify, setup-metadata, list-boards, configure-board].kb_entries)"
    - "case_studies: flatten([pre-verify, setup-metadata, list-boards, configure-board].case_studies)"
  webhook: https://jobseek.colophon-group.org/api/murmur/accept
```

(Note: `pre-verify.canonical_*` is field-prefix wildcard sugar — copies
every field of `pre-verify`'s output whose key starts with `canonical_`.
This is a documented extension to rule (1) and is included in the JSON
Schema's `composes` enum-of-patterns.)

Resulting `final_output`:

```json
{
  "canonical_name": "ExampleCo",
  "canonical_website": "https://example.co",
  "slug": "exampleco",
  "description": "...",
  "industry_ids": ["software", "saas"],
  "boards": [
    {
      "alias": "careers",
      "board_url": "https://job-boards.greenhouse.io/exampleco",
      "provider": "greenhouse",
      "outcome": "configured",
      "monitor_type": "greenhouse",
      "monitor_config": { "token": "exampleco" },
      "scraper_type": "greenhouse",
      "scraper_config": { "...": "..." },
      "verdict": "ok",
      "per_field": { "...": "..." }
    }
  ],
  "kb_entries": [],
  "case_studies": []
}
```

---

## Appendix A — Single-envelope grep gate

`scripts/grep-no-accepted-key.sh` searches under `src/` and `test/` for
the literal `accepted:` JSON-key shape (`\baccepted\b\s*:`), excluding
paths matching `_legacy`. Wire it via `pnpm grep:no-accepted-key` and
include it in `pnpm grep:all`.

## Appendix B — Cross-references

| Issue | Phase | What this contract unblocks |
|---|---|---|
| #22 (D5) | A | Streamable HTTP spike — needs §3 header constants only. |
| #6 (M1) | B | Project skeleton — depends on TS package layout. |
| #9 (M4) | B | Atomic claim — uses §4 envelope on `pull_task`. |
| #10 (M5) | B | Submit result — uses §4 envelope + §5 ValidationError. |
| #12 (M7) | B | task_tool dispatch — §3 + §4. |
| #14 (M9) | B | Webhook delivery — §6. |
| #15 (M10) | B | composes flattening — §7. |
| #16 (M11) | B | Auth + bearer — §2. |
| jobseek #2755…#2763 | B | Crawler refactor consumes `docs/contracts.py`. |
