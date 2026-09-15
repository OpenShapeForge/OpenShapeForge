// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { generateArtifacts } from "./generate.js";
import type { PlatformSchemaManifest } from "./schema.js";

test("realtime tombstones use the same compiled RLS predicate and only policy columns", () => {
  const input: PlatformSchemaManifest = { version: 1, tables: [{
    schema: "erp", name: "messages", tenantScoped: true, generatedCrud: true,
    columns: [
      { name: "id", type: "uuid", primaryKey: true },
      { name: "tenant_id", type: "uuid" },
      { name: "owner_id", type: "uuid" },
      { name: "body", type: "text" },
      { name: "acl", type: "jsonb" },
    ],
    rowScope: { userColumns: ["owner_id"], recordPermissions: { column: "acl", empty: "restricted" } },
  }] };
  const artifacts = generateArtifacts(input);
  const manifest = JSON.parse(artifacts.find(a => a.path.endsWith("manifest.json"))!.contents);
  const realtime = manifest.tables[0].realtime;
  expect(realtime.visibilityColumns).toEqual(["acl", "owner_id", "tenant_id"]);
  expect(artifacts.find(a => a.path.endsWith("schema.sql"))!.contents).toContain(`USING (${realtime.readPredicate})`);
  expect(realtime.readPredicate).not.toContain("body");
  expect(generateArtifacts(input)).toEqual(artifacts);
});
