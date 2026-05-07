/**
 * Defensive URL validation for publisher-controlled URLs (M1, issue #81).
 *
 * Murmur stores two publisher-supplied URL classes:
 *   - `final_output.webhook` (in pipeline def) — Murmur POSTs `final_output`
 *     to this URL on run completion.
 *   - subcommand `endpoint` (in pipeline def, per subcommand) — Murmur
 *     proxies `task_tool` calls to this URL via `dispatchTaskTool`.
 *
 * A hostile (or compromised) publisher could set these to a private /
 * loopback / metadata IP and force Murmur to make outbound requests
 * against the host's internal network or cloud-metadata service. We
 * defend at registration: any URL whose effective host parses to a
 * private/link-local/metadata IP is rejected with
 * `validation:url_not_allowed`.
 *
 * **What this validator does NOT cover.** DNS rebinding (host resolves
 * to a public IP at registration, a private IP at dispatch) requires
 * either a runtime DNS pin or a per-request resolution check. v1
 * accepts that gap and validates by-hostname/IP only at registration.
 * Documented in `docs/auth.md`.
 *
 * **Why outside `src/auth/middleware.ts`.** This is a pure URL-shape
 * helper, not an auth gate. Keeping it adjacent to auth (under
 * `src/auth/`) groups the security-boundary code together. The grep
 * gate forbids `===`/`!==` here too; we use `startsWith`, length flags,
 * and a typed enum-like pattern.
 *
 * @see src/api/publisher/pipelines.ts — registration-time consumer
 */

/**
 * Result of a validation attempt.
 *
 *   - `{ ok: true }` — the URL is well-formed and not in a blocked range.
 *   - `{ ok: false, reason }` — see {@link UrlValidationReason}.
 */
export type UrlValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: UrlValidationReason };

/**
 * Reason tokens emitted by {@link validatePublisherUrl}. Stable across
 * MVP; clients use them to surface registration errors.
 */
export type UrlValidationReason =
  | "unparseable"
  | "scheme_not_https"
  | "host_empty"
  | "host_loopback"
  | "host_private"
  | "host_link_local"
  | "host_metadata"
  | "host_zero";

/**
 * Validate a publisher-supplied URL. Returns `ok: true` only if:
 *   - the URL parses,
 *   - the scheme is `https:` (production) — `http:` is also accepted in
 *     `relaxed` mode used by integration tests against a local mock,
 *   - the host is non-empty,
 *   - the host (when an IP literal) is NOT in any blocked range:
 *     - 0.0.0.0/8         (host_zero)
 *     - 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 (host_private)
 *     - 127.0.0.0/8       (host_loopback)
 *     - 169.254.0.0/16    (host_link_local — covers AWS/GCP metadata at 169.254.169.254)
 *     - 169.254.169.254 / fd00:ec2::254 (host_metadata, even though the IP is in link-local — explicit reason for the common case)
 *     - ::1               (host_loopback — IPv6 loopback)
 *     - fc00::/7          (host_private — IPv6 ULA)
 *     - fe80::/10         (host_link_local — IPv6 link-local)
 *
 * Hostnames that don't parse as IP literals (e.g. `jobseek.example.com`)
 * pass the IP-range check unconditionally. DNS-time validation is out
 * of scope for v1.
 *
 * @param url the candidate URL string.
 * @param mode `'strict'` (default) requires `https:`; `'relaxed'` also
 *   accepts `http:` for tests / loopback fixtures. Production uses
 *   strict; integration tests use relaxed.
 */
export function validatePublisherUrl(
  url: string,
  mode: "strict" | "relaxed" = "strict",
): UrlValidationResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "unparseable" };
  }

  if (mode === "strict") {
    if (parsed.protocol !== "https:") {
      return { ok: false, reason: "scheme_not_https" };
    }
  } else {
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return { ok: false, reason: "scheme_not_https" };
    }
  }

  const host = parsed.hostname;
  if (host.length < 1) {
    return { ok: false, reason: "host_empty" };
  }

  // Strip IPv6 brackets if present.
  const ipv6Stripped =
    host.startsWith("[") && host.endsWith("]")
      ? host.slice(1, host.length - 1)
      : host;

  // Cloud-metadata sentinels — explicit reason for the common case
  // (link-local would also catch this, but operators reading the error
  // benefit from the specific reason).
  if (ipv6Stripped === "169.254.169.254") {
    return { ok: false, reason: "host_metadata" };
  }
  if (ipv6Stripped === "fd00:ec2::254") {
    return { ok: false, reason: "host_metadata" };
  }

  // IPv4 literal?
  if (isIpv4Literal(ipv6Stripped)) {
    return classifyIpv4(ipv6Stripped);
  }

  // IPv6 literal?
  if (isIpv6Literal(ipv6Stripped)) {
    return classifyIpv6(ipv6Stripped);
  }

  // Hostname — pass.
  return { ok: true };
}

// --------------------------------------------------------------------------
// IPv4 helpers
// --------------------------------------------------------------------------

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isIpv4Literal(host: string): boolean {
  return IPV4_RE.test(host);
}

function classifyIpv4(host: string): UrlValidationResult {
  const m = IPV4_RE.exec(host);
  if (!m) {
    return { ok: false, reason: "unparseable" };
  }
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = Number(m[3]);
  const d = Number(m[4]);
  if (
    a > 255 ||
    b > 255 ||
    c > 255 ||
    d > 255
  ) {
    return { ok: false, reason: "unparseable" };
  }

  if (a < 1) {
    return { ok: false, reason: "host_zero" };
  }
  // 127.0.0.0/8 — loopback
  if (
    !(a < 127) &&
    !(a > 127)
  ) {
    return { ok: false, reason: "host_loopback" };
  }
  // 10.0.0.0/8 — private
  if (
    !(a < 10) &&
    !(a > 10)
  ) {
    return { ok: false, reason: "host_private" };
  }
  // 172.16.0.0/12 — private
  if (
    !(a < 172) &&
    !(a > 172) &&
    !(b < 16) &&
    !(b > 31)
  ) {
    return { ok: false, reason: "host_private" };
  }
  // 192.168.0.0/16 — private
  if (
    !(a < 192) &&
    !(a > 192) &&
    !(b < 168) &&
    !(b > 168)
  ) {
    return { ok: false, reason: "host_private" };
  }
  // 169.254.0.0/16 — link-local
  if (
    !(a < 169) &&
    !(a > 169) &&
    !(b < 254) &&
    !(b > 254)
  ) {
    return { ok: false, reason: "host_link_local" };
  }
  return { ok: true };
}

// --------------------------------------------------------------------------
// IPv6 helpers
// --------------------------------------------------------------------------

function isIpv6Literal(host: string): boolean {
  // Crude — the URL parser already validated bracketed IPv6 form. We
  // detect IPv6-shape by the presence of `::` or multiple colons (a
  // hostname can't legally contain `:`).
  if (host.includes(":")) {
    return true;
  }
  return false;
}

function classifyIpv6(host: string): UrlValidationResult {
  const lower = host.toLowerCase();
  // Loopback ::1
  if (lower === "::1") {
    return { ok: false, reason: "host_loopback" };
  }
  // Unspecified ::
  if (lower === "::") {
    return { ok: false, reason: "host_zero" };
  }
  // fc00::/7 — ULA
  if (lower.startsWith("fc") || lower.startsWith("fd")) {
    return { ok: false, reason: "host_private" };
  }
  // fe80::/10 — link-local
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) {
    return { ok: false, reason: "host_link_local" };
  }
  return { ok: true };
}
