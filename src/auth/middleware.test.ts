import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { EnvelopeResponse } from "@murmur/contracts-types";

import { UNAUTHORIZED_BODY, bearerAuth } from "./middleware.js";

const TOKEN = "demo-secret-token-1234";
const TOKEN_BUF = Buffer.from(TOKEN, "utf8");

/**
 * Helper: build a tiny Hono app that mounts the auth middleware and
 * exposes both `/health` (bypassed) and `/protected` (gated).
 */
function makeApp(): Hono {
  const app = new Hono();
  app.use("*", bearerAuth(TOKEN_BUF));
  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/protected", (c) => c.json({ ok: true, data: "secret" }));
  return app;
}

describe("bearerAuth middleware", () => {
  it("missing Authorization header returns 401 with the canonical envelope", async () => {
    const app = makeApp();

    const response = await app.request("/protected");

    expect(response.status).toBe(401);
    const body = (await response.json()) as EnvelopeResponse<unknown>;
    expect(body).toEqual({ ok: false, errors: ["unauthorized"] });
  });

  it("wrong scheme (Basic) returns 401", async () => {
    const app = makeApp();
    const basicCreds = Buffer.from(`user:${TOKEN}`, "utf8").toString("base64");

    const response = await app.request("/protected", {
      headers: { Authorization: `Basic ${basicCreds}` },
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as EnvelopeResponse<unknown>;
    expect(body).toEqual({ ok: false, errors: ["unauthorized"] });
  });

  it("wrong token (right scheme, bad value) returns 401", async () => {
    const app = makeApp();

    const response = await app.request("/protected", {
      headers: { Authorization: `Bearer not-the-real-token` },
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as EnvelopeResponse<unknown>;
    expect(body).toEqual({ ok: false, errors: ["unauthorized"] });
  });

  it("wrong token at the EXACT env-token length returns 401", async () => {
    // Exercise the constant-time-compare branch (not the length-mismatch
    // branch). The candidate is the same byte-length as TOKEN but differs
    // at every position.
    const app = makeApp();
    const sameLengthDifferent = "X".repeat(TOKEN.length);
    expect(sameLengthDifferent.length).toBe(TOKEN.length); // sanity

    const response = await app.request("/protected", {
      headers: { Authorization: `Bearer ${sameLengthDifferent}` },
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as EnvelopeResponse<unknown>;
    expect(body).toEqual({ ok: false, errors: ["unauthorized"] });
  });

  it("correct token runs the protected handler", async () => {
    const app = makeApp();

    const response = await app.request("/protected", {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as EnvelopeResponse<{
      readonly data?: string;
    }>;
    expect(body).toEqual({ ok: true, data: "secret" });
  });

  it("/health bypasses auth (no bearer header)", async () => {
    const app = makeApp();

    const response = await app.request("/health");

    expect(response.status).toBe(200);
    const body = (await response.json()) as EnvelopeResponse<unknown>;
    expect(body).toEqual({ ok: true });
  });

  it("token of different length than env-token returns 401 (constant-time-safe)", async () => {
    const app = makeApp();

    // Length-mismatched token — exercises the dummy-buffer fallback path
    // inside the middleware. Must still 401 cleanly.
    const response = await app.request("/protected", {
      headers: { Authorization: `Bearer short` },
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as EnvelopeResponse<unknown>;
    expect(body).toEqual({ ok: false, errors: ["unauthorized"] });
  });

  it("malformed scheme casing (lowercase 'bearer') returns 401", async () => {
    // We require exact `Bearer ` prefix per the contract docstring; a
    // lowercase scheme is not accepted. (The Authorization header name
    // itself is case-insensitive on the wire — Hono normalizes that for us.)
    const app = makeApp();

    const response = await app.request("/protected", {
      headers: { Authorization: `bearer ${TOKEN}` },
    });

    expect(response.status).toBe(401);
  });

  it("empty bearer token (Bearer with no value) returns 401", async () => {
    const app = makeApp();

    const response = await app.request("/protected", {
      headers: { Authorization: "Bearer " },
    });

    expect(response.status).toBe(401);
  });

  it("Authorization with only 'Bearer' (no space) returns 401", async () => {
    const app = makeApp();

    const response = await app.request("/protected", {
      headers: { Authorization: "Bearer" },
    });

    expect(response.status).toBe(401);
  });

  it("query-string `?token=` is ignored (bearer must come from Authorization header)", async () => {
    const app = makeApp();

    const response = await app.request(`/protected?token=${TOKEN}`);

    expect(response.status).toBe(401);
  });

  it("UNAUTHORIZED_BODY is the canonical envelope shape", () => {
    expect(UNAUTHORIZED_BODY).toEqual({
      ok: false,
      errors: ["unauthorized"],
    });
  });
});
