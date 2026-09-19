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

  // The contract: no create, no delete, and no role that could grant either.
  expect(tenants.source?.crud?.operations).toEqual({ list: true, get: true, create: false, update: true, delete: false });
  expect(tenants.source?.graphql?.operations).toMatchObject({ create: false, delete: false });
  expect(tenants.source?.authorization?.roles).toMatchObject({ create: [], delete: [] });

  // Database: the registry mark, and the restrictive policies emitted beside it.
  const manifest = JSON.parse(artifacts.groups.db.find(artifact => artifact.path.endsWith("manifest.json"))!.contents);
  const runtimeTable = manifest.tables.find((table: { name: string }) => table.name === "erp.tenants");
  expect(runtimeTable.source.crud.operations).toMatchObject({ create: false, delete: false });
  expect(runtimeTable.constraints).toContainEqual(expect.objectContaining({ expression: "id = tenant_id" }));
  const schema = artifacts.groups.db.find(artifact => artifact.path.endsWith("schema.sql"))!.contents;
  expect(schema).toContain('CREATE POLICY "tenants_registry_insert" ON "erp"."tenants"\n  AS RESTRICTIVE FOR INSERT\n  WITH CHECK (app.bypass_rls());');
  expect(schema).toContain('CREATE POLICY "tenants_registry_delete" ON "erp"."tenants"\n  AS RESTRICTIVE FOR DELETE\n  USING (app.bypass_rls());');

  // MCP: the tool catalog carries one entry per entity operation
  // (osf_create/osf_get/... with an `entity`); Tenant contributes none at
  // all — it has no mcp: block — so there is no create or delete to find.
  const tools = JSON.parse(artifacts.groups.mcp.find(artifact => artifact.path.endsWith("tools.json"))!.contents);
  expect((tools.entities as Array<{ entity: string }>).some(entry => entry.entity === "Tenant")).toBe(false);
  const entityTools = (tools.tools as Array<{ name: string; entity?: string; operation?: string }>)
    .filter(tool => tool.entity === "Tenant");
  expect(entityTools).toEqual([]);
  expect((tools.tools as Array<{ entity?: string; operation?: string }>)
    .some(tool => tool.entity === "Tenant" && ["create", "delete"].includes(tool.operation ?? ""))).toBe(false);

  // REST: Tenant has no REST projection (no rest: block, and aab4e7b0 keeps
  // it off tenant REST); the only /tenants paths are the control plane's
  // provisioning routes, none of them a tenant-scoped POST or DELETE on the
  // registry row.
  const openapi = JSON.parse(artifacts.groups.db.find(artifact => artifact.path.endsWith("openapi.json"))!.contents);
  const tenantPaths = Object.keys(openapi.paths).filter(path => /\/tenants(\/|$)/.test(path));
  expect(tenantPaths.length).toBeGreaterThan(0);
  expect(tenantPaths.every(path => path.startsWith("/api/control/"))).toBe(true);
  expect(Object.keys(openapi.paths).some(path => path.startsWith("/api/rest/") && /tenants/.test(path))).toBe(false);
  expect(JSON.stringify(openapi)).not.toMatch(/"operationId":"(create|delete)Tenant"/);

  // Web: no page or action shard for the entity, no page configs, and the
  // entity manifest grants no create or delete role.
  expect(artifacts.groups.ui.some(artifact => /\/tenant\.tsx?$|\/tenant\//.test(artifact.path))).toBe(false);
  const pageConfigs = JSON.parse(artifacts.groups.ui.find(artifact => artifact.path.endsWith("entity-page-configs.seed.json"))!.contents);
  expect(pageConfigs.rows.filter((row: { entitySlug: string }) => row.entitySlug === "tenant")).toEqual([]);
  const webManifest = artifacts.groups.ui.find(artifact => artifact.path.endsWith("compiler/entity-manifest.ts"))!.contents;
  const webEntry = webManifest.match(/"tenant": \{[\s\S]*?\n  \}/)![0];
  expect(webEntry).toContain('"create": []');
  expect(webEntry).toContain('"delete": []');
  expect(webEntry).toContain('"update": [\n        "Organization.All.ReadWrite"\n      ]');
}, 30_000);
