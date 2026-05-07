/**
 * Skill registry tests (M5 Phase A, issue #85).
 */

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { seedDemoPublisher } from "../../db/bootstrap.js";
import { runMigrations } from "../../db/migrate.js";
import { createServer } from "../../server.js";

import {
  parseSkillRef,
  validatePipelineSkillRefs,
} from "./skills.js";

const TEST_TOKEN = "test-skills-bearer";
const TEST_TOKEN_BUF = Buffer.from(TEST_TOKEN, "utf8");
const ADMIN_HEADERS = {
  Authorization: `Bearer ${TEST_TOKEN}`,
  "Content-Type": "application/json",
};

function freshServer(): {
  db: Database.Database;
  app: ReturnType<typeof createServer>;
} {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  seedDemoPublisher(db, { MURMUR_TOKEN: TEST_TOKEN });
  const app = createServer({ token: TEST_TOKEN_BUF, db });
  return { db, app };
}

const VALID_BUNDLE = {
  name: "add-company",
  version: "1.0.0",
  description: "Procedural guide for the add-company pipeline.",
  manifest: {
    loadable_by: ["jobseek-add-company"],
    loads_on: [{ subtask: "pre-verify" }],
    on_demand: true,
  },
  files: [
    {
      path: "SKILL.md",
      content: `---
name: add-company
version: 1.0.0
description: Procedural guide
---
# add-company

Walks the agent through pre-verifying a company.`,
    },
    {
      path: "duplicates.md",
      content: "# Detecting duplicate companies\n\nRules of thumb...",
    },
  ],
};

