/**
 * Base shapes for the four demo-path subtasks. These are TypeScript
 * mirrors of the JSON Schemas in `docs/contracts/pipeline-def.schema.json`;
 * the schemas remain authoritative for runtime validation.
 *
 * The shapes here are deliberately permissive (most fields `unknown` or
 * narrow records) — the pipeline def's `output_schema` is what Murmur
 * actually validates against at `submit_result` time. These types exist
 * to give TypeScript callers (Murmur core, jobseek's TS surface in
 * `apps/web`) a typed handle on the demo-path payload shapes.
 *
 * @see docs/contracts.md §1 — Pipeline-def YAML schema
 */

/**
 * Optional fields every subtask's output may carry. Surfaced verbatim in
 * `final_output` via the pipeline's `composes` rule.
 */
export interface SubtaskKBExtras {
  readonly kb_entries?: ReadonlyArray<KBEntry>;
  readonly case_studies?: ReadonlyArray<CaseStudy>;
}

export interface KBEntry {
  readonly slug: string;
  readonly title: string;
  readonly body: string;
  readonly tags?: ReadonlyArray<string>;
}

export interface CaseStudy {
  readonly slug: string;
  readonly summary: string;
  readonly body: string;
}

/* ---------- pre-verify ---------- */

export interface PreVerifyInput {
  readonly company_name: string;
  readonly website: string;
}

export interface PreVerifyOutput extends SubtaskKBExtras {
  readonly verified: boolean;
  readonly canonical_name: string;
  readonly canonical_website: string;
  readonly reject_reason?: string;
}

/* ---------- setup-metadata ---------- */

export interface SetupMetadataInput {
  readonly canonical_name: string;
  readonly canonical_website: string;
}

export interface SetupMetadataOutput extends SubtaskKBExtras {
  readonly slug: string;
  readonly description: string;
  readonly founded_year?: number;
  readonly employee_count_range?: string;
  readonly logo_url?: string;
  readonly industry_ids: ReadonlyArray<string>;
}

/* ---------- list-boards ---------- */

export interface ListBoardsInput {
  readonly canonical_website: string;
}

export interface DiscoveredBoard {
  /** Stable alias for this board within the run (e.g., `"careers-de"`). */
  readonly alias: string;
  readonly board_url: string;
  readonly provider: string;
  readonly hreflang?: string;
}

export interface ListBoardsOutput extends SubtaskKBExtras {
  readonly boards: ReadonlyArray<DiscoveredBoard>;
}

/* ---------- configure-board ---------- */

export interface ConfigureBoardInput {
  readonly alias: string;
  readonly board_url: string;
  readonly provider: string;
}

export interface ConfigureBoardOutput extends SubtaskKBExtras {
  readonly outcome: "configured" | "blocked";
  readonly monitor_type?: string;
  readonly monitor_config?: Readonly<Record<string, unknown>>;
  readonly scraper_type?: string;
  readonly scraper_config?: Readonly<Record<string, unknown>>;
  readonly verdict?: "ok" | "needs-work" | "rejected";
  readonly per_field?: Readonly<Record<string, unknown>>;
}

/**
 * Discriminated union of subtask names used for typed dispatch.
 */
export type SubtaskName =
  | "pre-verify"
  | "setup-metadata"
  | "list-boards"
  | "configure-board";

/**
 * Lookup table mapping subtask name → input/output pair.
 */
export interface SubtaskShape {
  "pre-verify": { input: PreVerifyInput; output: PreVerifyOutput };
  "setup-metadata": { input: SetupMetadataInput; output: SetupMetadataOutput };
  "list-boards": { input: ListBoardsInput; output: ListBoardsOutput };
  "configure-board": { input: ConfigureBoardInput; output: ConfigureBoardOutput };
}
