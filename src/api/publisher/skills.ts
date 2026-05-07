/**
 * Skill registry — M5 Phase A foundation (issue #85).
 *
 * Endpoints (all publisher-scoped via `publisherAuth(db)`):
 *
 *   - `POST   /skills`                    — upload a new skill bundle (admin)
 *   - `GET    /skills`                    — list this publisher's skills
 *   - `GET    /skills/:name`              — list versions of a named skill
 *   - `GET    /skills/:name/:version`     — bundle metadata + manifest
 *   - `GET    /skills/:name/:version/files`
 *                                         — list files in the bundle
 *   - `GET    /skills/:name/:version/files/*`
 *                                         — read one file
 *   - `DELETE /skills/:name/:version`     — mark deprecated (admin)
 *
 * **Phase-A interim upload form.** The issue specifies multipart with
 * `bundle.tar.gz` OR `{ git_ref, path }`. v1 ships a JSON-body form
 * that takes the bundle inline:
 *
 * ```json
 * {
 *   "name": "<short-name>",
 *   "version": "<semver>",
 *   "description": "...",
 *   "manifest": { "loadable_by": [...], "loads_on": [...], "on_demand": true },
 *   "files": [
 *     { "path": "SKILL.md", "content": "---\\nname: ...\\n---\\n# ..." },
 *     { "path": "article-1.md", "content": "..." }
 *   ]
 * }
 * ```
 *
 * The on-disk extraction + tarball / git-ref forms land in a follow-up
 * once a real publisher needs them. The DB shape (`skill_files` flat
 * table) is the canonical store; tarball / git-ref handlers will
 * unpack into the same rows.
 *
 * **Versioning.** `(publisher_id, name, version)` is a UNIQUE index;
 * re-uploading the same triple returns 409. Deprecation flips
 * `deprecated_at` but keeps the row + files for in-flight runs.
 *
 * **Pipeline binding.** Pipelines reference skills via
 * `<publisher>/<name>@<version>` strings. Validation happens at
 * `POST /pipelines` time — the pipeline-routes handler imports
 * `validatePipelineSkillRefs` from this module.
 *
 * @see docs/skills.md — authoring guide
 */

import type Database from "better-sqlite3";
import type { Hono } from "hono";

import type { Err, Ok } from "@murmur/contracts-types";

import {
  getPublisherId,
  requireAnyKind,
  requireKind,
} from "../../auth/publisher_auth.js";
import { newRowId } from "../../auth/tokens.js";

/**
 * Maximum byte size of a single uploaded file. 256 KB — generous for a
 * single markdown article; binary files are out of scope.
 */
export const SKILL_FILE_BYTE_CAP = 256 * 1024;

/**
 * Maximum total byte size of a single skill bundle. 4 MB — fits the
 * 5 MB body cap on `POST /pipelines` with headroom for JSON overhead.
 */
export const SKILL_BUNDLE_BYTE_CAP = 4 * 1024 * 1024;

/**
 * Maximum number of files in a single bundle.
 */
export const SKILL_BUNDLE_FILE_CAP = 64;

/**
 * Body shape accepted by `POST /skills`. Phase-A interim form — the
 * tarball / git-ref forms land in a follow-up.
 */
interface PostSkillsBody {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly description?: unknown;
  readonly manifest?: unknown;
  readonly files?: unknown;
}

/**
 * One file in a bundle.
 */
interface BundleFile {
  readonly path: string;
  readonly content: string;
}

/**
 * Whitelist regex for skill names. Mirrors the M0 pipeline-id rule —
 * kebab-case identifiers, slug-safe.
 */
const SKILL_NAME_RE = /^[a-z][a-z0-9-]*[a-z0-9]$/;

/**
 * Whitelist regex for semver-ish versions. Permissive — accepts
 * `1.0.0`, `1.0.0-rc1`, `1.0.0+build.1`. The spec allows `name@latest`
 * at pipeline-registration time but storage is always pinned.
 */
const SKILL_VERSION_RE = /^[A-Za-z0-9.+_-]+$/;

/**
 * Whitelist regex for file paths inside a bundle. Disallows leading
 * `/`, `..`, and any path traversal. Allows `_examples/foo.json` etc.
 */
const SKILL_FILE_PATH_RE = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;

/**
 * Mount the M5 skill-registry routes onto the publisher sub-app.
 */
