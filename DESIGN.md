# Murmur — Design Spec (MVP)

**Status:** Draft, MVP for theory-validation demo
**Date:** 2026-04-28

Murmur is the **infrastructure layer between publisher apps and user agents** — between apps that need decision work done, and the coding agents (Claude Code, Cursor, …) already running in users' IDEs. Publishers expose pipelines of small decision subtasks; user agents in their owners' environments pull a subtask, complete it in-session, and submit a structured result. Murmur does not invent agent cognition — it orchestrates existing cognition (claims, schemas, dynamic per-board fan-out, conditional skip, lifecycle hooks) and stitches results back to the publisher. The protocol is closer to a typed, claim-based workflow runtime than a thin router — the §3.1 primitives (`spawns`, `skip_if`, claim TTL, schema-snapshot, audit log) reflect that. The first publisher and demo target is jobseek (intentionally a simple first case); the protocol is publisher-agnostic by design.

---

## 1. Hypothesis

The product theory has three layers:

1. **Protocol viability (layer 1)** — the protocol can deliver a publisher's task definition + per-subtask context to a foreign agent in a way the agent can act on end-to-end, without app-specific tooling on the agent side.
2. **Discovery (layer 2)** — agents can find work worth doing across many publishers.
3. **Economics (layer 3)** — agent-owners actually want to spend idle subscription credits this way.

**This MVP tests layer 1 only.** Explicitly *not* under test:

- Whether agents are intelligent enough to do useful work (assumed yes — every Claude Code session is daily evidence).
- Whether jobseek's particular task is hard or easy (it's a deliberately simple first case so the protocol stays the variable).
- Discovery and economics (layers 2 and 3 — different evidence required, real users and time).

- **Confirming signals (both must hold):**
  1. A Claude Code agent in a fresh empty directory completes a jobseek crawler-config pipeline via Murmur end-to-end (pull → probe via `task_tool` → submit, three subtasks, webhook accepted).
  2. **Audience picks the specific company live from a list of 3 pre-validated candidates.** This shows we rehearsed breadth (3 boards across providers), not just one cherry-picked URL. We are *not* claiming this proves generalization beyond the rehearsed set — that's a separate research question.
- **Falsifying signals (any one breaks the demo):**
  - Agent can't act on a subtask without operator hints not in the protocol.
  - The round-trip loses fidelity such that jobseek's accept handler needs operator repair.

Discovery and economics (layers 2 and 3) require real users and time; this MVP doesn't pretend to test them.

**The protocol, in one paragraph:** Three static MCP tools — `pull_task`, `submit_result`, `task_tool` — exposed by a Murmur server speaking Streamable HTTP. Publishers POST pipeline definitions (YAML: subtasks with instructions, schemas, optional subcommands wrapping publisher HTTP endpoints) and POST runs to start work. Agents pull a subtask, optionally invoke publisher subcommands via `task_tool` (Murmur proxies to publisher HTTP), and submit a structured result. When all subtasks of a run finish, Murmur webhooks the composed `final_output` back to the publisher.

---

## 2. Demo script

A scripted ~3-minute run executed live.

**Pre-staged before demo:**

- Murmur deployed to its Hetzner box, reachable at the public URL.
- The `jobseek/add-company` pipeline registered with Murmur.
- 3 candidate jobseek companies pre-tested end-to-end against the full pipeline; URLs/names on a slide.
- One terminal showing Claude Code in a fresh empty directory; one terminal/browser showing jobseek.

**Live:**

1. Show the empty directory and the one-line MCP entry in `~/.claude/mcp.json` pointing at Murmur's public URL. (Bearer token in the entry; not on the slide.)
2. **Audience picks one of 3 pre-validated companies on the slide.** Operator triggers a jobseek run with that input.
3. Prompt Claude Code: *"Pull a Murmur task and complete it. Repeat until no more tasks."*
4. Agent calls `pull_task` → receives `pre-verify`. Confirms via `task_tool('search companies', ...)` and submits.
5. Agent calls `pull_task` → receives `list-boards`. Uses built-in web fetch (and `task_tool('analyze hreflang', ...)` if needed) to find the board URL(s); submits.
6. Agent calls `pull_task` → receives `configure-board` (one instance per board the agent listed). Reads `instructions` telling it to use `task_tool('probe monitor', ...)`, then `select monitor`, `run monitor`, `feedback`, etc.
7. Agent iterates on probes/runs, then calls `submit_result` with `monitor_type`/`monitor_config`/`scraper_*`/`verdict`/`per_field`. (For the demo company we pick a single-board greenhouse target so this completes in one configure-board pass.)
8. Switch to jobseek view: `final_output` arrives via webhook, accept handler re-runs the same probe logic in-process, writes the audience-chosen company to jobseek's catalog (Postgres). Visible on screen.

For the demo we deliberately use the demo-minimum subset (§5.1): the chosen company has one board, no `setup-metadata` rich fields, no KB authoring. The full §3.1 pipeline shape applies to non-demo runs.

**Landing line:** *"That agent had never seen jobseek. Audience-chosen input. The protocol carried what jobseek decided to put in it — Murmur's job is to route, not to know."*

---

## 3. Protocol

Two surfaces: an HTTP API for publishers, an MCP server for agents. Both are thin wrappers around the same store.

**Vocabulary used throughout this section:**

- **Pipeline** — a publisher's task definition (YAML): an ordered list of subtask defs. Versioned; immutable once a run starts.
- **Subtask def** — one entry in a pipeline's `subtasks:` list. Authoring-time concept.
- **Run** — one execution of a pipeline, triggered by the publisher with an `initial_input`. Pinned to the pipeline version at start.
- **Subtask instance** — the runtime occurrence of a subtask def within a run. The thing agents claim.
- **Claim** — a time-limited lease on a specific subtask instance, identified by `claim_token`. Issued by `pull_task`, consumed by `submit_result`. Bound to the token, not to the agent's MCP session. Throughout the doc, the agent-facing argument is named `claim` and its value is the `claim_token`; "claim" and "claim_token" refer to the same thing.
- **Subcommand** — a publisher-declared callable under a subtask def, invoked by the agent through `task_tool('<name>', {...})`.
- **Publisher** — an app that registers pipelines and accepts `final_output` via webhook.
- **Agent** — a coding agent (Claude Code, Cursor, …) running in a user's environment, connected to Murmur over MCP.
- **Host** — the runtime that loads MCP tools and hands them to the agent's model (Claude Code, Cursor, …). The agent's MCP "host."

### 3.1 Pipeline definition

YAML, authored by the publisher, registered to the server.

