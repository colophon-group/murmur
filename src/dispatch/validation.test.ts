/**
 * Tests for `src/dispatch/validation.ts`.
 *
 * Test bullets are taken verbatim from issue #14's "Verification"
 * section. Every named bullet has at least one corresponding `it()`
 * below; the bullet text is included in the test title so a reviewer
 * can grep for it.
 */

import { describe, it, expect } from "vitest";

import {
  validateJsonSchema,
  validateAgainst,
  formatAjvError,
} from "./validation.js";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const allSeven = JSON.parse(
  readFileSync(
    resolve(__dirname, "../../docs/contracts/fixtures/all-seven.json"),
    "utf8",
  ),
) as Record<string, unknown>;

// The §3.1 jobseek pipeline def. We exercise the schemas inside it,
// not the pipeline-def envelope itself (which has its own schema in
// docs/contracts/pipeline-def.schema.json).
const PIPELINE_DEF = allSeven["1_pipeline_def"] as {
  initial_input: object;
  subtasks: ReadonlyArray<{
    id: string;
    output_schema: object;
    subcommands?: ReadonlyArray<{ name: string; input_schema?: object }>;
  }>;
};

describe("validateJsonSchema (registration-time)", () => {
  it("accepts a valid JSON Schema (no error)", () => {
    const result = validateJsonSchema({
      type: "object",
      properties: { foo: { type: "string" } },
      required: ["foo"],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a schema with an unknown keyword (would be 400 at registration)", () => {
    // `requried` (typo of `required`) is not a JSON Schema keyword.
    // Ajv `strict: true` rejects it at compile time.
    const result = validateJsonSchema({
      type: "object",
      requried: ["foo"], // typo
      properties: { foo: { type: "string" } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/requried|strict/i);
    }
  });

  it("rejects a schema referencing an undefined $ref (would be 400)", () => {
    const result = validateJsonSchema({
      type: "object",
      properties: { foo: { $ref: "#/$defs/DoesNotExist" } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it("rejects non-object inputs (e.g. a bare boolean)", () => {
    expect(validateJsonSchema(true).ok).toBe(false);
    expect(validateJsonSchema(null).ok).toBe(false);
    expect(validateJsonSchema("not a schema").ok).toBe(false);
  });

  it("registers the §3.1 jobseek pipeline def YAML without error (initial_input + every subtask schema)", () => {
    expect(validateJsonSchema(PIPELINE_DEF.initial_input).ok).toBe(true);
    for (const subtask of PIPELINE_DEF.subtasks) {
      const r = validateJsonSchema(subtask.output_schema);
      expect(
        r.ok,
        `subtask ${subtask.id} output_schema: ${r.ok ? "" : r.error}`,
      ).toBe(true);
      for (const sub of subtask.subcommands ?? []) {
        if (sub.input_schema !== undefined) {
          const ri = validateJsonSchema(sub.input_schema);
          expect(
            ri.ok,
            `subtask ${subtask.id} subcommand ${sub.name} input_schema: ${ri.ok ? "" : ri.error}`,
          ).toBe(true);
        }
      }
    }
  });

  it("rejects a deliberately broken version of the §3.1 YAML (unknown keyword injected)", () => {
    const broken = {
      ...PIPELINE_DEF.initial_input,
      // `addtionalProperties` (typo) is not a known keyword; strict mode
      // rejects it.
      addtionalProperties: false,
    } as object;
    expect(validateJsonSchema(broken).ok).toBe(false);
  });
});

describe("validateAgainst (runtime instance validation)", () => {
  // Output schema cribbed from §3.1 `pre-verify` subtask:
  const PRE_VERIFY_OUTPUT_SCHEMA = {
    type: "object",
    required: ["verified", "canonical_name", "canonical_website"],
    properties: {
      verified: { type: "boolean" },
      canonical_name: { type: "string" },
      canonical_website: { type: "string" },
      reject_reason: { type: "string" },
    },
  };

  it("accepts a valid instance (no errors)", () => {
    const result = validateAgainst(PRE_VERIFY_OUTPUT_SCHEMA, {
      verified: true,
      canonical_name: "ExampleCo",
      canonical_website: "https://example.co",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        verified: true,
        canonical_name: "ExampleCo",
        canonical_website: "https://example.co",
      });
    }
  });

  it("accepts submit_result with an extra unknown field (no additionalProperties: false)", () => {
    const result = validateAgainst(PRE_VERIFY_OUTPUT_SCHEMA, {
      verified: true,
      canonical_name: "ExampleCo",
      canonical_website: "https://example.co",
      surprise: "this should be tolerated",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects submit_result with a type mismatch — 'validation:/board_url:must be string'", () => {
    const schema = {
      type: "object",
      required: ["board_url"],
      properties: { board_url: { type: "string" } },
    };
    const result = validateAgainst(schema, { board_url: 123 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("validation:/board_url:must be string");
    }
  });

  it("rejects submit_result with a missing required field — 'validation::must have required property \\'verified\\''", () => {
    const result = validateAgainst(PRE_VERIFY_OUTPUT_SCHEMA, {
      canonical_name: "ExampleCo",
      canonical_website: "https://example.co",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain(
        "validation::must have required property 'verified'",
      );
    }
  });

  it("rejects task_tool with bad args — pattern mismatch yields 'validation:/board_url:must match pattern …'", () => {
    const inputSchema = {
      type: "object",
      required: ["board_url"],
      properties: {
        board_url: { type: "string", pattern: "^https://" },
      },
    };
    const result = validateAgainst(inputSchema, {
      board_url: "ftp://nope.example.com",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Ajv's message is `must match pattern "<pattern>"`.
      expect(
        result.errors.some(
          (e) =>
            e.startsWith("validation:/board_url:") && e.includes("must match pattern"),
        ),
      ).toBe(true);
    }
  });

  it("returns multiple errors all together (not first-only)", () => {
    const schema = {
      type: "object",
      required: ["a", "b", "c"],
      properties: {
        a: { type: "string" },
        b: { type: "string" },
        c: { type: "string" },
      },
    };
    // Missing all three required fields:
    const result = validateAgainst(schema, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // All three required-property errors must appear.
      expect(
        result.errors.some((e) =>
          e.includes("must have required property 'a'"),
        ),
      ).toBe(true);
      expect(
        result.errors.some((e) =>
          e.includes("must have required property 'b'"),
        ),
      ).toBe(true);
      expect(
        result.errors.some((e) =>
          e.includes("must have required property 'c'"),
        ),
      ).toBe(true);
    }
  });

  it("formats every error with a JSON-Pointer path (root → empty, nested → '/foo/0/bar')", () => {
    const schema = {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            required: ["bar"],
            properties: { bar: { type: "string" } },
          },
        },
      },
    };
    const result = validateAgainst(schema, {
      items: [{ bar: 1 }, { /* missing bar */ }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => e.startsWith("validation:/items/0/bar:")),
      ).toBe(true);
      expect(
        result.errors.some(
          (e) =>
            e.startsWith("validation:/items/1:") &&
            e.includes("must have required property 'bar'"),
        ),
      ).toBe(true);
    }
  });

  it("caches compiled validators by schema reference (idempotent fast path)", () => {
    const schema = { type: "string" };
    // First call compiles, second call reuses. We cannot directly observe
    // the cache, but we can assert correctness across many calls without
    // throwing or slowing down meaningfully.
    for (let i = 0; i < 100; i++) {
      const r = validateAgainst(schema, "ok");
      expect(r.ok).toBe(true);
    }
    const bad = validateAgainst(schema, 42);
    expect(bad.ok).toBe(false);
  });

  it("does NOT use the strict registration validator at runtime — unknown keyword logs but does not fail", () => {
    // Runtime Ajv is `strict: 'log'`. A schema with a harmless unknown
    // keyword (e.g. an OpenAPI extension like `x-internal`) should still
    // validate the instance.
    const schema = {
      type: "object",
      "x-internal": "some annotation",
      properties: { foo: { type: "string" } },
    };
    const result = validateAgainst(schema, { foo: "ok" });
    expect(result.ok).toBe(true);
  });
});

describe("formatAjvError (internal)", () => {
  it("formats a root error with empty path: 'validation::<msg>'", () => {
    expect(
      formatAjvError({
        instancePath: "",
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "verified" },
        message: "must have required property 'verified'",
      }),
    ).toBe("validation::must have required property 'verified'");
  });

  it("formats a nested error: 'validation:/foo/0/bar:<msg>'", () => {
    expect(
      formatAjvError({
        instancePath: "/foo/0/bar",
        schemaPath: "#/properties/foo/items/properties/bar/type",
        keyword: "type",
        params: { type: "string" },
        message: "must be string",
      }),
    ).toBe("validation:/foo/0/bar:must be string");
  });

  it("uses an empty message when Ajv supplies none (defensive)", () => {
    expect(
      formatAjvError({
        instancePath: "/x",
        schemaPath: "#/x",
        keyword: "type",
        params: {},
      }),
    ).toBe("validation:/x:");
  });
});
