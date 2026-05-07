/**
 * Tests for `src/auth/tokens.ts` — token mint / hash / prefix helpers
 * (M1, issue #81).
 */

import { describe, expect, it } from "vitest";

import {
  TOKEN_ENTROPY_BYTES,
  TOKEN_PREFIX_CHARS,
  hashToken,
  mintToken,
  newRowId,
  visiblePrefix,
} from "./tokens.js";

describe("mintToken", () => {
  it("returns a wire-form `mp_<scope>_<base64url>` string with 256 bits of entropy", () => {
    const minted = mintToken("admin");
    expect(minted.plaintext.startsWith("mp_admin_")).toBe(true);
    // base64url-encoding of 32 bytes = 43 chars (no `=` padding).
    const random = minted.plaintext.slice("mp_admin_".length);
    expect(random.length).toBeGreaterThanOrEqual(42);
    expect(random.length).toBeLessThanOrEqual(43);
    // base64url charset: A-Za-z0-9_-
    expect(/^[A-Za-z0-9_-]+$/.test(random)).toBe(true);
  });

  it("supports each declared scope (admin, runner, webhook_signing, subcommand_bearer, bootstrap)", () => {
    for (const scope of [
      "admin",
      "runner",
      "webhook_signing",
      "subcommand_bearer",
      "bootstrap",
    ] as const) {
      const minted = mintToken(scope);
      expect(minted.plaintext.startsWith(`mp_${scope}_`)).toBe(true);
    }
  });

  it("hash is SHA-256 hex of the plaintext", () => {
    const minted = mintToken("runner");
    expect(minted.hash.length).toBe(64);
    expect(/^[0-9a-f]{64}$/.test(minted.hash)).toBe(true);
    expect(minted.hash).toBe(hashToken(minted.plaintext));
  });

  it("prefix is the last TOKEN_PREFIX_CHARS chars of the plaintext", () => {
    const minted = mintToken("admin");
    expect(minted.prefix.length).toBe(TOKEN_PREFIX_CHARS);
    expect(minted.plaintext.endsWith(minted.prefix)).toBe(true);
  });

  it("two consecutive mints differ — entropy is fresh per call", () => {
    const a = mintToken("admin");
    const b = mintToken("admin");
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.hash).not.toBe(b.hash);
  });

  it("mints exactly TOKEN_ENTROPY_BYTES bytes of randomness", () => {
    const minted = mintToken("admin");
    const random = minted.plaintext.slice("mp_admin_".length);
    const decoded = Buffer.from(random, "base64url");
    expect(decoded.byteLength).toBe(TOKEN_ENTROPY_BYTES);
  });
});

describe("hashToken", () => {
  it("returns a stable 64-char lowercase hex string for the same input", () => {
    const h1 = hashToken("mp_admin_abcdef");
    const h2 = hashToken("mp_admin_abcdef");
    expect(h1).toBe(h2);
    expect(h1.length).toBe(64);
    expect(/^[0-9a-f]{64}$/.test(h1)).toBe(true);
  });

  it("is sensitive to a single-byte change", () => {
    expect(hashToken("a")).not.toBe(hashToken("b"));
  });

  it("treats UTF-8 bytes deterministically", () => {
    // The whole-string UTF-8 hash should equal the SHA-256 of the
    // identical UTF-8 bytes computed by other means; we don't depend
    // on a magic constant here, just stability across calls and
    // distinctness across inputs.
    const a = hashToken("ä");
    const b = hashToken("ä"); // composed vs decomposed
    // Bytes differ → hashes differ. This test pins the contract that
    // we hash the bytes the caller gave us, not a normalised form.
    expect(a).not.toBe(b);
  });

  it("throws on empty input", () => {
    expect(() => hashToken("")).toThrow(/non-empty/);
  });
});

describe("visiblePrefix", () => {
  it("returns the last TOKEN_PREFIX_CHARS chars when the token is longer", () => {
    const t = "mp_admin_AAAAAAAA"; // 17 chars; suffix = "AAAAAAAA"
    expect(visiblePrefix(t)).toBe("AAAAAAAA");
    expect(visiblePrefix(t).length).toBe(TOKEN_PREFIX_CHARS);
  });

  it("returns the whole token when shorter than the cap", () => {
    const t = "abc";
    expect(visiblePrefix(t)).toBe("abc");
  });

  it("throws on empty input", () => {
    expect(() => visiblePrefix("")).toThrow(/non-empty/);
  });
});

describe("newRowId", () => {
  it("returns 24 lowercase hex chars", () => {
    const id = newRowId();
    expect(id.length).toBe(24);
    expect(/^[0-9a-f]{24}$/.test(id)).toBe(true);
  });

  it("two consecutive calls differ", () => {
    expect(newRowId()).not.toBe(newRowId());
  });
});
