// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { compileAuthoringBackendManifest, listAuthoringEntitySlugs } from "../packages/compiler/src/authoring/backend-manifest";
import { generateArtifacts } from "../packages/compiler/src/generate";
import { checkCoreEntityV3, migrateCoreEntity, physicalTables, planCoreEntityMigration, readYamlCorpus, restoreInterfaceMetadata, yaml } from "./core-entity-v3";

const definition = (entity = "Example", extra = {}) => ({ schemaVersion: 1, kind: "coreEntity", module: "core", entity,
  title: entity, language: "en", fields: [{ key: "name", valueType: "string", persisted: { column: "name", storageClass: "core" } }], ...extra });

describe("kind-aware coreEntity cutover gate", () => {
  test("includes examples and loadable fixtures; excludes other versioned kinds", () => {
    const report = checkCoreEntityV3([
      { path: "examples/entity.yaml", document: definition() },
      { path: "packages/x/__fixtures__/entity.yaml", document: definition("Fixture", { schemaVersion: 2 }) },
      { path: "catalog.yaml", document: { kind: "semanticTypeCatalog", schemaVersion: 1 } },
      { path: "_base.yaml", document: { kind: "baseEntity", schemaVersion: 1 } },
    ]);
    expect(report.total).toBe(2); expect(report.old).toBe(2); expect(report.failures).toHaveLength(2);
  });
  test("accepts v3 field relations, rejects even empty legacy relationships", () => {
    expect(checkCoreEntityV3([{ path: "entity.yaml", document: definition("A", { schemaVersion: 3 }) }]).failures).toEqual([]);
    expect(checkCoreEntityV3([{ path: "entity.yaml", document: definition("A", { schemaVersion: 3, relationships: [] }) }]).failures).toHaveLength(1);
  });
  test("cannot hide production behind a legacy exemption", () => {
    const path = "packages/compiler/config/authoring/entities/core/label-rule.yaml";
    expect(checkCoreEntityV3([{ path, document: definition() }], { [path]: "legacy" }).failures).toHaveLength(2);
  });
  test("only explicit isolated legacy rejection fixtures can be exempted; stale entries fail", () => {
    const path = "packages/x/__fixtures__/legacy-rejection/v1.yaml";
    expect(checkCoreEntityV3([{ path, document: definition() }], { [path]: "assert v1 Pascal relation rejection" }).failures).toEqual([]);
    expect(checkCoreEntityV3([], { [path]: "assert v1 Pascal relation rejection" }).failures).toHaveLength(1);
  });
});

