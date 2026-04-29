/**
 * `POST /pipelines` and `POST /pipelines/{id}/runs` route handlers.
 *
 * These mount onto the publisher sub-app from `./index.ts`. Both routes
 * sit behind the bearer-auth middleware installed in `src/server.ts`;
 * this module assumes auth has already passed when its handlers run.
 *
 * @see DESIGN.md §3.2 — POST /pipelines, POST /pipelines/{id}/runs
 */

import type Database from "better-sqlite3";
import type { Hono } from "hono";
import { parse as parseYaml, YAMLParseError } from "yaml";

import type { Err, Ok, PipelineDef } from "@murmur/contracts-types";

import {
  validateAgainst,
  validateJsonSchema,
} from "../../dispatch/validation.js";
import { newInstanceId, newRunId } from "./ids.js";
import { computeReadySet } from "./ready_set.js";
import { PIPELINE_DEF_SCHEMA } from "./schema.js";

/**
 * Maximum body size accepted by `POST /pipelines`. Anything larger is
 * rejected with `413 { ok: false, errors: ["payload_too_large"] }` BEFORE
 * the body is parsed as YAML — both to short-circuit obvious abuse and
 * to keep the YAML parser from chewing through pathological inputs.
 */
export const PIPELINE_BODY_BYTE_CAP = 5 * 1024 * 1024;

/** Shape of the `POST /pipelines` request body. */
interface PostPipelinesBody {
  readonly id?: unknown;
  readonly def_yaml?: unknown;
}

/** Shape of the `POST /pipelines/{id}/runs` request body. */
interface PostRunsBody {
  readonly initial_input?: unknown;
}

/**
 * Walk a pipeline-def's schema-bearing fields and confirm each is a
 * structurally valid JSON Schema (compiles under Ajv `strict: true`).
 *
 * The outer `pipeline-def.schema.json` only asserts each schema slot is
 * a JSON object — it does NOT compile the inner schemas. We do that
 * here so a typo like `requried:` is caught at registration, not at
 * the first runtime validation.
 *
 * @returns an array of `validation:<path>:<msg>` strings; empty when
 *   every inner schema is well-formed.
 */
function validateInnerSchemas(def: PipelineDef): ReadonlyArray<string> {
  const errors: string[] = [];

  // initial_input — top-level schema for `POST /pipelines/{id}/runs`.
  const initialResult = validateJsonSchema(def.initial_input);
  if (!initialResult.ok) {
    errors.push(`validation:/initial_input${initialResult.error.startsWith(":") ? "" : ":"}${initialResult.error}`);
  }

  for (let i = 0; i < def.subtasks.length; i++) {
    const sub = def.subtasks[i];
    if (sub === undefined) continue;
    const outResult = validateJsonSchema(sub.output_schema);
    if (!outResult.ok) {
      errors.push(
        `validation:/subtasks/${i}/output_schema${outResult.error.startsWith(":") ? "" : ":"}${outResult.error}`,
      );
    }
    const subcommands = sub.subcommands ?? [];
    for (let j = 0; j < subcommands.length; j++) {
      const cmd = subcommands[j];
      if (cmd === undefined) continue;
      if (cmd.input_schema !== undefined) {
        const r = validateJsonSchema(cmd.input_schema);
        if (!r.ok) {
          errors.push(
            `validation:/subtasks/${i}/subcommands/${j}/input_schema${r.error.startsWith(":") ? "" : ":"}${r.error}`,
          );
        }
      }
    }
  }
  return errors;
}

/**
 * Build a `400 Err` response body for a list of pre-formatted error
 * tokens. Centralised so every reject path on this surface emits the
 * exact same envelope shape.
 */
function badRequest(errors: ReadonlyArray<string>): Err {
  return { ok: false, errors };
}

/**
 * Mount the pipeline-registration and run-creation routes onto the given
 * Hono sub-app.
 *
 * Routes registered (relative to the sub-app's mount point):
 *   - `POST /pipelines` — register/upsert a pipeline def.
 *   - `POST /pipelines/{id}/runs` — start a run.
 *
 * @param app the sub-app to mount onto (the publisher Hono).
 * @param db the open SQLite handle (from `openDb`).
 */