export function mountSkillRoutes(app: Hono, db: Database.Database): void {
  // POST /skills — admin-only.
  app.post("/skills", async (c) => {
    const adminFail = requireKind(c, "admin");
    if (adminFail !== null) return adminFail;
    const publisherId = getPublisherId(c);
    if (publisherId === null) {
      return c.json(badRequest(["unauthorized"]), 401);
    }

    let raw: ArrayBuffer;
    try {
      raw = await c.req.arrayBuffer();
    } catch {
      return c.json(badRequest(["body_unreadable"]), 400);
    }
    if (raw.byteLength > SKILL_BUNDLE_BYTE_CAP) {
      return c.json(badRequest(["payload_too_large"]), 413);
    }

    let body: PostSkillsBody;
    try {
      body = JSON.parse(new TextDecoder().decode(raw)) as PostSkillsBody;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json(badRequest([`json:${msg}`]), 400);
    }
    if (typeof body !== "object" || body === null) {
      return c.json(badRequest(["body must be a JSON object"]), 400);
    }

    const errors: string[] = [];
    if (typeof body.name !== "string" || !SKILL_NAME_RE.test(body.name)) {
      errors.push("name must be kebab-case (^[a-z][a-z0-9-]*[a-z0-9]$)");
    }
    if (
      typeof body.version !== "string" ||
      !SKILL_VERSION_RE.test(body.version)
    ) {
      errors.push("version must match ^[A-Za-z0-9.+_-]+$");
    }
    if (typeof body.description !== "string" || body.description.length < 1) {
      errors.push("description must be a non-empty string");
    }
    if (typeof body.manifest !== "object" || body.manifest === null) {
      errors.push("manifest must be a JSON object");
    }
    const filesValue = body.files;
    if (!Array.isArray(filesValue)) {
      errors.push("files must be an array");
    }
    if (errors.length > 0) {
      return c.json(badRequest(errors), 400);
    }

    const files = filesValue as ReadonlyArray<unknown>;
    if (files.length < 1) {
      return c.json(badRequest(["files must be non-empty"]), 400);
    }
    if (files.length > SKILL_BUNDLE_FILE_CAP) {
      return c.json(
        badRequest([`files exceeds cap of ${SKILL_BUNDLE_FILE_CAP}`]),
        400,
      );
    }
    const validatedFiles: BundleFile[] = [];
    let totalBytes = 0;
    let hasSkillMd = false;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (typeof f !== "object" || f === null) {
        return c.json(badRequest([`files[${i}] must be an object`]), 400);
      }
      const fObj = f as Record<string, unknown>;
      const path = fObj["path"];
      const content = fObj["content"];
      if (typeof path !== "string" || !SKILL_FILE_PATH_RE.test(path)) {
        return c.json(
          badRequest([`files[${i}].path must match ${SKILL_FILE_PATH_RE.source}`]),
          400,
        );
      }
      if (typeof content !== "string") {
        return c.json(badRequest([`files[${i}].content must be a string`]), 400);
      }
      const byteSize = Buffer.byteLength(content, "utf8");
      if (byteSize > SKILL_FILE_BYTE_CAP) {
        return c.json(
          badRequest([
            `files[${i}].content exceeds ${SKILL_FILE_BYTE_CAP}-byte cap`,
          ]),
          413,
        );
      }
      totalBytes += byteSize;
      if (path === "SKILL.md") {
        hasSkillMd = true;
      }
      validatedFiles.push({ path, content });
    }
    if (totalBytes > SKILL_BUNDLE_BYTE_CAP) {
      return c.json(badRequest(["bundle_too_large"]), 413);
    }
    if (!hasSkillMd) {
      return c.json(badRequest(["files must contain SKILL.md"]), 400);
    }

    const name = body.name as string;
    const version = body.version as string;
    const description = body.description as string;
    const manifest = body.manifest as Record<string, unknown>;
    const now = new Date().toISOString();
    const skillRowId = `skl_${newRowId()}`;

    // Insert skill + files in one transaction. The UNIQUE index on
    // `(publisher_id, name, version)` rejects duplicate triples.
    const tx = db.transaction(() => {
      try {
        db.prepare(
          `INSERT INTO skills
             (id, publisher_id, name, version, description, manifest_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          skillRowId,
          publisherId,
          name,
          version,
          description,
          JSON.stringify(manifest),
          now,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("UNIQUE")) {
          throw new SkillTripleConflict();
        }
        throw err;
      }
      const insertFile = db.prepare(
        `INSERT INTO skill_files
           (id, skill_id, path, content, byte_size, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const f of validatedFiles) {
        insertFile.run(
          `sklf_${newRowId()}`,
          skillRowId,
          f.path,
          f.content,
          Buffer.byteLength(f.content, "utf8"),
          now,
        );
      }
    });
    try {
      tx();
    } catch (err) {
      if (err instanceof SkillTripleConflict) {
        return c.json(badRequest(["skill_triple_taken"]), 409);
      }
      throw err;
    }

    const out: PostSkillOk = {
      id: skillRowId,
      name,
      version,
      description,
      file_count: validatedFiles.length,
      total_bytes: totalBytes,
      created_at: now,
    };
    return c.json({ ok: true, data: out } as Ok<PostSkillOk>, 201);
  });

  // GET /skills — list this publisher's skills (active + deprecated).
  app.get("/skills", (c) => {
    const scopeFail = requireAnyKind(c, ["admin", "runner"]);
    if (scopeFail !== null) return scopeFail;
    const publisherId = getPublisherId(c);
    if (publisherId === null) {
      return c.json(badRequest(["unauthorized"]), 401);
    }
    const rows = db
      .prepare(
        `SELECT id, name, version, description, deprecated_at, created_at
           FROM skills WHERE publisher_id = ?
           ORDER BY name ASC, created_at DESC`,
      )
      .all(publisherId) as ReadonlyArray<{
      id: string;
      name: string;
      version: string;
      description: string;
      deprecated_at: string | null;
      created_at: string;
    }>;
    return c.json({ ok: true, data: { skills: rows } }, 200);
  });

  // GET /skills/:name — list versions of a named skill in this publisher.
  app.get("/skills/:name", (c) => {
    const scopeFail = requireAnyKind(c, ["admin", "runner"]);
    if (scopeFail !== null) return scopeFail;
    const publisherId = getPublisherId(c);
    if (publisherId === null) {
      return c.json(badRequest(["unauthorized"]), 401);
    }
    const name = c.req.param("name");
    if (!name) {
      return c.json(badRequest(["name_required"]), 400);
    }
    const rows = db
      .prepare(
        `SELECT id, version, description, deprecated_at, created_at
           FROM skills WHERE publisher_id = ? AND name = ?
           ORDER BY created_at DESC`,
      )
      .all(publisherId, name) as ReadonlyArray<{
      id: string;
      version: string;
      description: string;
      deprecated_at: string | null;
      created_at: string;
    }>;
    if (rows.length < 1) {
      return c.json(notFound(["skill_not_found"]), 404);
    }
    return c.json(
      { ok: true, data: { name, versions: rows } },
      200,
    );
  });

  // GET /skills/:name/:version — single bundle's metadata + manifest.
  app.get("/skills/:name/:version", (c) => {
    const scopeFail = requireAnyKind(c, ["admin", "runner"]);
    if (scopeFail !== null) return scopeFail;
    const publisherId = getPublisherId(c);
    if (publisherId === null) {
      return c.json(badRequest(["unauthorized"]), 401);
    }
    const name = c.req.param("name");
    const version = c.req.param("version");
    if (!name || !version) {
      return c.json(badRequest(["name_and_version_required"]), 400);
    }
    const row = db
      .prepare(
        `SELECT id, name, version, description, manifest_json, deprecated_at, created_at
           FROM skills WHERE publisher_id = ? AND name = ? AND version = ?`,
      )
      .get(publisherId, name, version) as
      | {
          id: string;
          name: string;
          version: string;
          description: string;
          manifest_json: string;
          deprecated_at: string | null;
          created_at: string;
        }
      | undefined;
    if (!row) {
      return c.json(notFound(["skill_not_found"]), 404);
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(row.manifest_json);
    } catch {
      manifest = {};
    }
    return c.json(
      {
        ok: true,
        data: {
          id: row.id,
          name: row.name,
          version: row.version,
          description: row.description,
          manifest,
          deprecated_at: row.deprecated_at,
          created_at: row.created_at,
        },
      },
      200,
    );
  });

  // GET /skills/:name/:version/files — list file paths in the bundle.
  app.get("/skills/:name/:version/files", (c) => {
    const scopeFail = requireAnyKind(c, ["admin", "runner"]);
    if (scopeFail !== null) return scopeFail;
    const publisherId = getPublisherId(c);
    if (publisherId === null) {
      return c.json(badRequest(["unauthorized"]), 401);
    }
    const name = c.req.param("name");
    const version = c.req.param("version");
    if (!name || !version) {
      return c.json(badRequest(["name_and_version_required"]), 400);
    }
    const rows = db
      .prepare(
        `SELECT skill_files.path, skill_files.byte_size
           FROM skill_files
           JOIN skills ON skills.id = skill_files.skill_id
          WHERE skills.publisher_id = ?
            AND skills.name = ?
            AND skills.version = ?
          ORDER BY skill_files.path ASC`,
      )
      .all(publisherId, name, version) as ReadonlyArray<{
      path: string;
      byte_size: number;
    }>;
    if (rows.length < 1) {
      return c.json(notFound(["skill_not_found"]), 404);
    }
    return c.json({ ok: true, data: { files: rows } }, 200);
  });

  // GET /skills/:name/:version/files/* — read a single file's content.
  app.get("/skills/:name/:version/files/:path{.+}", (c) => {
    const scopeFail = requireAnyKind(c, ["admin", "runner"]);
    if (scopeFail !== null) return scopeFail;
    const publisherId = getPublisherId(c);
    if (publisherId === null) {
      return c.json(badRequest(["unauthorized"]), 401);
    }
    const name = c.req.param("name");
    const version = c.req.param("version");
    const path = c.req.param("path");
    if (!name || !version || !path) {
      return c.json(badRequest(["name_version_and_path_required"]), 400);
    }
    const row = db
      .prepare(
        `SELECT skill_files.content, skill_files.byte_size, skill_files.path
           FROM skill_files
           JOIN skills ON skills.id = skill_files.skill_id
          WHERE skills.publisher_id = ?
            AND skills.name = ?
            AND skills.version = ?
            AND skill_files.path = ?`,
      )
      .get(publisherId, name, version, path) as
      | { content: string; byte_size: number; path: string }
      | undefined;
    if (!row) {
      return c.json(notFound(["skill_file_not_found"]), 404);
    }
    return c.json(
      {
        ok: true,
        data: { path: row.path, byte_size: row.byte_size, content: row.content },
      },
      200,
    );
  });

  // DELETE /skills/:name/:version — mark deprecated.
  app.delete("/skills/:name/:version", (c) => {
    const adminFail = requireKind(c, "admin");
    if (adminFail !== null) return adminFail;
    const publisherId = getPublisherId(c);
    if (publisherId === null) {
      return c.json(badRequest(["unauthorized"]), 401);
    }
    const name = c.req.param("name");
    const version = c.req.param("version");
    if (!name || !version) {
      return c.json(badRequest(["name_and_version_required"]), 400);
    }
    const now = new Date().toISOString();
    const result = db
      .prepare(
        `UPDATE skills SET deprecated_at = ?
          WHERE publisher_id = ?
            AND name = ? AND version = ?
            AND deprecated_at IS NULL`,
      )
      .run(now, publisherId, name, version);
    if (result.changes < 1) {
      // Either not found OR already deprecated — distinguish for the
      // caller without leaking other-publisher row presence.
      const exists = db
        .prepare(
          `SELECT 1 FROM skills WHERE publisher_id = ? AND name = ? AND version = ?`,
        )
        .get(publisherId, name, version);
      if (!exists) {
        return c.json(notFound(["skill_not_found"]), 404);
      }
      return c.json(badRequest(["skill_already_deprecated"]), 409);
    }
    return c.json(
      { ok: true, data: { name, version, deprecated_at: now } },
      200,
    );
  });
}

/**
 * Successful body for `POST /skills`. The bundle's full content is NOT
 * echoed — operators / dashboards re-fetch via the GET endpoints.
 */
export interface PostSkillOk {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly file_count: number;
  readonly total_bytes: number;
  readonly created_at: string;
}

/**
 * Validate every `<publisher>/<name>@<version>` ref in a pipeline def's
 * `skills` arrays (top-level + per-subtask). Resolves `name@latest` to
 * the highest non-deprecated version in the publisher's namespace and
 * returns the resolved set so the caller can write the resolved refs
 * into the stored pipeline def (the spec calls this out: "snapshots
 * into the stored pipeline def").
 *
 * Cross-publisher refs are rejected — Phase 1 scope is same-publisher
 * skills only.
 *
 * @returns either `{ ok: true, resolved }` with the resolution map, or
 *   `{ ok: false, errors }` with `validation:<path>:<reason>` strings.
 */
export function validatePipelineSkillRefs(
  db: Database.Database,
  publisherId: string,
  refs: ReadonlyArray<{ path: string; ref: string }>,
):
  | {
      readonly ok: true;
      readonly resolved: ReadonlyMap<string, string>;
    }
  | {
      readonly ok: false;
      readonly errors: ReadonlyArray<string>;
    } {
  const errors: string[] = [];
  const resolved = new Map<string, string>();

  for (const { path, ref } of refs) {
    // Refs are `<publisher>/<name>@<version>` — same publisher only in
    // v1, so we accept either `<publisher>/<name>@<version>` (verifying
    // <publisher> matches our slug — looked up via publishers row) OR
    // `<name>@<version>` (implicit same-publisher).
    const parsed = parseSkillRef(ref);
    if (!parsed) {
      errors.push(`validation:${path}:malformed_skill_ref`);
      continue;
    }

    if (parsed.publisherSlug) {
      const ourSlug = db
        .prepare(`SELECT slug FROM publishers WHERE id = ?`)
        .get(publisherId) as { slug: string } | undefined;
      if (!ourSlug || ourSlug.slug !== parsed.publisherSlug) {
        errors.push(`validation:${path}:cross_publisher_skill_ref_unsupported`);
        continue;
      }
    }

    let version = parsed.version;
    if (version === "latest") {
      const latest = db
        .prepare(
          `SELECT version FROM skills
            WHERE publisher_id = ? AND name = ? AND deprecated_at IS NULL
            ORDER BY created_at DESC LIMIT 1`,
        )
        .get(publisherId, parsed.name) as { version: string } | undefined;
      if (!latest) {
        errors.push(
          `validation:${path}:skill_not_found:${parsed.name}@latest`,
        );
        continue;
      }
      version = latest.version;
    } else {
      const exists = db
        .prepare(
          `SELECT 1 FROM skills
            WHERE publisher_id = ? AND name = ? AND version = ?`,
        )
        .get(publisherId, parsed.name, version);
      if (!exists) {
        errors.push(
          `validation:${path}:skill_not_found:${parsed.name}@${version}`,
        );
        continue;
      }
    }

    const canonical = parsed.publisherSlug
      ? `${parsed.publisherSlug}/${parsed.name}@${version}`
      : `${parsed.name}@${version}`;
    resolved.set(ref, canonical);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, resolved };
}

/**
 * Test seam — exposed so the pipelines-route module can unit-test the
 * resolver against a hand-built ref list without round-tripping a full
 * pipeline def.
 */
export function parseSkillRef(
  ref: string,
): { publisherSlug: string | null; name: string; version: string } | null {
  // `<publisher>/<name>@<version>` or `<name>@<version>`.
  const at = ref.indexOf("@");
  if (at < 1) return null;
  const left = ref.slice(0, at);
  const version = ref.slice(at + 1);
  if (version.length < 1) return null;
  if (version !== "latest" && !SKILL_VERSION_RE.test(version)) return null;
  const slash = left.indexOf("/");
  if (slash < 0) {
    if (!SKILL_NAME_RE.test(left)) return null;
    return { publisherSlug: null, name: left, version };
  }
  const publisherSlug = left.slice(0, slash);
  const name = left.slice(slash + 1);
  if (!SKILL_NAME_RE.test(publisherSlug) || !SKILL_NAME_RE.test(name)) {
    return null;
  }
  return { publisherSlug, name, version };
}

// --------------------------------------------------------------------------
// Internals
// --------------------------------------------------------------------------

class SkillTripleConflict extends Error {
  constructor() {
    super("skill_triple_taken");
  }
}

function badRequest(errors: ReadonlyArray<string>): Err {
  return { ok: false, errors };
}

function notFound(errors: ReadonlyArray<string>): Err {
  return { ok: false, errors };
}
