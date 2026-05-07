/**
 * Tests for `src/auth/bootstrap_auth.ts` — POST /publishers gate +
 * `MURMUR_BOOTSTRAP_TOKEN` env reader.
 */

import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import {
  bootstrapAuth,
  readBootstrapTokenFromEnv,
} from "./bootstrap_auth.js";

const TOKEN = "test-bootstrap-token-32bytes!";
const TOKEN_BUF = Buffer.from(TOKEN, "utf8");

function buildApp(): Hono {
  const app = new Hono();
  app.use("*", bootstrapAuth(TOKEN_BUF));
  app.post("/probe", (c) => c.json({ ok: true }));
  return app;
}

describe("bootstrapAuth", () => {
  it("admits a request with the correct bearer", async () => {
    const r = await buildApp().request("/probe", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(r.status).toBe(200);
  });

  it("rejects without an Authorization header", async () => {
    const r = await buildApp().request("/probe", { method: "POST" });
    expect(r.status).toBe(401);
  });

  it("rejects an Authorization without the Bearer prefix", async () => {
    const r = await buildApp().request("/probe", {
      method: "POST",
      headers: { Authorization: "Token xyz" },
    });
    expect(r.status).toBe(401);
  });

  it("rejects an empty bearer (literal 'Bearer ')", async () => {
    const r = await buildApp().request("/probe", {
      method: "POST",
      headers: { Authorization: "Bearer " },
    });
    expect(r.status).toBe(401);
  });

  it("rejects a bearer of the wrong length", async () => {
    const r = await buildApp().request("/probe", {
      method: "POST",
      headers: { Authorization: "Bearer short" },
    });
    expect(r.status).toBe(401);
  });

  it("rejects a same-length but different bearer", async () => {
    const wrong = "X".repeat(TOKEN.length);
    const r = await buildApp().request("/probe", {
      method: "POST",
      headers: { Authorization: `Bearer ${wrong}` },
    });
    expect(r.status).toBe(401);
  });
});

describe("readBootstrapTokenFromEnv", () => {
  it("returns a Buffer when MURMUR_BOOTSTRAP_TOKEN is set", () => {
    const buf = readBootstrapTokenFromEnv({
      MURMUR_BOOTSTRAP_TOKEN: "value",
    });
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf?.toString("utf8")).toBe("value");
  });

  it("returns undefined when the var is unset", () => {
    expect(readBootstrapTokenFromEnv({})).toBeUndefined();
  });

  it("returns undefined when the var is empty string", () => {
    expect(
      readBootstrapTokenFromEnv({ MURMUR_BOOTSTRAP_TOKEN: "" }),
    ).toBeUndefined();
  });
});