describe("lossless migration helper", () => {
  test("keeps readonly CRUD exposure and transport opt-ins", () => {
    const source = definition("Example", { crud: { operations: { create: false, update: false, delete: false } }, rest: true });
    const migrated = migrateCoreEntity(source, [source]);
    expect(Object.keys(migrated.operations)).toEqual(["list", "get"]);
    expect(migrated.interfaces).toEqual({ graphql: {}, rest: {} });
    expect(source.schemaVersion).toBe(1);
  });
  test("does not invent operations for an internal storage entity", () => {
    const source = definition("Internal", { crud: false });
    expect(migrateCoreEntity(source, [source]).operations).toEqual({});
  });
  test("moves secure-input intent to the existing canonical create operation", () => {
    const interaction = { sourceField: "name", sourceEntity: "Example", definitionsField: "configuration", into: "configuration" };
    const source = definition("Example", { mcp: { elicitOnCreate: interaction } });
    const result = migrateCoreEntity(source, [source]);
    expect(result.operations.create.interaction).toEqual({ type: "secureInput", ...interaction });
    expect(result.interfaces.mcp).toEqual({});
  });
  test("maps ordinary Web layouts and action acknowledgement onto canonical operations", () => {
    const group = { title: { en: "Details", nl: "Details" }, fields: ["name"] };
    const source = definition("Example", { displayTemplate: "{{name}}", ui: {
      routes: { list: "/examples", detail: "/examples/:id", create: "/examples/new" },
      presentations: { list: { columns: [{ key: "name" }], rowLink: "/examples/:id" },
        detail: { header: { title: "{{name}}" }, groups: [{ id: "details", groups: [group] }], actions: [{ key: "delete", mutation: "delete", confirm: { en: "Delete?", nl: "Verwijderen?" } }] },
        form: { variants: { create: { title: { en: "Create", nl: "Aanmaken" }, groups: [group] }, edit: { extends: "create", title: { en: "Edit", nl: "Bewerken" } } } } },
    } });
    const result = migrateCoreEntity(source, [source]);
    expect(result.ui).toBeUndefined();
    expect(result.interfaces.web.views.record.layout.tabs[0].groups).toEqual([group]);
    expect(result.interfaces.web.views.record.modes.create.groups).toEqual([group]);
    expect(result.operations.delete.confirmation).toEqual({ mode: "acknowledgement" });
  });
  test("keeps FK column, alias-inherited policy and field immutability", () => {
    const target = definition("Customer");
    const source = definition("Order", { fields: [{ key: "customerId", semanticType: "customerId", immutable: true, persisted: { column: "customer_id", storageClass: "core" } }],
      relationships: [{ key: "customer", kind: "belongsTo", target: "Customer", foreignKey: "customer_id" }] });
    const migrated = migrateCoreEntity(source, [source, target], { customerId: { kind: "entityId", entity: "customer", classification: { sensitivity: "internal" }, validation: { format: "uuid" } } });
    expect(migrated.fields[0]).toMatchObject({ key: "customerId", semanticType: "Customer", immutable: true,
      persisted: { column: "customer_id" }, classification: { sensitivity: "internal" }, validation: { format: "uuid" }, relationship: { ownership: "reference" } });
    expect(migrated.relationships).toBeUndefined();
  });
  test("collection uses inverse storage, not JSON or a second FK", () => {
    const source = definition("Customer", { relationships: [{ key: "orders", kind: "hasMany", target: "Order", foreignKey: "customer_id" }] });
    const target = definition("Order", { relationships: [{ key: "customer", kind: "belongsTo", target: "Customer", foreignKey: "customer_id" }] });
    const migrated = migrateCoreEntity(source, [source, target]);
    expect(migrated.fields.at(-1)).toEqual({ key: "orders", semanticType: "Order", cardinality: "collection", relationship: { inverse: "customerId", ownership: "reference" } });
  });
  test("rewrites v2 context relationship arrays to the canonical field keys", () => {
    const target = definition("Customer");
    const base = definition("Order");
    const source = { ...base, schemaVersion: 2, operations: migrateCoreEntity(base, [base]).operations,
      relationships: [{ key: "customer", kind: "belongsTo", target: "Customer", foreignKey: "customer_id" }],
      interfaces: { web: { views: {
        collection: { route: "/orders", columns: [{ key: "name" }] },
        record: { title: "{{name}}", layout: { context: { fields: ["name"], relationships: ["customer"] }, tabs: [{ relationship: "customer" }] } },
      } } },
    };
    const result = migrateCoreEntity(source, [source, target]);
    expect(result.interfaces.web.views.record.layout.context.relationships).toEqual(["customerId"]);
    expect(result.interfaces.web.views.record.layout.tabs[0].relationship).toBe("customerId");
  });
  test("refuses unresolved via, missing tenancy targets and custom UI", () => {
    for (const extra of [
      { relationships: [{ key: "events", via: "relation" }] },
      { relationships: [{ key: "tenant", kind: "belongsTo", foreignKey: "tenant_id" }] },
      { ui: { presentations: { form: { variableSources: [] } } } },
    ]) { const source = definition("Example", extra); expect(() => migrateCoreEntity(source, [source])).toThrow(); }
  });
  test("preserves the nullable FK carried by a server-managed tenant column", () => {
    const tenant = definition("Tenant");
    const source = definition("Scoped", { authorization: { roles: { read: ["General.All.Read"] } },
      relationships: [{ key: "tenant", kind: "belongsTo", target: "Tenant", foreignKey: "tenant_id" }] });
    const migrated = migrateCoreEntity(source, [source, tenant]);
    const field = migrated.fields.find((field: any) => field.key === "tenantId");
    expect(field).toMatchObject({ semanticType: "Tenant", readOnly: true, persisted: { column: "tenant_id" }, relationship: { ownership: "reference" } });
    expect(field.required).not.toBe(true);
    expect(migrated.relationships).toBeUndefined();
  });
  test("preserves nested field presentation without inventing Web routes", () => {
    const source = definition("Example", { fields: [{ key: "settings", valueType: "object", children: [
      { key: "map", valueType: "object", render: { component: "MapPicker", props: { clearable: true } } },
    ] }] });
    const result = migrateCoreEntity(source, [source]);
    expect(result.interfaces.web.views).toBeUndefined();
    expect(result.interfaces.web.fields["settings.map"].render).toEqual(source.fields[0].children[0].render);
    expect(result.fields[0].children[0].render).toBeUndefined();
  });
  test("resuming a cutover restores workflow and presentation metadata without overriding authored changes", () => {
    const original = definition("Example", { workflow: { nodes: { actions: { list: true, update: false } } },
      fields: [{ key: "name", valueType: "string", render: { component: "Input" } }] });
    const migrated = definition("Example", { schemaVersion: 3, interfaces: { web: { fields: { name: { render: { component: "CustomInput" } } } } } });
    const restored = restoreInterfaceMetadata(original, migrated);
    expect(restored.interfaces.workflow).toEqual(original.workflow);
    expect(restored.interfaces.web.fields.name.render.component).toBe("CustomInput");
    expect(restored.workflow).toBeUndefined();
  });
  test("planner does not overwrite main-owned Block or Template files", () => {
    const entries = ["Block", "Template", "TemplateVersion"].map(entity => ({ path: `${entity}.yaml`, document: definition(entity) }));
    expect(planCoreEntityMigration(entries, {}).planned).toEqual([]);
  });
  test("physical comparison detects FK/index/RLS changes, ignoring only provenance", () => {
    const table = { schema: "erp", name: "orders", columns: [{ name: "id", type: "uuid", sourceField: "id" }], source: { authoringVersion: 1 } };
    const physical = physicalTables({ tables: [table] });
    expect(physicalTables({ tables: [{ ...table, source: { authoringVersion: 3 } }] })).toEqual(physical);
    for (const addition of [{ indexes: [{ name: "id_idx", columns: ["id"] }] }, { rowScope: { userColumns: ["id"] } },
      { columns: [{ name: "id", type: "uuid", references: { schema: "erp", table: "customers", column: "id" } }] }]) {
      expect(physicalTables({ tables: [{ ...table, ...addition }] })).not.toEqual(physical);
    }
  });
});

