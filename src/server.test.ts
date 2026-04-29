import { describe, expect, it } from "vitest";

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

  it("GET /unknown returns the M0 envelope shape", async () => {
    const app = createServer();

    const response = await app.request("/some/missing/path");
    const body = (await response.json()) as { ok: boolean; errors: unknown };

    expect(response.status).toBe(404);
    expect(body.ok).toBe(false);
    expect(Array.isArray(body.errors)).toBe(true);
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