describe("POST /skills — happy path", () => {
  it("creates a skill with file rows + manifest, returns 201", async () => {
    const { app, db } = freshServer();
    const r = await app.request("/skills", {
      method: "POST",
      headers: ADMIN_HEADERS,
      body: JSON.stringify(VALID_BUNDLE),
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as {
      ok: boolean;
      data: { id: string; name: string; file_count: number };
    };
    expect(body.ok).toBe(true);
    expect(body.data.id.startsWith("skl_")).toBe(true);
    expect(body.data.name).toBe("add-company");
    expect(body.data.file_count).toBe(2);

    // DB rows.
    const skill = db
      .prepare(`SELECT id, manifest_json FROM skills WHERE name = ?`)
      .get("add-company") as { id: string; manifest_json: string };
    expect(skill).toBeDefined();
    const fileRows = db
      .prepare(`SELECT path, byte_size FROM skill_files WHERE skill_id = ?`)
      .all(skill.id) as Array<{ path: string; byte_size: number }>;
    expect(fileRows.map((f) => f.path).sort()).toEqual([
      "SKILL.md",
      "duplicates.md",
    ]);
  });
});

describe("POST /skills — validation", () => {
  it("rejects missing SKILL.md with 400", async () => {
    const { app } = freshServer();
    const bundle = {
      ...VALID_BUNDLE,
      files: [
        { path: "duplicates.md", content: "no skill.md here" },
      ],
    };
    const r = await app.request("/skills", {
      method: "POST",
      headers: ADMIN_HEADERS,
      body: JSON.stringify(bundle),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { errors: string[] };
    expect(body.errors).toContain("files must contain SKILL.md");
  });

  it("rejects malformed name with 400", async () => {
    const { app } = freshServer();
    const r = await app.request("/skills", {
      method: "POST",
      headers: ADMIN_HEADERS,
      body: JSON.stringify({ ...VALID_BUNDLE, name: "Bad Name!" }),
    });
    expect(r.status).toBe(400);
  });

  it("rejects path-traversal in file paths", async () => {
    const { app } = freshServer();
    const r = await app.request("/skills", {
      method: "POST",
      headers: ADMIN_HEADERS,
      body: JSON.stringify({
        ...VALID_BUNDLE,
        files: [
          ...VALID_BUNDLE.files,
          { path: "../escape.md", content: "evil" },
        ],
      }),
    });
    expect(r.status).toBe(400);
  });

  it("rejects re-upload of same name@version with 409", async () => {
    const { app } = freshServer();
    const r1 = await app.request("/skills", {
      method: "POST",
      headers: ADMIN_HEADERS,
      body: JSON.stringify(VALID_BUNDLE),
    });
    expect(r1.status).toBe(201);
    const r2 = await app.request("/skills", {
      method: "POST",
      headers: ADMIN_HEADERS,
      body: JSON.stringify(VALID_BUNDLE),
    });
    expect(r2.status).toBe(409);
    const body = (await r2.json()) as { errors: string[] };
    expect(body.errors).toContain("skill_triple_taken");
  });

  it("returns 401 without admin scope", async () => {
    const { app } = freshServer();
    const r = await app.request("/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_BUNDLE),
    });
    expect(r.status).toBe(401);
  });

  it("returns 413 on a file exceeding the per-file cap", async () => {
    const { app } = freshServer();
    const big = "x".repeat(300 * 1024);
    const r = await app.request("/skills", {
      method: "POST",
      headers: ADMIN_HEADERS,
      body: JSON.stringify({
        ...VALID_BUNDLE,
        files: [
          ...VALID_BUNDLE.files,
          { path: "big.md", content: big },
        ],
      }),
    });
    expect(r.status).toBe(413);
  });
});

describe("GET /skills + /skills/:name + /skills/:name/:version", () => {
  it("lists publisher's skills with deprecated_at flag", async () => {
    const { app } = freshServer();
    await app.request("/skills", {
      method: "POST",
      headers: ADMIN_HEADERS,
      body: JSON.stringify(VALID_BUNDLE),
    });
    await app.request("/skills", {
      method: "POST",
      headers: ADMIN_HEADERS,
      body: JSON.stringify({ ...VALID_BUNDLE, version: "1.1.0" }),
    });
    const r = await app.request("/skills", { headers: ADMIN_HEADERS });
    const body = (await r.json()) as {
      data: { skills: Array<{ name: string; version: string }> };
    };
    expect(body.data.skills).toHaveLength(2);
  });

  it("lists versions of a named skill", async () => {
    const { app } = freshServer();
    await app.request("/skills", {
      method: "POST",
      headers: ADMIN_HEADERS,
      body: JSON.stringify(VALID_BUNDLE),
    });
    await app.request("/skills", {
      method: "POST",
      headers: ADMIN_HEADERS,
      body: JSON.stringify({ ...VALID_BUNDLE, version: "1.1.0" }),
    });
    const r = await app.request("/skills/add-company", {
      headers: ADMIN_HEADERS,
    });
    const body = (await r.json()) as {
      data: { name: string; versions: Array<{ version: string }> };
    };
    expect(body.data.versions.map((v) => v.version).sort()).toEqual([
      "1.0.0",
      "1.1.0",
    ]);
  });

  it("returns 404 for an unknown skill name", async () => {
    const { app } = freshServer();
    const r = await app.request("/skills/no-such-skill", {
      headers: ADMIN_HEADERS,
    });
    expect(r.status).toBe(404);
  });

  it("returns single bundle metadata + parsed manifest", async () => {
    const { app } = freshServer();
    await app.request("/skills", {
      method: "POST",
      headers: ADMIN_HEADERS,
      body: JSON.stringify(VALID_BUNDLE),
    });
    const r = await app.request("/skills/add-company/1.0.0", {
      headers: ADMIN_HEADERS,
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      data: { manifest: { on_demand: boolean } };
    };
    expect(body.data.manifest.on_demand).toBe(true);
  });

  it("lists files of a bundle", async () => {
    const { app } = freshServer();
    await app.request("/skills", {
      method: "POST",
      headers: ADMIN_HEADERS,
      body: JSON.stringify(VALID_BUNDLE),
    });
    const r = await app.request("/skills/add-company/1.0.0/files", {
      headers: ADMIN_HEADERS,
    });
    const body = (await r.json()) as {
      data: { files: Array<{ path: string }> };
    };
    expect(body.data.files.map((f) => f.path).sort()).toEqual([
      "SKILL.md",
      "duplicates.md",
    ]);
  });

  it("reads a file's content", async () => {
    const { app } = freshServer();
    await app.request("/skills", {
      method: "POST",
      headers: ADMIN_HEADERS,
      body: JSON.stringify(VALID_BUNDLE),
    });
    const r = await app.request(
      "/skills/add-company/1.0.0/files/SKILL.md",
      { headers: ADMIN_HEADERS },
    );
    const body = (await r.json()) as {
      data: { path: string; content: string };
    };
    expect(body.data.path).toBe("SKILL.md");
    expect(body.data.content.startsWith("---")).toBe(true);
  });

  it("returns 404 for an unknown file in a known bundle", async () => {
    const { app } = freshServer();
    await app.request("/skills", {
      method: "POST",
      headers: ADMIN_HEADERS,
      body: JSON.stringify(VALID_BUNDLE),
    });
    const r = await app.request(
      "/skills/add-company/1.0.0/files/nope.md",
      { headers: ADMIN_HEADERS },
    );
    expect(r.status).toBe(404);
  });
});

describe("DELETE /skills/:name/:version", () => {
  it("marks deprecated_at + returns 200", async () => {
    const { app, db } = freshServer();
    await app.request("/skills", {
      method: "POST",
      headers: ADMIN_HEADERS,
      body: JSON.stringify(VALID_BUNDLE),
    });
    const r = await app.request("/skills/add-company/1.0.0", {
      method: "DELETE",
      headers: ADMIN_HEADERS,
    });
    expect(r.status).toBe(200);
    const row = db
      .prepare(
        `SELECT deprecated_at FROM skills WHERE name = ? AND version = ?`,
      )
      .get("add-company", "1.0.0") as { deprecated_at: string | null };
    expect(row.deprecated_at).not.toBeNull();
  });

  it("returns 404 for unknown skill", async () => {
    const { app } = freshServer();
    const r = await app.request("/skills/no-such/1.0.0", {
      method: "DELETE",
      headers: ADMIN_HEADERS,
    });
    expect(r.status).toBe(404);
  });

  it("returns 409 for already-deprecated", async () => {
    const { app } = freshServer();
    await app.request("/skills", {
      method: "POST",
      headers: ADMIN_HEADERS,
      body: JSON.stringify(VALID_BUNDLE),
    });
    await app.request("/skills/add-company/1.0.0", {
      method: "DELETE",
      headers: ADMIN_HEADERS,
    });
    const r2 = await app.request("/skills/add-company/1.0.0", {
      method: "DELETE",
      headers: ADMIN_HEADERS,
    });
    expect(r2.status).toBe(409);
  });
});

describe("Cross-publisher isolation", () => {
  it("a publisher cannot see another publisher's skills", async () => {
    const { app, db } = freshServer();
    // Bootstrap a second publisher manually + give them a token.
    const otherTokenHash = (
      await import("../../auth/tokens.js")
    ).hashToken("other-token");
    db.prepare(
      `INSERT INTO publishers (id, slug, display_name, created_at, updated_at)
       VALUES ('pub_other', 'other', 'Other', '2026-05-07T00:00:00.000Z', '2026-05-07T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO publisher_tokens
         (id, publisher_id, kinds_json, secret_hash, prefix, source, created_at)
       VALUES ('tok_other', 'pub_other', '["admin"]', ?, 'PFX', 'api', '2026-05-07T00:00:00.000Z')`,
    ).run(otherTokenHash);

    // Demo publisher uploads a skill.
    await app.request("/skills", {
      method: "POST",
      headers: ADMIN_HEADERS,
      body: JSON.stringify(VALID_BUNDLE),
    });

    // 'other' publisher's GET /skills returns empty.
    const r = await app.request("/skills", {
      headers: { Authorization: "Bearer other-token" },
    });
    const body = (await r.json()) as { data: { skills: unknown[] } };
    expect(body.data.skills).toEqual([]);

    // 'other' GET on demo's skill name → 404.
    const r2 = await app.request("/skills/add-company/1.0.0", {
      headers: { Authorization: "Bearer other-token" },
    });
    expect(r2.status).toBe(404);
  });
});

describe("parseSkillRef", () => {
  it("parses bare name@version", () => {
    expect(parseSkillRef("add-company@1.0.0")).toEqual({
      publisherSlug: null,
      name: "add-company",
      version: "1.0.0",
    });
  });

  it("parses publisher-qualified ref", () => {
    expect(parseSkillRef("jobseek/add-company@1.0.0")).toEqual({
      publisherSlug: "jobseek",
      name: "add-company",
      version: "1.0.0",
    });
  });

  it("accepts @latest", () => {
    expect(parseSkillRef("add-company@latest")).toEqual({
      publisherSlug: null,
      name: "add-company",
      version: "latest",
    });
  });

  it("rejects malformed refs", () => {
    expect(parseSkillRef("no-version")).toBeNull();
    expect(parseSkillRef("@no-name")).toBeNull();
    expect(parseSkillRef("Bad Name@1.0.0")).toBeNull();
    expect(parseSkillRef("name@bad version")).toBeNull();
  });
});

describe("validatePipelineSkillRefs", () => {
  it("returns ok when every ref resolves", async () => {
    const { db } = freshServer();
    db.prepare(
      `INSERT INTO skills (id, publisher_id, name, version, description, manifest_json, created_at)
       VALUES ('skl_1', 'pub_demo_seed', 'add-company', '1.0.0', 'd', '{}', '2026-05-07T00:00:00.000Z')`,
    ).run();
    const result = validatePipelineSkillRefs(db, "pub_demo_seed", [
      { path: "/skills/0", ref: "add-company@1.0.0" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.get("add-company@1.0.0")).toBe(
      "add-company@1.0.0",
    );
  });

  it("resolves @latest to the most-recent non-deprecated version", async () => {
    const { db } = freshServer();
    db.prepare(
      `INSERT INTO skills (id, publisher_id, name, version, description, manifest_json, created_at)
       VALUES ('skl_a', 'pub_demo_seed', 'sk', '1.0.0', 'd', '{}', '2026-05-07T01:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO skills (id, publisher_id, name, version, description, manifest_json, created_at)
       VALUES ('skl_b', 'pub_demo_seed', 'sk', '1.1.0', 'd', '{}', '2026-05-07T02:00:00.000Z')`,
    ).run();
    const result = validatePipelineSkillRefs(db, "pub_demo_seed", [
      { path: "/skills/0", ref: "sk@latest" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.get("sk@latest")).toBe("sk@1.1.0");
  });

  it("rejects a ref to a non-existent version", async () => {
    const { db } = freshServer();
    const result = validatePipelineSkillRefs(db, "pub_demo_seed", [
      { path: "/skills/0", ref: "ghost@1.0.0" },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain("skill_not_found");
  });

  it("rejects a cross-publisher ref", async () => {
    const { db } = freshServer();
    const result = validatePipelineSkillRefs(db, "pub_demo_seed", [
      { path: "/skills/0", ref: "other-pub/sk@1.0.0" },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain("cross_publisher_skill_ref_unsupported");
  });
});
