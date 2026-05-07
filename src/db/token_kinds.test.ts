/**
 * Tests for `src/db/token_kinds.ts` — the `kinds_json` codec.
 */

import { describe, expect, it } from "vitest";

import {
  VALID_KINDS,
  decodeKindsJson,
  encodeKindsJson,
  type TokenKind,
} from "./token_kinds.js";

describe("encodeKindsJson", () => {
  it("encodes a single kind", () => {
    expect(encodeKindsJson(["admin"])).toBe('["admin"]');
  });

  it("normalises to sorted-unique order", () => {
    expect(encodeKindsJson(["runner", "admin"])).toBe('["admin","runner"]');
    expect(encodeKindsJson(["admin", "admin", "runner"])).toBe(
      '["admin","runner"]',
    );
  });

  it("throws on empty input", () => {
    expect(() => encodeKindsJson([])).toThrow(/non-empty/);
  });
});

describe("decodeKindsJson", () => {
  it("round-trips with encodeKindsJson", () => {
    const cases: ReadonlyArray<ReadonlyArray<TokenKind>> = [
      ["admin"],
      ["runner"],
      ["admin", "runner"],
      ["webhook_signing"],
      ["subcommand_bearer"],
      ["admin", "runner", "webhook_signing", "subcommand_bearer"],
    ];
    for (const input of cases) {
      const encoded = encodeKindsJson(input);
      const decoded = decodeKindsJson(encoded);
      expect(decoded).toBeTruthy();
      expect(decoded?.size).toBe(new Set(input).size);
      for (const k of input) {
        expect(decoded?.has(k)).toBe(true);
      }
    }
  });

  it("returns null on parse error", () => {
    expect(decodeKindsJson("not-json")).toBeNull();
    expect(decodeKindsJson("{")).toBeNull();
  });

  it("returns null on non-array root", () => {
    expect(decodeKindsJson('"admin"')).toBeNull();
    expect(decodeKindsJson("123")).toBeNull();
    expect(decodeKindsJson('{"kinds":["admin"]}')).toBeNull();
    expect(decodeKindsJson("null")).toBeNull();
  });

  it("returns null on non-string item", () => {
    expect(decodeKindsJson("[123]")).toBeNull();
    expect(decodeKindsJson('["admin", null]')).toBeNull();
    expect(decodeKindsJson('[true]')).toBeNull();
  });

  it("returns null on unknown kind string", () => {
    expect(decodeKindsJson('["wizard"]')).toBeNull();
    expect(decodeKindsJson('["admin", "skill_registrar"]')).toBeNull();
  });

  it("decodes empty array as empty set", () => {
    const decoded = decodeKindsJson("[]");
    expect(decoded).toBeTruthy();
    expect(decoded?.size).toBe(0);
  });
});

describe("VALID_KINDS", () => {
  it("matches the TokenKind union (size 4 for v1)", () => {
    expect(VALID_KINDS.size).toBe(4);
    expect(VALID_KINDS.has("admin")).toBe(true);
    expect(VALID_KINDS.has("runner")).toBe(true);
    expect(VALID_KINDS.has("webhook_signing")).toBe(true);
    expect(VALID_KINDS.has("subcommand_bearer")).toBe(true);
  });
});