export function mountPipelineRoutes(app: Hono, db: Database.Database): void {
  // Prepared statements — better-sqlite3 lets us reuse them across
  // requests for free. They're scoped to this module and hold no
  // per-request state.
  const upsertPipeline = db.prepare(
    `INSERT INTO pipelines (id, version, def_json, created_at, updated_at)
       VALUES (@id, 1, @def_json, @now, @now)
     ON CONFLICT(id) DO UPDATE SET
       version = pipelines.version + 1,
       def_json = excluded.def_json,
       updated_at = excluded.updated_at`,
  );
  const selectPipeline = db.prepare(
    `SELECT id, version, def_json FROM pipelines WHERE id = ?`,
  );
  const insertRun = db.prepare(
    `INSERT INTO runs (
       id, pipeline_id, pipeline_version, status, initial_input_json,
       webhook_url, created_at
     ) VALUES (
       @id, @pipeline_id, @pipeline_version, 'running', @initial_input_json,
       @webhook_url, @now
     )`,
  );
  const insertInstance = db.prepare(
    `INSERT INTO subtask_instances (
       id, run_id, subtask_id, status, input_json, created_at, updated_at
     ) VALUES (
       @id, @run_id, @subtask_id, @status, @input_json, @created_at, @updated_at
     )`,
  );

  // POST /pipelines
  app.post("/pipelines", async (c) => {
    // 1. Body cap. Hono parses the body lazily; we read raw bytes once
    //    and gate on length BEFORE asking for `c.req.json()` so a 6 MB
    //    body never makes it to the JSON parser.
    let raw: ArrayBuffer;
    try {
      raw = await c.req.arrayBuffer();
    } catch {
      return c.json(badRequest(["body_unreadable"]), 400);
    }
    if (raw.byteLength > PIPELINE_BODY_BYTE_CAP) {
      return c.json(badRequest(["payload_too_large"]), 413);
    }

    // 2. Parse JSON wrapper.
    let body: PostPipelinesBody;
    try {
      const text = new TextDecoder("utf-8", { fatal: false }).decode(raw);
      body = JSON.parse(text) as PostPipelinesBody;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json(badRequest([`json:${msg}`]), 400);
    }
    if (typeof body !== "object" || body === null) {
      return c.json(badRequest(["body must be a JSON object"]), 400);
    }
    const defYamlRaw = body.def_yaml;
    if (typeof defYamlRaw !== "string" || defYamlRaw.length === 0) {
      return c.json(badRequest(["def_yaml must be a non-empty string"]), 400);
    }

    // 3. Parse YAML.
    let parsedDef: unknown;
    try {
      parsedDef = parseYaml(defYamlRaw);
    } catch (err) {
      const msg =
        err instanceof YAMLParseError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      return c.json(badRequest([`yaml:${msg}`]), 400);
    }
    if (
      parsedDef === null ||
      typeof parsedDef !== "object" ||
      Array.isArray(parsedDef)
    ) {
      return c.json(badRequest(["yaml: parsed value must be a JSON object"]), 400);
    }

    // 4. Validate against the M0 pipeline-def schema.
    const outerResult = validateAgainst<PipelineDef>(
      PIPELINE_DEF_SCHEMA,
      parsedDef,
    );
    if (!outerResult.ok) {
      return c.json(badRequest(outerResult.errors), 400);
    }
    const def = outerResult.value;

    // 5. Inner-schema validation: each `output_schema`, each
    //    subcommand's `input_schema`, plus `initial_input`, must
    //    compile as a standalone JSON Schema (catches `requried:` typos
    //    and similar).
    const innerErrors = validateInnerSchemas(def);
    if (innerErrors.length > 0) {
      return c.json(badRequest(innerErrors), 400);
    }

    // 6. Persist (UPSERT — last-write-wins).
    const now = new Date().toISOString();
    upsertPipeline.run({
      id: def.id,
      def_json: JSON.stringify(def),
      now,
    });

    const ok: Ok<{ id: string }> = { ok: true, data: { id: def.id } };
    return c.json(ok, 200);
  });

  // POST /pipelines/{id}/runs
  app.post("/pipelines/:id/runs", async (c) => {
    const pipelineId = c.req.param("id");
    if (pipelineId === undefined || pipelineId === "") {
      return c.json(badRequest(["pipeline_id_required"]), 400);
    }

    let body: PostRunsBody;
    try {
      body = (await c.req.json()) as PostRunsBody;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json(badRequest([`json:${msg}`]), 400);
    }
    if (typeof body !== "object" || body === null) {
      return c.json(badRequest(["body must be a JSON object"]), 400);
    }

    // Pipeline lookup — 404 on miss.
    const row = selectPipeline.get(pipelineId) as
      | { id: string; version: number; def_json: string }
      | undefined;
    if (row === undefined) {
      const err: Err = { ok: false, errors: ["pipeline_not_found"] };
      return c.json(err, 404);
    }
    const def = JSON.parse(row.def_json) as PipelineDef;

    // Validate initial_input against the pipeline's `initial_input`
    // schema — we already proved at registration that it's a valid
    // JSON Schema.
    const initialResult = validateAgainst(def.initial_input, body.initial_input);
    if (!initialResult.ok) {
      return c.json(badRequest(initialResult.errors), 400);
    }

    // Compute ready set + assemble row inserts. Wrap in a transaction so
    // a partial failure leaves no run/instance rows behind.
    const runId = newRunId();
    const now = new Date().toISOString();
    const readyRows = computeReadySet(
      def,
      runId,
      body.initial_input,
      now,
      newInstanceId,
    );

    const tx = db.transaction(() => {
      insertRun.run({
        id: runId,
        pipeline_id: def.id,
        pipeline_version: row.version,
        initial_input_json: JSON.stringify(body.initial_input),
        webhook_url: def.final_output.webhook,
        now,
      });
      for (const r of readyRows) {
        insertInstance.run({
          id: r.id,
          run_id: r.run_id,
          subtask_id: r.subtask_id,
          status: r.status,
          input_json: r.input_json,
          created_at: r.created_at,
          updated_at: r.updated_at,
        });
      }
    });
    tx();

    const ok: Ok<{ run_id: string }> = { ok: true, data: { run_id: runId } };
    return c.json(ok, 200);
  });
}
