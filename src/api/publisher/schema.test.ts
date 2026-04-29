import { describe, expect, it } from "vitest";

import { PIPELINE_DEF_SCHEMA, loadPipelineDefSchema } from "./schema.js";

describe("loadPipelineDefSchema", () => {
  it("returns a JSON Schema object with the expected $id", () => {
    const schema = loadPipelineDefSchema() as { $id?: string; type?: string };
    expect(schema.type).toBe("object");
    expect(schema.$id).toMatch(/pipeline-def\.schema\.json$/);
  });

  it("PIPELINE_DEF_SCHEMA module-level export is the same shape", () => {
    const top = PIPELINE_DEF_SCHEMA as { type?: string };
    expect(top.type).toBe("object");
  });
});
