// SPDX-License-Identifier: BUSL-1.1
/**
 * What a tenant formula may read of an authored record, and what the worker
 * that backfills formulas may therefore select: the same list
 * (formula-columns.ts). Database-free: the compiled acceptance entity of the
 * test composition, a versioned head of the core model and the worker grants
 * the migration chain applies.
 */
import { describe, expect, test } from "bun:test";
import { extensionWorkerGrants } from "../../../../db/migrations/worker-role.js";
import { getGeneratedCrudTables } from "../../catalog.js";
import type { GeneratedCrudTable } from "../../types.js";
import { formulaColumns, outOfScopeFormulaColumns } from "../formula-columns.js";
import { extensionRegistry } from "../registry.js";
import { acceptanceTable, TABLE } from "./fixture.js";

const names = (columns: ReadonlyArray<{ name: string }>) => columns.map((column) => column.name);
const asset = acceptanceTable();
const spec = getGeneratedCrudTables().find((table) => table.source?.authoringEntityName === "ExtensibleAssetSpec" && !table.subtype)!;

describe("formula columns", () => {
  test("never the tenant, the source, the write clock or a reference", () => {
    expect(names(formulaColumns(asset))).toEqual(["id", "created_at", "external_id", "source_authority", "source_organization",
      "source_administration", "source_administration_name", "source_version", "name"]);
    // The spec's foreign key reads as its owner: a reference, not an input.
    expect(names(formulaColumns(spec))).not.toContain("asset_id");
    expect(names(formulaColumns(spec))).toContain("weight");
    expect(outOfScopeFormulaColumns(asset).map((item) => item.column.name)).toEqual(["updated_at"]);
  });

  test("never the publication state of a versioned head", () => {
    const head = getGeneratedCrudTables().find((table) => table.source?.versioning && table.columns.some((column) => column.name === "lifecycle_status"))!;
    const publication = ["latest_version", "latest_version_id", "published_version", "published_version_id", "lifecycle_status"];
    expect(names(formulaColumns(head)).filter((name) => publication.includes(name))).toEqual([]);
    expect(outOfScopeFormulaColumns(head).map((item) => item.column.name)).toEqual(expect.arrayContaining(publication));
    expect(outOfScopeFormulaColumns(head).find((item) => item.column.name === "lifecycle_status")!.reason).toContain("publication state");
  });

  test("only what the read contract names", () => {
    const widened: GeneratedCrudTable = { ...asset, columns: [...asset.columns, { name: "internal_code", type: "text", required: false, primaryKey: false, generated: null }] };
    expect(names(formulaColumns(widened))).not.toContain("internal_code");
  });
});

describe("the worker's column grants", () => {
  const grants = (tables: readonly GeneratedCrudTable[]) => extensionWorkerGrants(extensionRegistry, tables);
  const tables = getGeneratedCrudTables();

  test("are the columns a formula may read, the write path's own and nothing else", () => {
    const own = grants(tables).find((grant) => grant.table === TABLE)!;
    expect(own.select).toEqual([...new Set(["id", "tenant_id", "created_at", "extension_values", "updated_at", ...names(formulaColumns(asset))])].sort());
    expect(own.update).toEqual(["extension_values", "updated_at"]);
    // A column outside the read contract is not granted, however scalar.
    const widened = tables.map((table) => table === asset
      ? { ...asset, columns: [...asset.columns, { name: "internal_code", type: "text", required: false, primaryKey: false, generated: null }] } : table);
    expect(grants(widened).find((grant) => grant.table === TABLE)!.select).not.toContain("internal_code");
  });

  test("on an owned child: its formula columns, and its foreign key only to find it", () => {
    const child = grants(tables).find((grant) => grant.table === `${spec.schema}.${spec.table}`)!;
    expect(child.select).toEqual([...new Set(["id", "tenant_id", "created_at", "asset_id", ...names(formulaColumns(spec))])].sort());
  });

  test("on a collection's child: the foreign keys a rollup may follow, never a classified or field-policed one", () => {
    const member = getGeneratedCrudTables().find((table) => table.source?.authoringEntityName === "ExtensibleAssetMember" && !table.subtype)!;
    const select = grants(tables).find((grant) => grant.table === `${member.schema}.${member.table}`)!.select;
    expect(select).toEqual(expect.arrayContaining(["asset_id", "item_id", "group_id", "location_id", "booking_id"]));
    expect(select).not.toContain("confidential_location_id");
    expect(select).not.toContain("restricted_location_id");
  });

  test("across such a foreign key: what no rollup of the source can be proven against stays out", () => {
    const location = getGeneratedCrudTables().find((table) => table.source?.authoringEntityName === "ExtensibleAssetLocation" && !table.subtype)!;
    const select = grants(tables).find((grant) => grant.table === `${location.schema}.${location.table}`)!.select;
    expect(select).toContain("capacity");
    expect(select).not.toContain("contact_email");
    expect(select).not.toContain("certified_capacity");
    expect(grants(tables).find((grant) => grant.table === "erp.extensible_asset_bookings")).toBeUndefined();
  });
});
