// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadActivePlatformCompile } from "../active-manifest.js";
import { generateArtifacts } from "../generate.js";

test("authoritative tenant fields retain nullable single FKs and inverse storage without a second tenant store", async () => {
  const active = await loadActivePlatformCompile(join(import.meta.dir, "../../../.."));
  const sql = generateArtifacts(active.manifest).find(artifact => artifact.path.endsWith("schema.sql"))!.contents;
  for (const name of ["label_rules", "tenant_settings"]) {
    const table = active.manifest.tables.find(table => table.schema === "erp" && table.name === name)!;
    const tenant = table.columns.find(column => column.name === "tenant_id")!;
    expect(tenant.required).not.toBe(true);
    expect(tenant.references).toEqual({ schema: "erp", table: "tenants", column: "id" });
    expect(table.columns.filter(column => column.name === "tenant_id")).toHaveLength(1);
    expect(table.indexes!.some(index => index.columns.length === 1 && index.columns[0] === "tenant_id")).toBe(true);
    expect(table.indexes!.every(index => new Set(index.columns).size === index.columns.length)).toBe(true);
    expect(sql).toContain(`ADD CONSTRAINT "${name}_tenant_id_fkey" FOREIGN KEY ("tenant_id")\n      REFERENCES "erp"."tenants"("id")`);
    const contract = active.entities.find(entity => entity.contract.storage.table === name)!.contract;
    expect(contract.model.fields.find(field => field.key === "tenantId")).toMatchObject({ semanticType: "Tenant", readOnly: true, required: false });
  }
  expect(sql).not.toContain('FOREIGN KEY ("tenant_id", "tenant_id")');
  expect(active.manifest.tables.filter(table => table.name === "tenants").map(table => table.schema).sort()).toEqual(["erp", "platform"]);
  const owner = active.entities.find(entity => entity.contract.entity.name === "Tenant")!.contract;
  expect(owner.model.relationships.find(relationship => relationship.key === "tenantSettings")).toMatchObject({ target: "TenantSetting", kind: "hasMany", inverse: "tenantId", ownership: "reference", foreignKey: "tenant_id" });
}, 30_000);
