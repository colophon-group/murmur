# Murmur

Cross-publisher MCP work queue with auditable claim/dispatch lifecycle. See
[`DESIGN.md`](DESIGN.md) for the full protocol spec and demo plan.

## Quickstart

Prereqs: Node ≥ 22 (`.nvmrc` pins the LTS line) and `pnpm@10.30.0`
(matches `packageManager` in `package.json`; `corepack enable` is the easiest
way to get it).

```bash
# install dependencies
pnpm install

# run the dev server (hot-reload via tsx)
PORT=8080 pnpm dev

# in another shell:
curl -s http://localhost:8080/health
# → {"ok":true}

# run the test suite (Vitest + v8 coverage)
pnpm test

# typecheck (strict TS, no any, noUncheckedIndexedAccess)
pnpm typecheck

# lint (ESLint flat config + ts-prune for unused exports)
pnpm lint

# all grep gates (auth equality, timingSafeEqual, accepted-key, secret logging)
pnpm grep:all
```

`PORT` is mandatory — boot fails fast if it's unset. See `DESIGN.md` §6.2 for
the full env var list (most arrive in later milestones).

## Layout

```
src/                      Murmur server (Hono + node-server)
  server.ts               HTTP app factory
  index.ts                Boot: read PORT, bind socket
  logger.ts               Tiny structured logger (JSON-line to stderr)
packages/contracts-types/ M0 contract types (envelope, headers, pipeline, ...)
scripts/                  CI gate scripts (grep-all, check-unused-exports, ...)
docs/                     Boundary contracts + bootstrap runbooks
```

## Development process

This repo is built by Claude Code agents in three roles. See
[`AGENTS.md`](AGENTS.md) for the per-issue workflow and quality gates each PR
must pass before merge.
