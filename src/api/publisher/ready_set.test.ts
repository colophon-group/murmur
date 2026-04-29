import { describe, expect, it } from "vitest";

import type { PipelineDef } from "@murmur/contracts-types";

import { computeReadySet, spawnTemplateIds } from "./ready_set.js";

const SAMPLE: PipelineDef = {
  id: "p",
  initial_input: { type: "object" },
  subtasks: [
    {
      id: "pre-verify",
      instructions: "x",
      output_schema: { type: "object" },
    },
    {
      id: "setup-metadata",
      instructions: "x",
      requires: ["pre-verify"],
      output_schema: { type: "object" },
    },
    {
      id: "list-boards",
      instructions: "x",
      requires: ["pre-verify"],
      output_schema: { type: "object" },
      spawns: { for_each: "boards", template: "configure-board" },
    },
    {
      id: "configure-board",
      instructions: "x",
      output_schema: { type: "object" },
    },
  ],
  final_output: { composes: ["pre-verify.*"], webhook: "https://x.example" },
};

describe("spawnTemplateIds", () => {
  it("collects every subtask id named as a spawn template", () => {
    expect(spawnTemplateIds(SAMPLE)).toEqual(new Set(["configure-board"]));
  });

  it("returns empty set when no subtask has spawns", () => {
    const def: PipelineDef = { ...SAMPLE, subtasks: [SAMPLE.subtasks[0]!] };
    expect(spawnTemplateIds(def).size).toBe(0);
  });
});

describe("computeReadySet", () => {
  it("includes only subtasks with empty/absent requires that are not spawn templates", () => {
    let counter = 0;
    const rows = computeReadySet(
      SAMPLE,
      "r_test",
      { hello: "world" },
      "2026-04-29T00:00:00.000Z",
      () => `i_${++counter}`,
    );
    expect(rows.map((r) => r.subtask_id)).toEqual(["pre-verify"]);
    expect(rows[0]?.run_id).toBe("r_test");
    expect(rows[0]?.status).toBe("ready");
    expect(JSON.parse(rows[0]?.input_json ?? "")).toEqual({ hello: "world" });
    expect(rows[0]?.created_at).toBe("2026-04-29T00:00:00.000Z");
    expect(rows[0]?.id).toBe("i_1");
  });

  it("treats requires:[] (empty array) the same as absent requires", () => {
    const def: PipelineDef = {
      ...SAMPLE,
      subtasks: [
        {
          id: "a",
          instructions: "x",
          requires: [],
          output_schema: { type: "object" },
        },
      ],
      final_output: { composes: ["a.*"], webhook: "https://x.example" },
    };
    const rows = computeReadySet(
      def,
      "r",
      {},
      "2026-04-29T00:00:00.000Z",
      () => "i_a",
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.subtask_id).toBe("a");
  });
});
