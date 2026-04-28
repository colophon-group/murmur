# Murmur — Design Spec (MVP)

**Status:** Draft, MVP for theory-validation demo
**Date:** 2026-04-28

Murmur is the **infrastructure layer between publisher apps and user agents** — between apps that need decision work done, and the coding agents (Claude Code, Cursor, …) already running in users' IDEs. Publishers expose pipelines of small decision subtasks; user agents in their owners' environments pull a subtask, complete it in-session, and submit a structured result. Murmur does not invent agent cognition — it routes existing cognition to where it's useful and stitches results back to the publisher. The first publisher and demo target is jobseek (intentionally a simple first case); the protocol is publisher-agnostic by design.

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
4. Agent calls `pull_task` → receives jobseek's `find-board`. Uses built-in web fetch, identifies the board URL and provider, calls `submit_result`.
5. Agent calls `pull_task` → receives `configure-monitor`. Reads `instructions` telling it to use `task_tool("test monitor", {...})` to verify before submitting.
6. Agent picks a candidate config, calls `task_tool("test monitor", {...})` — Murmur proxies to jobseek's probe endpoint, returns posting count + samples. Agent confirms `ok: true`, calls `submit_result`.
7. Same loop for `configure-scraper` with `task_tool("test scraper", {...})`.
8. Switch to jobseek view: `final_output` arrives via webhook, accept handler re-runs the same probe logic in-process, writes the audience-chosen company to jobseek's catalog. Visible on screen.

**Landing line:** *"That agent had never seen jobseek. Audience-chosen input. The protocol carried what jobseek decided to put in it — Murmur's job is to route, not to know."*

---

## 3. Protocol

Two surfaces: an HTTP API for publishers, an MCP server for agents. Both are thin wrappers around the same store.

**Vocabulary used throughout this section:**

- **Pipeline** — a publisher's task definition (YAML): an ordered list of subtask defs. Versioned; immutable once a run starts.
- **Subtask def** — one entry in a pipeline's `subtasks:` list. Authoring-time concept.
- **Run** — one execution of a pipeline, triggered by the publisher with an `initial_input`. Pinned to the pipeline version at start.
- **Subtask instance** — the runtime occurrence of a subtask def within a run. The thing agents claim.
- **Claim** — a time-limited lease on a specific subtask instance, identified by `claim_token`. Issued by `pull_task`, consumed by `submit_result`. Bound to the token, not to the agent's MCP session.
- **Subcommand** — a publisher-declared callable under a subtask def, invoked by the agent through `task_tool('<name>', {...})`.
- **Publisher** — an app that registers pipelines and accepts `final_output` via webhook.
- **Agent** — a coding agent (Claude Code, Cursor, …) running in a user's environment, connected to Murmur over MCP.
- **Host** — the runtime that loads MCP tools and hands them to the agent's model (Claude Code, Cursor, …). The agent's MCP "host."

### 3.1 Pipeline definition

YAML, authored by the publisher, registered to the server.

