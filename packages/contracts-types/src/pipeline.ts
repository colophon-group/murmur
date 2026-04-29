/**
 * Pipeline-def shape — TypeScript mirror of
 * `docs/contracts/pipeline-def.schema.json` (JSON Schema 2020-12).
 *
 * The JSON Schema is authoritative for `POST /pipelines` validation; this
 * file gives TypeScript callers a typed handle.
 *
 * @see docs/contracts.md §1 — Pipeline-def YAML schema
 * @see docs/contracts.md §7 — `final_output.composes` flattening rules
 */

/**
 * A subcommand declared on a subtask. Invoked by the agent via
 * `task_tool('<name>', '<claim>', args)`.
 */
export interface SubcommandDef {
  /** Subcommand name as it appears in agent calls (e.g. `"probe monitor"`). */
  readonly name: string;
  /**
   * Publisher endpoint Murmur proxies to. `METHOD URL` form, e.g.
   * `"POST https://jobseek.colophon-group.org/api/murmur/probes/monitor"`.
   */
  readonly endpoint: string;
  /** JSON Schema (draft 2020-12) for `args` passed to `task_tool`. */
  readonly input_schema?: Readonly<Record<string, unknown>>;
}

/**
 * Reference to one or more prior subtask outputs that are the input to
 * this subtask. Resolved by Murmur at claim-creation time.
 */
export interface InputRef {
  /** Subtask id whose output supplies the input. */
  readonly from: string;
  /**
   * Optional JSON Pointer (RFC 6901) into the source output. Empty
   * string or omitted → the entire output document.
   */
  readonly path?: string;
}

/**
 * `spawns` — dynamic instantiation. Parent's output triggers one child
 * per element of a named array field. See DESIGN.md §3.1.
 */
export interface SpawnsDef {
  /** Field on the parent's output that is the array to iterate. */
  readonly for_each: string;
  /** Subtask def id used as the template for each child instance. */
  readonly template: string;
  /**
   * Optional input-key name under which the child sees the for_each
   * element. Per DESIGN.md §3.1's worked example (`bind_as: board`), the
   * spawned subtask's `pull_task` input becomes `{ [bind_as]: <element> }`.
   * Omitted ⇒ the child's input is the element itself (legacy shape).
   */
  readonly bind_as?: string;
}

export interface SubtaskDef {
  readonly id: string;
  readonly instructions: string;
  readonly inputs?: ReadonlyArray<InputRef>;
  /** JSON Schema (draft 2020-12) for `submit_result.result`. */
  readonly output_schema: Readonly<Record<string, unknown>>;
  readonly subcommands?: ReadonlyArray<SubcommandDef>;
  readonly spawns?: SpawnsDef;
  /**
   * Subtask ids whose outputs MUST be present before this subtask is
   * eligible to claim. Replaces implicit "next in list" ordering when set.
   */
  readonly requires?: ReadonlyArray<string>;
  /**
   * JSONLogic-style expression on prior outputs. When true, the subtask
   * is auto-completed with an empty output. Deferred for MVP.
   */
  readonly skip_if?: Readonly<Record<string, unknown>>;
}

/**
 * `final_output.composes` — the rule the publisher writes to flatten
 * subtask outputs into the webhook payload's `final_output`.
 *
 * Three primitive rule shapes:
 *
 * 1. **Wildcard expansion** — `<subtask_id>.*` copies every top-level
 *    field of that subtask's output into `final_output` at the same key.
 *
 * 2. **Field rename** — `<key>: <subtask_id>.<field>` (or `.*`) places
 *    the subtask's field at `final_output[<key>]`.
 *
 * 3. **Cartesian product** — `<key>: <list_subtask>.<field> × <spawn_subtask>.*`
 *    pairs each element of the list with the corresponding spawned
 *    instance's output (matched by the spawn `for_each` index), producing
 *    `final_output[<key>]: Array<{ ...listItem, ...spawnOutput }>`.
 *
 * 4. **Flatten** — `<key>: flatten([<subtask_id>, ...].<field>)` collects
 *    `<field>` from each named subtask's output (or every spawn instance,
 *    when the subtask has spawns) and concatenates the arrays.
 *
 * Rules MUST be expressed as an ordered array of strings; later rules can
 * overwrite earlier ones. See `docs/contracts.md` §7 for the canonical
 * grammar and worked examples.
 */
export type ComposeRule = string;

export interface FinalOutputDef {
  readonly composes: ReadonlyArray<ComposeRule>;
  readonly webhook: string;
}

export interface PipelineDef {
  readonly id: string;
  readonly version?: number;
  readonly initial_input: Readonly<Record<string, unknown>>;
  readonly subtasks: ReadonlyArray<SubtaskDef>;
  readonly final_output: FinalOutputDef;
}
