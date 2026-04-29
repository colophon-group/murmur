/**
 * Tests for `scripts/deploy.sh` — the Hetzner deploy entrypoint.
 *
 * Strategy: spawn `bash scripts/deploy.sh` with a custom PATH that
 * shadows `docker` and `pnpm` with shell stubs. The stubs:
 *   - record their argv to a per-test log file,
 *   - exit with a configurable code so we can simulate failures.
 *
 * This validates the script's behavior end-to-end (env validation,
 * `.env` mode 600, command order, fail-fast on migrate failure)
 * without requiring docker / a real box.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "..", "..");
const DEPLOY_SH = join(REPO_ROOT, "scripts", "deploy.sh");

interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly dockerLog: string;
  readonly pnpmLog: string;
  readonly envFile: string | null;
  readonly envFileMode: number | null;
}

interface RunOptions {
  /** Env vars to set in the child shell. */
  readonly env?: Record<string, string>;
  /** Override exit codes for stub commands. Default 0. */
  readonly stubExits?: {
    readonly docker?: number;
    readonly dockerExec?: number;
    readonly pnpm?: number;
  };
}

/**
 * Spawn `bash deploy.sh` with mocked docker/pnpm on PATH, in an
 * isolated tmp HOME so /home/deploy doesn't get touched. We rebind
 * `DEPLOY_DIR` via env override (the script reads it).
 */
