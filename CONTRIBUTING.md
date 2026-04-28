# Contributing to Murmur

Most work in this repo is performed by Claude Code agents driven by an orchestrator (see `AGENTS.md`). Humans can contribute too — this guide tells you how.

## Quick start (local)

```bash
pnpm install
pnpm dev          # boots the local Murmur server (after M1 lands)
pnpm test         # runs unit tests
pnpm typecheck    # strict TS
pnpm lint         # ESLint
pnpm grep:all     # security/style grep gates
```

## Pre-commit hooks

We use [lefthook](https://github.com/evilmartians/lefthook):

```bash
brew install lefthook   # or your equivalent
lefthook install
```

Pre-commit runs typecheck, lint --fix on staged, prettier on staged, and grep gates. Pre-push runs full test + grep:all. None of these are skippable; if a hook fails, the commit / push is blocked. **Do not use `--no-verify`** — fix the issue.

## Process

1. Pick an open, unblocked issue from [Demo readiness](https://github.com/colophon-group/murmur/milestone/1).
2. Comment on it: `Claimed by @<your-handle> until <ISO-timestamp +2h>`. If a claim's TTL elapses without a PR, anyone (including the orchestrator) can re-claim.
3. Add an "Implementation sketch" comment **before** writing code. See `AGENTS.md` for the template.
4. Branch off `main`: `git checkout -b dev/<issue-num>-<short-slug>`.
5. **Interfaces first** — types/signatures with no implementation. Commit.
6. **Tests next** — derived from the issue's "Verification" section. Commit. Tests should fail.
7. **Implement** until tests pass. Multiple small commits preferred.
8. Run `pnpm typecheck && pnpm lint && pnpm test && pnpm grep:all` locally. Fix anything red.
9. Open a PR with `Closes #<issue-num>` in the body. Title format: `[<role>] <issue title>` (e.g., `[feat] M5: Atomic claim pickup`).
10. Comment on the issue: `Implementation complete, PR #<n>, ready for review`.
11. A reviewer (agent or human) will leave comments. Address them; reply `Fixed in <sha>` and resolve threads. Push again.
12. When approved: orchestrator (or a human maintainer) squash-merges.

## Code standards

- TypeScript strict; no `any`; no `as <T>` without a comment justifying it
- ESLint clean; no `// eslint-disable` without an inline reason
- Coverage ≥85% on gated paths (`src/auth/**`, `src/api/**`, `src/dispatch/**`)
- Functions ≤50 lines unless an inline comment explains why
- Comments only when WHY isn't obvious from names + types
- All response envelopes use `EnvelopeResponse<T>` from `@murmur/contracts-types` (the M0 package)

## Security guardrails

- **Never log `MURMUR_TOKEN`** or any secret. The `grep:no-token-logged` gate will catch obvious mistakes.
- Token comparisons use `crypto.timingSafeEqual` (the `grep:uses-timingsafeequal` gate enforces this in `src/auth/**`).
- URLs received from agents are SSRF-validated before any outbound fetch (publisher side; see DESIGN.md §3.6).

## Reporting issues

- Bugs → open an issue with `type:feature` (or `type:infra`) and the relevant `area:*` label
- Spec disagreements → open a PR against `DESIGN.md` separately; do not bundle with code PRs

## What you'll find here

- `DESIGN.md` — protocol spec, demo plan, ws coverage matrix
- `AGENTS.md` — agent process (the human-readable version of what the orchestrator enforces)
- `.claude/agents/` — agent role definitions (orchestrator, developer, reviewer)
- `.claude/settings.json` — Claude Code permissions
- `.github/workflows/ci.yml` — CI pipeline
- `lefthook.yml` — local hook config
- `scripts/grep-*.sh` — quality gates
