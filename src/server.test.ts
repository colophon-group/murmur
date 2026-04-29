import { describe, expect, it } from "vitest";

import type { EnvelopeResponse } from "@murmur/contracts-types";

import { createServer } from "./server.js";
import { readPortFromEnv } from "./index.js";

describe("createServer", () => {
  it("GET /health returns 200 with { ok: true }", async () => {
    const app = createServer();

    const response = await app.request("/health");

    expect(response.status).toBe(200);
    const body = (await response.json()) as unknown;
    expect(body).toEqual({ ok: true });
  });

  it("GET /unknown returns 404", async () => {
    const app = createServer();

    const response = await app.request("/unknown");

    expect(response.status).toBe(404);
  });

  it("GET /unknown returns the M0 Err envelope shape exactly", async () => {
    const app = createServer();

    const response = await app.request("/some/missing/path");

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
