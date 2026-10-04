// SPDX-License-Identifier: BUSL-1.1
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import {
  DATABASE_ROLES, generateArtifacts, resolveDatabaseRoleNames,
  type DatabaseRoleNames,
} from "./generate.js";
import { collectAllArtifacts, runCompiler } from "./index.js";
import type { GeneratedArtifact, PlatformSchemaManifest } from "./schema.js";

const defaults = Object.fromEntries(DATABASE_ROLES.map(role => [role.key, role.name])) as DatabaseRoleNames;
const secondary: DatabaseRoleNames = {
  app: "secondary_app", worker: "secondary_worker",
  blueprintReader: "secondary_blueprint_reader", identityResolver: "secondary_identity_resolver",
};
const manifest: PlatformSchemaManifest = {
  version: 1,
  tables: [{
    schema: "workflow", name: "role_jobs", tenantScoped: true, workerAccess: "role-test-worker",
    columns: [
      { name: "id", type: "uuid", primaryKey: true },
      { name: "tenant_id", type: "uuid", required: true },
      { name: "title", type: "text", required: true },
    ],
  }],
};
const digest = (artifacts: GeneratedArtifact[]) =>
  createHash("sha256").update(JSON.stringify(artifacts)).digest("hex");
const artifact = (artifacts: GeneratedArtifact[], suffix: string) =>
  artifacts.find(item => item.path.endsWith(suffix))!.contents;
const contract = (artifacts: GeneratedArtifact[]) => JSON.parse(artifact(artifacts, "db/manifest.json"));
const generate = (names?: DatabaseRoleNames) =>
  generateArtifacts(manifest, names === undefined ? {} : { databaseRoleNames: names });
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true }))); });

async function hostRoot() {
  const root = await mkdtemp(join(tmpdir(), "osf-role-names-"));
  roots.push(root);
  await mkdir(join(root, "packages/compiler/config"), { recursive: true });
  await writeFile(join(root, "packages/compiler/config/platform-schema.yaml"), "version: 1\ntables: []\n");
  const authoring = join(root, "role-fixture");
  await mkdir(join(authoring, "entities"), { recursive: true });
  await cp(join(import.meta.dir, "../config/authoring/entities/_base.yaml"), join(authoring, "entities/_base.yaml"));
  // The same real three-entity identity fixture used by index.test.ts: this
  // tests option assembly/write plumbing, not four repeats of the whole corpus.
  const identityFields: Record<string, string[]> = {
    relation: ["displayName", "relationType", "status", "businessContext"],
    "natural-person": ["relationId", "firstName", "lastName"],
    "contact-detail": ["relationId", "type", "value", "isPrimary", "status"],
  };
  for (const [slug, fields] of Object.entries(identityFields)) {
    const source = parse(await readFile(join(import.meta.dir, `../config/authoring/entities/core/${slug}.yaml`), "utf8"));
    const entity = Object.fromEntries(["schemaVersion", "kind", "module", "entity", "title", "description", "language", "authorization", "operations", "interfaces"]
      .map(key => [key, source[key]]));
    entity.interfaces = { ...source.interfaces, web: { operations: source.interfaces.web.operations } };
    entity.fields = source.fields.filter((field: { key: string }) => fields.includes(field.key));
    await writeFile(join(authoring, `entities/${slug}.yaml`), stringify(entity));
  }
  await cp(join(import.meta.dir, "../config/authoring/authorization.yaml"), join(authoring, "authorization.yaml"));
  await cp(join(import.meta.dir, "../config/authoring/catalogs"), join(authoring, "catalogs"), { recursive: true });
  for (const name of ["documents", "core-versioning"]) {
    await mkdir(join(root, name));
    await writeFile(join(root, name, "index.ts"), `export default { name: "${name}" };\n`);
    await writeFile(join(root, name, "runtime.ts"), `export default { name: "${name}", operationHandlers: {} };\n`);
  }
  await writeFile(join(root, "authoring.config.yaml"),
    "layers:\n  - role-fixture\nplugins:\n  - ./documents/index.ts\n  - ./core-versioning/index.ts\n");
  return root;
}

