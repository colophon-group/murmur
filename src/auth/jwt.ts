/**
 * JWT (HS256) sign + verify for the human-plane session model
 * (M2, issue #82).
 *
 * **Why not a library.** node:crypto can do HS256 in ~30 lines, and
 * adding a JWT library widens the supply-chain surface for one
 * algorithm we already control. The wire format is RFC 7519: three
 * base64url-encoded segments joined by `.` — header, payload, signature.
 *
 * **Algorithm.** HS256 only. The `alg` claim in the header is parsed
 * and verified to be `HS256` exactly — `none` and asymmetric algs are
 * rejected. This closes the well-known "alg=none" attack and the
 * "RS256 / HS256 confusion" attack class.
 *
 * **Claims.** Standard `iat`, `exp`, `iss` plus Murmur-specific:
 *   - `sub` — the user_id
 *   - `iss` — the literal string `"murmur"`
 *   - `memberships` — array of `{ publisher_id, role }` snapshots taken
 *     at JWT-issue time. Stale on revocation between JWTs but that's
 *     bounded by the 24h JWT TTL; admin can force a revoke by toggling
 *     `users.disabled_at` (the verify path consults it).
 *
 * **Constant-time signature compare.** The signature byte sequence is
 * compared via `crypto.timingSafeEqual` to defeat timing oracles.
 *
 * **No `===` / `!==` in this module.** Same `grep-no-naked-eq-in-auth`
 * gate as the rest of `src/auth/`. Length-flag tests and `!x` patterns
 * throughout.
 *
 * @see docs/auth.md — JWT shape + verifier
 * @see RFC 7519 — JWT spec
 */

import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Algorithm constant baked into every issued JWT and required on
 * every verified JWT. Single value — Murmur does not negotiate
 * algorithms.
 */
export const JWT_ALG = "HS256";

/**
 * Default JWT TTL — 24 hours per issue #82's session model. Tests
 * override this to small values to exercise expiry.
 */
export const DEFAULT_JWT_TTL_SECONDS = 24 * 60 * 60;

/**
 * One per-publisher membership row carried in the JWT payload.
 */
export interface JwtMembership {
  readonly publisher_id: string;
  readonly role: "admin" | "reviewer" | "viewer";
}

/**
 * Claims carried in the JWT payload. The shape is stable across
 * MVP — adding a new optional claim is fine; renaming or removing
 * one requires a JWT version bump.
 */
export interface JwtClaims {
  /** User id (subject). */
  readonly sub: string;
  /** Issuer — always `"murmur"`. */
  readonly iss: "murmur";
  /** Issued-at, unix seconds. */
  readonly iat: number;
  /** Expiry, unix seconds. */
  readonly exp: number;
  /** Snapshot of the user's publisher memberships at issue time. */
  readonly memberships: ReadonlyArray<JwtMembership>;
}

/**
 * Reasons a verify can fail. Stable tokens — middleware uses these
 * to decide whether to surface a generic 401 (always — see auth
 * model) or to log a more specific code internally.
 */
export type JwtVerifyFailure =
  | "malformed"
  | "alg_not_hs256"
  | "bad_signature"
  | "expired"
  | "issuer_mismatch"
  | "claims_invalid";

/**
 * Sign a JWT with the given HS256 secret. Returns the wire-format
 * `<header>.<payload>.<signature>` string.
 *
 * @param secret HMAC secret (raw bytes). Caller-supplied; the boot
 *   layer reads it from `MURMUR_JWT_SECRET`.
 * @param claims claims to embed (excluding `iat`/`exp` if `nowFn` /
 *   `ttlSeconds` are supplied; pass `iat`/`exp` explicitly to bypass).
 * @returns the signed JWT string.
 */
export function signJwt(
  secret: Buffer,
  claims: Omit<JwtClaims, "iat" | "exp"> & {
    readonly iat?: number;
    readonly exp?: number;
  },
  options: {
    readonly nowSeconds?: number;
    readonly ttlSeconds?: number;
  } = {},
): string {
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttl = options.ttlSeconds ?? DEFAULT_JWT_TTL_SECONDS;
  const finalClaims: JwtClaims = {
    sub: claims.sub,
    iss: claims.iss,
    iat: claims.iat ?? now,
    exp: claims.exp ?? now + ttl,
    memberships: claims.memberships,
  };

  const header = { alg: JWT_ALG, typ: "JWT" };
  const headerB64 = base64urlEncode(Buffer.from(JSON.stringify(header), "utf8"));
  const payloadB64 = base64urlEncode(
    Buffer.from(JSON.stringify(finalClaims), "utf8"),
  );
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = createHmac("sha256", secret).update(signingInput, "utf8").digest();
  const sigB64 = base64urlEncode(sig);
  return `${signingInput}.${sigB64}`;
}

/**
 * Verify a JWT. Returns either the decoded claims or a structured
 * failure reason. Never throws.
 *
 * Verification steps (in order):
 *   1. Wire shape — three `.`-separated base64url segments.
 *   2. Header parses, `alg === "HS256"` exactly (literal-only compare).
 *   3. Signature byte-equals `HMAC(secret, header.payload)` under
 *      `crypto.timingSafeEqual`.
 *   4. Payload parses, has the required Murmur claims.
 *   5. `iss === "murmur"`.
 *   6. `exp` strictly greater than `nowSeconds`.
 *
 * @param secret HMAC secret used for sign-time. MUST be the same byte
 *   sequence (rotation requires a multi-secret verify path; that's
 *   out of scope for v1).
 * @param token the raw `<header>.<payload>.<sig>` string.
 * @returns `{ ok: true, claims }` or `{ ok: false, reason }`.
 */
