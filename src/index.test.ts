import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { readMurmurTokenFromEnv } from "./index.js";

/**
 * Path to `src/index.ts`, computed relative to this test file. Used by the
 * fail-fast spawn test to invoke the boot module in a child process.
 */
const INDEX_PATH = fileURLToPath(new URL("./index.ts", import.meta.url));

interface SpawnResult {
  readonly code: number | null;
  readonly stderr: string;
}

/**
 * Spawn `node --import tsx <indexPath>` with a curated env and collect the
 * exit code + stderr. Returns once the process exits.
 */
async function runIndex(env: NodeJS.ProcessEnv): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    // Match the script invocation used by `pnpm start` (see package.json).
    const child = spawn(
      process.execPath,
      ["--import", "tsx", INDEX_PATH],
      {
        env,
        stdio: ["ignore", "ignore", "pipe"],
      },
    );

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolve({ code, stderr });
    });

    // Hard kill after 5s to keep the test bounded; the boot path under test
    // exits in <100ms, so reaching the timeout is itself a failure.
    const killTimer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 5000);
    child.on("exit", () => clearTimeout(killTimer));
  });
}

describe("readMurmurTokenFromEnv", () => {
  it("returns the token bytes when MURMUR_TOKEN is set", () => {
    const buf = readMurmurTokenFromEnv({
      MURMUR_TOKEN: "abc123",
    } as NodeJS.ProcessEnv);
    expect(buf.toString("utf8")).toBe("abc123");
  });

  it("throws referencing MURMUR_TOKEN when unset", () => {
    expect(() => readMurmurTokenFromEnv({} as NodeJS.ProcessEnv)).toThrow(
      /MURMUR_TOKEN/,
    );
  });

  it("throws referencing MURMUR_TOKEN when empty", () => {
    expect(() =>
      readMurmurTokenFromEnv({ MURMUR_TOKEN: "" } as NodeJS.ProcessEnv),
    ).toThrow(/MURMUR_TOKEN/);
  });
});

describe("boot fail-fast (MURMUR_TOKEN unset)", () => {
  it("exits non-zero when MURMUR_TOKEN is unset at boot", async () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: "0", // bind to ephemeral if we ever got past token check (we don't)
    };
    delete env.MURMUR_TOKEN;

    const { code, stderr } = await runIndex(env);

    expect(code).not.toBe(0);
    expect(code).not.toBeNull();
    // The boot path logs a structured error mentioning the var name so
    // operators can diagnose without the token value leaking.
    expect(stderr).toMatch(/MURMUR_TOKEN/);
  }, 10_000);

  it("exits non-zero when MURMUR_TOKEN is empty at boot", async () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MURMUR_TOKEN: "",
      PORT: "0",
    };

    const { code, stderr } = await runIndex(env);

    expect(code).not.toBe(0);
    expect(code).not.toBeNull();
    expect(stderr).toMatch(/MURMUR_TOKEN/);
  }, 10_000);
});