```yaml
id: jobseek/add-company
webhook: https://jobseek.colophon-group.org/api/murmur/accept
initial_input_schema:
  company_name: string
  website: string
subtasks:
  - id: pre-verify
    instructions: |
      Confirm this is a real, non-duplicate company with a careers page.
      Use task_tool('search companies', {q: ...}) to check duplicates;
      task_tool('verify company', {website: ...}) to confirm it exists.
      If reject: set verified=false and pick a reject_reason.
    inputs: [init.company_name, init.website]
    outputs:
      verified: boolean
      canonical_name: string
      canonical_website: string
      reject_reason: enum [duplicate, not-a-company, company-not-found, no-job-board, no-open-positions, subsidiary]?
      reject_message: string?
      parent_slug: string?    # set when reject_reason=subsidiary
      kb_entries: array?      # optional learnings from this step
      case_studies: array?
    subcommands:
      - name: search companies
        endpoint: POST https://jobseek.colophon-group.org/api/murmur/companies/search
        input_schema:  { q: string }
        output_schema: { matches: array }
      - name: verify company
        endpoint: POST https://jobseek.colophon-group.org/api/murmur/companies/verify
        input_schema:  { website: string }
        output_schema: { exists: boolean, careers_page: string, errors: array }

  - id: setup-metadata
    skip_if: { "!": [{ "var": "pre-verify.verified" }] }   # short-circuits list-boards and configure-board
    instructions: |
      Pick logos, write descriptions in en/de/fr/it, set industry, founded
      year, employee count range. Use task_tool('discover company', ...)
      to kick off auto-discovery; task_tool('list logo candidates') to
      review; task_tool('taxonomy search', ...) for industry IDs.
    inputs: [pre-verify.canonical_name, pre-verify.canonical_website]
    outputs:
      logo_url: string
      icon_url: string
      logo_type: enum
      descriptions: { en: string, de: string, fr: string, it: string }
      industry_id: string
      employee_count_range: integer
      founded_year: integer
      kb_entries: array?
      case_studies: array?
    subcommands:
      - name: discover company
        endpoint: POST https://jobseek.colophon-group.org/api/murmur/discover
      - name: list logo candidates
        endpoint: POST https://jobseek.colophon-group.org/api/murmur/discover/logos
      - name: taxonomy search
        endpoint: POST https://jobseek.colophon-group.org/api/murmur/taxonomy/search

  - id: list-boards
    skip_if: { "!": [{ "var": "pre-verify.verified" }] }
    instructions: |
      Discover all distinct boards (hreflang variants, regional/functional
      splits). Use task_tool('analyze hreflang', ...) for variants and
      task_tool('infer link pattern', ...) when needed. Capture provider
      hints, hreflang lang/region, and traversal source so configure-board
      can reuse them. Cross-board reconciliation (mirrors, subsets) runs
      in the accept handler — don't try to dedupe yourself.

      Consolidate parametrized variants of the SAME ATS instance into ONE
      entry. E.g., Accenture's 12 country/language pages on www.accenture.com
      are one Accenture monitor with a parametrization list, not 12 boards.
      Same for Oracle HCM sites under one tenant.
    inputs: [pre-verify.canonical_website]
    outputs:
      boards:
        type: array
        items:
          alias: string
          url: string
          provider_hint: enum?        # greenhouse|lever|workday|...
          hreflang_lang: string?
          hreflang_region: string?
          source: enum?               # careers-page | hreflang | manual | parent-portal
          job_link_pattern: string?
      kb_entries: array?
      case_studies: array?
    spawns:
      for_each: boards
      template: configure-board
      bind_as: board                  # spawned subtask sees `board` in its inputs
    subcommands:
      - name: analyze hreflang
        endpoint: POST https://jobseek.colophon-group.org/api/murmur/boards/hreflang
      - name: infer link pattern
        endpoint: POST https://jobseek.colophon-group.org/api/murmur/boards/infer-pattern

  - id: configure-board    # template; instantiated per board by list-boards.spawns
    instructions: |
      Configure monitor and (when needed) scraper for this board, OR mark
      the board as not-real / redundant / parent-portal so the accept handler
      can drop it. The `outcome` field is the routing decision.

      Standard procedure (outcome=configured):
        1. task_tool('probe monitor', { board_url, expected_count }) — review
           the cost-ranked list of monitor types it returns.
        2. Pick a candidate type. task_tool('select monitor',
           { type, name: 'cfg-1', config: {...} }).
        3. task_tool('run monitor', { config: 'cfg-1' }) — verify the count
           is close to expected and samples look right.
        4. If the count is wrong, FIRST try iterating config (filters,
           pagination, url_transform) under a new name 'cfg-2'. Only switch
           monitor type after config iteration fails.
        5. Once monitor is good: if it's an auto-configuring type
           (greenhouse, lever, ashby, rss), skip to step 7. Otherwise
           task_tool('probe scraper'), then 'select scraper', then
           'run scraper'. Iterate config the same way.
        6. task_tool('feedback', { verdict, per_field: {...} }).
        7. submit_result with outcome='configured' and the populated
           monitor/scraper fields.

      Non-standard outcomes (skip steps 1-7 and submit immediately):
        - outcome='phantom' — probes confirm the URL exists but has no real
          listings (not a temporary 0; structurally empty: 404, login wall,
          parked domain). Set phantom_evidence with what you saw.
        - outcome='parent-portal' — careers page redirects to a parent
          company's portal (SWISS → Lufthansa Group, Fiat → Stellantis).
          Set parent_company_hint. Accept handler drops this board and
          may queue a fresh run for the parent.
        - outcome='unsupported' — board exists with real jobs but no
          monitor type extracts them well (e.g., custom JS app no probe
          handles). Set evidence; accept handler may file a follow-up.

      task_tool('help <name>') for schema details. task_tool('kb search', { q })
      if you hit something unfamiliar.
    inputs: [board]
    outputs:
      outcome: enum [configured, phantom, parent-portal, unsupported]
      # Populated only when outcome=configured:
      monitor_type: enum?
      monitor_config: object?
      scraper_type: enum?       # nullable when monitor auto-configures
      scraper_config: object?
      verdict: enum [good, acceptable, bad]?
      per_field: object?        # title=excellent|good|... etc.
      # Populated for non-configured outcomes:
      phantom_evidence: string?       # outcome=phantom
      parent_company_hint: string?    # outcome=parent-portal (slug or URL)
      unsupported_reason: string?     # outcome=unsupported
      # Optional learnings captured at this step:
      kb_entries: array?
      case_studies: array?
    subcommands:
      - { name: probe monitor,   endpoint: POST .../probes/monitor-all }
      - { name: select monitor,  endpoint: POST .../select/monitor }
      - { name: run monitor,     endpoint: POST .../run/monitor }
      - { name: probe scraper,   endpoint: POST .../probes/scraper-all }
      - { name: select scraper,  endpoint: POST .../select/scraper }
      - { name: run scraper,     endpoint: POST .../run/scraper }
      - { name: probe deep,      endpoint: POST .../probes/deep }
      - { name: probe api,       endpoint: POST .../probes/api }
      - { name: feedback,        endpoint: POST .../feedback }
      - { name: reject-config,   endpoint: POST .../select/reject }

final_output:
  composes:
    - pre-verify.canonical_*
    - setup-metadata.*
    - boards: list-boards.boards × configure-board.*
    - kb_entries: flatten([pre-verify, setup-metadata, list-boards, configure-board].kb_entries)
    - case_studies: flatten([pre-verify, setup-metadata, list-boards, configure-board].case_studies)
  webhook: https://jobseek.colophon-group.org/api/murmur/accept
```

This pipeline def — pipeline shape only, schemas truncated for readability — covers ws's full workflow. The full mapping is in §9. Each subtask explicitly declares its own `kb_entries` and `case_studies` optional outputs; the publisher's `composes` rule flattens them into `final_output`. Murmur has no special "universal field" — the publisher decides which subtasks may author KB content.

Subtasks are pure decisions: `instructions + input → output`. No side effects on Murmur's side, no filesystem, no built-in app-specific tools. When a subtask benefits from verification, the publisher declares **subcommands** under that subtask (see §3.4 for dispatch semantics).

**Schema fields beyond the basic example.** The pipeline-def schema also supports the following, used to host non-trivial workflows like jobseek's `ws`:

- `skip_if` — JSONLogic-style expression on prior outputs. If true, the subtask is auto-completed with an empty output and the run advances. Used for conditional steps (e.g., "skip downstream subtasks when `pre-verify.verified` is false").
- `spawns` — declares that this subtask's output triggers dynamic instantiation of one child subtask per item in a named list field. Example: a `list-boards` subtask returning `{boards: [...]}` with `spawns: { for_each: boards, template: configure-board }` causes Murmur to instantiate one `configure-board` subtask per discovered board, in order. Replaces the "fixed subtask list" assumption when N is discovered at runtime.
- `requires` — IDs of subtasks whose outputs are inputs. Replaces the implicit "next in list" ordering. Murmur uses `requires` to compute the ready set; siblings without ordering constraints are eligible to be claimed concurrently (post-MVP — see §5).
- `notes` parameter on `submit_result` — agents may pass an optional free-text `notes` arg alongside the structured `result`. Persisted in the audit log; not part of the schema-validated output. Hosts ws's reflection-per-step concept without colliding with publisher schemas that legitimately use field names like `notes` or `_notes`.

### 3.2 Server endpoints (publisher-facing)