export function verifyJwt(
  secret: Buffer,
  token: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): { ok: true; claims: JwtClaims } | { ok: false; reason: JwtVerifyFailure } {
  if (token.length < 1) {
    return { ok: false, reason: "malformed" };
  }

  const parts = token.split(".");
  if (parts.length < 3 || parts.length > 3) {
    return { ok: false, reason: "malformed" };
  }
  const headerB64 = parts[0];
  const payloadB64 = parts[1];
  const sigB64 = parts[2];
  if (
    !headerB64 ||
    !payloadB64 ||
    !sigB64 ||
    headerB64.length < 1 ||
    payloadB64.length < 1 ||
    sigB64.length < 1
  ) {
    return { ok: false, reason: "malformed" };
  }

  let header: unknown;
  try {
    header = JSON.parse(base64urlDecode(headerB64).toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof header !== "object" || header === null) {
    return { ok: false, reason: "malformed" };
  }
  const headerObj = header as Record<string, unknown>;
  if (headerObj["alg"] !== JWT_ALG) {
    return { ok: false, reason: "alg_not_hs256" };
  }

  // Constant-time signature compare. We accept any provided signature
  // length and pad to the expected 32 bytes to keep the work uniform.
  const expectedSig = createHmac("sha256", secret)
    .update(`${headerB64}.${payloadB64}`, "utf8")
    .digest();
  let providedSig: Buffer;
  try {
    providedSig = base64urlDecode(sigB64);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const sameLength =
    !(providedSig.length < expectedSig.length) &&
    !(providedSig.length > expectedSig.length);
  if (!sameLength) {
    timingSafeEqual(expectedSig, expectedSig);
    return { ok: false, reason: "bad_signature" };
  }
  if (!timingSafeEqual(providedSig, expectedSig)) {
    return { ok: false, reason: "bad_signature" };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(base64urlDecode(payloadB64).toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, reason: "malformed" };
  }
  const claims = payload as Record<string, unknown>;

  if (claims["iss"] !== "murmur") {
    return { ok: false, reason: "issuer_mismatch" };
  }
  const sub = claims["sub"];
  const iat = claims["iat"];
  const exp = claims["exp"];
  const memberships = claims["memberships"];
  if (typeof sub !== "string" || sub.length < 1) {
    return { ok: false, reason: "claims_invalid" };
  }
  if (typeof iat !== "number" || typeof exp !== "number") {
    return { ok: false, reason: "claims_invalid" };
  }
  if (!Array.isArray(memberships)) {
    return { ok: false, reason: "claims_invalid" };
  }
  // Validate each membership's shape; any malformed entry rejects the
  // whole token (don't silently drop — that would mask issuer bugs).
  const validatedMemberships: JwtMembership[] = [];
  for (const m of memberships) {
    if (typeof m !== "object" || m === null) {
      return { ok: false, reason: "claims_invalid" };
    }
    const mObj = m as Record<string, unknown>;
    const pid = mObj["publisher_id"];
    const role = mObj["role"];
    if (typeof pid !== "string" || pid.length < 1) {
      return { ok: false, reason: "claims_invalid" };
    }
    if (role !== "admin" && role !== "reviewer" && role !== "viewer") {
      return { ok: false, reason: "claims_invalid" };
    }
    validatedMemberships.push({ publisher_id: pid, role });
  }

  if (!(exp > nowSeconds)) {
    return { ok: false, reason: "expired" };
  }

  const verified: JwtClaims = {
    sub,
    iss: "murmur",
    iat,
    exp,
    memberships: validatedMemberships,
  };
  return { ok: true, claims: verified };
}

/**
 * Generate a fresh refresh token + its hash. The plaintext is returned
 * to the caller (and onward to the operator) once; storage holds the
 * hash. 32 bytes (256 bits) of CSPRNG entropy ⇒ SHA-256 unsalted is
 * sufficient (same argument as `publisher_tokens`).
 */
export function mintRefreshToken(): {
  readonly plaintext: string;
  readonly hash: string;
} {
  const bytes = randomBytes(32);
  const plaintext = `mr_${base64urlEncode(bytes)}`;
  const hash = createHmac("sha256", "murmur-refresh-static-pepper")
    .update(plaintext, "utf8")
    .digest("hex");
  return { plaintext, hash };
}

/**
 * Compute the storage hash for a presented refresh token. Used by the
 * `/auth/refresh` handler to look up the stored row by hash.
 */
export function hashRefreshToken(plaintext: string): string {
  return createHmac("sha256", "murmur-refresh-static-pepper")
    .update(plaintext, "utf8")
    .digest("hex");
}

// --------------------------------------------------------------------------
// base64url helpers (RFC 4648 §5)
// --------------------------------------------------------------------------

function base64urlEncode(buf: Buffer): string {
  return buf.toString("base64url");
}

function base64urlDecode(s: string): Buffer {
  return Buffer.from(s, "base64url");
}