```yaml
id: jobseek/add-company
version: 1
initial_input_schema:
  company_name: string
  website: string
subtasks:
  - id: find-board
    instructions: |
      Given the company website, find the URL of its public job board
      and identify the provider.
      Allowed providers: greenhouse, lever, workday, ashby, smartrecruiters, ...
    inputs: [init.website]
    outputs:
      board_url: string
      board_provider: enum
  - id: configure-monitor
    instructions: |
      Given the board URL and provider, choose the monitor type and config
      jobseek should use to detect new postings. Use
      task_tool("test monitor", {...}) to verify your candidate before
      submitting; task_tool("help") lists everything available for this task.
    inputs: [find-board.board_url, find-board.board_provider]
    outputs:
      monitor_type: enum
      monitor_config: object
    subcommands:
      - name: test monitor
        help: Try a candidate monitor config against the live board. Returns posting count and samples.
        input_schema:  { board_url: string, monitor_type: enum, monitor_config: object }
        output_schema: { ok: boolean, postings_seen: integer, sample_postings: array, errors: array }
        endpoint: POST https://jobseek.colophon-group.org/api/murmur/probes/monitor
  - id: configure-scraper
    instructions: |
      Given the board URL and monitor, choose the scraper type and config
      to extract individual postings. Use task_tool("test scraper", {...})
      to verify against a sample posting before submitting.
    inputs: [find-board.board_url, configure-monitor.monitor_type]
    outputs:
      scraper_type: enum
      scraper_config: object
    subcommands:
      - name: test scraper
        help: Try a candidate scraper config against a sample posting from the board.
        input_schema:  { board_url: string, scraper_type: enum, scraper_config: object, sample_url: string }
        output_schema: { ok: boolean, parsed_posting: object, errors: array }
        endpoint: POST https://jobseek.colophon-group.org/api/murmur/probes/scraper
final_output:
  composes: [find-board.*, configure-monitor.*, configure-scraper.*]
  webhook: https://jobseek.colophon-group.org/api/murmur/accept
```

Subtasks are linear and pure decisions: `instructions + input → output`. No side effects on Murmur's side, no filesystem, no built-in app-specific tools. When a subtask benefits from verification, the publisher declares **subcommands** under that subtask — each with a name, JSON Schemas for input and output, optional help text, and a publisher HTTP `endpoint`. Agents invoke them through `task_tool` (see §3.4 for dispatch semantics). The publisher only writes HTTP endpoints; the MCP surface stays static.

### 3.2 Server endpoints (publisher-facing)

- `POST /pipelines` — register/upsert a pipeline def. Returns `{id, version}`.
- `POST /pipelines/{id}/runs` — start a run with `initial_input`. Returns `{run_id}`.
- `GET /runs/{run_id}` — poll status and final output.
- `POST {webhook}` — server pushes `final_output` to the publisher when the run completes.

### 3.3 Server endpoints (agent-facing, behind MCP)

- `GET /work/next` — atomically claim the oldest unclaimed subtask instance across all pipelines, or 204. Implementation: single statement `UPDATE subtask_instances SET claim_token=?, expires_at=? WHERE id=(SELECT id FROM subtask_instances WHERE claim_token IS NULL AND status='ready' ORDER BY created_at LIMIT 1) RETURNING …` inside `BEGIN IMMEDIATE` on a WAL-mode SQLite. No SELECT-then-UPDATE race.
- `POST /work/{claim_token}/result` — submit a structured result. Validates against the subtask's `output_schema` and the claim is consumed atomically: `UPDATE subtask_instances SET result=?, status='done' WHERE claim_token=? AND status='claimed' AND expires_at>now() RETURNING …`. If the row no longer matches (TTL expired, already submitted), the call returns `{accepted: false, reason: 'claim_lost'}` and the agent's submission is discarded.

**Claim semantics:**

