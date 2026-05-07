import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import type { EnvelopeResponse } from "@murmur/contracts-types";

import { seedDemoPublisher } from "./db/bootstrap.js";
import { runMigrations } from "./db/migrate.js";
import { createServer } from "./server.js";
import { readMurmurTokenFromEnv, readPortFromEnv } from "./index.js";

const TEST_TOKEN = "test-murmur-token-secret";
const TEST_TOKEN_BUF = Buffer.from(TEST_TOKEN, "utf8");

describe("createServer", () => {
  it("GET /health returns 200 with { ok: true } (no bearer required)", async () => {
    const app = createServer({ token: TEST_TOKEN_BUF });

    const response = await app.request("/health");

    expect(response.status).toBe(200);
    const body = (await response.json()) as unknown;
    expect(body).toEqual({ ok: true });
  });

  it("GET /unknown without a db returns 404 (M1: zoned auth, no wildcard gate)", async () => {
    // M1 (issue #81) auth restructure: with no db, no auth middleware
    // is mounted (publisher API + agent surfaces are db-dependent).
    // Unknown paths fall through to the 404 handler. Pre-M1 the
    // wildcard `app.use('*', bearerAuth(...))` would have 401'd here;
    // that's gone in favour of path-scoped middleware (`/work/*`,
    // `/mcp/*`, `/pipelines*`, `/runs*`, `/publishers/me*`).
    const app = createServer({ token: TEST_TOKEN_BUF });

    const response = await app.request("/unknown");

    expect(response.status).toBe(404);
  });

  it("GET /some/missing/path with the correct bearer returns 404", async () => {
    const app = createServer({ token: TEST_TOKEN_BUF });

    const response = await app.request("/some/missing/path", {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });

    // Type the parsed body as `EnvelopeResponse<unknown>` so that `tsc`
    // validates this assertion against the canonical contract too — if the
    // server's 404 body drifts from the envelope, this file fails to compile.
    const body = (await response.json()) as EnvelopeResponse<unknown>;

    expect(response.status).toBe(404);
    expect(body.ok).toBe(false);

    // Pin the exact wire shape: string-token form, single `"not_found"` entry.
    expect(body).toEqual({
      ok: false,
      errors: ["not_found"],
    });
  });

  it("ignores `?token=...` query strings on a zoned path (bearer is read from Authorization only)", async () => {
    // Pick a path that IS in an auth-gated zone so the auth check
    // actually fires. /pipelines is publisherAuth-zoned when db is
    // supplied. A `?token=…` query param is never consulted by the
    // auth middleware; only the Authorization header is.
    const db = new Database(":memory:");
    runMigrations(db);
    seedDemoPublisher(db, { MURMUR_TOKEN: TEST_TOKEN });
    const app = createServer({ token: TEST_TOKEN_BUF, db });

    const response = await app.request(
      `/pipelines?token=${TEST_TOKEN}`,
      { method: "POST" },
    );

    // No Authorization header → 401 even though the token appears in the URL.
    const body = (await response.json()) as EnvelopeResponse<unknown>;
    expect(response.status).toBe(401);
    expect(body).toEqual({ ok: false, errors: ["unauthorized"] });
    db.close();
  });
});

describe("readPortFromEnv", () => {
  it("returns the integer port when PORT is set", () => {
    expect(readPortFromEnv({ PORT: "8080" } as NodeJS.ProcessEnv)).toBe(8080);
  });

  it("throws when PORT is unset", () => {
    expect(() => readPortFromEnv({} as NodeJS.ProcessEnv)).toThrow(/PORT/);
  });

  it("throws when PORT is empty", () => {
    expect(() => readPortFromEnv({ PORT: "" } as NodeJS.ProcessEnv)).toThrow(
      /PORT/,
    );
  });

  it("throws when PORT is not numeric", () => {
    expect(() =>
      readPortFromEnv({ PORT: "not-a-number" } as NodeJS.ProcessEnv),
    ).toThrow(/PORT/);
  });

  it("throws when PORT is zero or negative", () => {
    expect(() =>
      readPortFromEnv({ PORT: "0" } as NodeJS.ProcessEnv),
    ).toThrow(/PORT/);
    expect(() =>
      readPortFromEnv({ PORT: "-1" } as NodeJS.ProcessEnv),
    ).toThrow(/PORT/);
  });

  it("throws when PORT is above the valid range", () => {
    expect(() =>
      readPortFromEnv({ PORT: "70000" } as NodeJS.ProcessEnv),
    ).toThrow(/PORT/);
  });
});

describe("readMurmurTokenFromEnv", () => {
  it("returns a UTF-8 buffer when MURMUR_TOKEN is set", () => {
    const buf = readMurmurTokenFromEnv({
      MURMUR_TOKEN: TEST_TOKEN,
    } as NodeJS.ProcessEnv);

    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.toString("utf8")).toBe(TEST_TOKEN);
  });

  it("throws when MURMUR_TOKEN is unset", () => {
    expect(() => readMurmurTokenFromEnv({} as NodeJS.ProcessEnv)).toThrow(
      /MURMUR_TOKEN/,
    );
  });

  it("throws when MURMUR_TOKEN is empty", () => {
    expect(() =>
      readMurmurTokenFromEnv({ MURMUR_TOKEN: "" } as NodeJS.ProcessEnv),
    ).toThrow(/MURMUR_TOKEN/);
  });

  it("error message does not include the token value", () => {
    // We pass a non-empty value here only to assert the message doesn't echo
    // it back. Empty/unset cases are covered above.
    let caught: unknown;
    try {
      // Intentionally pass an empty string to trigger the failure path.
      readMurmurTokenFromEnv({ MURMUR_TOKEN: "" } as NodeJS.ProcessEnv);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    // The variable name appears (we want operators to know which var is
    // missing); the value must NOT — empty here is fine, but if a future
    // refactor accidentally interpolates a value, this guard breaks.
    expect(message).toMatch(/MURMUR_TOKEN/);
  });
});
