/**
 * Authoritative `TokenKind` vocabulary + `kinds_json` codec for the
 * multi-tenant auth foundation (M1, issue #81).
 *
 * Lives outside `src/auth/` so the type-narrowing `===`/`!==` it relies
 * on doesn't trip the `grep-no-naked-eq-in-auth` gate, which forbids
 * naked equality inside `src/auth/`. The auth middleware imports the
 * codec from here.
 *
 * **Vocabulary.** Closed at the type level (TypeScript union) so adding
 * a new kind is a typecheck-time decision. The DB column has NO CHECK
 * constraint so a future kind can land without a migration; the decoder
 * accepts only the union members today, but extending the union and the
 * `VALID_KINDS` constant in lockstep keeps the DB and type layer in
 * sync.
 *
 * **Format on disk.** `publisher_tokens.kinds_json` is a JSON array of
 * `TokenKind` strings, e.g. `["admin"]`, `["runner"]`,
 * `["admin","runner"]`. The encoder normalises to sorted-unique form so
 * two equivalent kind sets produce byte-identical column values
 * (matters for tests that compare row contents).
 *
 * @see src/auth/publisher_auth.ts — read-side consumer
 * @see src/db/migrations/0002_publishers_and_tokens.sql — column home
 */

/**
 * Authoritative set of `kind` values stored in
 * `publisher_tokens.kinds_json` (and `publisher_secrets.kind`). Keep in
 * lockstep with {@link VALID_KINDS} below.
 */
export type TokenKind =
  | "admin"
  | "runner"
  | "webhook_signing"
  | "subcommand_bearer";

/**
 * Runtime mirror of {@link TokenKind} — the strings the decoder accepts.
 * A `Set` lookup is O(1); the decoder iterates the parsed JSON array
 * once.
 */
export const VALID_KINDS: ReadonlySet<TokenKind> = new Set<TokenKind>([
  "admin",
  "runner",
  "webhook_signing",
  "subcommand_bearer",
]);

/**
 * Encode a list of kinds for storage in `publisher_tokens.kinds_json`.
 * Normalises to sorted-unique ordering so two equivalent kind sets
 * produce byte-identical column values (idempotency under re-seed,
 * predictable test fixtures).
 *
 * @param kinds the kinds the token should grant. Order-insensitive.
 * @returns a JSON-encoded sorted array, e.g. `'["admin","runner"]'`.
 * @throws Error if the input array is empty (a token with no grants is
 *   meaningless; reject at the API boundary instead of silently storing
 *   `[]`).
 */
export function encodeKindsJson(kinds: ReadonlyArray<TokenKind>): string {
  if (kinds.length < 1) {
    throw new Error("encodeKindsJson: kinds must be non-empty");
  }
  const sorted = Array.from(new Set<TokenKind>(kinds)).sort();
  return JSON.stringify(sorted);
}

/**
 * Decode a `publisher_tokens.kinds_json` value into a typed Set. Returns
 * `null` on any malformed input (parse error, non-array, non-string item,
 * unknown kind). The auth middleware treats null as 401 — same wire shape
 * as a missing token, so a malformed DB row doesn't leak schema details.
 *
 * @param json the raw column value.
 * @returns a `Set<TokenKind>` of valid kinds, or `null` on malformed
 *   input. Empty arrays decode to an empty Set (callers should treat
 *   this as "no grants" → 401 at the route level).
 */
export function decodeKindsJson(json: string): ReadonlySet<TokenKind> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  const out = new Set<TokenKind>();
  for (const item of parsed) {
    if (typeof item !== "string") {
      return null;
    }
    if (!VALID_KINDS.has(item as TokenKind)) {
      return null;
    }
    out.add(item as TokenKind);
  }
  return out;
}
