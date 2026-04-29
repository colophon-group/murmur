import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { log } from "./logger.js";

describe("log", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("writes a JSON line with level=info to stderr", () => {
    log.info("hello", { a: 1 });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = errorSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.level).toBe("info");
    expect(parsed.msg).toBe("hello");
    expect(parsed.a).toBe(1);
    expect(typeof parsed.time).toBe("string");
  });

  it("writes level=warn for log.warn", () => {
    log.warn("careful");
    const line = errorSpy.mock.calls[0]?.[0] as string;
    expect(JSON.parse(line).level).toBe("warn");
  });

  it("writes level=error for log.error", () => {
    log.error("nope");
    const line = errorSpy.mock.calls[0]?.[0] as string;
    expect(JSON.parse(line).level).toBe("error");
  });

  it("survives non-serializable fields without throwing", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => log.info("circular", { cyclic })).not.toThrow();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