describe("trusted database role names", () => {
  test("absent and explicit defaults retain all original artifact bytes and checksum", () => {
    // Captured from the unmodified generator at main 5a47bd1d, before this option existed.
    expect(digest(generate())).toBe("cf2bc3c34e8598746c943cd5d933bd9637259eeba5d29272a84167bff1f9db6b");
    expect(generate(defaults)).toEqual(generate());
  });

  test("a second host coherently changes the worker SQL and complete role contract", () => {
    const current = generate(secondary);
    expect(artifact(current, "schema.sql")).toContain("current_user = 'secondary_worker'");
    expect(artifact(current, "schema.sql")).not.toContain("current_user = 'openshapeforge_worker'");
    expect(contract(current).workerDatabaseRole).toBe(secondary.worker);
    expect(contract(current).databaseRoles).toEqual(DATABASE_ROLES.map(role => ({ ...role, name: secondary[role.key] })));
    expect(contract(current).checksum).not.toBe(contract(generate()).checksum);
    for (const original of generate()) {
      if (!original.path.endsWith("schema.sql") && !original.path.endsWith("db/manifest.json")) {
        expect(artifact(current, original.path)).toBe(original.contents);
      }
    }
  });

  test("each single role affects checksum, input key order does not, and defaults never mutate", () => {
    const original = generate();
    for (const role of DATABASE_ROLES) {
      const changed = generate({ ...defaults, [role.key]: secondary[role.key] });
      expect(contract(changed).checksum).not.toBe(contract(original).checksum);
      if (role.key !== "worker") expect(artifact(changed, "schema.sql")).toBe(artifact(original, "schema.sql"));
    }
    const reordered = Object.fromEntries(Object.entries(secondary).reverse()) as DatabaseRoleNames;
    expect(generate(reordered)).toEqual(generate(secondary));
    expect(generate()).toEqual(original);
    expect(generate(defaults)).toEqual(original);
  });

  test("snapshots exact names without normalizing or truncating the caller", () => {
    const input = { ...secondary, app: "a".repeat(63) };
    const resolved = resolveDatabaseRoleNames(input);
    input.app = "later_app";
    expect(resolved.app).toBe("a".repeat(63));
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(() => { (resolved as { app: string }).app = "other_app"; }).toThrow();
  });

  test("rejects malformed, aliased and reserved names before emitting SQL", () => {
    const { app: _app, ...missing } = secondary;
    const inherited = Object.create(secondary);
    const invalid: unknown[] = [
      null, [], "roles", missing, inherited,
      { ...secondary, extra: "extra_role" }, { ...secondary, [Symbol("extra")]: "extra_role" },
      { ...secondary, worker: secondary.app },
      ...[undefined, null, 123, [], {}, "", "UPPER", " leading", "trailing ", "a".repeat(64),
        "postgres", "public", "pg_read_all_data", "pg_custom_role", "role'", 'role"', "role;sql", "role--", "role/*", "role\\name"]
        .map(app => ({ ...secondary, app })),
    ];
    for (const input of invalid) {
      expect(() => generate(input as DatabaseRoleNames)).toThrow("databaseRoleNames requires");
    }
  });

  test("collector snapshots before async work and runCompiler writes the same custom contract", async () => {
    const root = await hostRoot();
    const input = { ...secondary };
    const pending = collectAllArtifacts(root, { databaseRoleNames: input });
    Object.assign(input, defaults);
    const custom = await pending;
    expect(contract(custom.groups.db).workerDatabaseRole).toBe(secondary.worker);
    expect(contract(custom.groups.db).databaseRoles.map((role: { name: string }) => role.name))
      .toEqual(DATABASE_ROLES.map(role => secondary[role.key]));
    const normal = await collectAllArtifacts(root);
    const explicit = await collectAllArtifacts(root, { databaseRoleNames: defaults });
    expect(explicit.all).toEqual(normal.all);
    await runCompiler({ repoRoot: root, databaseRoleNames: secondary });
    for (const output of custom.all) expect(await readFile(join(root, output.path), "utf8")).toBe(output.contents);
  }, 30_000);

  test("invalid collector input refuses before plugins or artifact writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "osf-role-invalid-"));
    roots.push(root);
    const target = join(root, "apps/api/src/generated/db/manifest.json");
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, "untouched");
    await expect(runCompiler({ repoRoot: root, databaseRoleNames: { ...secondary, app: "postgres" } }))
      .rejects.toThrow("non-reserved SQL identifiers");
    expect(await readFile(target, "utf8")).toBe("untouched");
    await expect(readFile(join(root, "apps/api/src/generated/db/schema.sql")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});
