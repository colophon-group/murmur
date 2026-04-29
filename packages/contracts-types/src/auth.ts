/**
 * `MURMUR_TOKEN` — single shared bearer used by both directions:
 *
 *   - Agents/publishers → Murmur:  `Authorization: Bearer <MURMUR_TOKEN>`
 *   - Murmur → publisher webhook:  `Authorization: Bearer <MURMUR_TOKEN>`
 *   - Murmur → publisher subcommand endpoints: `Authorization: Bearer <MURMUR_TOKEN>`
 *
 * @see docs/contracts.md §2 — MURMUR_TOKEN format and lifetime
 */

/**
 * Format on the wire: opaque ASCII string, treated as a single secret
 * value. Length ≥ 32, characters from URL-safe base64 alphabet
 * (`A-Z a-z 0-9 - _`). Issuers SHOULD generate via
 * `crypto.randomBytes(32).toString("base64url")` or equivalent.
 *
 * Lifetime: rotated per deployment. No expiry encoded in the token; the
 * server holds the current valid value in env (`MURMUR_TOKEN`). Multiple
 * tokens not supported in MVP.
 */
export interface MurmurTokenSpec {
  /** Minimum length, in characters. */
  readonly minLength: 32;

  /** Allowed characters (regex source, not anchored). */
  readonly charClass: "[A-Za-z0-9_-]";

  /** Token comparison MUST be timing-safe (e.g., `crypto.timingSafeEqual`). */
  readonly comparison: "timing-safe";

  /** Rotation cadence: per deployment. No automatic rotation. */
  readonly rotation: "per-deployment";
}

/**
 * Reference spec value for tests and validators.
 */
export const MURMUR_TOKEN_SPEC: MurmurTokenSpec = {
  minLength: 32,
  charClass: "[A-Za-z0-9_-]",
  comparison: "timing-safe",
  rotation: "per-deployment",
};

/**
 * Bearer scheme prefix, including the trailing space.
 */
export const BEARER_PREFIX = "Bearer ";
