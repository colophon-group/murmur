import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  ConfigureBoardOutput,
  EnvelopeResponse,
  ListBoardsOutput,
  PipelineDef,
  ValidationError,
  WebhookPayload,
} from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(__dirname, "../../../docs/contracts/fixtures/all-seven.json");

interface AllSevenFixture {
  "1_pipeline_def": PipelineDef;
  "2_murmur_token": {
    example: string;
    min_length: number;
    char_class: string;
    comparison: "timing-safe";
    rotation: "per-deployment";
  };
  "3_proxy_headers": Record<string, string>;
  "4_envelope_ok": EnvelopeResponse<unknown>;
  "4_envelope_err_token": EnvelopeResponse<unknown>;
  "4_envelope_err_publisher": EnvelopeResponse<unknown>;
  "5_validation_error_envelope": {
    ok: false;
    errors: ValidationError[];
  };
  "6_webhook": {
    // Body is the composed final_output directly — no wrapper. The
    // type alias `WebhookPayload` names this naked shape.
    headers: Record<string, string>;
    body: WebhookPayload;
    retry_count: number;
    retry_delay_ms: number;
    dedupe_window_ms: number | null;
  };
  "7_composes_examples": Record<string, string>;
}

describe("docs/contracts/fixtures/all-seven.json", () => {
  const raw = readFileSync(fixturePath, "utf-8");
  const fixture = JSON.parse(raw) as AllSevenFixture;

  it("§1 — pipeline def parses with required fields", () => {
    const p = fixture["1_pipeline_def"];
    expect(p.id).toBe("jobseek-add-company");
    expect(p.subtasks.length).toBe(4);
    expect(p.final_output.composes.length).toBeGreaterThan(0);
    expect(p.final_output.webhook.startsWith("https://")).toBe(true);
  });

  it("§1 — list-boards declares spawns", () => {
    const p = fixture["1_pipeline_def"];
    const lb = p.subtasks.find((s) => s.id === "list-boards");
    expect(lb?.spawns?.for_each).toBe("boards");
    expect(lb?.spawns?.template).toBe("configure-board");
  });

  it("§1 — configure-board declares all demo subcommands", () => {
    const p = fixture["1_pipeline_def"];
    const cb = p.subtasks.find((s) => s.id === "configure-board");
    const names = (cb?.subcommands ?? []).map((sc) => sc.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "probe monitor",
        "select monitor",
        "run monitor",
        "probe scraper",
        "select scraper",
        "run scraper",
        "feedback",
      ]),
    );
  });

  it("§2 — token example matches spec", () => {
    const t = fixture["2_murmur_token"];
    expect(t.example.length).toBeGreaterThanOrEqual(t.min_length);
    expect(t.example).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t.comparison).toBe("timing-safe");
    expect(t.rotation).toBe("per-deployment");
  });

  it("§3 — proxy headers carry exact casing", () => {
    const h = fixture["3_proxy_headers"];
    expect(h["Authorization"]).toMatch(/^Bearer /);
    expect(h["X-Murmur-Subcommand"]).toBe("probe monitor");
    expect(h["X-Murmur-Claim-Token"]).toMatch(/^c_/);
  });

  it("§4 — OK envelope parses", () => {
    const r = fixture["4_envelope_ok"];
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toBeDefined();
    }
  });

  it("§4 — Err envelope has token-form errors", () => {
    const r = fixture["4_envelope_err_token"];
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toEqual(["claim_lost"]);
    }
  });

  it("§4 — fixture has no `accepted` key anywhere", () => {
    expect(raw).not.toMatch(/"accepted"\s*:/);
  });

  it("§5 — validation-error envelope uses JSON Pointer paths", () => {
    const e = fixture["5_validation_error_envelope"];
    expect(e.ok).toBe(false);
    expect(e.errors.length).toBeGreaterThan(0);
    for (const err of e.errors) {
      expect(typeof err.path).toBe("string");
      // JSON Pointer: "" or "/..."
      if (err.path !== "") {
        expect(err.path.startsWith("/")).toBe(true);
      }
      expect(typeof err.message).toBe("string");
    }
  });

  it("§6 — webhook headers carry run_id and bearer; constants match spec", () => {
    const w = fixture["6_webhook"];
    // run_id travels as the Idempotency-Key header (NOT in the body).
    expect(w.headers["Idempotency-Key"]).toMatch(/^r_/);
    expect(w.headers["Authorization"]).toMatch(/^Bearer /);
    expect(w.headers["Content-Type"]).toBe("application/json");
    expect(w.retry_count).toBe(1);
    expect(w.retry_delay_ms).toBe(30_000);
    expect(w.dedupe_window_ms).toBeNull();
  });

  it("§6 — webhook body is the composed final_output directly (no wrapper)", () => {
    const w = fixture["6_webhook"];
    // The body IS the composed object: keys come from the pipeline's
    // `final_output.composes` rules, not a fixed envelope.
    expect(typeof w.body).toBe("object");
    expect(w.body).not.toBeNull();
    expect(w.body["canonical_name"]).toBe("ExampleCo");
    expect(Array.isArray(w.body["boards"])).toBe(true);
    // The legacy wrapper fields MUST NOT appear at the body's top level.
    // They were the spec drift this fixture used to encode.
    expect(w.body["run_id"]).toBeUndefined();
    expect(w.body["pipeline_id"]).toBeUndefined();
    expect(w.body["pipeline_version"]).toBeUndefined();
    expect(w.body["completed_at"]).toBeUndefined();
    expect(w.body["final_output"]).toBeUndefined();
  });

  it("§7 — composes fixture covers wildcard, prefix, rename, cartesian, flatten", () => {
    const c = fixture["7_composes_examples"];
    expect(c["wildcard"]).toMatch(/\.\*$/);
    expect(c["wildcard_prefix"]).toMatch(/_\*$/);
    expect(c["rename"]).toContain(":");
    expect(c["cartesian"]).toContain("×");
    expect(c["flatten"]).toMatch(/^[a-z_]+:\s*flatten\(/);
  });

  it("§7 — pipeline composes uses cartesian + flatten as canonical example", () => {
    const composes = fixture["1_pipeline_def"].final_output.composes;
    expect(composes.some((r) => r.includes("×"))).toBe(true);
    expect(composes.some((r) => r.startsWith("kb_entries: flatten("))).toBe(true);
  });

  it("§1 — derived shapes (ListBoardsOutput / ConfigureBoardOutput) are typed", () => {
    // Compile-time only: ensures the demo-path subtask types are still
    // exported and structurally usable.
    const lb: ListBoardsOutput = { boards: [] };
    const cb: ConfigureBoardOutput = { outcome: "configured" };
    expect(lb.boards.length).toBe(0);
    expect(cb.outcome).toBe("configured");
  });
});
