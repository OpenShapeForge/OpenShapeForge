// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadActivePlatformCompile } from "../active-manifest.js";
import { generateArtifacts } from "../generate.js";

test("platform tenancy and authored tenant references keep distinct storage contracts", async () => {
  const active = await loadActivePlatformCompile(join(import.meta.dir, "../../../.."));
  const sql = generateArtifacts(active.manifest).find(artifact => artifact.path.endsWith("schema.sql"))!.contents;
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
  expect(authoredTenant.required).not.toBe(true);
  expect(authoredTenant.references).toEqual({ schema: "erp", table: "tenants", column: "id" });
  expect(tenantSettings.columns.filter(column => column.name === "tenant_id")).toHaveLength(1);
  expect(tenantSettings.indexes!.some(index => index.columns.length === 1 && index.columns[0] === "tenant_id")).toBe(true);
  expect(tenantSettings.indexes!.every(index => new Set(index.columns).size === index.columns.length)).toBe(true);
  expect(sql).toContain('ADD CONSTRAINT "tenant_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id")\n      REFERENCES "erp"."tenants"("id")');
  expect(active.entities.find(entity => entity.contract.storage.table === "tenant_settings")!
    .contract.model.fields.find(field => field.key === "tenantId"))
    .toMatchObject({ semanticType: "Tenant", readOnly: true, required: false });

  expect(sql).not.toContain('FOREIGN KEY ("tenant_id", "tenant_id")');
  expect(active.manifest.tables.filter(table => table.name === "tenants").map(table => table.schema).sort()).toEqual(["erp", "platform"]);
  const owner = active.entities.find(entity => entity.contract.entity.name === "Tenant")!.contract;
  expect(owner.model.relationships.find(relationship => relationship.key === "tenantSettings")).toMatchObject({ target: "TenantSetting", kind: "hasMany", inverse: "tenantId", ownership: "reference", foreignKey: "tenant_id" });
}, 30_000);