- `POST /pipelines` — register/upsert a pipeline def. Returns `{id, version}`.
- `POST /pipelines/{id}/runs` — start a run. Body: `{initial_input, prior_outputs?: {<subtask_id_or_path>: <output>}}`. `prior_outputs` pre-fills subtask outputs at run-start; those subtasks are skipped. Used for ws-style **reconfig** runs (start a new run from an existing company's prior data, then redo only the subtasks the operator wants redone). Validation runs at registration: pre-filled outputs must satisfy the subtask's `output_schema`; malformed runs are rejected with 4xx. Interaction with `spawns`: pre-filling a `spawns` parent (e.g., `list-boards.boards: [...]`) **does** trigger the spawn — children are instantiated as if the parent had submitted normally. To pre-fill specific spawned children, address by composite path: `"configure-board[alias=careers-de]": { ... }` — Murmur skips that child when it would otherwise be claimed. Children without `prior_outputs` claims run normally; this is how "redo only the German board" works. Returns `{run_id}`.
- `GET /runs/{run_id}` — poll status, final output, and (for the publisher) the run-level audit log: ordered list of `{subtask_id, claim, started_at, submitted_at, output, notes, agent_actions: [...]}`. Used for ws's trace-export.
- `POST {webhook}` — server pushes `final_output` to the publisher when the run completes (bearer-authed, idempotent on `run_id` — see §3.6).

### 3.3 Server endpoints (agent-facing, behind MCP)

- `GET /work/next` — atomically claim the oldest unclaimed subtask instance across all pipelines, or 204. Implementation: single statement `UPDATE subtask_instances SET claim_token=?, expires_at=? WHERE id=(SELECT id FROM subtask_instances WHERE claim_token IS NULL AND status='ready' ORDER BY created_at LIMIT 1) RETURNING …` inside `BEGIN IMMEDIATE` on a WAL-mode SQLite. No SELECT-then-UPDATE race. Accepts an optional `?run_id=…` query param; when supplied, the inner SELECT adds `AND run_id = ?` so the agent only picks up subtasks of that run (used by Claude-Code-driven flows that drive a single run end-to-end without consuming unrelated stale work — issue #75). Without the param, the legacy global FIFO applies.
- `POST /work/{claim_token}/result` — submit a structured result. Validates against the subtask's `output_schema` and the claim is consumed atomically: `UPDATE subtask_instances SET result=?, status='done' WHERE claim_token=? AND status='claimed' AND expires_at>now() RETURNING …`. If the row no longer matches (TTL expired, already submitted), the call returns `{accepted: false, reason: 'claim_lost'}` and the agent's submission is discarded.

**Claim semantics (MVP):**

- **Fixed 10-minute TTL.** No sliding, no hard cap, no pre-check. Agents that don't complete within 10 minutes lose their claim; the subtask returns to the pool. Demo runs complete in 2–5 min after rehearsal; this is sufficient.
- A background sweeper runs every 30s to reset rows whose `expires_at < now()` (so `WHERE claim_token IS NULL` in `GET /work/next` sees them).
- Bound to `claim_token`, not MCP session ID. Reconnects don't invalidate it; the agent passes `claim` explicitly to `task_tool` / `submit_result` (no session-based fallback).
- Subcommand **schemas and endpoint URLs are read live** from the current pipeline def at every dispatch. No per-claim snapshot. Pipeline upserts are last-write-wins; an agent mid-claim sees the new schema on its next `task_tool` call. Acceptable for one publisher with rare upserts; reinstate per-claim snapshot + version pinning for multi-publisher production.
- Murmur passes two headers on every proxy call:
  - `X-Murmur-Subcommand` — the subcommand name being invoked.
  - `X-Murmur-Claim-Token` — the canonical session key the publisher uses to keep claim-scoped state across subcommand calls (load-bearing for ws-style flows where `select monitor --as cfg-1`, `run monitor --config cfg-1`, and `feedback` all share state).

No retries on schema-validation failure for MVP — the run fails.

**Reinstated for full ws coverage** (post-demo): sliding TTL on success, hard 30-min wallclock cap, `wallclock_remaining_ms` pre-check, schema snapshot per claim, pipeline version pinning, `claim_closed` lifecycle callback, additional `X-Murmur-Pipeline-*`/`Run-Id`/`Subtask-Instance-Id` headers.

### 3.4 MCP server (agent-facing)

Three static tools, fixed for the lifetime of the connection:

- `pull_task({ run_id?: string })` → `{ instructions, input, output_schema, claim }` or `null`. `run_id` is optional; when supplied, the claim is restricted to ready subtasks of that run (issue #75 — drives a single run end-to-end without picking up unrelated queued work). Forwards to `GET /work/next?run_id=…`.
- `submit_result(claim, result, notes?)` → `{ accepted: true } | { accepted: false, errors: [...] }`. `notes` is an optional free-text reflection persisted in the audit log alongside the structured `result`.
- `task_tool(subcommand: string, claim: string, args?: object)` → `string | object` — universal dispatcher. Invokes a publisher-declared subcommand for a claim (see §3.1). `claim` is required (no session-based fallback in MVP). Static description (visible to the host's tool catalog):

  > *Invoke a subcommand for the current claim. The subtask `instructions` will tell you which subcommands to use and when; `task_tool('<name>', '<claim>', {...})` invokes one. The `claim` value is what `pull_task` returned in its `claim` field.*

**Dispatch:** Murmur looks up the subcommand in the run's current pipeline def, validates `args` against `input_schema`, POSTs to the declared `endpoint` with the publisher-failure protections in §3.6, and returns the response.

**Errors:**

- Claim unknown / expired → `claim_lost`; agent should call `pull_task` again.
- Unknown subcommand → returns the list of valid subcommand names for this claim's subtask.
- Args fail validation → returns schema errors.
- Publisher endpoint failure → see §3.6.

**Reinstated for full ws coverage** (post-demo): built-in `help` / `help <name>` subcommands (instructions text covers it for now); built-in `blocked` for graceful give-up (replaced for MVP by claim TTL expiry + operator triage); `status` for resume after disconnect; `report_blocker` static tool. None of these are load-bearing for the demo.

Configured by the agent's host (Claude Code, Cursor, …) via one line in `mcp.json`.

### 3.5 Worked example

Agent's second `pull_task()` returns:

```json
{
  "claim": "c_a1b2c3",
  "instructions": "Given the board URL and provider, choose the monitor type and config jobseek should use to detect new postings. Use task_tool(\"test monitor\", {...}) to verify your candidate before submitting.",
  "input": {
    "board_url": "https://job-boards.greenhouse.io/exampleco",
    "board_provider": "greenhouse"
  },
  "output_schema": {
    "monitor_type": { "enum": ["greenhouse", "lever", "workday", "..."] },
    "monitor_config": { "type": "object" }
  }
}
```

Agent calls `task_tool("test monitor", { board_url: "https://job-boards.greenhouse.io/exampleco", monitor_type: "greenhouse", monitor_config: { token: "exampleco" } })` — Murmur dispatches to the publisher's probe endpoint and returns:

```json
{ "ok": true, "postings_seen": 42, "sample_postings": [...] }
```

Agent then calls `submit_result("c_a1b2c3", ...)` with:

```json
{
  "monitor_type": "greenhouse",
  "monitor_config": { "token": "exampleco" }
}
```

Murmur validates against `output_schema`, marks the subtask done, and advances the run. The agent's next `pull_task()` returns the next pending subtask in the run (typically the next `configure-board` instance, or — when all configure-boards are done — closes the run).

### 3.6 Failure modes & demo-grade security

Specified explicitly to avoid implementation surprises.

**Demo-grade auth (replaces "no auth" cut).** One shared bearer token, `MURMUR_TOKEN`, gates every Murmur endpoint (publisher API + MCP transport). Required on every request as `Authorization: Bearer …`. Set via env var on the box, rotated per deployment.

- **No `GET /pipelines/{id}`** — read access to stored pipeline defs is not exposed.
- **Webhook auth: bearer in, not HMAC out.** Murmur's webhook POSTs to the publisher carry the same `MURMUR_TOKEN` as `Authorization: Bearer …`. The publisher's accept handler verifies the bearer and trusts the body. No HMAC, no per-publisher secret, no Argon2id storage. Adequate when (a) publisher's webhook is reachable only via Cloudflare Tunnel + bearer + TLS and (b) there's one trusted publisher.
- Adequate for a closed demo deployment. Not adequate for real users — no per-user identity, no privilege separation between agents and publishers, no rate limiting, no revocation primitive without redeploy.

**Publisher SSRF defense.** Murmur faithfully proxies the agent's `args` to the publisher's endpoint. Publisher probe endpoints that accept URLs (e.g., jobseek's `board_url`, `sample_url`) MUST allowlist hosts and reject private/loopback/link-local/metadata-service IPs after DNS resolution (with rebinding protection: resolve once, post and check the resolved IP). Allowlist by host pattern alone is *not* sufficient — subdomain takeovers and vendor-hosted careers pages can match patterns like `*.greenhouse.io`. Documented as a publisher requirement in §4.2.

**Reinstated for full ws coverage** (post-demo): scoped `AGENT_TOKEN` / `PUBLISHER_TOKEN` (privilege separation), HMAC-SHA256 webhook signing with per-publisher `webhook_secret` (Argon2id-hashed at rest), Murmur-side SSRF defense on `endpoint`/`webhook` URLs (DNS-rebinding-aware) at registration + dispatch. All required when onboarding untrusted publishers.

**Failure modes:**

- **Publisher endpoint slow / hung.** Hard 15s timeout on every `task_tool` proxy call. On timeout, Murmur returns `{ok: false, errors: ["publisher_timeout"]}` to the agent (structured, so the agent can react) rather than letting the MCP call hang. Outbound HTTP connection pooled with a hard limit; no per-call leak.
- **Publisher endpoint 5xx.** Returned to the agent as `{ok: false, errors: ["publisher_5xx", "<status>"]}`. No automatic retry — the agent decides whether to retry, and the publisher sees one call per agent decision.
- **Publisher response too large.** 1 MB cap on response body. Truncated responses are returned with `{ok: false, errors: ["publisher_response_too_large"]}` so probes can't be used to dump unbounded data through Murmur.
- **Webhook delivery.** On run completion Murmur POSTs `final_output` to the publisher's webhook with `Authorization: Bearer <MURMUR_TOKEN>` and `Idempotency-Key: <run_id>`. One retry on non-2xx after 30s. Publishers verify the bearer, dedupe on the idempotency key.
- **Audit log payload truncation.** Every `task_tool` call's args+response are logged to `agent_actions`. Fields are silently truncated to a fixed 4 KB cap. No `_truncated` map for MVP — consumers needing lossless capture should sample-snapshot at the publisher endpoint instead. (Full structured truncation map reinstated post-MVP.)
- **Audit log retention.** Per-run audit trails are kept for 30 days post run-completion, then deleted by a background sweeper.
- **Webhook accept-handler contract.** Publishers MUST: (a) cap webhook body size before reading (suggest 5 MB; reject 413 otherwise); (b) verify the bearer token; (c) treat `Idempotency-Key: <run_id>` as a transactional dedupe key with a UNIQUE constraint on the writer's catalog table; (d) return 2xx for already-applied keys (idempotent success). Documented in §4.1.
- **Claim TTL vs. in-flight `submit_result`.** The atomic CAS on `(claim_token, status='claimed', expires_at>now())` means a submission arriving after TTL expiry is rejected with `claim_lost` rather than overwriting state shared with a fresh claim.
- **Claim TTL vs. in-flight `task_tool`.** TTL slides forward only on a successful round-trip, capped by the hard 30-minute wallclock. A probe that takes 10s won't expire the claim mid-flight; a stuck or crashed agent doesn't keep extending a claim it isn't completing.
- **MCP transport reconnect.** Claims are bound to `claim_token`, not session ID. An agent reconnecting after a Cloudflare Tunnel idle drop can resume by passing `claim` to `task_tool` / `submit_result`. Murmur sends Streamable HTTP keepalives every 25s to head off idle drops.
- **Schema validation failure on `submit_result`.** Run fails. No retry for MVP. The publisher learns via the run-status endpoint or absence of the webhook.
- **Pipeline upsert mid-run.** Schema set frozen at claim issue, endpoint URLs resolved live (§3.3) — fixed-URL hot-fixes flow without breaking in-flight claims, but schema changes don't.
- **Two agents racing for the same task slot.** Resolved at `GET /work/next` by the atomic claim statement (§3.3). Only one agent gets the claim; the other gets the next available subtask or 204.

---

## 4. Publisher integration

### 4.1 The model (any publisher)

Any publisher integrates with Murmur in four steps:

1. **Author a pipeline definition** in YAML — initial input schema, ordered subtasks (each with instructions, input refs, output schema as JSON Schema), and a webhook URL. JSON Schema is written directly in YAML; no shorthand preprocessor.
2. **Register it** via authenticated `POST /pipelines` (typically from CI on change). Last write wins; no version tracking for MVP.
3. **Trigger runs** by POSTing to `/pipelines/{id}/runs` whenever the publisher's app needs the work done.
4. **Accept results** at the webhook URL — verify the bearer (`MURMUR_TOKEN`), dedupe on `Idempotency-Key: <run_id>`, then apply `final_output`.

Optional: declare **subcommands** under each subtask in the pipeline def for in-subtask verification (see §3.1 for shape, §3.4 for dispatch). The same validation logic typically powers both the in-subtask subcommands and the final-output check at the accept webhook, so one implementation serves both call sites.

What Murmur owns end-to-end for any publisher:

- Pipeline registry & durable run-state store
- Distribution to agents (claim model, claim TTL, atomic claim pickup, multi-agent coordination)
- Schema validation (initial input, subcommand args, subtask outputs)
- Webhook delivery on run completion, with idempotency key
- Audit trail (runs, subtask instances, results)

**What the publisher has to build.** "Publishers write HTTP endpoints" is true on the integration surface but undersells the work. A complete integration includes:

1. *Pipeline def* — YAML, per pipeline.
2. *Run trigger* — wherever the publisher's app needs the work, a small client that POSTs to `/pipelines/{id}/runs`.
3. *Accept-webhook handler* — receives `final_output`, applies it to the publisher's data store. Should be idempotent on `run_id`.
4. *Subcommand HTTP endpoints* — one per subcommand declared in the pipeline def. These typically wrap the publisher's existing validation/probe logic.
5. *Type / class library backing the subtasks* — the actual domain knowledge (e.g., for jobseek, the monitor and scraper class hierarchies). Murmur doesn't help you build these.

For a brownfield publisher with an existing validation library and CSV/DB writers (jobseek), this is mostly wiring. For a greenfield publisher, items 4 and 5 dominate the integration cost.

**Subcommand endpoints: public hostname for MVP.** Subcommand `endpoint` URLs in pipeline defs use the publisher's public hostname (e.g., `jobseek.colophon-group.org`). Murmur's box and jobseek's box share a private VPC (per §6.1), but routing all subcommand traffic over the public path simplifies deploy, lets the same endpoint serve curl/dev tooling, and adds only ~30ms per call — acceptable for the demo. Post-MVP: a `private_endpoint` field for in-VPC routing (a 1-line schema addition; deferred until call volume justifies the optimization).

**Subcommand state contract.** Publishers that keep claim-scoped state (e.g., named `--as cfg-1` configs) MUST: (a) key state on `(X-Murmur-Run-Id, X-Murmur-Subtask-Instance-Id, X-Murmur-Claim-Token)`; (b) treat the `claim_closed` notification (§3.3) as the cleanup signal; (c) tolerate a 60-minute hard TTL on claim-scoped storage even without a notification (defense against missed callbacks); (d) treat agent reconnect as best-effort — if state is gone, return a structured error so the agent can retry from a known beat. This is the load-bearing contract for ws-style flows.

### 4.2 Worked example: jobseek

Jobseek is the demo publisher and the only integrator for MVP. It's a brownfield case: it has an existing `ws` workflow built on git/PRs that Murmur replaces in full. Constraint set by the project: **the ws→Murmur reimplementation must not lose any ws functionality** — git/branch/PR/worktree/issue-claim machinery is replaced by Murmur primitives (not lost), and every other ws capability maps to a Murmur subtask, subcommand, or audit endpoint. The full mapping is in §9 (coverage matrix); this section covers the run-level shape.

**Run shape.** A run of `jobseek/add-company` mirrors the 7-step ws workflow:

| Subtask | ws step it replaces | Decision the agent makes | Spawns / skip |
|---|---|---|---|
| `pre-verify` | step 00 | Is this a real, non-duplicate company? Confirm name + website. | — |
| `setup-metadata` | step 01 | Logo selection, descriptions (4 locales), industry, employee_count_range, founded_year, logo_type. | — |
| `list-boards` | step 02 | Ordered list of boards (alias + URL + optional job-link-pattern). | `spawns: { for_each: boards, template: configure-board }` |
| `configure-board` (one per board) | steps 03 + 04 + 05 fused | `outcome` (configured / phantom / parent-portal / unsupported); when configured: monitor type+config, optional scraper type+config, per-field quality verdict. | scraper fields nullable when monitor auto-configures; non-configured outcomes skip the populating subcommands |
| (no dedicated reflect subtask) | step 07 | Each subtask explicitly declares optional `kb_entries` / `case_studies` arrays in its `outputs`. The pipeline's `final_output.composes` rule flattens them across subtasks. Jobseek's accept handler ingests. | — |

Submit (ws step 06) is no longer an agent action — it's automatic at run-completion when all subtasks have valid outputs. Final-output validation runs in jobseek's accept handler (the same probe library the subcommands wrap).

**Subcommand surface (per subtask)**, matching ws's CLI breadth so the agent has parity with what `ws` exposes today:

- **`pre-verify`**: `search companies`, `verify company`, `kb search`, `kb view`.
- **`setup-metadata`**: `discover company` (kicks off logo + enrichment), `list logo candidates`, `taxonomy search`, `kb search`, `kb view`.
- **`list-boards`**: `analyze hreflang`, `infer link pattern`, `kb search`, `kb view`. (No `compare boards` here — board reconciliation runs in jobseek's accept handler against `final_output`; agents shouldn't delete boards based on overlap with the catalog they can't see.)
- **`configure-board`**: `probe monitor`, `select monitor <type> --as <name>`, `run monitor`, `probe scraper`, `select scraper`, `run scraper`, `probe deep`, `probe api`, `feedback --verdict <…> --per-field …`, `select config <name>`, `reject-config <name> --reason …`, `kb search`, `kb view`. Agent iterates: probe → review costs/options → select with `--as <name>` → run → if results disagree with expected job count, **iterate config** (don't immediately switch monitor type) → run again → feedback. Multiple named configs may be tried before final selection. If the agent decides the work is unsalvageable, `task_tool('blocked', ...)` releases the claim and the publisher decides what to do.
- **All subtasks** also have `kb search`, `kb view` available. KB additions and case studies are explicit optional `kb_entries` / `case_studies` arrays on each subtask's `outputs` schema (see §3.1 example). The pipeline's `final_output.composes` rule flattens them across subtasks; the accept handler ingests them.

**`kb search` vs. `kb view`.** ws's KB has 100+ entries; full-body responses for a multi-result search would blow Murmur's 1 MB response cap (§3.6). Convention: `kb search` returns ranked summaries `[{path, symptom, tags, snippet}]` with no bodies; `kb view <path>` returns a single full entry. Same publisher endpoint with two paths.

**Storage migration on jobseek's side (independent of Murmur).** Jobseek is moving its catalog (companies, boards, monitor/scraper configs) and KB out of disk + git into a local Postgres instance on the crawler box. Murmur is unchanged by this — it sees only the publisher's HTTP surface and the accept-webhook target. Effects on the integration: `kb search` / `kb view` query Postgres rather than reading markdown files; the accept handler writes companies/boards/KB rows to Postgres rather than appending to CSVs and committing markdown. KB content authored by agents during a run flows through `final_output.kb_entries` / `final_output.case_studies` (aggregated by Murmur from optional subtask outputs); the accept handler ingests them directly. No git commit anywhere on the agent path.

Each of these wraps an existing function from `apps/crawler/src/workspace/commands/*.py` — refactored from CLI binding into an importable async function plus an HTTP shim. One implementation per command, three callers: agent (via `task_tool`), accept handler (in-process for final-output validation), curl/dev tooling.

**Workflow control mapping.**

- `ws task next` → implicit on `submit_result` (run advances).
- `ws task back --to <step>` → agent calls `task_tool('blocked', ...)`; publisher issues a fresh run with `prior_outputs` for the work it wants kept (no native rewind in Murmur — see §3.4).
- `ws task fail --reason` → `task_tool('blocked', { reason })`.
- `ws task complete` → automatic at final subtask submit; jobseek's accept handler does the trace upload and any cleanup.
- `ws task troubleshoot` / `ws help` → KB browsing exposed as `task_tool('kb search …')` / `task_tool('help …')`.
- `ws status` / `ws resume` → `task_tool('status')`.
- `ws task learn` / `ws task casestudy` → optional `kb_entries` / `case_studies` arrays declared on each subtask's `outputs` (§3.1); flattened into `final_output` by the pipeline's `composes` rule.
- `ws new --reconfig` → `POST /pipelines/{id}/runs` with `prior_outputs` populated from the existing company's data.

**Trace export (HF dataset).** Jobseek's accept handler reads `GET /runs/{id}` after webhook delivery, extracts the per-subtask audit log + `_notes`, and uploads to the existing Hugging Face dataset. Murmur exposes the audit; the upload remains a publisher concern.

**What jobseek removes** (replaced by Murmur primitives, *not* lost): GH-issue creation in `requestCompany`, draft-PR machinery, `.workspace/<slug>/` dir, `workspace.yaml`, `boards/<alias>.yaml`, per-company branches, worktrees, `ws new` / `ws await-board` / `ws boards-done` / `ws submit` / `ws use` / `ws del` (workflow CLI), CSV conflict resolution. The cron `resolve-company-requests.yml` becomes a fallback Murmur agent that pulls + completes any unclaimed subtasks (and re-POSTs `companyRequest` rows that never reached Murmur). From Murmur's perspective this cron is just another agent. Devs never manually configure companies; the worst-case escape hatch is hand-editing the CSVs.

**What jobseek keeps** (now exposed as subcommand HTTP endpoints): monitor + scraper class library, probe/validation logic (refactored as importable async + HTTP shim), data-source writers, taxonomy + KB readers and writers, logo / enrichment discovery, board comparison, the `companyRequest` table, the `inspect.py` CSV validator.

**Probe SSRF defense (jobseek-side).** Per §3.6, the publisher must filter URLs the agent submits. Jobseek's `probe`/`run` subcommands accept only `board_url` / `sample_url` whose host matches the documented board-host allowlist (`*.greenhouse.io`, `jobs.lever.co/*`, `*.myworkdayjobs.com`, …) and reject private/loopback/link-local/metadata IPs after DNS resolution (rebinding-aware). Anything else returns `{ok: false, errors: ["url_not_allowed"]}` immediately.

**Board reconciliation is jobseek's accept-handler responsibility, not the agent's.** When the webhook fires with `final_output`, jobseek runs `compare-boards` on the configured boards (the same logic ws today uses post-discovery) and decides:

- **MIRROR** (>90% URL overlap between two configured boards): keep one, drop the other. Heuristic: keep the lower-cost monitor type; on tie, keep the more specific (regional/functional) board over a generic mirror.
- **SUBSET** (board A's URLs strictly contained in board B's): drop A.
- **OVERLAP** (20–80% URL intersection): keep both, but record the overlap percentage on each board row so the catalog ingestion knows to dedupe at job level.
- **PHANTOM** (`outcome=phantom`): drop the board entirely; no catalog row written. Log `phantom_evidence` for operator review.
- **PARENT-PORTAL** (`outcome=parent-portal`): drop the board, queue a fresh `requestCompany` for the `parent_company_hint` if it's not already in the catalog. The original company's run still applies for any other configured boards (some companies have *both* their own boards and a parent portal).
- **UNSUPPORTED** (`outcome=unsupported`): drop the board, file an internal issue with `unsupported_reason` for the engineering team to either add a monitor type or improve probe coverage.

Reconciliation runs against the run's own boards plus any existing boards already in the catalog under this slug (for reconfig runs). The accept handler is the single authoritative writer; agents never delete boards directly. This is the same pattern as ws's `_auto_compare_boards` logic in `apps/crawler/src/workspace/commands/crawl.py`, lifted out of the agent loop.

**Heavy multi-board scale.** Real configurations include Adani (15 Oracle HCM sites), ByteDance (29 api_sniffer boards parametrized by job-category), Omnicom (33 Greenhouse subsidiaries). Sequential `configure-board` claims at ~5 min each = 30+ minutes for ByteDance, ~2.5 hours for Omnicom — too long for one interactive Claude Code session. Mitigations:

1. **Publisher-side run splitting.** Jobseek's `requestCompany` for known multi-tenant cases (Omnicom, holding companies) issues N runs, one per logical cluster, each with a slice of `boards`. The cron fallback (§4.2) picks them up.
2. **Parametrized monitors as one configure-board.** Cases like Accenture (12 country-parametrized boards on one URL), Adani (15 Oracle HCM site IDs) actually want one `configure-board` returning a list of `{site_id, country, language}` parameters — not 12-15 separate `configure-board` instances. Pipeline accommodates this by letting `monitor_config` itself contain the parametrization array; jobseek's accept handler expands it into N `boards.csv` rows. This is a publisher-side schema choice, not a Murmur primitive.
3. **Concurrent claims within a run** (post-MVP per §5): unblocks long-tail per-board time, doesn't help wall-clock for one agent. Real fix is #1 + #2.

This means `list-boards` agents should consolidate parametrized variants into one entry per *distinct ATS instance*, not per region — matching how the catalog actually models them today.

### 4.3 Illustrative example: `demo/translate-grade`

**Out of MVP scope. Not a deliverable; not in the demo.** Sketched here only to show how a hypothetical second, unrelated publisher would integrate against the same Murmur protocol — useful for reasoning about whether the integration model is publisher-agnostic, even though the demo doesn't exercise it.

```yaml
id: demo/translate-grade
version: 1
initial_input_schema: { phrase: string, target_lang: string }
subtasks:
  - id: translate
    instructions: |
      Translate the phrase to the target language. Use task_tool("score quality",
      {translation, target_lang}) to get a quality score before submitting;
      iterate the translation if the score is below 70.
    inputs: [init.phrase, init.target_lang]
    outputs: { translation: string, quality_score: integer }
    subcommands:
      - name: score quality
        help: Returns a 0-100 quality score for a candidate translation.
        input_schema:  { translation: string, target_lang: string }
        output_schema: { score: integer, notes: string }
        endpoint: POST https://translate-demo.example/score
final_output:
  composes: [translate.*]
  webhook: https://translate-demo.example/accept
```

Sized to be readable at a glance: ~80 LoC if it were ever built (pipeline YAML, two routes, an LLM call for scoring). Confirms in principle that the agent-side surface stays untouched across publishers; doesn't prove it for real until a non-jobseek publisher actually integrates.

---

## 5. Shortcuts (explicit; do not "fix" these in MVP)

- **Demo-grade auth only.** Single shared bearer token across the deployment (see §3.6). No per-user identity, no per-publisher API keys, no rate limiting, no anti-abuse. Adequate for a closed demo, not for real users.
- **One pass per pipeline.** No parallel claims, no aggregation, no voting. Architecture is forward-compatible (claim-based, not assign-based) but the feature is not built.
- **Sequential subtask claims within a run.** Sibling subtasks declared with `requires` (§3.1) could be claimed concurrently; for MVP the server takes them one at a time. ws's parallel Track A/B/C is an acknowledged loss with mitigation in §9.8.
- **Pipeline-def shape: dynamic but acyclic.** With `spawns` and `skip_if` (§3.1) the run topology is computed from prior outputs at runtime — not "linear" in a strict sense. No DAG cycles; no agent-defined branching beyond what `skip_if` and `spawns.for_each` provide.

### 5.1 Demo-minimum subset (vs. full ws-coverage)

Two implementation tiers, both within the spec:

**Demo minimum** (one pre-validated company, ~10–14 person-days realistic — see §5.2 for the breakdown). Pipeline: `pre-verify` → `list-boards` → one or more `configure-board` instances → submit. **`spawns` is required even for the demo** because a real "single-board" company often discovers a second board during `list-boards` (a careers page + a smartrecruiters mirror, or hreflang variants). Pre-validating the demo company means confirming `list-boards` returns ≤2 boards, but without `spawns` the second one has nowhere to go. **Required for demo:** `spawns`, schema validation (Ajv with raw JSON Schema — no shorthand preprocessor), claim TTL semantics, atomic claim pickup, multi-config iteration via per-claim KV (load-bearing for `configure-board`'s probe → select → run loop). **Deferred:** `skip_if`, `prior_outputs` reconfig, `blocked`/`status` built-ins, `claim_closed` lifecycle callbacks, KB reads/writes, audit endpoint full shape. Subcommand surface limited to `probe monitor`, `run monitor`, `probe scraper`, `run scraper`, `select monitor`, `select scraper`, `feedback` (7 — see §5.2 for the actual jobseek work).

**Full ws coverage** (per §9, ~24–38 person-days *on top of* demo-minimum): adds `skip_if`, `blocked`/`status` primitives, `prior_outputs` reconfig with composite-path addressing, `claim_closed` lifecycle callback, `kb search` / `kb view` subcommands available everywhere, per-subtask `kb_entries`/`case_studies` outputs flattened into `final_output`, audit endpoint with `agent_actions` per subtask, taxonomy add via operator path, full subcommand surface (~25 endpoints), parent-portal idempotency. Required to retire `ws` entirely; not required for the demo.

Implementing demo-minimum first, then layering the rest, is the recommended order. This section's purpose is to keep §9's "Hosted" rows from masquerading as MVP scope.

### 5.2 Delivery split: Murmur package vs. jobseek changes (for the demo)

What gets built where to make the §2 demo run end-to-end. Items marked ⊘ are full-coverage features deliberately deferred from the demo path. Items marked ✓ must ship before the demo.

**Implementation tracking:** the work below is split across two GH repos:

- **Murmur side** — [colophon-group/murmur milestone "Demo readiness"](https://github.com/colophon-group/murmur/milestone/1): 3 epics (#1, #2, #5), 21 detail issues (M0-M12, I1, D1-D5, R1-R2)
- **Jobseek side** — [colophon-group/jobseek milestone "Murmur demo readiness"](https://github.com/colophon-group/jobseek/milestone/1): 2 epics (#2753, #2754), 9 detail issues (J1-J5, P1-P4)

Each issue has an explicit "Verification" section with named test files, specific assertions, manual-check commands, and quality gates a reviewer can run. Definition-of-done checklists are merge-required.

**Process:** work is performed by Claude Code agents (orchestrator → developer → reviewer) following [`AGENTS.md`](AGENTS.md). Role definitions in [`.claude/agents/`](.claude/agents/). Permissions in [`.claude/settings.json`](.claude/settings.json). Pre-commit hooks (`lefthook.yml`) and CI (`.github/workflows/ci.yml`) enforce typecheck, lint, test, and grep gates locally and on every PR.

**In the Murmur package** (`/Users/Viktor/murmur`):

| Item | Demo? |
|---|---|
| Hono HTTP server with single shared bearer-token auth (`MURMUR_TOKEN`) | ✓ |
| SQLite (WAL) schema: `pipelines`, `runs`, `subtask_instances`, `subtask_results`, `agent_actions` | ✓ |
| MCP server with three static tools (`pull_task`, `submit_result`, `task_tool`) over Streamable HTTP | ✓ |
| Publisher API: `POST /pipelines` (last-write-wins, no version), `POST /pipelines/{id}/runs`, `GET /runs/{run_id}` | ✓ |
| Agent API: atomic `GET /work/next` (`UPDATE … RETURNING` in `BEGIN IMMEDIATE`), atomic `POST /work/{claim}/result` (CAS) | ✓ |
| `task_tool` dispatch: lookup subcommand in current pipeline, validate `args`, HTTP proxy with 15s timeout + 1 MB cap | ✓ |
| `X-Murmur-Subcommand` + `X-Murmur-Claim-Token` headers on proxy calls | ✓ |
| Claim semantics: fixed 10-min TTL, sweeper every 30s, claim bound to token | ✓ |
| Webhook delivery: bearer-authed POST + `Idempotency-Key: <run_id>` + one retry on non-2xx | ✓ |
| Pipeline-def YAML uses JSON Schema directly (no shorthand preprocessor) | ✓ |
| Output schema validation (Ajv) on `submit_result` | ✓ |
| `spawns` (variable-count children, runtime instantiation) | ✓ — load-bearing even for "one company" demos when `list-boards` finds 2+ boards |
| Audit log: silent fixed-size (4 KB) field truncation; basic `console.log` | ✓ |
| Deploy: `Dockerfile` for `linux/arm64`, `docker-compose.yml`, `deploy.sh`, GH Actions workflow | ✓ |
| Cloudflare Tunnel config + `cloudflared` container | ✓ |
| Streamable HTTP transport validated through Cloudflare Tunnel for a real Claude Code session | ✓ (validate before relying on it) |
| **Reinstated for full ws coverage** (deferred from demo) | |
| Scoped `AGENT_TOKEN` / `PUBLISHER_TOKEN` (privilege separation), token rotation/revocation | ⊘ |
| HMAC-SHA256 webhook signing + per-publisher `webhook_secret` (Argon2id-hashed at rest) | ⊘ |
| Murmur-side SSRF defense on `endpoint`/`webhook` URLs (DNS-rebinding-aware) | ⊘ |
| Sliding TTL on success, hard wallclock cap, `wallclock_remaining_ms`, cap pre-check | ⊘ |
| One-active-claim-per-session rule | ⊘ (agent passes `claim` explicitly always) |
| Schema-snapshot per claim, pipeline version pinning, additional `X-Murmur-Pipeline-*`/`Run-Id`/`Subtask-Instance-Id` headers | ⊘ |
| Built-in subcommands `help`, `help <name>`, `blocked`, `status`; `claim_closed` lifecycle callback | ⊘ |
| `skip_if` (JSONLogic on prior outputs); `prior_outputs` on run creation | ⊘ |
| `_truncated` path-keyed-map in audit log; structured audit endpoint with full `agent_actions[]` shape | ⊘ |
| YAML→JSON-Schema shorthand preprocessor | ⊘ |
| SQLite `.backup` pre-snapshot cron | ⊘ |

**In jobseek** (`/Users/Viktor/jobseek`):

| Item | Demo? | Where in jobseek |
|---|---|---|
| Pipeline-def YAML for `jobseek/add-company` (demo-minimum shape) | ✓ | `apps/crawler/murmur/pipelines/add-company-demo.yaml` |
| CI step (or rehearsal script) to register pipeline via `POST /pipelines` | ✓ | `apps/crawler/murmur/scripts/register.ts` (or shell script) |
| Run trigger: `requestCompany` (or curl on a side terminal) POSTs to `/pipelines/jobseek-add-company/runs` with `{company_name, website}` | ✓ | `apps/web/src/lib/actions/stats.ts` *or* a demo-only button |
| Webhook accept handler: verify bearer (`MURMUR_TOKEN`), dedupe by `Idempotency-Key`, write to catalog | ✓ | `apps/web/src/app/api/murmur/accept/route.ts` |
| Refactor `ws probe monitor` / `ws run monitor` / `ws probe scraper` / `ws run scraper` / `ws select monitor` / `ws select scraper` / `ws feedback` from CLI bindings to importable async functions | ✓ | extract from `apps/crawler/src/workspace/commands/crawl.py` (~1700 LOC of the 2561-line file). Realistic effort: 5–7 days. Heavily coupled to `state.WorkspaceState`, `out.die`, file I/O, git. Needs (a) IO/state interface abstracted, (b) `out.die` → exception, (c) `asyncio.run` removed in favor of awaitable, (d) per-claim KV substituting for workspace YAML. Largest single risk in §5.2 estimate. |
| HTTP shim subcommand endpoints (7 demo-path endpoints): `POST /api/murmur/probes/monitor`, `…/run/monitor`, `…/probes/scraper`, `…/run/scraper`, `…/select/monitor`, `…/select/scraper`, `…/feedback` | ✓ | new routes in `apps/web/src/app/api/murmur/` |
| Per-claim subcommand state KV (keyed on `X-Murmur-Claim-Token`) for `select monitor --as cfg-N` named configs reused by `run monitor --config cfg-N` and `feedback` | ✓ — `configure-board` instructions explicitly tell the agent to iterate config under named labels | small Postgres table |
| SSRF allowlist on `board_url` / `sample_url` (post-DNS-resolution check) | ✓ | shared util in subcommand routes |
| Final acceptance: write to local Postgres (or for demo, append to `companies.csv` / `boards.csv` if Postgres migration not ready) | ✓ | accept handler |
| Probe/validation library used both by subcommands and the accept handler's final-output guard | ✓ | one implementation (the refactored async functions above) |
| 3 pre-validated demo-company candidates on a slide; rehearsed end-to-end | ✓ | rehearsal artifacts; not committed code |
| Other subcommands (search companies, verify company, discover, taxonomy search, kb search, kb view, etc.) | ⊘ | post-demo |
| `pre-verify` reject_reason handling, parent-portal queueing | ⊘ | post-demo |
| Board reconciliation logic in accept handler (mirror/subset detection) | ⊘ | post-demo (single-board demo doesn't exercise it) |
| `outcome=phantom`/`parent-portal`/`unsupported` handling | ⊘ | post-demo |
| Murmur catalog/KB → local Postgres migration | ⊘ | parallel jobseek-side track |
| Removal of `ws task` / `ws new` / draft-PR machinery / `resolve-company-requests.yml` cron | ⊘ | post-demo (ws stays operational alongside) |

**Boundary contracts** (both sides agree on these before either starts coding):

- Pipeline-def YAML schema (JSON Schema directly, no shorthand)
- `MURMUR_TOKEN` format and lifetime (single shared bearer)
- `X-Murmur-Subcommand` + `X-Murmur-Claim-Token` proxy headers (exact casing)
- `task_tool` request/response envelope: `{ok: boolean, errors: string[]?, data: object?}`
- `submit_result` validation-error shape (per-field JSON Pointer paths)
- Webhook contract: bearer auth, `Idempotency-Key: <run_id>`, dedupe window on publisher side
- `final_output.composes` flattening rules (including the cartesian product `boards: list-boards.boards × configure-board.*`)

**Realistic demo-day-readiness estimate: ~10–14 person-days.** Breakdown:

- Murmur core (HTTP + SQLite + atomic claim + MCP three tools + dispatch + spawns runtime + 2 headers + bearer auth + sweeper + Ajv validation): 3–4 days.
- Streamable HTTP + ARM64 + Cloudflare Tunnel debugging (better-sqlite3 native rebuilds, MCP TS SDK reconnection through cloudflared, validating with a real Claude Code session): 2 days.
- Jobseek refactor (lift 7 demo-path commands out of `crawl.py`'s ~1700 LOC of CLI-bound state, replace `out.die` + state YAML + `asyncio.run` with pure awaitable + per-claim KV): 4–5 days. **Largest single risk; first to slip.**
- Webhook accept handler + final-output validation + catalog write to Postgres or CSV: ~1 day.
- Rehearsal: pre-validate 3 candidate companies end-to-end, fall back when the first 1–2 break under non-determinism: ~2 days.

Down from ~16–22 days by cutting: schema-snapshot + version-pinning, sliding TTL + cap pre-check + `wallclock_remaining_ms`, one-active-claim-per-session rule, scoped tokens, HMAC + Argon2id, Murmur-side SSRF on URLs, YAML→JSON-Schema preprocessor, `_truncated` path map, built-in `help`/`blocked`/`status`. Each can be reinstated post-demo when the deferral becomes load-bearing (multiple publishers, untrusted publishers, multi-tenant deployments).
- **No retry on bad result.** Schema-fail = run-fail.
- **MCP only on agent side.** No CLI, no `npx` runner. Demo target = Claude Code.
- **One publisher (jobseek).** §4.3 sketches a hypothetical second publisher for reasoning purposes only; it is not built or demoed.
- **No rewards / token accounting.**
- **Server is single-process SQLite.** No HA, no horizontal scale.
- **Pipeline defs stored on Murmur.** Not fetched from publisher repos.

**Load-bearing assumptions (not Murmur-side cuts but worth naming):**

- The agent's host (Claude Code) provides web fetch. The jobseek `list-boards` subtask depends on it.
- The host honors the static `task_tool` description well enough that the agent reads `instructions` first and only consults `help` when needed (publisher convention, not Murmur-enforced).

---

## 6. Deployment

Single Hetzner box, mirroring jobseek's crawler-box pattern. One CX22-class machine, one dedicated Hetzner volume with snapshots, one Cloudflare Tunnel for the public URL.

### 6.1 Topology

- **Box:** Hetzner CAX (ARM64) VPS.
  - IPv4 `178.105.51.62`
  - IPv6 `2a01:4f8:1c18:d64c::/64`
  - Private (jobseek network) `10.0.0.5` — same VPC as jobseek's Postgres/Typesense, so any future Murmur ↔ jobseek traffic can stay private.
- **Architecture: ARM64.** Docker images must be built for `linux/arm64`. CI Buildx target: `--platform=linux/arm64`.
- **Volume:** dedicated Hetzner volume mounted at `/mnt/murmur`; SQLite at `/mnt/murmur/murmur.db`. Snapshots enabled (default cadence: daily, 7-day retention).
- **Public URL:** `murmur.colophon-group.org` via Cloudflare Tunnel — same pattern as jobseek's `typesense.colophon-group.org`. No inbound port on the box, no Caddy/TLS to manage. MCP hosts (Claude Code) connect to this URL.
- **SSH access:** the existing `~/.ssh/hetzner_deploy` keypair (used by jobseek's deploy GH Actions) is authorised on this box. CI uses the `HETZNER_SSH_KEY` GH secret (same value, shared across boxes in the colophon-group fleet).

### 6.2 Compose

`docker-compose.yml` on the box, `network_mode: host` to match jobseek:

```yaml
services:
  murmur:
    image: ghcr.io/${OWNER}/murmur:latest
    network_mode: host
    restart: unless-stopped
    mem_limit: 512m
    environment:
      PORT: "8080"
      DATABASE_PATH: "/mnt/murmur/murmur.db"
    volumes:
      - /mnt/murmur:/mnt/murmur
    healthcheck:
      test: ["CMD", "wget", "-q", "-O-", "http://localhost:8080/health"]
      interval: 30s

  cloudflared:
    image: cloudflare/cloudflared:latest
    network_mode: host
    restart: unless-stopped
    command: tunnel --no-autoupdate run
    environment:
      TUNNEL_TOKEN: "${CLOUDFLARE_TUNNEL_TOKEN}"
```

One process serves both the publisher HTTP API and the MCP transport on the same port. The MCP transport is **Streamable HTTP** (the 2025-03 MCP spec replacement for the deprecated SSE transport) — better-behaved through Cloudflare Tunnel, no idle-timeout dance. Murmur sends keepalive pings every 25s on long-lived connections to head off intermediary drops. MCP hosts connect via the public URL; publisher API calls hit the same hostname.

### 6.3 Deploy pipeline

Mirrors jobseek's `deploy-crawler-browser.yml`:

1. GH Actions on push to `main`:
   - Build image, push to `ghcr.io/${OWNER}/murmur:latest`.
   - SCP `docker-compose.yml` and `deploy.sh` to `/home/deploy/` on the box.
   - SSH and run `bash deploy.sh`.
2. `deploy.sh`:
   - Write `/home/deploy/.env` from secrets passed via `appleboy/ssh-action` `envs:`.
   - `docker compose pull && docker compose up -d --remove-orphans`.
   - Apply pending SQLite migrations (single tracked schema version).

Secrets in the GH `production` environment: `CLOUDFLARE_TUNNEL_TOKEN`, `OWNER`, GHCR pull credentials, `MURMUR_TOKEN`. No `.env` checked in; ephemeral on the box.

### 6.4 Backups

Hetzner volume snapshots, daily, 7-day retention. SQLite runs in WAL mode, which means a naive volume snapshot taken between `*.db` and `*.db-wal` can restore to an inconsistent state. Mitigation: a small pre-snapshot hook that runs `sqlite3 /mnt/murmur/murmur.db ".backup /mnt/murmur/snapshot.db"` (a consistent online backup), and the snapshot picks up `snapshot.db`. Cron runs the backup 2 minutes before the daily Hetzner snapshot window. No restic/borg for MVP.

### 6.5 Box bootstrap (one-time, manual)

1. Provision the Hetzner box (CX22, Ubuntu 24.04).
2. Attach the dedicated volume; format ext4; mount at `/mnt/murmur`; persist in `/etc/fstab`.
3. Install Docker.
4. Create `/home/deploy/`; generate an SSH keypair; add the public key to GH Actions secrets.
5. Create the Cloudflare Tunnel in the dashboard; copy the token into GH secrets; point a hostname at `localhost:8080`.
6. First GH Actions deploy creates `/home/deploy/.env` and starts the stack.

No IaC for MVP, matching jobseek.

### 6.6 Observability

Out of MVP scope. `docker compose logs` is sufficient for the demo. If signal during the demo matters, drop in an Alloy sidecar against Grafana Cloud, copying the relevant chunk from jobseek's `alloy.river`.

---

## 7. Decisions and open questions

### 7.1 Decided (defaults applied)

- **Stack.** Node/TypeScript, Hono for the HTTP API, the official MCP TS SDK with the **Streamable HTTP** transport mounted on the same port as the publisher API. SQLite (WAL) for storage.
- **Hostname.** `murmur.colophon-group.org` via Cloudflare Tunnel.
- **Pipeline-def authoring location.** Each publisher keeps its pipeline defs in its own repo and uploads via `POST /pipelines` on change (e.g., for jobseek: `apps/crawler/murmur/pipelines/*.yaml`). Publishers own their task definitions.
- **Pipeline upserts.** New version per upsert; in-flight runs pinned to start-time version; subcommand catalog snapshotted into the claim row.
- **Claim binding.** Bound to `claim_token`, not MCP session ID; survives reconnects.
- **MCP tool surface.** Three static tools: `pull_task`, `submit_result`, `task_tool`. No dynamic registration.
- **Publisher endpoint protections.** 15s timeout, 1 MB response cap, no automatic retry, structured error returns.
- **Webhook idempotency.** `Idempotency-Key: <run_id>` header; one retry on non-2xx.

### 7.2 Genuinely open

- **Demo target choice.** Picking the 3 pre-validated companies (across at least 2 providers) requires pre-testing the full pipeline end-to-end against real boards. Allow ~half a day of rehearsal-time discovery: the first chosen company will likely break (Workday tenant quirk, careers-page-not-board-page, scraper variant gap) and we'll fall back.
- **Schema validation library.** Default: Ajv with a YAML-to-JSON-Schema preprocessor for pipeline def authoring ergonomics. Validate during `POST /pipelines` so authoring errors surface at registration, not at first claim.
- **Live observability for the demo.** Default: drop in Alloy → Grafana Cloud only if rehearsal shows we need it. Otherwise `docker compose logs -f` on a side terminal during the live run.

---

## 8. Strategic risks (beyond MVP)

The MVP tests *protocol viability*. It does not test whether Murmur is a good business. These are the project-level concerns that the demo cannot answer; they are surfaced here so they don't get lost behind the technical work.

- **Two-sided market chicken-and-egg.** Publishers integrate (5 things to build per §4.1) only when there are agents pulling. Agents subscribe only when there's compelling work. The MVP demos one substantive publisher; it doesn't show a path from that to a populated market. Pre-MVP probe: talk to 3 prospective publishers and ask whether they'd integrate *before* the agent network exists.
- **Substitutability.** A publisher's alternative is to ship its own MCP server with the same domain tools and skip Murmur entirely — strictly less work than §4.1's integration list. Murmur's unique offer is *cross-publisher agent attention*, which only exists once N≥3 publishers have integrated. Until then, the value proposition is "we host your queue and audit trail," which is weak. The doc owes an answer to "why a publisher integrates instead of self-serving."
- **Token-economics premise.** The reward thesis ("agent-owners spend idle subscription credits") assumes a monetizable idle-capacity pool that subscription plans (Anthropic Pro/Max) may not actually have — they enforce 5-hour rolling windows and concurrent-session caps, not idle credit pools. Worth verifying with users running near their cap before building economics on this assumption.
- **Wisdom-of-crowd.** Forward-compatibility cited as a feature (§5 claim model), but for probe-gated tasks (jobseek), N agents add cost without signal — the probe is the oracle. For non-probe-gated tasks, the publisher needs an oracle to grade aggregated answers — and if they have one, they can grade a single answer. The capability is plausible only for tasks with a cheap consensus check (multiple translations, multiple summaries) and no existing automated grader.
- **Demo-to-product gap.** What's the next 100 hours of work after a successful demo, and is that path obviously achievable? Currently undefined. A realistic milestone-2 sketch (e.g., "second external publisher signed, basic discovery surface, billing prototype") would clarify whether the MVP is a foundation or a one-off.

These risks don't block the MVP; they decide whether the MVP becomes a project. Recommended pre-investment: 2–3 publisher conversations and 1–2 agent-owner conversations before committing the next phase of work.

---

## 9. ws → Murmur coverage matrix

Constraint: the ws→Murmur reimplementation must not lose any ws functionality. This section enumerates every ws capability and maps it to its Murmur destination. **Replaced** = different mechanism, same outcome. **Hosted** = exposed as a Murmur subtask or subcommand. **Cut** = explicitly out of scope, with a mitigation.

**A "Hosted" status here means "in the spec," NOT "ready for the demo."** Many Hosted rows depend on mechanisms that are deferred from demo-minimum (`spawns`, `skip_if`, `prior_outputs`, `blocked`, `status`, `claim_closed`, KB endpoints). The full demo-vs-full split lives in §5.2; this matrix is about end-state coverage, not delivery sequencing. Treat any Hosted row whose mechanism is ⊘ in §5.2 as "post-demo."

### 9.1 CLI surface (every `ws <cmd>`)

**Workspace lifecycle:**

| ws | Murmur destination | Status |
|---|---|---|
| `ws new <slug> --issue N` | `POST /pipelines/jobseek-add-company/runs` (jobseek's `requestCompany` wrapper) | Replaced |
| `ws new ... --reconfig` | `POST /pipelines/.../runs` with `prior_outputs: { ... }` (§3.2) | Hosted |
| `ws search "<q>"` | `task_tool('search companies', { q })` subcommand on `pre-verify` | Hosted |
| `ws use <slug>` | Implicit; the agent works on whatever `pull_task` returns | Replaced |
| `ws status` | `task_tool('status')` (§3.4) | Hosted |
| `ws validate` | jobseek's `inspect.py` runs in the accept handler before applying | Replaced |
| `ws resume` | `task_tool('status')` after reconnect; claims survive reconnect (§3.3) | Hosted |
| `ws submit` | Automatic at run-completion (all subtasks valid) | Replaced |
| `ws reject --reason ...` (whole-run reject) | `pre-verify.verified=false` with `reject_reason` enum (matches ws's reasons: duplicate, not-a-company, company-not-found, no-job-board, no-open-positions, subsidiary). Subsidiary case sets `parent_slug` so the accept handler can queue a fresh run for the parent. Downstream subtasks short-circuit via `skip_if`. | Replaced |
| `ws del [slug]` | Operator declines the run in jobseek; Murmur sweeps via TTL | Replaced |
| `ws help` | KB browsing as a subcommand: `task_tool('help <topic>')` | Hosted |

**Board management:**

| ws | Murmur destination | Status |
|---|---|---|
| `ws add board <alias> --url ...` | Encoded in `list-boards` output | Hosted |
| `ws add boards <urls...>` | Encoded in `list-boards` output | Hosted |
| `ws set --name/--website/--logo/--description/...` | Encoded in `setup-metadata` output | Hosted |
| `ws set --logo-candidate N / --icon-candidate N` | Subcommands on `setup-metadata`: `list logo candidates`, then chosen URL goes in output | Hosted |
| `ws del board <alias>` | Agent omits the board from `list-boards` output. To remove a board after `configure-board` has run for it: `task_tool('blocked', ...)` + publisher reissues run with adjusted `prior_outputs`. | Hosted |

**Probing / running / selecting (per board):**

| ws | Murmur destination | Status |
|---|---|---|
| `ws probe monitor -n N` | `task_tool('probe monitor', { board_url, expected_count })` on `configure-board` | Hosted |
| `ws probe scraper` | `task_tool('probe scraper', { board_url, sample_urls })` | Hosted |
| `ws probe deep -n N` | `task_tool('probe deep', { board_url })` (Playwright api_sniffer detection) | Hosted |
| `ws probe api <url>` | `task_tool('probe api', { url })` (single-API analysis) | Hosted |
| `ws select monitor <type> [--as] [--config]` | `task_tool('select monitor', { type, name, config })` (state lives in subcommand server, not Murmur) | Hosted |
| `ws select scraper <type> [--as] [--config]` | `task_tool('select scraper', { ... })` | Hosted |
| `ws select config <name>` | `task_tool('select config', { name })` | Hosted |
| `ws reject-config <name> --reason` | `task_tool('reject-config', { name, reason })` | Hosted |
| `ws run monitor [--config]` | `task_tool('run monitor', { ... })` | Hosted |
| `ws run scraper [--url ... --config]` | `task_tool('run scraper', { ... })` | Hosted |
| `ws compare-boards` | jobseek's accept handler runs the same logic on `final_output` (against per-run boards plus existing catalog rows for reconfig). Drops MIRROR/SUBSET/PHANTOM/PARENT-PORTAL/UNSUPPORTED outcomes; keeps OVERLAP with annotation. See §4.2. | Replaced (publisher-side) |

**Feedback / synchronization / workflow control:**

| ws | Murmur destination | Status |
|---|---|---|
| `ws feedback --verdict --per-field ... --notes` | `task_tool('feedback', { ... })` then encoded in `configure-board` output (verdict, per_field) | Hosted |
| `ws await-board` / `ws boards-done` | Replaced by `list-boards` returning the full board set; no parallel discovery primitive in MVP. Post-MVP: revisit if real publishers need it (see §5 forward-compatibility note). | Replaced (with caveat) |
| `ws task` (show step instructions) | `instructions` returned by `pull_task` | Replaced |
| `ws task next --notes "<reflection>"` | `submit_result(claim, result, notes?)` — explicit `notes` parameter (§3.1). Persists in audit. | Replaced |
| `ws task back --to <step> --reason` | `task_tool('blocked', { reason })` + publisher issues fresh run with `prior_outputs` for keepers (no native rewind in Murmur — see §3.4). | Replaced |
| `ws task fail --reason` | `task_tool('blocked', { reason })` (§3.4) | Hosted |
| `ws task complete` | Automatic at last subtask submit | Replaced |
| `ws task status` | `task_tool('status')` | Hosted |
| `ws task troubleshoot <q>` | `task_tool('kb search', { q })` | Hosted |
| `ws task learn ...` | Universal optional `kb_entries` array on any subtask's output (§3.1). Murmur aggregates across subtasks into `final_output.kb_entries`; accept handler ingests. | Replaced |
| `ws task casestudy ...` | Universal optional `case_studies` array on any subtask's output (§3.1). Aggregated into `final_output.case_studies`; accept handler ingests. | Replaced |

**Taxonomy / discovery / utilities:**

| ws | Murmur destination | Status |
|---|---|---|
| `ws taxonomy search <name> <q>` | `task_tool('taxonomy search', { ... })` on `setup-metadata` | Hosted |
| `ws taxonomy validate <name>` | jobseek's accept handler validates final output; no agent-time taxonomy mutation | Replaced |
| `ws taxonomy add <name> --en --de --fr --it` | Out of agent scope; operator-only (jobseek admin UI). | Cut for agents (operator path unchanged) |
| `ws discover <slug>` (foreground) | `task_tool('discover company', { website })` | Hosted |
| `ws discover-bg <slug>` | Async kicked off by `task_tool('discover company', ...)`; results polled via `task_tool('list logo candidates')` | Hosted |
| `ws logos <slug>` | `task_tool('list logo candidates')` | Hosted |

### 9.2 Workflow steps (00–07 + fail mode)

| ws step | Murmur subtask(s) |
|---|---|
| 00 pre-verify | `pre-verify` |
| 01 setup | `setup-metadata` |
| 02 add-boards | `list-boards` (returns boards array; spawns per-board children) |
| 03 select-monitor | inside `configure-board` (subcommands) |
| 04 select-scraper | inside `configure-board` (subcommands; `skip_if` on auto-config monitors) |
| 05 verify-and-feedback | inside `configure-board` (the `verdict` + `per_field` outputs) |
| 06 submit | automatic on run-completion |
| 07 reflect | per-subtask optional `kb_entries` / `case_studies` outputs flattened into `final_output` (no dedicated reflect subtask) |
| fail-mode | `task_tool('blocked', ...)` then operator triage |

### 9.3 State / artifacts

| ws artifact | Murmur destination |
|---|---|
| `.workspace/<slug>/workspace.yaml` | run row + per-subtask result rows |
| `.workspace/<slug>/workflow.yaml` | run row (current_subtask, completed_subtasks) |
| `.workspace/<slug>/log.yaml` | per-subtask `agent_actions[]` in audit log |
| `.workspace/<slug>/boards/<alias>.yaml` | each `configure-board` instance's result row |
| `.workspace/<slug>/artifacts/` (logos, probe results) | publisher-side; agents reference via subcommand returns |
| `companies.csv` / `boards.csv` row append | jobseek's accept handler writes to local Postgres on webhook delivery (jobseek migrating catalog off CSV+git; §4.2). |
| Git branch / worktree / draft PR | replaced by run state in Murmur |

### 9.4 Side effects

| ws side effect | Murmur destination |
|---|---|
| GitHub issue claim/unclaim/comment/close | replaced (run states + jobseek admin UI) |
| Git branch / commit / push / PR | replaced (Murmur run state + accept-handler writes) |
| Live HTTP probes | publisher subcommand endpoints |
| Live monitor / scraper crawls | publisher subcommand endpoints |
| Logo discovery (Google/Wikipedia/Wikidata) | publisher `discover company` subcommand (kicks off async, polled) |
| CSV finalization | jobseek's accept handler |
| Trace export to Hugging Face | jobseek's accept handler reads `GET /runs/{id}` audit, uploads |
| KB writes (`kb/*.md`) | Each subtask explicitly declares optional `kb_entries` / `case_studies` arrays in its `outputs` (§3.1). The pipeline's `final_output.composes` rule flattens them; jobseek's accept handler ingests into local Postgres KB. No agent-time HTTP write, no git commit, no operator-curated `kb_pending` queue, no dedicated reflect subtask. Same final outcome as ws today; cleaner mechanism. |

### 9.5 Quality / safety machinery

| ws machinery | Murmur destination |
|---|---|
| Preflight checks (branch/PR consistency) | not needed (no git) |
| Workflow gates (state-based) | replaced by `output_schema` validation + `skip_if` |
| Idempotent `ws new` | `POST /pipelines/.../runs` with `Idempotency-Key: <publisher-side-key>` (publisher concern) |
| Stale worktree cleanup | not needed |
| CSV conflict resolution | not needed (accept handler is the only writer) |
| Stuck-PR reclaim (oldest-issue selection) | claim TTL + sweeper (§3.3) |
| Issue claim (prevent duplicate processing) | claim model (one active claim per session, §3.3) |
| Budget caps (`BUDGET_PER_5H` in resolve-company-requests.yml) | jobseek's cron applies its own budget when triggering runs; Murmur doesn't enforce |
| Anti-flapping git retries | not needed |
| Validation (`inspect.py`) | runs in accept handler before applying |

### 9.6 Knowledge content

| ws content | Murmur destination |
|---|---|
| `steps/*.md` | `instructions` field in pipeline def |
| `kb/*.md` (107 entries) | served via `task_tool('kb search', ...)` / `task_tool('kb view', ...)` subcommands; backed by jobseek's local Postgres after the catalog migration (§4.2). |
| `commands/help.py` topics | served via `task_tool('help <topic>')` subcommand |
| Per-monitor / per-scraper docs | served as KB topics |
| Parallel step templates (`steps/parallel/*.md`) | not needed for MVP (no parallel branches); revisit post-MVP if real |

### 9.7 Local mode and dev ergonomics

| ws | Murmur destination |
|---|---|
| `WS_LOCAL=1` (skip git/GitHub) | not needed (no git/GitHub in Murmur). Local dev: run Murmur server + jobseek's subcommand server locally; point Claude Code's MCP at localhost. |
| `ws artifacts` | publisher side; subcommand returns include artifact references |

### 9.8 Genuine acknowledged losses (with mitigation)

Items where the ws → Murmur port reduces capability *and* mitigation isn't free:

1. **Concurrent per-board parallelism (Track A/B/C).** ws supports parallel discovery via three subagents; Murmur's MVP processes a run sequentially. *Mitigation:* the protocol's `requires` field already permits siblings without ordering constraints (§3.1); enabling concurrent claims for a single run is a post-MVP server change, not a protocol change. Acceptable cost: longer wall-clock for first run on companies with many boards.
2. **`ws use` multi-workspace switching for one human.** ws lets one developer juggle multiple companies in flight. Murmur expects one active claim per agent session. *Mitigation:* developers run multiple Claude Code sessions, one per claim. No real loss for agent users (each agent does one thing at a time anyway); minor friction for a single human handling many.
3. **Direct CSV mutation by humans for emergencies.** Devs editing CSVs directly is the documented escape hatch (§4.2). Unchanged.

Nothing else from the audit is lost. If implementation reveals further gaps, the mitigation is to extend Murmur's protocol primitives or jobseek's subcommand surface, not to rebuild ws.
