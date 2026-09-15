// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadActivePlatformCompile } from "../../../../../packages/compiler/src/active-manifest.js";
import { generateArtifacts } from "../../../../../packages/compiler/src/generate.js";
import { isCallerWritableColumn, isWritableColumn, normalizeWritableValues } from "./write-policy.js";
import type { GeneratedCrudTable } from "./types.js";

for (const entity of ["LabelRule", "TenantSetting"]) {
  test(`${entity}: canonical tenant field and physical column remain server-managed on create and update`, async () => {
    // Use the actual emitted runtime DTO, not a handwritten column fixture or
    // a stale on-disk generation from another concurrent workstream.
    const active = await loadActivePlatformCompile(join(import.meta.dir, "../../../../.."));
    const manifest = JSON.parse(generateArtifacts(active.manifest).find(artifact => artifact.path.endsWith("db/manifest.json"))!.contents) as { tables: GeneratedCrudTable[] };
    const table = (manifest.tables as GeneratedCrudTable[]).find(table => table.source?.authoringEntityName === entity)!;
    expect(table).toBeDefined();
    const tenant = table.columns.find(column => column.name === "tenant_id")!;
    expect(tenant.sourceField).toBe("tenantId");
    expect(tenant.required).toBe(false);
    for (const operation of ["create", "update"] as const) {
      expect(isWritableColumn(tenant, operation)).toBe(false);
      expect(isCallerWritableColumn(table, tenant, operation)).toBe(false);
      const supplied = { tenantId: "00000000-0000-4000-8000-000000000099", tenant_id: "00000000-0000-4000-8000-000000000099", key: "safe-value" };
      const normalized = normalizeWritableValues(table, supplied, operation);
      expect([...normalized.keys()].map(column => column.name)).toEqual(["key"]);
      expect([...normalized.values()]).toEqual(["safe-value"]);
    }
  }, 30_000);
}
