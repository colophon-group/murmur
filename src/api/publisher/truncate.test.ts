import { describe, expect, it } from "vitest";

import {
  AGENT_ACTION_PAYLOAD_CAP_BYTES,
  TRUNCATION_MARKER,
  truncatePayload,
} from "./truncate.js";

describe("truncatePayload", () => {
  it("returns null and truncated=false for null input", () => {
    expect(truncatePayload(null, AGENT_ACTION_PAYLOAD_CAP_BYTES)).toEqual({
      text: null,
      truncated: false,
    });
  });

  it("passes short strings through unchanged", () => {
    const short = "hello";
    expect(truncatePayload(short, AGENT_ACTION_PAYLOAD_CAP_BYTES)).toEqual({
      text: short,
      truncated: false,
    });
  });

  it("clips long strings and appends the marker", () => {
    const big = "a".repeat(AGENT_ACTION_PAYLOAD_CAP_BYTES + 100);
    const result = truncatePayload(big, AGENT_ACTION_PAYLOAD_CAP_BYTES);
    expect(result.truncated).toBe(true);
    expect(result.text).not.toBeNull();
    expect(result.text?.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it("never splits a multi-byte UTF-8 sequence", () => {
    // 4-byte emoji repeated. The cap may fall mid-sequence; the helper
    // must back off to a code-point boundary.
    const emoji = "\u{1F600}"; // 4 bytes in UTF-8
    const big = emoji.repeat(500); // ~2000 bytes
    const result = truncatePayload(big, 1024);
    expect(result.truncated).toBe(true);
    // Decoding the result must succeed (no broken code units).
    expect(() => Buffer.from(result.text ?? "", "utf8").toString("utf8"))
      .not.toThrow();
  });

  it("at exactly capBytes is not truncated", () => {
    const exact = "x".repeat(AGENT_ACTION_PAYLOAD_CAP_BYTES);
    expect(truncatePayload(exact, AGENT_ACTION_PAYLOAD_CAP_BYTES)).toEqual({
      text: exact,
      truncated: false,
    });
  });
});