- **One active claim per session.** `pull_task` refuses to issue a second claim while a session has one outstanding (returns the existing claim's metadata so the agent can resume). Eliminates the "which claim does this `task_tool` apply to" question.
- **Soft TTL:** 10 minutes. Slides forward only on *successful* `task_tool` round-trip, so a stuck call or crashed agent doesn't extend a claim it isn't using.
- **Hard wallclock cap:** 30 minutes from `pull_task`, regardless of slides. `expires_at = min(now() + 10min, claim_created_at + 30min)`.
- **Cap pre-check:** Every `task_tool` response includes `wallclock_remaining_ms`. `task_tool` calls that would land their slide past the cap are rejected up-front with `{ok: false, errors: ["claim_near_expiry"]}` before the publisher round-trip — no successful call followed by a doomed `submit_result`.
- On expiry the subtask instance returns to the pool with `claim_token = NULL`. A background sweeper runs every 30s to reset rows whose `expires_at < now()` (so the atomic `WHERE claim_token IS NULL` in `GET /work/next` sees them).
- Bound to `claim_token`, not MCP session ID. Reconnects don't invalidate it; an agent can resume by passing `claim` to `task_tool` / `submit_result`.
- Subcommand **schemas** (input, output, help) are snapshotted into the claim row at issue time so mid-flight pipeline upserts can't change them under an active agent. Subcommand **endpoint URLs** are resolved live from the run's pinned pipeline version, so a publisher can hot-fix a wrong URL without breaking in-flight claims. Murmur passes `X-Murmur-Pipeline-Id`, `X-Murmur-Pipeline-Version`, and `X-Murmur-Subcommand` headers on every proxy call so the publisher can detect and reject contract-skew at the server.
- Pipeline upserts create a new `version`; in-flight runs stay pinned to the version they started with.

No retries on schema-validation failure for MVP — the run fails.

### 3.4 MCP server (agent-facing)

Three static tools, fixed for the lifetime of the connection:

- `pull_task()` → `{ instructions, input, output_schema, claim }` or `null`.
- `submit_result(claim, result)` → `{ accepted: true } | { accepted: false, errors: [...] }`.
- `task_tool(subcommand: string, args?: object, claim?: string)` → `string | object` — universal dispatcher. Invokes a publisher-declared subcommand for the agent's active claim (see §3.1). Static description (visible to the host's tool catalog):

  > *Invoke a subcommand for the current claim. The subtask `instructions` will tell you which subcommands to use and when; `task_tool('<name>', {...})` invokes one. Use `task_tool('help')` or `task_tool('help <name>')` only when you need schema-level detail beyond what `instructions` already gives you (e.g., the exact field names of a config object).*

Built-in subcommands provided by Murmur for every claim:

- `help` — list available subcommands with their help text. Useful fallback when subtask `instructions` don't cover what the agent needs.
- `help <name>` — return the named subcommand's `input_schema`, `output_schema`, and help text.

**Dispatch:** Murmur resolves the active claim from the optional `claim` arg, falling back to the session's single active claim (`pull_task` enforces one-per-session, §3.3). With the claim known, Murmur looks up the subcommand in the claim's snapshotted schema set, validates `args` against `input_schema`, checks the cap pre-check (§3.3), resolves the endpoint URL from the run's pinned pipeline version, POSTs with the publisher-failure protections in §3.6, and returns the response — augmented with `wallclock_remaining_ms`. The claim's TTL slides forward only on a successful (non-error) round-trip.

**Errors:**

- No active claim → suggests calling `pull_task` first.
- Unknown subcommand → suggests `task_tool('help')`.
- Args fail validation → returns schema errors.
- `claim_near_expiry` → call would slide past hard cap; agent should `submit_result` now or accept the run will fail.
- Publisher endpoint failure → see §3.6.

Optional static tool, post-MVP:

- `report_blocker(claim, reason)` — agent declines, subtask returns to pool with a recorded reason.

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

Murmur validates against `output_schema`, marks the subtask done, and advances the run. The agent's next `pull_task()` returns `configure-scraper`.

### 3.6 Failure modes & demo-grade security

Specified explicitly to avoid implementation surprises.

**Demo-grade auth (replaces "no auth" cut).** Murmur is publicly hostnamed before the demo; "no auth" is a demo disruption vector. Two demo-grade tokens, both shared but scoped:

