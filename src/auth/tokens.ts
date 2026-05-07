/**
 * Token generation, hashing, and inspection utilities for the multi-tenant
 * auth foundation (M1, issue #81).
 *
 * **Format.** A Murmur publisher token is a string of the form:
 *
 *   ```
 *   mp_<scope>_<base64url(32 random bytes)>
 *   ```
 *
 *   - `mp_` — Murmur publisher prefix. Distinguishes from a future `ma_`
 *     (Murmur agent) token kind and from third-party tokens that might be
 *     pasted into the same env var by mistake.
 *   - `<scope>` — `admin`, `runner`, `webhook_signing`, `subcommand_bearer`,
 *     or `bootstrap` (the only token whose scope appears in the wire form;
 *     publisher tokens carry kinds in DB metadata, not in the visible
 *     prefix). `bootstrap` is the deployment-wide token gating
 *     `POST /publishers`.
 *   - `<base64url(32 bytes)>` — 256 bits of CSPRNG entropy. Base64url
 *     (RFC 4648 §5) avoids the URL-unsafe `+ / =` chars.
 *
 * **Storage policy.**
 *   - Incoming-verify tokens (admin / runner / bootstrap) are stored as
 *     SHA-256 hex of the full token bytes. With 256 bits of input entropy
 *     SHA-256 is collision-resistant against any feasible attacker; no
 *     salt is required.
 *   - Outgoing-use secrets (webhook_signing / subcommand_bearer) are
 *     stored plaintext because Murmur needs the cleartext to sign / inject.
 *     They are not hashed; this module's `hashToken` is for verify-side
 *     tokens only.
 *
 * **Why no naked `===` in this module.** `grep-no-naked-eq-in-auth`
 * forbids `===` / `!==` inside `src/auth/`. The hash compare in the
 * middleware uses indexed `WHERE secret_hash = ?` (constant-time at the
 * SQLite layer for fixed-length text). Other comparisons here are
 * length-or-less branches.
 *
 * @see DESIGN.md §3.6 — auth model
 * @see src/auth/middleware.ts — verify-side use
 * @see src/db/schema.md — `publisher_tokens`, `publisher_secrets`
 */

import { createHash, randomBytes } from "node:crypto";

/**
 * Visible scopes that appear in the token's wire form (`mp_<scope>_...`).
 * Distinct from the DB-side `kinds_json` set: a single token row may grant
 * MULTIPLE kinds (e.g. the demo's grandfathered MURMUR_TOKEN grants both
 * `admin` and `runner`), but a freshly-minted token has a single primary
 * scope reflected in its prefix.
 *
 * `bootstrap` lives here because the `POST /publishers` endpoint accepts
 * a token whose wire form is `mp_bootstrap_…` — but bootstrap tokens are
 * NOT stored in `publisher_tokens` (they have no publisher; they're a
 * deployment-wide secret loaded from `MURMUR_BOOTSTRAP_TOKEN`).
 */
export type TokenScope =
  | "admin"
  | "runner"
  | "webhook_signing"
  | "subcommand_bearer"
  | "bootstrap";

/**
 * Number of random bytes in a freshly minted token. 32 bytes = 256 bits
 * of entropy, well above the threshold where SHA-256 collisions become
 * a concern.
 */
export const TOKEN_ENTROPY_BYTES = 32;

/**
 * Length of the visible prefix surfaced in operator UIs ("which token is
 * this?"). 8 chars of base64url ≈ 48 bits — recognisable but not enough
 * to brute-force the rest.
 */
export const TOKEN_PREFIX_CHARS = 8;

/**
 * Result of {@link mintToken}. The plaintext is returned ONCE — the caller
 * (the rotate API or the boot seed) is responsible for handing it to the
 * operator and never logging it.
 */
export interface MintedToken {
  /** Full plaintext token (wire form: `mp_<scope>_<base64url-32>`). */
  readonly plaintext: string;
  /** SHA-256 hex of the plaintext bytes. Stored in `publisher_tokens.secret_hash`. */
  readonly hash: string;
  /** Operator-visible prefix (last {@link TOKEN_PREFIX_CHARS} chars). */
  readonly prefix: string;
}

/**
 * Mint a fresh token with the given visible scope. The plaintext is
 * generated from `crypto.randomBytes` ({@link TOKEN_ENTROPY_BYTES} bytes)
 * and base64url-encoded. The hash is SHA-256 hex.
 *
 * @param scope the visible scope embedded in the wire form. NOT the same
 *   as the DB-side `kinds_json` set (which the caller supplies separately
 *   to `INSERT INTO publisher_tokens`).
 * @returns the {@link MintedToken} triple. Caller MUST discard `plaintext`
 *   immediately after returning it to the operator.
 */
export function mintToken(scope: TokenScope): MintedToken {
  const bytes = randomBytes(TOKEN_ENTROPY_BYTES);
  const random = bytes.toString("base64url");
  const plaintext = `mp_${scope}_${random}`;
  const hash = hashToken(plaintext);
  const prefix = visiblePrefix(plaintext);
  return { plaintext, hash, prefix };
}

/**
 * Compute the SHA-256 hex of the given token's UTF-8 bytes.
 *
 * Used by the auth middleware to look up `publisher_tokens.secret_hash`
 * and by the boot seed to grandfather `MURMUR_TOKEN` (which doesn't
 * follow the `mp_<scope>_…` form but is hashed identically).
 *
 * @param token any non-empty string. Empty inputs throw — the caller is
 *   the auth middleware which short-circuits before invoking this on an
 *   empty candidate, so a thrown error here surfaces a programmer bug.
 * @returns 64-char lowercase hex string.
 * @throws Error if `token` is empty.
 */
export function hashToken(token: string): string {
  if (token.length < 1) {
    throw new Error("hashToken: token must be non-empty");
  }
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Return the operator-visible prefix of a token: the last
 * {@link TOKEN_PREFIX_CHARS} characters. Picking the SUFFIX (not the
 * leading `mp_<scope>_` portion) gives the operator a discriminator
 * even when many tokens share the same scope prefix.
 *
 * The prefix is for display only — auth never compares against it.
 *
 * @param token the full plaintext token.
 * @returns up to {@link TOKEN_PREFIX_CHARS} chars; if the token is
 *   shorter than the cap (degenerate test inputs), returns the whole
 *   token. Empty inputs throw.
 */
export function visiblePrefix(token: string): string {
  if (token.length < 1) {
    throw new Error("visiblePrefix: token must be non-empty");
  }
  if (token.length <= TOKEN_PREFIX_CHARS) {
    return token;
  }
  return token.slice(token.length - TOKEN_PREFIX_CHARS);
}

/**
 * Generate a random opaque row-id for a `publisher_tokens` or
 * `publisher_secrets` row. 12 random bytes hex-encoded — 96 bits is
 * enough for row-id uniqueness; this is NOT a token.
 *
 * @returns 24-char lowercase hex string.
 */
export function newRowId(): string {
  return randomBytes(12).toString("hex");
}
