/**
 * Mock-jobseek HTTP server — a stand-in publisher used by the
 * integration tests. Listens on `127.0.0.1:0` (kernel-assigned port)
 * and records every incoming request's method, URL, raw headers, and
 * body to an in-memory log so the tests can assert wire-level details.
 *
 * The server exposes the seven `task_tool`-proxied routes plus the
 * `/api/murmur/accept` webhook receiver. Each route returns a stub
 * envelope `{ ok: true, data: ... }` shaped roughly like what the real
 * jobseek's J5 surface returns. The exact body shape is not
 * load-bearing for the integration test (the test asserts the *flow*,
 * not the publisher's internal logic) but keeping it close to reality
 * makes the failure mode easy to read.
 *
 * Key observations the test relies on:
 *
 *   - **`req.rawHeaders`**: Node's `req.headers` lower-cases names by
 *     default, so a header asserted as `X-Murmur-Subcommand` would pass
 *     even if the client emitted `x-murmur-subcommand`. The raw form
 *     preserves casing as it appeared on the wire. The mock records
 *     the array verbatim (same `[name, value, name, value, ...]` shape)
 *     and the test scans it for the M0-constant strings.
 *
 *   - **Webhook idempotency**: the `/api/murmur/accept` handler tracks
 *     applied `Idempotency-Key` values in an in-memory `Set`. The
 *     "apply side-effect" is incrementing a counter; on a duplicate
 *     key the counter does NOT increment. Both cases still 200 — the
 *     publisher is idempotent on the writer side, not the receiver
 *     side, exactly as DESIGN.md §3.6 specifies.
 *
 *   - **Bearer captured but not validated**: the mock does not enforce
 *     the bearer; it only records what arrived. The tests assert on
 *     the captured value. This keeps the test focused on the cross-repo
 *     contract Murmur emits, not on the publisher's auth policy (which
 *     is jobseek-side and out of scope here).
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Minimal record of one HTTP request the mock observed. `rawHeaders`
 * is the verbatim array from `req.rawHeaders`: an even-length array of
 * `[name, value, name, value, ...]` with case preserved.
 */
export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly rawHeaders: ReadonlyArray<string>;
  readonly body: string;
}

/**
 * Public surface of the running mock. `origin` is the `http://127.0.0.1:<port>`
 * URL the test should use as `apiBase` when building pipeline defs.
 *
 * `acceptApplyCount` is the number of distinct `Idempotency-Key`s the
 * webhook handler has "applied" — the load-bearing assertion for the
 * idempotency replay test.
 */
export interface MockJobseek {
  readonly origin: string;
  readonly received: ReadonlyArray<RecordedRequest>;
  readonly acceptApplyCount: () => number;
  readonly seenIdempotencyKeys: () => ReadonlyArray<string>;
  readonly close: () => Promise<void>;
}

/**
 * Stub envelope returned by every non-accept route. Shape matches
 * Murmur's M0 envelope on the response side too — the dispatcher
 * surfaces this verbatim under `data` of the `task_tool` response.
 */
function defaultStubBody(path: string): unknown {
  // Branch on path so every route's stub looks superficially route-shaped
  // (e.g., a probe returns a candidate list; a select returns an ack).
  if (path.endsWith("/probes/monitor") || path.endsWith("/probes/scraper")) {
    return {
      ok: true,
      data: {
        candidates: [
          { type: "rss", confidence: 0.9 },
          { type: "html", confidence: 0.6 },
        ],
      },
    };
  }
  if (path.endsWith("/run/monitor") || path.endsWith("/run/scraper")) {
    return {
      ok: true,
      data: { count: 12, samples: ["job-1", "job-2"] },
    };
  }
  if (path.endsWith("/select/monitor") || path.endsWith("/select/scraper")) {
    return { ok: true, data: { stored_as: "cfg-1" } };
  }
  if (path.endsWith("/feedback")) {
    return { ok: true, data: { recorded: true } };
  }
  if (path.endsWith("/companies/verify")) {
    return {
      ok: true,
      data: { exists: true, careers_page: "https://example.com/careers" },
    };
  }
  // Catch-all: still M0-shaped.
  return { ok: true, data: {} };
}

/**
 * Start a mock-jobseek HTTP server. The returned promise resolves once
 * the kernel has assigned a port and the server is `listen`ing.
 *
 * The server is deliberately stateful: every request appends a new
 * {@link RecordedRequest} to the internal log. Tests assert on the log
 * after the scripted agent finishes its loop.
 */
export async function startMockJobseek(): Promise<MockJobseek> {
  const received: RecordedRequest[] = [];
  const appliedKeys: Set<string> = new Set();

  const server: Server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => {
      // Capture verbatim — DO NOT downcase headers here; the whole
      // point of the integration test is to assert the wire-cased
      // strings the client emitted.
      received.push({
        method: req.method ?? "",
        url: req.url ?? "",
        rawHeaders: [...req.rawHeaders],
        body,
      });

      const url = req.url ?? "";

      // Webhook accept: dedupe by Idempotency-Key (case-insensitive
      // header lookup against the LOWERCASED `req.headers` — this is
      // explicitly the "apply side" of the idempotency contract; the
      // assertion of the *casing* on the wire is done elsewhere
      // against `rawHeaders`).
      if (url === "/api/murmur/accept") {
        const idemKey = req.headers["idempotency-key"];
        if (typeof idemKey === "string") {
          appliedKeys.add(idemKey);
        }
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // Default: stub envelope.
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(defaultStubBody(url)));
    });
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      resolve();
    }),
  );

  const addr = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${addr.port}`;

  return {
    origin,
    received,
    acceptApplyCount: () => appliedKeys.size,
    seenIdempotencyKeys: () => Array.from(appliedKeys),
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Force-close any kept-alive sockets so the test process can
        // exit promptly; the dispatcher's undici `Pool` keeps connections
        // alive between calls.
        server.closeAllConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/**
 * Helper: extract the value of a header from a raw-headers array,
 * preserving the case of the matched name. Returns null if no entry
 * matches `name` case-insensitively.
 *
 * The integration test uses this twice — once to assert the matched
 * name's casing equals the M0 constant, and once to read the value.
 */
export function findRawHeader(
  rawHeaders: ReadonlyArray<string>,
  name: string,
): { readonly nameOnWire: string; readonly value: string } | null {
  const lower = name.toLowerCase();
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const k = rawHeaders[i];
    const v = rawHeaders[i + 1];
    if (k === undefined || v === undefined) continue;
    if (k.toLowerCase() === lower) {
      return { nameOnWire: k, value: v };
    }
  }
  return null;
}
