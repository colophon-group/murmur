/**
 * Tests for `src/auth/oauth_github.ts` — GitHub access-token verifier.
 */

import { describe, expect, it } from "vitest";

import {
  verifyGitHubAccessToken,
  type GitHubFetch,
} from "./oauth_github.js";

function fetchSeq(...responses: Array<{ url: string; status: number; body: string }>): GitHubFetch {
  let i = 0;
  return async (url) => {
    const r = responses[i];
    i += 1;
    if (!r) throw new Error(`unexpected fetch to ${url}`);
    return { status: r.status, body: r.body };
  };
}

describe("verifyGitHubAccessToken — happy paths", () => {
  it("returns identity from /user with non-null email", async () => {
    const fetch = fetchSeq({
      url: "https://api.github.com/user",
      status: 200,
      body: JSON.stringify({
        id: 4242,
        login: "alice",
        name: "Alice A.",
        email: "alice@example.com",
        avatar_url: "https://avatars/alice.png",
      }),
    });

    const r = await verifyGitHubAccessToken("gho_x", fetch);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.identity).toEqual({
      subject: "4242",
      email: "alice@example.com",
      display_name: "Alice A.",
      avatar_url: "https://avatars/alice.png",
    });
  });

  it("falls back to /user/emails when /user.email is null", async () => {
    const fetch = fetchSeq(
      {
        url: "https://api.github.com/user",
        status: 200,
        body: JSON.stringify({
          id: 1,
          login: "bob",
          name: "Bob",
          email: null,
          avatar_url: "https://x/y",
        }),
      },
      {
        url: "https://api.github.com/user/emails",
        status: 200,
        body: JSON.stringify([
          { email: "spam@example.com", primary: false, verified: true },
          { email: "bob@example.com", primary: true, verified: true },
        ]),
      },
    );

    const r = await verifyGitHubAccessToken("gho_x", fetch);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.identity.email).toBe("bob@example.com");
  });

  it("falls back from name to login as display_name", async () => {
    const fetch = fetchSeq({
      url: "https://api.github.com/user",
      status: 200,
      body: JSON.stringify({
        id: 7,
        login: "carol",
        name: null,
        email: "carol@example.com",
        avatar_url: "https://x/y",
      }),
    });

    const r = await verifyGitHubAccessToken("gho_x", fetch);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.identity.display_name).toBe("carol");
  });

  it("stringifies a numeric id verbatim", async () => {
    const fetch = fetchSeq({
      url: "https://api.github.com/user",
      status: 200,
      body: JSON.stringify({
        id: 99999999999,
        login: "dave",
        email: "dave@example.com",
        avatar_url: "https://x/y",
      }),
    });

    const r = await verifyGitHubAccessToken("gho_x", fetch);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.identity.subject).toBe("99999999999");
  });
});

describe("verifyGitHubAccessToken — failure paths", () => {
  it("rejects empty input as invalid token", async () => {
    const r = await verifyGitHubAccessToken("");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("github_invalid_token");
  });

  it("returns 'github_unreachable' on transport error", async () => {
    const fetch: GitHubFetch = async () => {
      throw new Error("ENOTFOUND");
    };
    const r = await verifyGitHubAccessToken("gho_x", fetch);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("github_unreachable");
  });

  it("returns 'github_invalid_token' on 401", async () => {
    const fetch = fetchSeq({
      url: "https://api.github.com/user",
      status: 401,
      body: '{"message":"Bad credentials"}',
    });
    const r = await verifyGitHubAccessToken("gho_x", fetch);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("github_invalid_token");
  });

  it("returns 'github_unexpected_status' on 500", async () => {
    const fetch = fetchSeq({
      url: "https://api.github.com/user",
      status: 500,
      body: "internal",
    });
    const r = await verifyGitHubAccessToken("gho_x", fetch);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("github_unexpected_status");
  });

  it("returns 'github_response_malformed' on non-object root", async () => {
    const fetch = fetchSeq({
      url: "https://api.github.com/user",
      status: 200,
      body: '"not-an-object"',
    });
    const r = await verifyGitHubAccessToken("gho_x", fetch);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("github_response_malformed");
  });

  it("returns 'github_response_malformed' on missing id", async () => {
    const fetch = fetchSeq({
      url: "https://api.github.com/user",
      status: 200,
      body: JSON.stringify({
        login: "noid",
        email: "noid@example.com",
        avatar_url: "https://x/y",
      }),
    });
    const r = await verifyGitHubAccessToken("gho_x", fetch);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("github_response_malformed");
  });

  it("returns 'github_response_malformed' on missing avatar_url", async () => {
    const fetch = fetchSeq({
      url: "https://api.github.com/user",
      status: 200,
      body: JSON.stringify({ id: 1, login: "x", email: "x@e.com" }),
    });
    const r = await verifyGitHubAccessToken("gho_x", fetch);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("github_response_malformed");
  });

  it("returns 'github_response_malformed' when both name + login are missing", async () => {
    const fetch = fetchSeq({
      url: "https://api.github.com/user",
      status: 200,
      body: JSON.stringify({
        id: 1,
        email: "x@e.com",
        avatar_url: "https://x/y",
      }),
    });
    const r = await verifyGitHubAccessToken("gho_x", fetch);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("github_response_malformed");
  });

  it("returns 'github_email_unavailable' when /user/emails has no primary verified entry", async () => {
    const fetch = fetchSeq(
      {
        url: "https://api.github.com/user",
        status: 200,
        body: JSON.stringify({
          id: 1,
          login: "x",
          email: null,
          avatar_url: "https://x/y",
        }),
      },
      {
        url: "https://api.github.com/user/emails",
        status: 200,
        body: JSON.stringify([
          { email: "x@e.com", primary: false, verified: true },
          { email: "y@e.com", primary: true, verified: false },
        ]),
      },
    );
    const r = await verifyGitHubAccessToken("gho_x", fetch);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("github_email_unavailable");
  });

  it("returns 'github_email_unavailable' when /user/emails returns 404 (token lacks user:email scope)", async () => {
    const fetch = fetchSeq(
      {
        url: "https://api.github.com/user",
        status: 200,
        body: JSON.stringify({
          id: 1,
          login: "x",
          email: null,
          avatar_url: "https://x/y",
        }),
      },
      {
        url: "https://api.github.com/user/emails",
        status: 404,
        body: "{}",
      },
    );
    const r = await verifyGitHubAccessToken("gho_x", fetch);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("github_email_unavailable");
  });

  it("returns 'github_invalid_token' when /user/emails returns 401", async () => {
    const fetch = fetchSeq(
      {
        url: "https://api.github.com/user",
        status: 200,
        body: JSON.stringify({
          id: 1,
          login: "x",
          email: null,
          avatar_url: "https://x/y",
        }),
      },
      {
        url: "https://api.github.com/user/emails",
        status: 401,
        body: "{}",
      },
    );
    const r = await verifyGitHubAccessToken("gho_x", fetch);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("github_invalid_token");
  });

  it("returns 'github_response_malformed' when /user/emails body is not a JSON array", async () => {
    const fetch = fetchSeq(
      {
        url: "https://api.github.com/user",
        status: 200,
        body: JSON.stringify({
          id: 1,
          login: "x",
          email: null,
          avatar_url: "https://x/y",
        }),
      },
      {
        url: "https://api.github.com/user/emails",
        status: 200,
        body: '{"primary":true}',
      },
    );
    const r = await verifyGitHubAccessToken("gho_x", fetch);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("github_response_malformed");
  });
});
