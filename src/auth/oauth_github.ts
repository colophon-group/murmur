/**
 * GitHub OAuth access-token verifier (M2, issue #82).
 *
 * **Murmur is the verifier, not the OAuth client.** The dashboard
 * (M4) runs the GitHub OAuth code flow and gets back an access_token;
 * Murmur's `POST /auth/exchange` accepts that access_token and verifies
 * it by calling `GET https://api.github.com/user`. If GitHub returns
 * 200 with a user record, the token is valid and we have the user's
 * canonical identity (id + email + name + avatar). If GitHub returns
 * 401, the token is invalid.
 *
 * **No Murmur-side OAuth app required.** The `/user` endpoint accepts
 * any valid user OAuth access_token regardless of which app issued it.
 * Operator setup for the dashboard (M4) needs a registered OAuth app;
 * Murmur's verifier path doesn't.
 *
 * **Why no `===` / `!==` in this module.** Inside `src/auth/`, same
 * `grep-no-naked-eq-in-auth` constraint as the rest of auth. Length-
 * flag tests + `!x` patterns.
 *
 * @see https://docs.github.com/en/rest/users/users#get-the-authenticated-user
 */

import { request as undiciRequest } from "undici";

/** Fixed endpoint Murmur introspects against. */
const GITHUB_USER_ENDPOINT = "https://api.github.com/user";

/** Fixed endpoint for primary email lookup (when /user.email is null). */
const GITHUB_EMAILS_ENDPOINT = "https://api.github.com/user/emails";

/**
 * Identity returned by a successful verify. Maps to a `users` row's
 * post-create or post-update state.
 */
export interface VerifiedGitHubIdentity {
  /** GitHub-stable subject (numeric id, stringified for portability). */
  readonly subject: string;
  /** Primary email — guaranteed non-empty. */
  readonly email: string;
  /** Display name (`name` or fallback to `login`). */
  readonly display_name: string;
  /** Avatar URL (always present on GitHub records). */
  readonly avatar_url: string;
}

/**
 * Reasons a verify can fail.
 */
export type GitHubVerifyFailure =
  | "github_unreachable"
  | "github_invalid_token"
  | "github_unexpected_status"
  | "github_email_unavailable"
  | "github_response_malformed";

/**
 * Verify a GitHub OAuth access_token and return the identity. Never
 * throws — every failure surfaces as a structured `{ ok: false, reason }`.
 *
 * @param accessToken the bearer the user (via the dashboard) presents.
 * @param fetchImpl test seam — production wires undici.
 * @returns the identity on 200, or a typed failure.
 */
export async function verifyGitHubAccessToken(
  accessToken: string,
  fetchImpl: GitHubFetch = defaultGitHubFetch,
): Promise<
  | { ok: true; identity: VerifiedGitHubIdentity }
  | { ok: false; reason: GitHubVerifyFailure }
> {
  if (accessToken.length < 1) {
    return { ok: false, reason: "github_invalid_token" };
  }

  let userRes: GitHubFetchResponse;
  try {
    userRes = await fetchImpl(GITHUB_USER_ENDPOINT, accessToken);
  } catch {
    return { ok: false, reason: "github_unreachable" };
  }
  if (userRes.status > 200) {
    if (userRes.status > 400 && userRes.status < 402) {
      return { ok: false, reason: "github_invalid_token" };
    }
    return { ok: false, reason: "github_unexpected_status" };
  }
  if (userRes.status < 200) {
    return { ok: false, reason: "github_unexpected_status" };
  }

  let userJson: unknown;
  try {
    userJson = JSON.parse(userRes.body);
  } catch {
    return { ok: false, reason: "github_response_malformed" };
  }
  if (typeof userJson !== "object" || userJson === null) {
    return { ok: false, reason: "github_response_malformed" };
  }
  const user = userJson as Record<string, unknown>;
  const id = user["id"];
  const login = user["login"];
  const name = user["name"];
  const email = user["email"];
  const avatar_url = user["avatar_url"];

  // GitHub returns `id` as a number; we stringify for storage as TEXT
  // (the `users.oauth_subject` column).
  let subject: string;
  if (typeof id === "number" && Number.isFinite(id)) {
    subject = String(id);
  } else if (typeof id === "string" && id.length > 0) {
    subject = id;
  } else {
    return { ok: false, reason: "github_response_malformed" };
  }

  if (typeof avatar_url !== "string" || avatar_url.length < 1) {
    return { ok: false, reason: "github_response_malformed" };
  }

  // Display name: prefer `name`, fall back to `login`. Either must
  // be a non-empty string.
  let display_name: string;
  if (typeof name === "string" && name.length > 0) {
    display_name = name;
  } else if (typeof login === "string" && login.length > 0) {
    display_name = login;
  } else {
    return { ok: false, reason: "github_response_malformed" };
  }

  // Email: GitHub's `/user` returns `email: null` for users whose
  // primary email is private. In that case we hit `/user/emails` to
  // find the primary verified address.
  let resolvedEmail: string;
  if (typeof email === "string" && email.length > 0) {
    resolvedEmail = email;
  } else {
    const emails = await fetchPrimaryEmail(accessToken, fetchImpl);
    if (!emails.ok) {
      return { ok: false, reason: emails.reason };
    }
    resolvedEmail = emails.email;
  }

  const identity: VerifiedGitHubIdentity = {
    subject,
    email: resolvedEmail,
    display_name,
    avatar_url,
  };
  return { ok: true, identity };
}

/**
 * Test seam type — minimal HTTP shape this module needs.
 */
export interface GitHubFetchResponse {
  readonly status: number;
  readonly body: string;
}

export type GitHubFetch = (
  url: string,
  bearer: string,
) => Promise<GitHubFetchResponse>;

// --------------------------------------------------------------------------
// Internals
// --------------------------------------------------------------------------

async function fetchPrimaryEmail(
  accessToken: string,
  fetchImpl: GitHubFetch,
): Promise<{ ok: true; email: string } | { ok: false; reason: GitHubVerifyFailure }> {
  let res: GitHubFetchResponse;
  try {
    res = await fetchImpl(GITHUB_EMAILS_ENDPOINT, accessToken);
  } catch {
    return { ok: false, reason: "github_unreachable" };
  }
  if (
    !(res.status < 200) &&
    !(res.status > 200) &&
    !(res.status < 400)
  ) {
    // Status is 200 — fall through to parse.
  } else if (
    !(res.status < 401) &&
    !(res.status > 401)
  ) {
    return { ok: false, reason: "github_invalid_token" };
  } else if (
    !(res.status < 404) &&
    !(res.status > 404)
  ) {
    // 404 happens when the token lacks the `user:email` scope — the
    // dashboard MUST request that scope at OAuth-app config time.
    return { ok: false, reason: "github_email_unavailable" };
  } else {
    return { ok: false, reason: "github_unexpected_status" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    return { ok: false, reason: "github_response_malformed" };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, reason: "github_response_malformed" };
  }

  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const isPrimary = e["primary"];
    const isVerified = e["verified"];
    const addr = e["email"];
    if (
      isPrimary === true &&
      isVerified === true &&
      typeof addr === "string" &&
      addr.length > 0
    ) {
      return { ok: true, email: addr };
    }
  }
  return { ok: false, reason: "github_email_unavailable" };
}

const defaultGitHubFetch: GitHubFetch = async (url, bearer) => {
  const res = await undiciRequest(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${bearer}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "murmur/1.0",
    },
  });
  const chunks: Buffer[] = [];
  for await (const chunk of res.body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return {
    status: res.statusCode,
    body: Buffer.concat(chunks).toString("utf8"),
  };
};
