// SPDX-License-Identifier: BUSL-1.1
/**
 * An authored index may carry a `where` predicate on one field: the index is
 * partial, so a unique one enforces at most one matching row per key.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileAuthoringBackendManifest } from "./backend-manifest.js";
import { generateArtifacts } from "../generate.js";
import type { AuthoredEntityIndex, CoreEntity } from "./types.js";

function compileWith(index: AuthoredEntityIndex) {
  const entity = {
    schemaVersion: 3, kind: "coreEntity", module: "core", entity: "Slot", title: "Slot", labels: { en: "Slot", nl: "Slot" },
    language: "en", domains: ["example"], baseEntity: false,
    authorization: { roles: { read: ["Example.Read"], create: ["Example.Create"], update: ["Example.Update"] } },
    indexes: [index],
    fields: [
      { key: "id", osfType: "string", required: true, validation: { format: "uuid" }, persisted: { column: "id", storageClass: "core" } },
      { key: "channel", osfType: "string", required: true, persisted: { column: "channel", storageClass: "core" } },
      { key: "isDefault", osfType: "boolean", required: true, defaultValue: false, persisted: { column: "is_default", storageClass: "core" } },
    ],
    operations: Object.fromEntries(["list", "get"].map((action) => [action, {
      name: action, description: action, implementation: { type: "entity", action },
      effects: { data: "read", external: "none" }, reliability: { idempotency: { mode: "natural" } }, confirmation: { mode: "none" },
    }])),
    interfaces: { rest: {}, graphql: {}, mcp: { tools: "generic" } },
  } as CoreEntity;
  const dir = mkdtempSync(join(tmpdir(), "partial-index-"));
  try {
    mkdirSync(join(dir, "entities")); mkdirSync(join(dir, "catalogs"));
    for (const [file, value] of Object.entries({ "catalogs/components.yaml": { defaults: {}, components: {}, viewDefaults: {} }, "catalogs/transforms.yaml": { transforms: {} }, "catalogs/osf-types.yaml": { types: {} }, "entities/slot.yaml": entity })) {
      writeFileSync(join(dir, file), JSON.stringify(value));
    }
    return compileAuthoringBackendManifest(dir, { mode: "promote", entityAllowlist: ["slot"], generatedCrudAllowlist: ["slot"] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("a where predicate makes the authored unique index partial", () => {
  const manifest = compileWith({ name: "slots_tenant_channel_default_uidx", fields: ["tenantId", "channel"], unique: true, where: { field: "isDefault", equals: true } });
  const table = manifest.tables.find((table) => table.source?.authoringEntityName === "Slot")!;
  expect(table.indexes).toContainEqual({ name: "slots_tenant_channel_default_uidx", columns: ["tenant_id", "channel"], unique: true, where: '"is_default" = true' });
  const sql = generateArtifacts(manifest).find((artifact) => artifact.path.endsWith("schema.sql"))!.contents;
  expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "slots_tenant_channel_default_uidx" ON "erp"."slots" ("tenant_id", "channel") WHERE "is_default" = true;');
});

test("the predicate must name a field of the entity with a value of its type", () => {
  expect(() => compileWith({ name: "slots_bad_uidx", fields: ["channel"], unique: true, where: { field: "missing", equals: true } })).toThrow('predicate references unknown field "missing"');
  expect(() => compileWith({ name: "slots_bad_uidx", fields: ["channel"], unique: true, where: { field: "isDefault", equals: "yes" } })).toThrow('predicate value must be a boolean for field "isDefault"');
});
