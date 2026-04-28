# AGENTS — development process for Murmur

The implementation plan lives in GitHub issues across two repos (DESIGN.md §5.2). Work happens via three roles of Claude Code agents: **orchestrator**, **developer**, **reviewer**.

## Quick map

| Role | When | What |
|---|---|---|
| orchestrator | Always running, picks up unblocked issues | Spawns developers, monitors PRs, spawns reviewers, iterates until merge, picks the next issue |
| developer | Spawned by orchestrator, one per issue | Claims, sketches, builds interfaces + tests + impl, opens PR, reports back |
| reviewer | Spawned by orchestrator after each developer hand-off | Strict review on the PR; non-blocking nits + blocking concerns; can open separate issues for orthogonal findings |

Role definitions: `.claude/agents/orchestrator.md`, `.claude/agents/developer.md`, `.claude/agents/reviewer.md`.

## The development process (per issue)

1. **Claim** — developer adds a comment to the issue: `Claimed by <handle> until <ISO timestamp +2h>`. If a claim's TTL elapses without a PR, the next orchestrator cycle treats the issue as unclaimed.
2. **Implementation sketch** — developer adds a second comment to the issue: a 1-paragraph approach + bullet list of files to add/edit + key types/interfaces + identified risks. Posted *before* code is written, so the orchestrator can intervene if the sketch is off.
3. **Branch** — developer creates `<role>/<issue-number>-<short-slug>` branch off `main`.
4. **Interfaces first** — developer writes the type signatures / abstract classes / function signatures with no implementation (throw `not implemented` body). JSDoc/docstrings explain contract.
5. **Tests against interfaces** — developer writes the verification tests from the issue's "Verification" section against the unimplemented interfaces. All tests should fail at this stage. This is a checkpoint: the test list captures every edge case the issue named.
6. **Implementation** — developer fills in the bodies until tests pass.
7. **Local quality gates** — developer runs `pnpm typecheck && pnpm lint && pnpm test && pnpm grep:all` (per the M1 setup) and confirms green.
8. **PR** — developer opens a PR with `Closes #<issue-number>` in the body. PR title is `[<role>] <issue title>`. PR description includes: links to issue, files changed summary, manual verification steps run.
9. **Hand-off** — developer comments on the issue: `Implementation complete, PR #<n>, ready for review`. Stops working.
10. **Review** — orchestrator spawns a reviewer on the PR. Reviewer leaves PR comments and a final `APPROVE` or `REQUEST CHANGES` summary. Findings unrelated to this PR become new GH issues.
11. **Iterate** — if `REQUEST CHANGES`, orchestrator re-spawns the developer to address feedback. The developer responds to each comment thread with either a code change or a justification (the reviewer must explicitly resolve threads they accept).
12. **Merge** — once `APPROVE` is final, orchestrator merges (squash-merge, conventional commit message, branch deleted).

## Quality gates (must pass before merge)

- `pnpm typecheck` — strict TS, no `any`, no `@ts-expect-error`
- `pnpm lint` — ESLint with `@typescript-eslint/no-explicit-any: error`, `unused-exports: error`
- `pnpm test` — Vitest green, coverage ≥ 85% on gated paths (per M1)
- `pnpm grep:all` — runs every grep gate (`grep:no-naked-eq-in-auth`, `grep:uses-timingsafeequal`, `grep:no-accepted-key`, `grep:no-token-logged`)
- `pnpm build` — prod build succeeds (where applicable)
- CI green on the PR
- Reviewer `APPROVE`
- Issue's "Definition of done" checklist all checked

## Reviewer authority

- Reviewer may **REQUEST CHANGES** for: missing tests from the issue's verification list, unhandled edge cases, weak typing (`any`, `as`), dead code, security smells, naming, complexity that exceeds the issue's scope, missing or misleading comments, untested error paths.
- Reviewer **must not** block on style preferences not encoded in lint rules — those are nits.
- For findings unrelated to the PR (pre-existing bug, technical debt, scope creep elsewhere), reviewer creates a new issue with the appropriate `area:*` and `type:*` labels and references it from the PR thread.

## Orchestrator authority

- May reject a developer's implementation sketch if the approach is wrong; developer must revise before coding.
- May reassign an issue if a developer's claim TTL elapses without a PR.
- May spawn multiple developers concurrently for unblocked issues (read the dependency graph from each issue's "Blocked by" line).
- May NOT skip the review step. Every PR gets a reviewer.

## Branch protection (configured manually)

`main` requires:
- 1 reviewer approval (the agent reviewer counts; configure as required check on agent's status)
- All CI checks pass
- No merge conflicts
- Squash merge only

## Cross-repo coordination

The Murmur ↔ jobseek work is split across two repos. The orchestrator monitors both milestones:

- [colophon-group/murmur — Demo readiness](https://github.com/colophon-group/murmur/milestone/1)
- [colophon-group/jobseek — Murmur demo readiness](https://github.com/colophon-group/jobseek/milestone/1)

Issues can have cross-repo `Blocked by` lines (e.g., `Blocked by: murmur#34 (M0)`); orchestrator must respect them.

## Where to find things

- `DESIGN.md` — protocol spec, demo plan, coverage matrix
- `AGENTS.md` (this file) — process
- `.claude/agents/` — role definitions
- `.claude/settings.json` — permissions
- `CONTRIBUTING.md` — human contributor guide (if/when humans contribute)
- `.github/workflows/ci.yml` — CI gates
- `lefthook.yml` — pre-commit hooks
- `scripts/grep-*.sh` — grep-gate scripts referenced by M1, M3, M5