test("real core corpus proposed migration preserves table/column/default/RLS storage; FK/index changes remain explicit", () => {
  const root = resolve(import.meta.dir, "..");
  const source = join(root, "packages/compiler/config/authoring");
  const scratch = mkdtempSync(join(tmpdir(), "osf367-v3-proof-"));
  try {
    cpSync(source, scratch, { recursive: true });
    const corpus = readYamlCorpus(root);
    const semanticTypes = corpus.find(entry => entry.document?.kind === "semanticTypeCatalog")!.document.types;
    const plan = planCoreEntityMigration(corpus, semanticTypes);
    const applied = corpus.filter(entry => entry.path.startsWith("packages/compiler/config/authoring/") && entry.document?.kind === "coreEntity" && entry.document.schemaVersion === 3)
      .flatMap(entry => {
        let original: any;
        try { original = yaml.parse(execFileSync("git", ["show", `HEAD:${entry.path}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })); }
        catch { return []; }
        if (![1, 2].includes(original.schemaVersion)) return [];
        return [{ ...entry, original }];
      });
    for (const entry of applied) writeFileSync(join(scratch, entry.path.slice("packages/compiler/config/authoring/".length)), yaml.stringify(entry.original));
    const options = { mode: "promote" as const, schemaByModule: { core: "erp" }, entityAllowlist: listAuthoringEntitySlugs(scratch), generatedCrudAllowlist: listAuthoringEntitySlugs(scratch) };
    const before = compileAuthoringBackendManifest(scratch, options);
    for (const entry of applied) writeFileSync(join(scratch, entry.path.slice("packages/compiler/config/authoring/".length)), yaml.stringify(entry.document));
    for (const entry of plan.planned.filter(entry => entry.path.startsWith("packages/compiler/config/authoring/"))) {
      writeFileSync(join(scratch, entry.path.slice("packages/compiler/config/authoring/".length)), yaml.stringify(entry.document));
    }
    const after = compileAuthoringBackendManifest(scratch, options);
    const withoutReferences = (manifest: any) => physicalTables(manifest).map(({ indexes, ...table }) => ({ ...table,
      columns: table.columns.map(({ references, ...column }: any) => column) }));
    const lostReferenceTargets: string[] = [];
    for (const old of before.tables) for (const column of old.columns) {
      if (!column.references) continue;
      const current = after.tables.find(table => table.schema === old.schema && table.name === old.name)?.columns.find(candidate => candidate.name === column.name)?.references;
      if (!current || current.schema !== column.references.schema || current.table !== column.references.table || current.column !== column.references.column) {
        lostReferenceTargets.push(`${old.schema}.${old.name}.${column.name} -> ${column.references.schema}.${column.references.table}.${column.references.column}`);
      }
    }
    // Composite tenant-scoped FKs may strengthen an existing target, but
    // neither dropping that target nor changing NULL/global behavior is a
    // syntax migration. Require an explicit separately verified policy change.
    expect({ lostReferenceTargets, storage: withoutReferences(after) }).toEqual({ lostReferenceTargets: [], storage: withoutReferences(before) });
    const sql = generateArtifacts(after).find(artifact => artifact.path.endsWith("schema.sql"))!.contents;
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "erp"."document_types"');
    expect(sql).toContain('"tenant_id" uuid NOT NULL');
    // Migration deliberately strengthens existing references, never silently
    // claiming byte-equivalent DDL when composite FK/index lowering differs.
    const changed = physicalTables(after).filter((table, index) => JSON.stringify(table) !== JSON.stringify(physicalTables(before)[index]));
    console.info(`v3 corpus proof: ${applied.length} applied and ${plan.planned.length} ready YAMLs; ${changed.length} tables with explicit FK/index changes`);
    const ddl = { foreignKeysAdded: 0, foreignKeysStrengthened: 0, indexesAdded: 0, indexesRemoved: 0 };
    const addedForeignKeys: string[] = [];
    for (const table of after.tables) {
      const old = before.tables.find(previous => previous.schema === table.schema && previous.name === table.name)!;
      for (const column of table.columns) {
        const previous = old.columns.find(candidate => candidate.name === column.name);
        if (column.references && !previous?.references) {
          ddl.foreignKeysAdded++;
          addedForeignKeys.push(`${table.schema}.${table.name}.${column.name} -> ${column.references.schema}.${column.references.table}.${column.references.column}`);
        }
        else if (column.references && JSON.stringify(column.references) !== JSON.stringify(previous?.references)) ddl.foreignKeysStrengthened++;
      }
      ddl.indexesAdded += (table.indexes ?? []).filter(index => !(old.indexes ?? []).some(previous => JSON.stringify(previous) === JSON.stringify(index))).length;
      ddl.indexesRemoved += (old.indexes ?? []).filter(index => !(table.indexes ?? []).some(current => JSON.stringify(current) === JSON.stringify(index))).length;
    }
    expect(ddl.indexesRemoved).toBe(0);
    console.info(`v3 DDL delta: ${JSON.stringify(ddl)}; no table/column/type/default/nullability/RLS or FK-target loss`);
    console.info(`v3 added FK targets: ${JSON.stringify(addedForeignKeys.sort())}`);
    for (const table of changed) for (const column of table.columns) {
      if (column.references?.localColumns) expect(column.references.localColumns).toEqual(["tenant_id", column.name]);
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}, 120_000);
