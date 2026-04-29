# Murmur — Integration tests

This directory holds **cross-module wire-level tests** that exercise the
full stack composition (publisher API + agent API + dispatcher + webhook
delivery) against an in-process Murmur server and a stub `node:http`
"publisher" mock. Per-module unit tests still live alongside their
modules (`src/api/agent/agent.test.ts`, `src/dispatch/task_tool.test.ts`,
`src/webhook.test.ts`, etc.) — those keep fast iteration cycles and stay
focused on a single seam at a time. The tests under this directory have
a higher boot cost (real DB + real HTTP socket on `127.0.0.1:0`) so they
sit here, run alongside `pnpm test`, and are gated by the same coverage
configuration.

## What's tested here

`full-flow.test.ts` boots a fresh in-process Murmur on a `:memory:`
SQLite and starts a tiny mock-jobseek HTTP server on a random port.
It registers the §3.1 jobseek pipeline def with endpoints pointed at
the mock, then drives a scripted "agent" loop that:

1. Calls `pull_task` (M5 / `GET /work/next`).
2. Optionally invokes `task_tool` (M7 / `dispatchTaskTool`) for the
   subcommands declared on the claimed subtask.
3. Submits a schema-valid result via `submit_result`
   (M5 / `POST /work/{claim}/result`).

The assertions cover:

- **Envelope discipline.** Every Murmur-side response is the M0
  `{ ok, errors?, data? }` shape — there is no `accepted` key anywhere.
- **Header casing on the wire.** The mock-jobseek captures
  `req.rawHeaders`, an array preserving the exact mixed-case casing the
  client emitted (Node lower-cases `req.headers` by default; we look at
  the raw form). The expected casing is the M0 constant in
  `@murmur/contracts-types`.
- **Bearer + idempotency.** Every proxied subcommand carries
  `Authorization: Bearer <MURMUR_TOKEN>` and the webhook delivery
  carries `Idempotency-Key: <run_id>`.
- **Spawns.** A 3-board variant of `list-boards` instantiates 3
  `configure-board` children, all claimed in FIFO `created_at` order.
- **Composition.** After all subtasks complete, `final_output` matches
  the §3.1 example shape produced by the §3.1 `composes` rules.
- **Webhook replay idempotency.** A second `deliverWebhook` call
  carrying the same `Idempotency-Key` is observed by the mock-jobseek
  but the apply-side-effect (a counter on the mock) increments only
  once.

## Why a separate `src/integration/` directory

Two reasons. (1) Boot cost — these tests open real sockets and run
real timers (deterministically via injected `setTimeoutFn`). Per-module
tests remain socket-free where possible. (2) The seam under test is
the *cross-repo wire contract*, not any one module. A breakage caused
by drift between Murmur's emitted headers and the contracts-types
constants would fail here even if every per-module test stays green.

## Running

```bash
pnpm test -- src/integration
```

Or as part of the full suite:

```bash
pnpm test
```

These tests must not depend on any external service. The mock-jobseek
listens on `127.0.0.1:0` (kernel-assigned port) and is torn down in
`afterEach`/`afterAll`. No env vars beyond what the rest of the suite
sets.