- **`AGENT_TOKEN`** — gates the agent surface (`GET /work/next`, `POST /work/{claim}/result`, MCP transport, including reconnects). Required on every request as `Authorization: Bearer …` (Streamable HTTP has no separate handshake; auth is per-request, including resume).
- **`PUBLISHER_TOKEN`** — gates the publisher surface (`POST /pipelines`, `POST /pipelines/{id}/runs`). Separate so a leaked agent token can't upsert a malicious `instructions` payload (which would, via the jobseek cron fallback, become RCE in jobseek's CI).
- Both tokens set via env var on the box, rotated per deployment. Single shared values within each role.
- **No `GET /pipelines/{id}` for MVP.** Read access to stored pipeline defs is not exposed; published `endpoint` URLs are visible only to running claims (which receive their own subcommand schemas, not arbitrary pipelines'). Closes the `webhook_secret` exfil path.
- Adequate for a closed demo deployment. Not adequate for real users — no per-user identity, no rate limiting, no revocation primitive without redeploy.

**Webhook signing.** Murmur's webhook POSTs are signed with HMAC-SHA256 over the body, using a per-publisher `webhook_secret`:

- Provenance: secret is provided at registration time as part of an out-of-band setup, *not* committed to the publisher's pipeline def YAML. Publishers store it in their CI secret manager and template it into the `POST /pipelines` request body.
- Storage in Murmur: hashed at rest (Argon2id) for verification only; never returned by any API.
- Rotation: a fresh `POST /pipelines` with a new `webhook_secret` updates it; webhooks for in-flight runs use the secret active at run-start (pinned in the run row).

**Publisher SSRF defense.** Murmur faithfully proxies the agent's `args` to the publisher's endpoint. Publisher probe endpoints that accept URLs (e.g., jobseek's `board_url`, `sample_url`) MUST allowlist hosts and reject private/loopback/link-local/metadata-service IPs after DNS resolution (with rebinding protection: resolve once, post and check the resolved IP). Allowlist by host pattern alone is *not* sufficient — subdomain takeovers and vendor-hosted careers pages can match patterns like `*.greenhouse.io`. Documented as a publisher requirement in §4.2.

**Murmur-side SSRF defense.** Pipeline `endpoint` and `webhook` URLs are publisher-controlled; a malicious pipeline could point them at metadata services. On registration, Murmur rejects URLs whose host resolves to private/loopback/link-local/metadata IPs, and re-checks at dispatch (DNS rebinding guard). Both rejections are hard 4xx at registration / hard structured error at dispatch.

**Failure modes:**

- **Publisher endpoint slow / hung.** Hard 15s timeout on every `task_tool` proxy call. On timeout, Murmur returns `{ok: false, errors: ["publisher_timeout"]}` to the agent (structured, so the agent can react) rather than letting the MCP call hang. Outbound HTTP connection pooled with a hard limit; no per-call leak.
- **Publisher endpoint 5xx.** Returned to the agent as `{ok: false, errors: ["publisher_5xx", "<status>"]}`. No automatic retry — the agent decides whether to retry, and the publisher sees one call per agent decision.
- **Publisher response too large.** 1 MB cap on response body. Truncated responses are returned with `{ok: false, errors: ["publisher_response_too_large"]}` so probes can't be used to dump unbounded data through Murmur.
- **Webhook delivery.** On run completion Murmur POSTs `final_output` to the publisher's webhook with an `Idempotency-Key: <run_id>` header. One retry on non-2xx after 30s. Publishers must treat the key as deduplication input — the same `final_output` may arrive twice.
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

1. **Author a pipeline definition** in YAML — initial input schema, ordered subtasks (each with instructions, input refs, output schema), webhook URL, and `webhook_secret` for HMAC signing.
2. **Register it** via authenticated `POST /pipelines` (typically from CI on change).
3. **Trigger runs** by POSTing to `/pipelines/{id}/runs` whenever the publisher's app needs the work done.
4. **Accept results** at the webhook URL — verify the HMAC signature against the shared secret, then apply `final_output`.

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

### 4.2 Worked example: jobseek

Jobseek is the demo publisher and the only integrator for MVP. It's a brownfield case: it has an existing `ws` workflow built on git/PRs that Murmur replaces in part. Today `ws` uses git for two things — multi-agent collaboration (one branch per company-in-progress) and work persistence (workspace state on the branch) — both of which move to Murmur. The git/PR machinery comes out of jobseek; the validation/probe logic stays, refactored from CLI commands into importable async functions.

| Concern | Owner after port | Notes |
|---|---|---|
| In-flight crawler-config state | Murmur (runs + subtasks + results) | Replaces `.workspace/<slug>/`, draft PRs, per-company branches |
| Multi-agent coordination | Murmur (claim model) | Replaces "one agent per branch"; parallel across runs, sequential within a linear run |
| Audit trail of who-did-what | Murmur (`runs`, `subtask_results`) | Replaces `git log` for this domain |
| Subtask instructions | jobseek `apps/crawler/murmur/pipelines/*.yaml`, content adapted from `workspace/steps/*.md` | Strip `ws`-CLI references; keep the decision content |
| In-subtask verification | jobseek public probe endpoints (see below) | Called by the agent during the configure-* subtasks |
| Final-output validation | jobseek `apps/web` accept handler, calling the same probe functions | Final guard before applying |
| Final acceptance | jobseek accept handler writes directly to `companies.csv` / `boards.csv` (or DB) | Replaces PR + auto-merge |
| Run trigger | jobseek's `requestCompany` POSTs to Murmur | Replaces GH-issue creation for new requests |

Jobseek exposes two HTTP probe endpoints under `jobseek.colophon-group.org` — `POST /api/murmur/probes/monitor` and `…/probes/scraper` — declared as `test monitor` and `test scraper` subcommands in the configure-* subtasks (see §3.1 for the full pipeline def with schemas). Agents invoke them as `task_tool("test monitor", {...})` and `task_tool("test scraper", {...})`. Both endpoints are thin shims around the same probe logic the accept handler runs as a final guard before applying `final_output`. One implementation, three callers (agent → `task_tool` → HTTP, accept handler in-process, manual debugging via curl).

`find-board` doesn't declare any subcommands for MVP — the agent uses its own web fetch and a documented list of board-host patterns (`*.greenhouse.io` → greenhouse, `jobs.lever.co/<co>` → lever, `*.myworkdayjobs.com` → workday, …). If find-board picks the wrong URL the configure-* probes will all fail; for MVP we pre-test the demo company.

What jobseek removes: GH-issue creation in `requestCompany`, draft-PR machinery, `workspace.yaml`, per-company branches, `ws task` / `ws new` / `ws await-board` / `ws submit`. What it keeps: monitor + scraper class library, probe/validation logic (refactored as importable), data-source writers, the `companyRequest` table, and `resolve-company-requests.yml` — repurposed as a fallback Murmur agent that periodically spawns a Claude Code Action to pull and complete any unclaimed subtasks (and re-POSTs `companyRequest` rows that never reached Murmur). From Murmur's perspective this cron is just another agent. Devs never manually configure companies; the worst-case escape hatch is hand-editing the CSVs.

**Probe SSRF defense (jobseek-side).** Per §3.6, the publisher must filter URLs the agent submits. Jobseek's monitor and scraper probes accept only `board_url` / `sample_url` whose host matches the documented board-host allowlist (`*.greenhouse.io`, `jobs.lever.co/*`, `*.myworkdayjobs.com`, …). Anything else returns `{ok: false, errors: ["url_not_allowed"]}` immediately, before any outbound fetch.

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
- **Linear pipelines only.** No DAG, no branching, no skip-on-error.
- **No retry on bad result.** Schema-fail = run-fail.
- **MCP only on agent side.** No CLI, no `npx` runner. Demo target = Claude Code.
- **One publisher (jobseek).** §4.3 sketches a hypothetical second publisher for reasoning purposes only; it is not built or demoed.
- **No rewards / token accounting.**
- **Server is single-process SQLite.** No HA, no horizontal scale.
- **Pipeline defs stored on Murmur.** Not fetched from publisher repos.

**Load-bearing assumptions (not Murmur-side cuts but worth naming):**

- The agent's host (Claude Code) provides web fetch. The jobseek `find-board` subtask depends on it.
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

Secrets in the GH `production` environment: `CLOUDFLARE_TUNNEL_TOKEN`, `OWNER`, GHCR pull credentials, `AGENT_TOKEN`, `PUBLISHER_TOKEN`. No `.env` checked in; ephemeral on the box.

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
