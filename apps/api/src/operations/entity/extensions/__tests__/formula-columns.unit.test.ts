// SPDX-License-Identifier: BUSL-1.1
/**
 * What a tenant formula may read of an authored record, and what the worker
 * that backfills formulas may therefore select: the same list
 * (formula-columns.ts). Database-free: the compiled acceptance entity of the
 * test composition, a versioned head of the core model and the worker grants
 * the migration chain applies.
 */
import { describe, expect, test } from "bun:test";
import manifest from "../../../../generated/db/manifest.json" with { type: "json" };
import { extensionWorkerGrants } from "../../../../db/migrations/worker-role.js";
import { getGeneratedCrudTables } from "../../catalog.js";
import type { GeneratedCrudTable } from "../../types.js";
import { formulaColumns, outOfScopeFormulaColumns } from "../formula-columns.js";
import { createExtensionRegistry, extensionRegistry } from "../registry.js";
import { acceptanceTable, ENTITY, TABLE, TARGET_ENTITY } from "./fixture.js";

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
    expect(select).toEqual(expect.arrayContaining(["asset_id", "item_id", "group_id", "location_id"]));
    expect(select).not.toContain("confidential_location_id");
    expect(select).not.toContain("restricted_location_id");
    // Its target is out of reach of the owner's readers: no rollup follows it, so nothing reads this key.
    expect(select).not.toContain("booking_id");
  });

  test("across such a foreign key: what no rollup of the source can be proven against stays out", () => {
    const location = getGeneratedCrudTables().find((table) => table.source?.authoringEntityName === "ExtensibleAssetLocation" && !table.subtype)!;
    const select = grants(tables).find((grant) => grant.table === `${location.schema}.${location.table}`)!.select;
    expect(select).toContain("capacity");
    expect(select).not.toContain("contact_email");
    expect(select).not.toContain("certified_capacity");
    expect(grants(tables).find((grant) => grant.table === "erp.extensible_asset_bookings")).toBeUndefined();
  });

  /** The compiled registry, narrowed to one route of a test; the group's readers widened so that its own lookups prove nothing. */
  const GROUP = "ExtensibleAssetGroup", GROUP_TABLE = "erp.extensible_asset_groups", LOCATION_TABLE = "erp.extensible_asset_locations";
  type EditableRegistry = { entities: Record<string, any>; readAccess: Record<string, any>; childRelations: Record<string, any> };
  const registryWith = (edit: (registry: EditableRegistry) => void) => {
    const registry = structuredClone((manifest as unknown as { extensionRegistry: EditableRegistry }).extensionRegistry);
    for (const entry of Object.values(registry.entities)) { entry.targets = []; entry.relations = []; entry.ownedSingleChildren = []; }
    registry.readAccess[GROUP].roles.push("Test.Wider.Read");
    edit(registry);
    return createExtensionRegistry(registry);
  };
  const location = { key: "location", kind: "belongsTo", entity: TARGET_ENTITY, table: LOCATION_TABLE, foreignKey: "location_id", ownership: "reference" };
  const selectOf = (registry: ReturnType<typeof createExtensionRegistry>, table: string, from = tables) => extensionWorkerGrants(registry, from).find((grant) => grant.table === table)?.select;

  describe("along a rollup's step from a child that is extensible itself", () => {
    test("a tenant reference to the source: the child's relation and what it leads to", () => {
      const registry = registryWith((edit) => {
        edit.entities[GROUP].targets = [{ entity: ENTITY, table: TABLE }];
        edit.entities[GROUP].relations = [location];
      });
      expect(selectOf(registry, LOCATION_TABLE)).toContain("capacity");
      expect(selectOf(registry, GROUP_TABLE)).toContain("location_id");
    });

    test("a tenant reference of the child leads there as well", () => {
      const registry = registryWith((edit) => {
        edit.entities[GROUP].targets = [{ entity: ENTITY, table: TABLE }, { entity: TARGET_ENTITY, table: LOCATION_TABLE }];
      });
      expect(selectOf(registry, LOCATION_TABLE)).toContain("capacity");
    });

    test("an inverse relation to it, with the foreign key that names the parent", () => {
      const widened = tables.map((table) => table.source?.authoringEntityName === GROUP && !table.subtype
        ? { ...table, columns: [...table.columns, { name: "asset_id", type: "uuid", required: false, primaryKey: false, generated: null }] } : table);
      const registry = registryWith((edit) => {
        edit.entities[ENTITY].relations = [{ key: "groups", kind: "hasMany", entity: GROUP, table: GROUP_TABLE, foreignKey: "asset_id", ownership: "reference" }];
        edit.entities[GROUP].relations = [location];
      });
      expect(selectOf(registry, LOCATION_TABLE, widened)).toContain("capacity");
      expect(selectOf(registry, GROUP_TABLE, widened)).toEqual(expect.arrayContaining(["asset_id", "location_id"]));
    });

    test("no link without its proof: the child's readers do not lend the target to the source", () => {
      const registry = registryWith((edit) => {
        edit.entities[GROUP].targets = [{ entity: ENTITY, table: TABLE }];
        edit.entities[GROUP].relations = [location];
        edit.readAccess[TARGET_ENTITY].roles = ["Test.Narrow.Read"];
      });
      expect(selectOf(registry, LOCATION_TABLE)).toBeUndefined();
      expect(selectOf(registry, GROUP_TABLE)).not.toContain("location_id");
    });

    test("a source that does not reach the child proves nothing about what the child reaches", () => {
      const registry = registryWith((edit) => {
        edit.entities[GROUP].targets = [{ entity: ENTITY, table: TABLE }];
        edit.entities[GROUP].relations = [location];
        edit.readAccess[GROUP].roles = ["Test.Narrow.Read"];
      });
      expect(selectOf(registry, LOCATION_TABLE)).toBeUndefined();
    });
  });

  describe("only along a route the proof holds for", () => {
    const part = (extra: Record<string, unknown>) => ({ kind: "hasMany", entity: "ExtensibleAssetPart", table: "erp.extensible_asset_parts", ownership: "reference", ...extra });

    test("a table reached through a classified foreign key alone stays out, on either side of the relation", () => {
      const single = registryWith((edit) => {
        edit.entities[GROUP].relations = [{ ...location, key: "confidentialLocation", foreignKey: "confidential_location_id" }];
      });
      expect(selectOf(single, LOCATION_TABLE)).toBeUndefined();
      const inverse = registryWith((edit) => { edit.entities[ENTITY].relations = [part({ key: "auditedParts", foreignKey: "audited_asset_id" })]; });
      expect(selectOf(inverse, "erp.extensible_asset_parts")).toBeUndefined();
    });

    test("so does one reached through a field-policed one", () => {
      const inverse = registryWith((edit) => { edit.entities[ENTITY].relations = [part({ key: "restrictedParts", foreignKey: "restricted_asset_id" })]; });
      expect(selectOf(inverse, "erp.extensible_asset_parts")).toBeUndefined();
    });

    test("a step whose foreign key is classified leaves its target out, though the collection is in reach", () => {
      const registry = registryWith((edit) => {
        edit.entities[ENTITY].relations = [{ key: "members", kind: "hasMany", entity: "ExtensibleAssetMember", table: "erp.extensible_asset_members", foreignKey: "asset_id", ownership: "owned", childAuthorization: "owner" }];
        edit.childRelations.ExtensibleAssetMember = [{ ...location, key: "confidentialLocation", foreignKey: "confidential_location_id" }];
      });
      expect(selectOf(registry, "erp.extensible_asset_members")).toContain("asset_id");
      expect(selectOf(registry, LOCATION_TABLE)).toBeUndefined();
    });

    test("an extensible entity's own foreign key goes with the proof of its lookup", () => {
      const registry = registryWith((edit) => {
        edit.entities[GROUP].relations = [location];
        edit.readAccess[TARGET_ENTITY].roles = ["Test.Narrow.Read"];
      });
      expect(selectOf(registry, GROUP_TABLE)).not.toContain("location_id");
    });
  });
});
