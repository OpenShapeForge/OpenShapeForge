// SPDX-License-Identifier: BUSL-1.1
/**
 * `authorization.ownerAxis`: one table owned through several references
 * lowers to a restrictive read policy whose role names are the owner
 * entities' own `authorization.roles.read`, so a host renaming a role renames
 * the policy and no migration restates a role name.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileAuthoringBackendManifest } from "./backend-manifest.js";
import { generateArtifacts } from "../generate.js";
import type { CoreEntity, Field } from "./types.js";

function entity(name: string, fields: Field[], read: string[], authorization: Record<string, unknown> = {}): CoreEntity {
  return {
    schemaVersion: 3, kind: "coreEntity", module: "core", entity: name, title: name, labels: { en: name, nl: name },
    language: "en", domains: ["example"], baseEntity: false,
    authorization: { roles: { read, create: ["Example.Create"], update: ["Example.Update"] }, ...authorization },
    fields: [
      { key: "id", osfType: "string", required: true, validation: { format: "uuid" }, persisted: { column: "id", storageClass: "core" } },
      { key: "updatedAt", osfType: "datetime", readOnly: true, required: true, persisted: { column: "updated_at", storageClass: "core" } },
      ...fields,
    ],
    operations: Object.fromEntries(["list", "get", "create", "update"].map((action) => [action, {
      name: action, description: action, implementation: { type: "entity", action },
      effects: { data: ["get", "list"].includes(action) ? "read" : "write", external: "none" },
      reliability: { idempotency: { mode: ["get", "list"].includes(action) ? "natural" : "none" } },
      confirmation: { mode: "none" }, ...(action === "update" ? { concurrency: { version: { mode: "required", field: "updatedAt" } } } : {}),
    }])),
    interfaces: { rest: {}, graphql: {}, mcp: { tools: "generic" } },
  } as CoreEntity;
}
const owner = (key: string, target: string, ownership: "owned" | "reference" = "owned"): Field =>
  ({ key, osfType: target, required: false, relationship: { inverse: { key: "items", ownership } } });

function compileManifest(mutate: (entities: Record<string, CoreEntity>) => void = () => {}) {
  const entities: Record<string, CoreEntity> = {
    left: entity("Left", [], ["Left.Read", "Shared.Read"]),
    right: entity("Right", [], ["Right.Read"]),
    item: entity("Item", [owner("left", "Left"), owner("right", "Right")], ["Left.Read", "Shared.Read", "Right.Read"], {
      ownerAxis: { fields: ["left", "right"], command: { setting: "app.item_command", values: ["reseed"] } },
    }),
  };
  mutate(entities);
  const dir = mkdtempSync(join(tmpdir(), "owner-axis-"));
  try {
    mkdirSync(join(dir, "entities")); mkdirSync(join(dir, "catalogs"));
    for (const [file, value] of Object.entries({ "catalogs/components.yaml": { defaults: {}, components: {}, viewDefaults: {} }, "catalogs/transforms.yaml": { transforms: {} }, "catalogs/osf-types.yaml": { types: {} },
      ...Object.fromEntries(Object.entries(entities).map(([slug, value]) => [`entities/${slug}.yaml`, value])) })) {
      writeFileSync(join(dir, file), JSON.stringify(value));
    }
    const slugs = Object.keys(entities);
    return compileAuthoringBackendManifest(dir, { mode: "promote", entityAllowlist: slugs, generatedCrudAllowlist: slugs });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("each owning reference lends its owner entity's read roles, and the policy is rendered from the manifest", () => {
  const manifest = compileManifest();
  const item = manifest.tables.find((table) => table.source?.authoringEntityName === "Item")!;
  expect(item.ownerAxis).toEqual({
    axes: [{ column: "left_id", roles: ["Left.Read", "Shared.Read"] }, { column: "right_id", roles: ["Right.Read"] }],
    command: { setting: "app.item_command", values: ["reseed"] },
  });
  // Exactly one owner per row, as a compiler-owned check beside the policy (columns sorted, so an
  // identical check another lowering already emitted is not repeated).
  expect(item.constraints).toContainEqual({ compilerOwned: true, version: "0001_owner-axis-items", name: "items_owner_axis_check", kind: "check", expression: 'num_nonnulls("left_id", "right_id") = 1' });
  const sql = generateArtifacts(manifest).find((artifact) => artifact.path.endsWith("schema.sql"))!.contents;
  expect(sql).toContain(`CREATE POLICY "items_owner_read" ON "erp"."items" AS RESTRICTIVE FOR SELECT
  USING (app.bypass_rls() OR nullif(current_setting('app.item_command', true), '') IN ('reseed') OR ("left_id" IS NOT NULL AND app.has_any_role(ARRAY['Left.Read', 'Shared.Read'])) OR ("right_id" IS NOT NULL AND app.has_any_role(ARRAY['Right.Read'])));`);
});

test("renaming an owner's read role renames the policy", () => {
  const manifest = compileManifest((entities) => { entities.right!.authorization!.roles.read = ["Right.Renamed"]; });
  const item = manifest.tables.find((table) => table.source?.authoringEntityName === "Item")!;
  expect(item.ownerAxis!.axes[1]).toEqual({ column: "right_id", roles: ["Right.Renamed"] });
});

test("refuses a reference that does not own, and a required one", () => {
  expect(() => compileManifest((entities) => { entities.item!.fields.find((field) => field.key === "right")!.relationship = { inverse: { key: "items", ownership: "reference" } }; }))
    .toThrow('Item: authorization.ownerAxis.fields "right" must be an owning reference');
  expect(() => compileManifest((entities) => { entities.item!.fields.find((field) => field.key === "right")!.required = true; }))
    .toThrow('authorization.ownerAxis.fields "right" must be an optional single entity reference');
});
