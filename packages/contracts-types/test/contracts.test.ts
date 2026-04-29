import { describe, expect, expectTypeOf, it } from "vitest";
import {
  AUTHORIZATION,
  BEARER_PREFIX,
  type EnvelopeResponse,
  type Err,
  IDEMPOTENCY_KEY,
  isErr,
  isOk,
  MURMUR_TOKEN_SPEC,
  MurmurHeaders,
  type Ok,
  type ValidationError,
  WEBHOOK_DEDUPE_WINDOW_MS,
  WEBHOOK_RETRY_COUNT,
  WEBHOOK_RETRY_DELAY_MS,
  X_MURMUR_CLAIM_TOKEN,
  X_MURMUR_SUBCOMMAND,
} from "../src/index.js";

describe("§3 — header casing is locked", () => {
  it("Authorization", () => {
    expect(AUTHORIZATION).toBe("Authorization");
    expect(MurmurHeaders.AUTHORIZATION).toBe("Authorization");
  });

  it("X-Murmur-Subcommand", () => {
    expect(X_MURMUR_SUBCOMMAND).toBe("X-Murmur-Subcommand");
    expect(MurmurHeaders.X_MURMUR_SUBCOMMAND).toBe("X-Murmur-Subcommand");
  });

  it("X-Murmur-Claim-Token", () => {
    expect(X_MURMUR_CLAIM_TOKEN).toBe("X-Murmur-Claim-Token");
    expect(MurmurHeaders.X_MURMUR_CLAIM_TOKEN).toBe("X-Murmur-Claim-Token");
  });

  it("Idempotency-Key", () => {
    expect(IDEMPOTENCY_KEY).toBe("Idempotency-Key");
    expect(MurmurHeaders.IDEMPOTENCY_KEY).toBe("Idempotency-Key");
  });
});

describe("§4 — envelope shape is the only envelope", () => {
  it("accepts an Ok response with data", () => {
    const r: EnvelopeResponse<{ x: number }> = { ok: true, data: { x: 1 } };
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.data?.x).toBe(1);
    }
  });

  it("accepts an Ok response with no data", () => {
    const r: EnvelopeResponse = { ok: true };
    expect(isOk(r)).toBe(true);
  });

  it("accepts an Err response with string errors", () => {
    const r: EnvelopeResponse = { ok: false, errors: ["claim_lost"] };
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors).toEqual(["claim_lost"]);
    }
  });

  it("type-level: EnvelopeResponse rejects { accepted: true }", () => {
    // The next line is the load-bearing assertion: the legacy
    // `{ accepted: true }` envelope shape is NOT assignable to
    // EnvelopeResponse<T>. If this comment is removed and the
    // ts-expect-error is silenced, the type system has regressed.
    // @ts-expect-error — the canonical envelope is `{ ok, errors?, data? }`, never `{ accepted, ... }`.
    const _legacy: EnvelopeResponse = { accepted: true };
    void _legacy;
  });

  it("type-level: Err requires errors[]", () => {
    // @ts-expect-error — Err.errors is required.
    const _missingErrors: Err = { ok: false };
    void _missingErrors;
  });

  it("type-level: Ok narrows correctly", () => {
    const r: EnvelopeResponse<number> = { ok: true, data: 42 };
    if (isOk(r)) {
      expectTypeOf(r).toMatchTypeOf<Ok<number>>();
      expectTypeOf(r.data).toEqualTypeOf<number | undefined>();
    }
  });

  it("type-level: Err narrows correctly", () => {
    const r: EnvelopeResponse<number> = { ok: false, errors: ["bad"] };
    if (isErr(r)) {
      expectTypeOf(r).toEqualTypeOf<Err>();
    }
  });
});

describe("§5 — ValidationError shape", () => {
  it("supports JSON Pointer paths and optional code", () => {
    const errs: ValidationError[] = [
      { path: "/monitor_config/token", message: "must be string", code: "type" },
      { path: "", message: "must be object", code: "type" },
      { path: "/per_field/title", message: "required" },
    ];
    expect(errs).toHaveLength(3);
  });

  it("fits inside an Err envelope", () => {
    const r: EnvelopeResponse = {
      ok: false,
      errors: [{ path: "/x", message: "bad", code: "type" }],
    };
    if (isErr(r)) {
      const first = r.errors[0];
      expect(typeof first === "object" && first !== null && "path" in first).toBe(true);
    }
  });
});

describe("§2 — MURMUR_TOKEN spec", () => {
  it("min length is 32", () => {
    expect(MURMUR_TOKEN_SPEC.minLength).toBe(32);
  });

  it("comparison is timing-safe", () => {
    expect(MURMUR_TOKEN_SPEC.comparison).toBe("timing-safe");
  });

  it("rotation is per-deployment", () => {
    expect(MURMUR_TOKEN_SPEC.rotation).toBe("per-deployment");
  });

  it("Bearer prefix is exact", () => {
    expect(BEARER_PREFIX).toBe("Bearer ");
  });
});

describe("§6 — webhook constants", () => {
  it("retry count is 1", () => {
    expect(WEBHOOK_RETRY_COUNT).toBe(1);
  });

  it("retry delay is 30s", () => {
    expect(WEBHOOK_RETRY_DELAY_MS).toBe(30_000);
  });

  it("dedupe window is durable (null)", () => {
    expect(WEBHOOK_DEDUPE_WINDOW_MS).toBeNull();
  });
});
