/**
 * Tests for `src/auth/jwt.ts` — HS256 sign/verify + refresh-token mint.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_JWT_TTL_SECONDS,
  hashRefreshToken,
  mintRefreshToken,
  signJwt,
  verifyJwt,
} from "./jwt.js";

const SECRET = Buffer.from(
  "0".repeat(32) + "f00f" + "1".repeat(28),
  "utf8",
);

const VALID_CLAIMS = {
  sub: "usr_alpha",
  iss: "murmur" as const,
  memberships: [{ publisher_id: "pub_1", role: "admin" as const }],
};

describe("signJwt + verifyJwt — happy path", () => {
  it("round-trips with default TTL", () => {
    const token = signJwt(SECRET, VALID_CLAIMS, { nowSeconds: 1_000_000 });
    const result = verifyJwt(SECRET, token, 1_000_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims.sub).toBe("usr_alpha");
    expect(result.claims.iss).toBe("murmur");
    expect(result.claims.exp).toBe(1_000_000 + DEFAULT_JWT_TTL_SECONDS);
    expect(result.claims.memberships).toEqual([
      { publisher_id: "pub_1", role: "admin" },
    ]);
  });

  it("supports an empty memberships array (no-publisher user)", () => {
    const token = signJwt(
      SECRET,
      { sub: "usr_beta", iss: "murmur", memberships: [] },
      { nowSeconds: 1_000_000 },
    );
    const result = verifyJwt(SECRET, token, 1_000_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims.memberships).toEqual([]);
  });
});

describe("verifyJwt — failure modes", () => {
  it("returns 'malformed' for empty input", () => {
    const r = verifyJwt(SECRET, "", 1_000_000);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("malformed");
  });

  it("returns 'malformed' for non-3-part input", () => {
    const r = verifyJwt(SECRET, "abc.def", 1_000_000);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("malformed");
  });

  it("returns 'alg_not_hs256' for alg=none tokens", () => {
    const header = Buffer.from('{"alg":"none","typ":"JWT"}').toString(
      "base64url",
    );
    const payload = Buffer.from(
      JSON.stringify({
        sub: "x",
        iss: "murmur",
        iat: 0,
        exp: 99999999,
        memberships: [],
      }),
    ).toString("base64url");
    const sig = "AAAA";
    const r = verifyJwt(SECRET, `${header}.${payload}.${sig}`, 1_000_000);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("alg_not_hs256");
  });

  it("returns 'bad_signature' when the signature byte sequence is wrong", () => {
    const token = signJwt(SECRET, VALID_CLAIMS, { nowSeconds: 1_000_000 });
    const tampered = token.slice(0, token.length - 4) + "ZZZZ";
    const r = verifyJwt(SECRET, tampered, 1_000_000);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("bad_signature");
  });

  it("returns 'bad_signature' when verifying with a different secret", () => {
    const token = signJwt(SECRET, VALID_CLAIMS, { nowSeconds: 1_000_000 });
    const wrongSecret = Buffer.from("wrong-secret-32-bytes-padding-ok", "utf8");
    const r = verifyJwt(wrongSecret, token, 1_000_000);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("bad_signature");
  });

  it("returns 'expired' when now > exp", () => {
    const token = signJwt(SECRET, VALID_CLAIMS, {
      nowSeconds: 1_000_000,
      ttlSeconds: 60,
    });
    const r = verifyJwt(SECRET, token, 1_000_000 + 61);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("expired");
  });

  it("returns 'issuer_mismatch' when iss is not 'murmur'", () => {
    const token = signJwt(
      SECRET,
      // Cast through unknown — we deliberately violate the type to
      // simulate a forged JWT with the wrong issuer.
      {
        sub: "x",
        iss: "evil-co" as unknown as "murmur",
        memberships: [],
      },
      { nowSeconds: 1_000_000 },
    );
    const r = verifyJwt(SECRET, token, 1_000_000);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("issuer_mismatch");
  });

  it("returns 'claims_invalid' when memberships entry has unknown role", () => {
    // We need to forge the JWT with a malformed membership. Build by
    // hand using signJwt's machinery.
    const token = signJwt(
      SECRET,
      {
        sub: "x",
        iss: "murmur",
        memberships: [
          // Cast through unknown to violate the type.
          { publisher_id: "pub_1", role: "wizard" as unknown as "admin" },
        ],
      },
      { nowSeconds: 1_000_000 },
    );
    const r = verifyJwt(SECRET, token, 1_000_000);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("claims_invalid");
  });
});

describe("mintRefreshToken + hashRefreshToken", () => {
  it("returns a stable hash across mint/hash calls", () => {
    const minted = mintRefreshToken();
    expect(minted.plaintext.startsWith("mr_")).toBe(true);
    expect(minted.hash.length).toBe(64);
    expect(hashRefreshToken(minted.plaintext)).toBe(minted.hash);
  });

  it("distinct mints produce distinct plaintexts", () => {
    const a = mintRefreshToken();
    const b = mintRefreshToken();
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.hash).not.toBe(b.hash);
  });
});
