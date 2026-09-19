// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadActivePlatformCompile } from "../active-manifest.js";
import { collectAllArtifacts } from "../index.js";

test("platform tenancy and authored tenant references keep distinct storage contracts", async () => {
  const active = await loadActivePlatformCompile(join(import.meta.dir, "../../../.."));
  const sql = (await collectAllArtifacts(join(import.meta.dir, "../../../.."))).groups.db
    .find(artifact => artifact.path.endsWith("schema.sql"))!.contents;
  const labelRules = active.manifest.tables.find(table => table.schema === "erp" && table.name === "label_rules")!;
  const labelTenant = labelRules.columns.find(column => column.name === "tenant_id")!;
  expect(labelTenant).toMatchObject({ type: "uuid", required: true });
  expect(labelTenant.references).toBeUndefined();
  expect(labelRules.columns.filter(column => column.name === "tenant_id")).toHaveLength(1);
  expect(sql).not.toContain('label_rules_tenant_id_fkey');
  expect(active.entities.find(entity => entity.contract.storage.table === "label_rules")!
    .contract.model.fields.find(field => field.key === "tenantId")).toBeUndefined();

  const tenantSettings = active.manifest.tables.find(table => table.schema === "erp" && table.name === "tenant_settings")!;
  const authoredTenant = tenantSettings.columns.find(column => column.name === "tenant_id")!;
  expect(authoredTenant.required).toBe(true);
  expect(authoredTenant.references).toEqual({ schema: "erp", table: "tenants", column: "id" });
  expect(tenantSettings.columns.filter(column => column.name === "tenant_id")).toHaveLength(1);
  expect(tenantSettings.indexes!.some(index => index.columns.length === 1 && index.columns[0] === "tenant_id")).toBe(true);
  expect(tenantSettings.indexes!.every(index => new Set(index.columns).size === index.columns.length)).toBe(true);
  expect(sql).toContain('ADD CONSTRAINT "tenant_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id")\n      REFERENCES "erp"."tenants"("id")');
  // The single-column key is bound because the registry proves its rows ARE
  // their tenant; the compiler stamps that check on erp.tenants.
  const tenants = active.manifest.tables.find(table => table.schema === "erp" && table.name === "tenants")!;
  expect(tenants.constraints).toContainEqual(expect.objectContaining({
    compilerOwned: true, name: "tenants_tenant_identity_check", kind: "check", expression: "id = tenant_id",
  }));
  expect(sql).toContain('CREATE TABLE IF NOT EXISTS "erp"."tenants" (\n  "id" uuid PRIMARY KEY NOT NULL DEFAULT app.current_tenant(),');
  expect(active.entities.find(entity => entity.contract.storage.table === "tenant_settings")!
    .contract.model.fields.find(field => field.key === "tenantId"))
    .toMatchObject({ osfType: "Tenant", readOnly: true, required: false });

  expect(sql).not.toContain('FOREIGN KEY ("tenant_id", "tenant_id")');
  expect(active.manifest.tables.filter(table => table.name === "tenants").map(table => table.schema).sort()).toEqual(["erp", "platform"]);
  const owner = active.entities.find(entity => entity.contract.entity.name === "Tenant")!.contract;
  expect(owner.model.relationships.find(relationship => relationship.key === "tenantSettings")).toMatchObject({ target: "TenantSetting", kind: "hasMany", inverse: "tenantId", ownership: "reference", foreignKey: "tenant_id" });
}, 30_000);

test("the Tenant registry row is provisioned, never created or deleted through a generated surface", async () => {
  const root = join(import.meta.dir, "../../../..");
  const active = await loadActivePlatformCompile(root);
  const artifacts = await collectAllArtifacts(root);
  const tenants = active.manifest.tables.find(table => table.schema === "erp" && table.name === "tenants")!;

  // The contract itself: no create, no delete, and no role that could grant either.
  expect(tenants.source?.crud?.operations).toEqual({ list: true, get: true, create: false, update: true, delete: false });
  expect(tenants.source?.graphql?.operations).toMatchObject({ create: false, delete: false });
  expect(tenants.source?.authorization?.roles).toMatchObject({ create: [], delete: [] });

  // GraphQL, MCP and REST all gate an entity's operations on those flags
  // (graphql/generated-entity-schema.ts, mcp/generated-mcp-server.ts,
  // rest/generated-rest-routes.ts); the runtime manifest carries them.
  const manifest = JSON.parse(artifacts.groups.db.find(artifact => artifact.path.endsWith("manifest.json"))!.contents);
  const runtimeTable = manifest.tables.find((table: { name: string }) => table.name === "erp.tenants");
  expect(runtimeTable.source.crud.operations).toMatchObject({ create: false, delete: false });
  expect(runtimeTable.constraints).toContainEqual(expect.objectContaining({ expression: "id = tenant_id" }));
  const openapi = artifacts.groups.db.find(artifact => artifact.path.endsWith("openapi.json"))!.contents;
  expect(openapi).not.toMatch(/"operationId": "(create|delete)Tenant"/);

  // Web: no generated page or action shard, and no role list that would light a create or delete control.
  expect(artifacts.groups.ui.some(artifact => /\/(tenant)\.tsx?$|\/tenant\//.test(artifact.path))).toBe(false);
  const webManifest = artifacts.groups.ui.find(artifact => artifact.path.endsWith("compiler/entity-manifest.ts"))!.contents;
  expect(webManifest).toContain('"tenant": {\n    "slug": "tenant",\n    "entity": "Tenant",\n    "required": {\n      "read": [\n        "Organization.All.Read",\n        "Organization.All.ReadWrite"\n      ],\n      "create": [],');
}, 30_000);