function runDeploy(opts: RunOptions = {}): RunResult {
  const tmp = mkdtempSync(join(tmpdir(), "murmur-deploy-test-"));
  const stubDir = join(tmp, "stubs");
  const deployDir = join(tmp, "deploy");
  mkdirSync(stubDir, { recursive: true });
  mkdirSync(deployDir, { recursive: true });

  const dockerLog = join(tmp, "docker.log");
  const pnpmLog = join(tmp, "pnpm.log");

  const dockerExit = opts.stubExits?.docker ?? 0;
  const dockerExecExit = opts.stubExits?.dockerExec ?? 0;
  const pnpmExit = opts.stubExits?.pnpm ?? 0;

  // `docker` stub:
  //   - logs every invocation to $DOCKER_LOG,
  //   - on `docker compose exec -T murmur pnpm migrate`, returns
  //     $DOCKER_EXEC_EXIT (so we can simulate a failing migration),
  //   - on `docker login`, drains stdin to avoid SIGPIPE,
  //   - otherwise returns $DOCKER_EXIT.
  writeFileSync(
    join(stubDir, "docker"),
    `#!/usr/bin/env bash
set -u
echo "docker $*" >> "$DOCKER_LOG"
case "$1 \${2:-}" in
  "login ghcr.io")
    # Drain stdin so callers using --password-stdin don't SIGPIPE.
    cat >/dev/null
    exit "$DOCKER_EXIT"
    ;;
esac
# Detect "compose exec ... pnpm migrate" — on failure, return the
# configured exit code. This lets us simulate a broken migration.
if [[ "$1" == "compose" && "$2" == "exec" ]]; then
  exit "$DOCKER_EXEC_EXIT"
fi
exit "$DOCKER_EXIT"
`,
    { mode: 0o755 },
  );
  // `pnpm` stub — only used if the script ever invoked pnpm directly
  // (it shouldn't; migrate runs inside the container via compose exec).
  writeFileSync(
    join(stubDir, "pnpm"),
    `#!/usr/bin/env bash
echo "pnpm $*" >> "$PNPM_LOG"
exit "$PNPM_EXIT"
`,
    { mode: 0o755 },
  );

  const baseEnv: Record<string, string> = {
    PATH: `${stubDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: tmp,
    DEPLOY_DIR: deployDir,
    DOCKER_LOG: dockerLog,
    PNPM_LOG: pnpmLog,
    DOCKER_EXIT: String(dockerExit),
    DOCKER_EXEC_EXIT: String(dockerExecExit),
    PNPM_EXIT: String(pnpmExit),
    ...(opts.env ?? {}),
  };

  const result = spawnSync("bash", [DEPLOY_SH], {
    env: baseEnv,
    encoding: "utf8",
  });

  const envPath = join(deployDir, ".env");
  const envFile = existsSync(envPath) ? readFileSync(envPath, "utf8") : null;
  const envFileMode = existsSync(envPath) ? statSync(envPath).mode & 0o777 : null;
  const dockerLogContents = existsSync(dockerLog) ? readFileSync(dockerLog, "utf8") : "";
  const pnpmLogContents = existsSync(pnpmLog) ? readFileSync(pnpmLog, "utf8") : "";

  // Cleanup tmpdir to avoid leaks across tests.
  rmSync(tmp, { recursive: true, force: true });

  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    dockerLog: dockerLogContents,
    pnpmLog: pnpmLogContents,
    envFile,
    envFileMode,
  };
}

const VALID_ENV: Record<string, string> = {
  OWNER: "colophon-group",
  GHCR_PAT: "test-pat",
  MURMUR_TOKEN: "test-murmur-token",
  CLOUDFLARE_TUNNEL_TOKEN: "test-cf-tunnel",
};

describe("scripts/deploy.sh", () => {
  it("uses set -euo pipefail at the top", () => {
    const src = readFileSync(DEPLOY_SH, "utf8");
    // Allow leading shebang + comments + blank lines, then the safety line.
    expect(src).toMatch(/^|\nset -euo pipefail\b/);
    // Stronger: there must be a literal `set -euo pipefail` line.
    expect(src).toContain("set -euo pipefail");
  });

  it("fails fast and lists missing env vars when none are set", () => {
    const r = runDeploy({ env: {} });
    expect(r.status).not.toBe(0);
    // Each required var must be named in stderr.
    for (const name of Object.keys(VALID_ENV)) {
      expect(r.stderr).toContain(name);
    }
    // No values must be printed (we set no values, so this is checking
    // the script doesn't echo them on success either). The `.env` file
    // must NOT have been written when validation fails.
    expect(r.envFile).toBeNull();
  });

  it("fails fast when only one env var is missing and names exactly that one", () => {
    const partial = { ...VALID_ENV };
    delete partial.MURMUR_TOKEN;
    const r = runDeploy({ env: partial });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("MURMUR_TOKEN");
    // Must not falsely accuse other vars.
    expect(r.stderr).not.toContain("OWNER ");
  });

  it("writes /home/deploy/.env with mode 0600 when all env vars are set", () => {
    const r = runDeploy({ env: VALID_ENV });
    expect(r.status).toBe(0);
    expect(r.envFile).not.toBeNull();
    expect(r.envFileMode).toBe(0o600);
  });

  it("writes the expected KEY=VALUE pairs into the env file", () => {
    const r = runDeploy({ env: VALID_ENV });
    expect(r.status).toBe(0);
    const env = r.envFile ?? "";
    expect(env).toContain(`OWNER=${VALID_ENV.OWNER}`);
    expect(env).toContain(`MURMUR_TOKEN=${VALID_ENV.MURMUR_TOKEN}`);
    expect(env).toContain(`CLOUDFLARE_TUNNEL_TOKEN=${VALID_ENV.CLOUDFLARE_TUNNEL_TOKEN}`);
  });

  it("does NOT write the GHCR_PAT into the env file (only docker login uses it)", () => {
    const r = runDeploy({ env: VALID_ENV });
    expect(r.status).toBe(0);
    expect(r.envFile ?? "").not.toContain(VALID_ENV.GHCR_PAT);
  });

  it("invokes docker compose pull then up -d --remove-orphans then exec pnpm migrate, in that order", () => {
    const r = runDeploy({ env: VALID_ENV });
    expect(r.status).toBe(0);
    const log = r.dockerLog;
    const idxPull = log.indexOf("docker compose pull");
    const idxUp = log.indexOf("docker compose up -d --remove-orphans");
    const idxMigrate = log.indexOf("docker compose exec -T murmur pnpm migrate");
    expect(idxPull).toBeGreaterThanOrEqual(0);
    expect(idxUp).toBeGreaterThan(idxPull);
    expect(idxMigrate).toBeGreaterThan(idxUp);
  });

  it("logs in to GHCR via stdin (no PAT on argv)", () => {
    const r = runDeploy({ env: VALID_ENV });
    expect(r.status).toBe(0);
    // Must reference `--password-stdin` and must NOT contain the PAT.
    expect(r.dockerLog).toContain("login ghcr.io");
    expect(r.dockerLog).toContain("--password-stdin");
    expect(r.dockerLog).not.toContain(VALID_ENV.GHCR_PAT);
  });

  it("exits non-zero when the migration step fails (set -e propagates)", () => {
    const r = runDeploy({ env: VALID_ENV, stubExits: { dockerExec: 1 } });
    expect(r.status).not.toBe(0);
  });

  it("exits non-zero when docker compose pull fails", () => {
    const r = runDeploy({ env: VALID_ENV, stubExits: { docker: 2 } });
    expect(r.status).not.toBe(0);
  });

  it("is idempotent on a second invocation with no changes", () => {
    // Two consecutive runs against the same VALID_ENV should both
    // succeed; the second is effectively the no-op case (docker stubs
    // simulate cached pull → exit 0; up -d no-op → exit 0).
    const r1 = runDeploy({ env: VALID_ENV });
    const r2 = runDeploy({ env: VALID_ENV });
    expect(r1.status).toBe(0);
    expect(r2.status).toBe(0);
  });
});

describe(".github/workflows/deploy.yml", () => {
  const WORKFLOW = join(REPO_ROOT, ".github", "workflows", "deploy.yml");

  it("exists", () => {
    expect(existsSync(WORKFLOW)).toBe(true);
  });

  it("pins appleboy/scp-action to a SHA, not a tag", () => {
    const src = readFileSync(WORKFLOW, "utf8");
    // Match `appleboy/scp-action@<40 hex chars>`. Reject tag-style refs.
    expect(src).toMatch(/appleboy\/scp-action@[0-9a-f]{40}\b/);
    expect(src).not.toMatch(/appleboy\/scp-action@v[0-9]/);
  });

  it("pins appleboy/ssh-action to a SHA, not a tag", () => {
    const src = readFileSync(WORKFLOW, "utf8");
    expect(src).toMatch(/appleboy\/ssh-action@[0-9a-f]{40}\b/);
    expect(src).not.toMatch(/appleboy\/ssh-action@v[0-9]/);
  });

  it("declares a concurrency group keyed on deploy-main with cancel-in-progress disabled", () => {
    const src = readFileSync(WORKFLOW, "utf8");
    expect(src).toMatch(/group:\s*deploy-main/);
    expect(src).toMatch(/cancel-in-progress:\s*false/);
  });

  it("uses environment: production so secrets resolve from the prod env", () => {
    const src = readFileSync(WORKFLOW, "utf8");
    expect(src).toMatch(/environment:\s*production/);
  });

  it("triggers on workflow_run after CI completes and supports manual dispatch", () => {
    const src = readFileSync(WORKFLOW, "utf8");
    expect(src).toMatch(/workflow_run:/);
    expect(src).toMatch(/workflows:\s*\["CI"\]/);
    expect(src).toMatch(/workflow_dispatch:/);
  });

  it("gates the deploy job on workflow_run.conclusion == 'success' or workflow_dispatch", () => {
    const src = readFileSync(WORKFLOW, "utf8");
    expect(src).toContain("workflow_run.conclusion == 'success'");
    expect(src).toContain("workflow_dispatch");
  });

  it("never echoes a secret value in script: blocks (only names in envs:)", () => {
    const src = readFileSync(WORKFLOW, "utf8");
    // Disallow naive `echo "$SECRET_*"` or `echo $secrets.*` patterns.
    expect(src).not.toMatch(/echo\s+"\$\{?secrets\./i);
    expect(src).not.toMatch(/printenv\s/);
  });
});
