import { describe, expect, it } from "vitest";

import { newInstanceId, newRunId } from "./ids.js";

describe("newRunId", () => {
  it("returns a string of the form r_<hex>", () => {
    const id = newRunId();
    expect(id).toMatch(/^r_[0-9a-f]{20,}$/);
  });

  it("is distinct across consecutive calls", () => {
    expect(newRunId()).not.toBe(newRunId());
  });
});

describe("newInstanceId", () => {
  it("returns a string of the form i_<hex>", () => {
    const id = newInstanceId();
    expect(id).toMatch(/^i_[0-9a-f]{20,}$/);
  });

  it("is distinct across consecutive calls", () => {
    expect(newInstanceId()).not.toBe(newInstanceId());
  });
});
