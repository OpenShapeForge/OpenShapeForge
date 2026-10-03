// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { generateArtifacts } from "../../generate.js";
import { compilePartialDerivedIdentifierFixture } from "./derive-on-create.fixtures.js";
import { ensureDerivedIdentifierIndexes } from "./derive-on-create.js";

test("partial unique indexes compile into usable suffix allocation and preserve the authored predicate", () => {
  const manifest = compilePartialDerivedIdentifierFixture();
  const table = manifest.tables.find((table) => table.name === "derived_identifier_fixtures")!;
  expect(table.indexes).toEqual([
    { name: "active_identifier_keys", columns: ["tenant_id", "key"], unique: true, where: '"active" = true' },
    { name: "derived_identifier_fixtures_key_derived_uidx", columns: ["tenant_id", "key"], unique: true },
  ]);
  expect(table.columns.find((column) => column.name === "key")?.deriveOnCreate?.conflictColumns)
    .toEqual(["tenant_id", "key"]);
  const schema = generateArtifacts(manifest).find((artifact) => artifact.path.endsWith("schema.sql"))!.contents;
  expect(schema).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "active_identifier_keys" ON "erp"."derived_identifier_fixtures" ("tenant_id", "key") WHERE "active" = true;');
  expect(schema).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "derived_identifier_fixtures_key_derived_uidx" ON "erp"."derived_identifier_fixtures" ("tenant_id", "key");');
});

test("generated derived-index SQL uses the existing identifier limit guard without collisions or truncation", () => {
  const manifest = compilePartialDerivedIdentifierFixture();
  const table = manifest.tables.find((table) => table.name === "derived_identifier_fixtures")!;
  table.name = `derived_${"x".repeat(55)}`;
  const binding = table.columns.find((column) => column.name === "key")!.deriveOnCreate!;
  table.indexes = ensureDerivedIdentifierIndexes(table.name, [
    { name: `${table.name}_authored_uidx`, columns: ["tenant_id", "name"], unique: true },
  ], [{ targetField: "key", targetColumn: "key", ...binding }]);
  expect(table.indexes.every((index) => Buffer.byteLength(index.name) > 63)).toBe(true);
  const sql = () => generateArtifacts(manifest).find((artifact) => artifact.path.endsWith("schema.sql"))!.contents;
  const first = sql();
  const emitted = [...first.matchAll(/CREATE UNIQUE INDEX IF NOT EXISTS "([^"]+)" ON "erp"\."derived_x+"/g)]
    .map((match) => match[1]!);
  expect(emitted).toHaveLength(2);
  expect(new Set(emitted).size).toBe(2);
  expect(emitted.every((name) => Buffer.byteLength(name) <= 63)).toBe(true);
  expect(emitted.every((name) => /_[a-f0-9]{8}$/.test(name))).toBe(true);
  expect(sql()).toBe(first);
});
