// SPDX-License-Identifier: BUSL-1.1
/**
 * Extensible entities: the authored `extensible:` block, the storage the
 * compiler lowers it into and the registry the manifest publishes. Fixtures:
 * __fixtures__/rowaccess/entities/extensible-part*.yaml (module `parts`).
 */
import { afterAll, describe, expect, it } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { compileAuthoringBackendManifest } from "./backend-manifest.js";
import {
  EXTENSION_TARGET_DENYLIST,
  EXTENSION_TYPE_DENYLIST,
  EXTENSION_VALUE_INDEXES,
  EXTENSION_VALUE_STATISTICS_TARGET,
  assertIndexProjection,
  isExtensionTargetCandidate,
} from "./extensible.js";
import { loadOsfTypes } from "./loader.js";
import { generateArtifacts } from "../generate.js";
import { collectPluginMigrationRegistry } from "../generate-plugin-migrations.js";
import { loadManifest } from "../load-manifest.js";
import type { PlatformSchemaManifest, TableDefinition } from "../schema.js";
import type { CompiledEntityContract } from "./types/compiled.js";

const fixtureDir = join(import.meta.dir, "__fixtures__", "rowaccess");
const slugs = ["extensible-part", "extensible-part-spec", "rest-custom", "rest-enabled"];
const temporary: string[] = [];
afterAll(() => { for (const dir of temporary) rmSync(dir, { recursive: true, force: true }); });

function compile(
  mutate: (contract: CompiledEntityContract) => void = () => {},
  options: { dir?: string; entityAllowlist?: string[] } = {},
): PlatformSchemaManifest {
  const entityAllowlist = options.entityAllowlist ?? slugs;
  return compileAuthoringBackendManifest(options.dir ?? fixtureDir, {
    mode: "promote",
    entityAllowlist,
    generatedCrudAllowlist: entityAllowlist,
    onCandidate: ({ contract }) => mutate(contract),
  });
}

/** A copy of the fixture layer with one entity document rewritten. */
function withDocument(slug: string, transform: (document: Record<string, any>) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "osf-extensible-"));
  temporary.push(dir);
  cpSync(fixtureDir, dir, { recursive: true });
  const path = join(dir, "entities", `${slug}.yaml`);
  const document = YAML.parse(readFileSync(path, "utf8")) as Record<string, any>;
  transform(document);
  writeFileSync(path, YAML.stringify(document));
  return dir;
}

const refuse = (transform: (document: Record<string, any>) => void, message: string | RegExp) =>
  expect(() => compile(() => {}, { dir: withDocument("extensible-part", transform) })).toThrow(message);

const table = (manifest: PlatformSchemaManifest, name: string): TableDefinition => {
  const found = manifest.tables.find((candidate) => `${candidate.schema}.${candidate.name}` === name);
  if (!found) throw new Error(`no table ${name}`);
  return found;
};

const schemaSql = (manifest: PlatformSchemaManifest) =>
  generateArtifacts(manifest).find((artifact) => artifact.path.endsWith("/db/schema.sql"))!.contents;
const manifestJson = (manifest: PlatformSchemaManifest) =>
  generateArtifacts(manifest).find((artifact) => artifact.path.endsWith("/db/manifest.json"))!.contents;

describe("extensible: the resolved contract", () => {
  it("resolves manage roles with the organization administrator, the limits with their defaults, and the allowed types", () => {
    let resolved: CompiledEntityContract["extensible"];
    compile((contract) => { if (contract.entity.name === "ExtensiblePart") resolved = contract.extensible; });
    expect(resolved).toMatchObject({
      manageRoles: ["General.All.ReadWrite", "Organization.All.ReadWrite"],
      limits: { fields: 50, filtersPerQuery: 5, formulaDepth: 5, syncFanOut: 100 },
      excludedTypes: ["iban"],
      excludedTargets: ["RestCustom"],
      indexProjections: { measurement: { number: "value", text: "unit" } },
    });
    const allowed = resolved!.allowedOsfTypes;
    // Base types, scalar catalog types and object types that project.
    for (const type of ["string", "integer", "number", "boolean", "date", "datetime", "money", "email", "measurement"]) {
      expect(allowed).toContain(type);
    }
    // The compiler's denylist, an object type without a projection, the
    // authored exclusion, `object` itself and every entity reference type.
    for (const type of ["condition", "fieldDefinition", "variableTemplate", "coordinates", "iban", "object", "ExtensiblePart", "extensiblePartId"]) {
      expect(allowed).not.toContain(type);
    }
    expect(allowed).toEqual([...allowed].sort());
  });

  it("is absent on every entity that does not declare it", () => {
    const seen: Record<string, unknown> = {};
    compile((contract) => { seen[contract.entity.name] = contract.extensible; });
    expect(seen.ExtensiblePartSpec).toBeUndefined();
    expect(seen.RestEnabled).toBeUndefined();
  });

  it("refuses an entity with a row-scope axis, owner axis or record ACL, naming why", () => {
    refuse((document) => {
      document.fields.push({ key: "ownerId", osfType: "string", validation: { format: "uuid" }, persisted: { column: "owner_id", storageClass: "core" } });
      document.authorization.rowAccess = { enabled: true, empty: "public", owner: { column: "owner_id", session: "app.current_user_id" } };
    }, /\[ExtensiblePart\] extensible is not available on an entity with a row-scope axis \(authorization\.rowAccess\.owner\): tenant fields are not yet proven for entities whose rows are visible to fewer than all tenant readers/);
    refuse((document) => {
      document.fields.push({ key: "orgUnit", osfType: "RestEnabled", persisted: { column: "org_unit_id", storageClass: "core" }, relationship: { inverse: false } });
      document.authorization.rowAccess = { enabled: true, empty: "public", group: { column: "org_unit_id" } };
    }, /row-scope axis \(authorization\.rowAccess\.group\)/);
    refuse((document) => {
      document.fields.push({ key: "permissions", osfType: "object", required: true, persisted: { column: "permissions", storageClass: "core" } });
      document.authorization.rowAccess = { enabled: true, empty: "public", recordPermissions: { field: "permissions", empty: "public", createRequires: ["view", "edit"] } };
    }, /record ACL \(authorization\.rowAccess\.recordPermissions\)/);
    refuse((document) => {
      document.fields.push(
        { key: "enabledOwner", osfType: "RestEnabled", relationship: { inverse: { key: "ownedParts", label: { en: "Parts" }, ownership: "owned" } } },
        { key: "customOwner", osfType: "RestCustom", relationship: { inverse: { key: "ownedParts", label: { en: "Parts" }, ownership: "owned" } } },
      );
      document.authorization.ownerAxis = { fields: ["enabledOwner", "customOwner"] };
    }, /owner axis \(authorization\.ownerAxis\)/);
  });

  it("admits plain tenant row access without any axis", () => {
    const dir = withDocument("extensible-part", (document) => {
      document.authorization.rowAccess = { enabled: true, empty: "public" };
    });
    expect(compile(() => {}, { dir }).extensionRegistry?.entities.ExtensiblePart).toBeDefined();
  });

  it("refuses an entity without manage roles or with a reserved key", () => {
    refuse((document) => { document.extensible.authorization.manage = []; }, "[ExtensiblePart] extensible requires authorization.manage with at least one role.");
    refuse((document) => {
      document.fields.push({ key: "extensions", osfType: "string", persisted: { column: "extensions", storageClass: "core" } });
    }, "[ExtensiblePart] extensible reserves the record property \"extensions\" for tenant values; rename the authored field.");
    refuse((document) => {
      document.fields.push({ key: "legacy", osfType: "string", persisted: { column: "extension_values", storageClass: "core" } });
    }, /reserves the column extension_values/);
  });

  it("refuses an owned child: its owner's snapshot would freeze its raw tenant values", () => {
    const dir = withDocument("extensible-part-spec", (document) => {
      document.extensible = { authorization: { manage: ["General.All.ReadWrite"] } };
    });
    expect(() => compile(() => {}, { dir })).toThrow("[ExtensiblePartSpec] extensible is not available on an owned child (owned by ExtensiblePart)");
  });

  it("refuses an unknown excluded type or target", () => {
    refuse((document) => { document.extensible.excludedTypes = ["noSuchType"]; }, "[ExtensiblePart] extensible excludedTypes names noSuchType, which is not an osfType of the catalog.");
    refuse((document) => { document.extensible.excludedTargets = ["NoSuchEntity"]; }, "[ExtensiblePart] extensible excludedTargets names NoSuchEntity, which is not an entity of this manifest.");
  });

  it("validates an index projection against the object type's children", () => {
    const types = loadOsfTypes(fixtureDir);
    expect(() => assertIndexProjection("measurement", types.measurement!, types)).not.toThrow();
    expect(() => assertIndexProjection("bad", { ...types.measurement!, indexProjection: { number: "unit" } }, types))
      .toThrow("osfType bad indexProjection.number names unit, whose type string does not land in value_number (expects integer or number).");
    expect(() => assertIndexProjection("bad", { ...types.measurement!, indexProjection: { text: "missing" } }, types))
      .toThrow("osfType bad indexProjection.text names missing, which is not a child of bad.");
    expect(() => assertIndexProjection("bad", { ...types.money!, indexProjection: { number: "amount" } }, types))
      .toThrow("osfType bad declares indexProjection, but only an object type has components to project.");
  });

  it("gives the shipped catalog exactly one projection: measurement", () => {
    const types = loadOsfTypes(join(import.meta.dir, "..", "..", "config", "authoring"));
    const projected = Object.entries(types).filter(([, definition]) => definition.indexProjection);
    expect(projected.map(([name]) => name)).toEqual(["measurement"]);
    expect(types.measurement!.indexProjection).toEqual({ number: "value", text: "unit" });
    for (const [name, definition] of projected) expect(() => assertIndexProjection(name, definition, types)).not.toThrow();
    // `money` is a scalar number: its currency is a field prop, never part of the value.
    expect(types.money!.baseType).toBe("number");
    for (const name of EXTENSION_TYPE_DENYLIST) expect(types[name]).toBeDefined();
  });
});

describe("extensible: storage", () => {
  const manifest = compile();
  const sql = schemaSql(manifest);

  it("adds the source column with a default on the entity table", () => {
    const entity = table(manifest, "parts.extensible_parts");
    expect(entity.columns.find((column) => column.name === "extension_values")).toEqual({
      name: "extension_values", type: "jsonb", required: true, default: "'{}'::jsonb",
    });
    expect(sql).toContain(`"extension_values" jsonb NOT NULL DEFAULT '{}'::jsonb`);
    // The composite reference target.
    expect(sql).toContain(`CREATE UNIQUE INDEX IF NOT EXISTS "extensible_parts_tenant_id_id_key" ON "parts"."extensible_parts" ("tenant_id", "id");`);
    expect(table(manifest, "parts.extensible_part_specs").columns.some((column) => column.name === "extension_values")).toBe(false);
  });

  it("lowers the typed index table with its composite key, cascading reference and partial indexes", () => {
    const values = table(manifest, "parts.extensible_parts_field_values");
    expect(values).toMatchObject({ tenantScoped: true, domainInternal: true, generatedCrudEligible: false, workerDml: true });
    expect(values.columns.map((column) => [column.name, column.type, column.primaryKey === true])).toEqual([
      ["tenant_id", "uuid", true], ["record_id", "uuid", true], ["field_id", "uuid", true], ["ordinal", "integer", true],
      ["value_text", "text", false], ["value_number", "numeric", false], ["value_boolean", "boolean", false],
      ["value_date", "date", false], ["value_timestamp", "timestamptz", false], ["value_ref_id", "uuid", false],
    ]);
    expect(values.columns.find((column) => column.name === "record_id")!.references).toEqual({
      schema: "parts", table: "extensible_parts", column: "id",
      localColumns: ["tenant_id", "record_id"], targetColumns: ["tenant_id", "id"], onDelete: "CASCADE",
    });
    expect(values.indexes).toEqual(EXTENSION_VALUE_INDEXES.map((index) => ({
      name: `extensible_parts_field_values_${index.suffix}_idx`, columns: [...index.columns], where: index.where,
    })));
    expect(sql).toContain(`CREATE TABLE IF NOT EXISTS "parts"."extensible_parts_field_values" (`);
    expect(sql).toContain(`PRIMARY KEY ("tenant_id", "record_id", "field_id", "ordinal")`);
    expect(sql).toContain(`"ordinal" integer NOT NULL DEFAULT 0`);
    // The measured shape: record_id last, the reference index led by the target id.
    for (const column of ["value_text", "value_number", "value_boolean", "value_date", "value_timestamp"]) {
      expect(sql).toContain(`CREATE INDEX IF NOT EXISTS "extensible_parts_field_values_${column}_record_idx" ON "parts"."extensible_parts_field_values" ("tenant_id", "field_id", "${column}", "record_id") WHERE ${column} IS NOT NULL;`);
    }
    expect(sql).toContain(`CREATE INDEX IF NOT EXISTS "extensible_parts_field_values_value_ref_id_record_idx" ON "parts"."extensible_parts_field_values" ("tenant_id", "value_ref_id", "field_id", "record_id") WHERE value_ref_id IS NOT NULL;`);
    // Planner statistics over field and value, at a high target, per value column.
    expect(values.statistics).toEqual(["value_text", "value_number", "value_boolean", "value_date", "value_timestamp"].map((column) => ({
      name: `extensible_parts_field_values_${column}_stats`, kinds: ["mcv"], columns: ["field_id", column], target: EXTENSION_VALUE_STATISTICS_TARGET,
    })));
    expect(EXTENSION_VALUE_STATISTICS_TARGET).toBe(1000);
    for (const column of ["field_id", "value_text", "value_number", "value_boolean", "value_date", "value_timestamp"]) {
      expect(sql).toContain(`ALTER TABLE "parts"."extensible_parts_field_values" ALTER COLUMN "${column}" SET STATISTICS 1000;`);
    }
    expect(sql).not.toContain(`ALTER COLUMN "value_ref_id" SET STATISTICS`);
    for (const column of ["value_text", "value_number", "value_boolean", "value_date", "value_timestamp"]) {
      expect(sql).toContain(`CREATE STATISTICS IF NOT EXISTS "parts"."extensible_parts_field_values_${column}_stats" (mcv) ON "field_id", "${column}" FROM "parts"."extensible_parts_field_values";`);
    }
    // The first shape is no longer declared under its old names.
    expect(sql).not.toMatch(/"extensible_parts_field_values_value_[a-z_]+?(?<!_record)_idx"/);
    expect(sql).toContain(`ADD CONSTRAINT "extensible_parts_field_values_record_id_fkey" FOREIGN KEY ("tenant_id", "record_id")\n      REFERENCES "parts"."extensible_parts"("tenant_id", "id") ON DELETE CASCADE;`);
  });

  it("lowers the unique-value table keyed on the claimed value, releasing it with the record", () => {
    const unique = table(manifest, "parts.extensible_parts_field_unique_values");
    expect(unique).toMatchObject({ tenantScoped: true, domainInternal: true, generatedCrudEligible: false, workerDml: true });
    expect(unique.columns.map((column) => [column.name, column.type, column.primaryKey === true, column.required === true])).toEqual([
      ["tenant_id", "uuid", true, true], ["field_id", "uuid", true, true], ["value_text", "text", true, true], ["record_id", "uuid", false, true],
    ]);
    expect(unique.columns.find((column) => column.name === "record_id")!.references?.onDelete).toBe("CASCADE");
    expect(sql).toContain(`PRIMARY KEY ("tenant_id", "field_id", "value_text")`);
    expect(sql).toContain(`ADD CONSTRAINT "extensible_parts_field_unique_values_record_id_fkey" FOREIGN KEY ("tenant_id", "record_id")`);
  });

  it("protects both side tables with the entity's own tenant policy", () => {
    for (const name of ["extensible_parts", "extensible_parts_field_values", "extensible_parts_field_unique_values"]) {
      expect(sql).toContain(`ALTER TABLE "parts"."${name}" ENABLE ROW LEVEL SECURITY;`);
      expect(sql).toContain(`ALTER TABLE "parts"."${name}" FORCE ROW LEVEL SECURITY;`);
      expect(sql).toContain(`CREATE POLICY "${name}_tenant_isolation" ON "parts"."${name}"`);
    }
    const policy = (name: string) => sql.slice(sql.indexOf(`CREATE POLICY "${name}_tenant_isolation"`)).split(";")[0]!.replaceAll(name, "<table>");
    expect(policy("extensible_parts_field_values")).toBe(policy("extensible_parts"));
    expect(policy("extensible_parts_field_unique_values")).toBe(policy("extensible_parts"));
  });

  it("lets a side-table row through only while its entity row is visible to the same session", () => {
    for (const name of ["extensible_parts_field_values", "extensible_parts_field_unique_values"]) {
      const exists = `app.bypass_rls() OR EXISTS (SELECT 1 FROM "parts"."extensible_parts" AS described WHERE described.tenant_id = "${name}".tenant_id AND described.id = "${name}"."record_id")`;
      expect(sql).toContain([
        `DROP POLICY IF EXISTS "${name}_record_access" ON "parts"."${name}";`,
        `CREATE POLICY "${name}_record_access" ON "parts"."${name}" AS RESTRICTIVE FOR ALL`,
        `  USING (${exists})`,
        `  WITH CHECK (${exists});`,
      ].join("\n"));
      expect(table(manifest, `parts.${name}`).recordAccessFrom).toEqual({ schema: "parts", table: "extensible_parts", column: "record_id" });
    }
    // The entity table itself inherits nothing.
    expect(sql).not.toContain(`"extensible_parts_record_access"`);
  });

  it("gives the side tables the entity's cross-tenant worker policy too", () => {
    const dir = withDocument("extensible-part", (document) => { document.workerAccess = "parts-sync"; });
    const widened = compile(() => {}, { dir });
    expect(table(widened, "parts.extensible_parts_field_values")).toMatchObject({ workerAccess: "parts-sync", workerDml: true });
    expect(table(widened, "parts.extensible_parts_field_unique_values")).toMatchObject({ workerAccess: "parts-sync", workerDml: true });
  });

  it("refuses side tables beyond PostgreSQL's identifier limit", () => {
    const dir = withDocument("extensible-part", (document) => { document.entity = "ExtensiblePartWithAnExceptionallyLongTableNameForTesting"; });
    expect(() => compile(() => {}, { dir, entityAllowlist: ["extensible-part", "rest-custom", "rest-enabled"] })).toThrow(/extensible needs table parts\.extensible_part_with_an_exceptionally_long_table_name_for_testings_field_values, which exceeds PostgreSQL's 63-byte identifier limit/);
  });
});

describe("extensible: the manifest registry", () => {
  it("publishes the entity, its targets, owned single children, projections and the reverse map", () => {
    const registry = compile().extensionRegistry!;
    expect(registry.entities).toEqual({
      ExtensiblePart: {
        table: "parts.extensible_parts",
        valuesTable: "parts.extensible_parts_field_values",
        uniqueTable: "parts.extensible_parts_field_unique_values",
        manageRoles: ["General.All.ReadWrite", "Organization.All.ReadWrite"],
        limits: { fields: 50, filtersPerQuery: 5, formulaDepth: 5, syncFanOut: 100 },
        allowedOsfTypes: expect.any(Array),
        // RestCustom is excluded by the entity.
        targets: [
          { entity: "ExtensiblePart", table: "parts.extensible_parts" },
          { entity: "ExtensiblePartSpec", table: "parts.extensible_part_specs" },
          { entity: "RestEnabled", table: "erp.rest_enableds" },
        ],
        ownedSingleChildren: [{ relation: "spec", entity: "ExtensiblePartSpec", table: "parts.extensible_part_specs", foreignKey: "part_id" }],
        relations: [{ key: "spec", kind: "hasMany", entity: "ExtensiblePartSpec", table: "parts.extensible_part_specs", foreignKey: "part_id", ownership: "owned" }],
      },
    });
    expect(registry.indexProjections).toEqual({ measurement: { number: "value", text: "unit" } });
    // Every entity a lookup or rollup can reach, with who may read it.
    expect(Object.keys(registry.readAccess)).toEqual(["ExtensiblePart", "ExtensiblePartSpec", "RestEnabled"]);
    expect(registry.readAccess.ExtensiblePartSpec).toEqual({ table: "parts.extensible_part_specs", roles: expect.any(Array) });
    expect(registry.referencedBy).toEqual({
      ExtensiblePart: [{ sourceEntity: "ExtensiblePart", valuesTable: "parts.extensible_parts_field_values" }],
      ExtensiblePartSpec: [{ sourceEntity: "ExtensiblePart", valuesTable: "parts.extensible_parts_field_values" }],
      RestEnabled: [{ sourceEntity: "ExtensiblePart", valuesTable: "parts.extensible_parts_field_values" }],
    });
  });

  it("lists an owned child only when it is authorized through its owner", () => {
    const children = (transform: (document: Record<string, any>) => void) =>
      compile(() => {}, { dir: withDocument("extensible-part-spec", transform) }).extensionRegistry!.entities.ExtensiblePart!.ownedSingleChildren;
    // A reader of the part who may not read the spec would see its weight through a formula.
    expect(children((document) => { document.authorization.roles.read = ["General.All.ReadWrite"]; })).toEqual([]);
    expect(children((document) => { document.authorization.roles.update = ["General.All.ReadWrite", "Organization.All.ReadWrite"]; })).toEqual([]);
    // A classified column has reading rules of its own.
    expect(children((document) => {
      document.fields.push({ key: "cost", osfType: "number", label: { en: "Cost" }, classification: { sensitivity: "confidential" },
        persisted: { column: "cost", storageClass: "core" } });
    })).toEqual([]);
    expect(children(() => {}).map((child) => child.relation)).toEqual(["spec"]);
  });

  it("names what narrows the rows of an entity a lookup could reach, never folding it into the roles", () => {
    const access = (transform: (document: Record<string, any>) => void) =>
      compile(() => {}, { dir: withDocument("extensible-part-spec", transform) }).extensionRegistry!.readAccess.ExtensiblePartSpec!;
    expect(access(() => {}).rowPolicy).toBeUndefined();
    expect(access((document) => { document.authorization.rowAccess = { enabled: true, empty: "public" }; }).rowPolicy).toBe("rowAccess");
    expect(access((document) => { document.authorization.roles.read = ["Spec.Reader"]; }).roles).toEqual(["Spec.Reader"]);
  });

  it("does not list an owned child without a one-per-parent key", () => {
    const dir = withDocument("extensible-part-spec", (document) => { delete document.indexes; });
    expect(compile(() => {}, { dir }).extensionRegistry!.entities.ExtensiblePart!.ownedSingleChildren).toEqual([]);
  });

  it("leaves a target out that a reader cannot resolve through its own get", () => {
    const manifest = compile((contract) => { if (contract.entity.name === "RestEnabled") delete contract.entityOperations.get; });
    expect(manifest.extensionRegistry!.entities.ExtensiblePart!.targets.map((target) => target.entity)).toEqual(["ExtensiblePart", "ExtensiblePartSpec"]);
    expect(manifest.extensionRegistry!.referencedBy.RestEnabled).toBeUndefined();
  });

  it("never lists a tenant registry, an entity without writes of its own or the access-control model as a target", () => {
    // No generated create, update or delete: kept by the platform, a plugin or a parent.
    const readOnly = compile((contract) => {
      if (contract.entity.name !== "RestEnabled") return;
      delete contract.entityOperations.create; delete contract.entityOperations.update; delete contract.entityOperations.delete;
    });
    expect(readOnly.extensionRegistry!.entities.ExtensiblePart!.targets.map((target) => target.entity)).toEqual(["ExtensiblePart", "ExtensiblePartSpec"]);
    expect(readOnly.extensionRegistry!.referencedBy.RestEnabled).toBeUndefined();

    let contract: CompiledEntityContract | undefined;
    const manifest = compile((candidate) => { if (candidate.entity.name === "RestEnabled") contract = candidate; });
    const target = table(manifest, "erp.rest_enableds");
    expect(isExtensionTargetCandidate(contract!, target)).toBe(true);
    // A tenant registry: the row is its tenant.
    expect(isExtensionTargetCandidate(contract!, { ...target, constraints: [{ compilerOwned: true, version: "0001_tenant-identity-rest-enableds",
      name: "rest_enableds_tenant_identity_check", kind: "check", expression: "id = tenant_id" }] })).toBe(false);
    expect(isExtensionTargetCandidate(contract!, { ...target, tenantScoped: false, tenantIdentityColumn: "id" })).toBe(false);
    expect(isExtensionTargetCandidate(contract!, { ...target, schema: "platform" })).toBe(false);
    // The access-control model, by name.
    for (const name of EXTENSION_TARGET_DENYLIST) {
      expect(isExtensionTargetCandidate({ ...contract!, entity: { ...contract!.entity, name } }, target)).toBe(false);
    }
    expect(EXTENSION_TARGET_DENYLIST).toEqual(expect.arrayContaining(["AuthorizationProfile", "OrganizationPermission", "UserOrganizationPermission"]));
  });

  it("renders the registry top-level in manifest.json, byte-identically on every run", () => {
    const first = manifestJson(compile());
    const second = manifestJson(compile());
    expect(second).toBe(first);
    const parsed = JSON.parse(first);
    expect(parsed.extensionRegistry.entities.ExtensiblePart.valuesTable).toBe("parts.extensible_parts_field_values");
    expect(Object.keys(parsed).indexOf("extensionRegistry")).toBeLessThan(Object.keys(parsed).indexOf("tables"));
  });

  it("is absent, and the manifest unchanged, when no entity is extensible", () => {
    const plain = compile(() => {}, { entityAllowlist: ["rest-custom", "rest-enabled"] });
    expect(plain.extensionRegistry).toBeUndefined();
    expect(JSON.parse(manifestJson(plain)).extensionRegistry).toBeUndefined();
    expect(schemaSql(plain)).not.toContain("extension_values");
  });
});

describe("extensible: roll-forward", () => {
  // The manifest before the entity became extensible, against the one after.
  const before = compile(() => {}, { dir: withDocument("extensible-part", (document) => { delete document.extensible; }) });
  const after = compile();

  it("only adds tables, a defaulted column and indexes; nothing existing changes", () => {
    const beforeTables = new Map(before.tables.map((entry) => [`${entry.schema}.${entry.name}`, entry]));
    const added: string[] = [];
    for (const entry of after.tables) {
      const key = `${entry.schema}.${entry.name}`;
      const previous = beforeTables.get(key);
      if (!previous) { added.push(key); continue; }
      const previousColumns = new Map(previous.columns.map((column) => [column.name, column]));
      for (const column of entry.columns) {
        const old = previousColumns.get(column.name);
        if (old) expect(column).toEqual(old);
        // A new column must be addable to a populated table without a backfill.
        else expect(column.default !== undefined || column.required !== true).toBe(true);
      }
      expect(entry.columns.filter((column) => previousColumns.has(column.name)).length).toBe(previous.columns.length);
      const afterIndexes = new Map((entry.indexes ?? []).map((index) => [index.name, index]));
      for (const index of previous.indexes ?? []) expect(afterIndexes.get(index.name)).toEqual(index);
      expect(entry.constraints ?? []).toEqual(previous.constraints ?? []);
    }
    expect(added.sort()).toEqual(["parts.extensible_parts_field_unique_values", "parts.extensible_parts_field_values"]);
    expect(after.tables.length - before.tables.length).toBe(2);
  });

  it("keeps every DDL statement of the earlier schema except the extended CREATE TABLE", () => {
    const statements = (manifest: PlatformSchemaManifest) => new Set(schemaSql(manifest).split(/;\n/).map((statement) => statement.trim()));
    const afterStatements = statements(after);
    const missing = [...statements(before)].filter((statement) => !afterStatements.has(statement));
    // The only statement that differs is the entity's CREATE TABLE IF NOT
    // EXISTS, which a built database skips; roll-forward adds the column.
    expect(missing).toHaveLength(1);
    expect(missing[0]).toStartWith(`CREATE TABLE IF NOT EXISTS "parts"."extensible_parts" (`);
  });
});

describe("extensible: platform tables", () => {
  const platform = loadManifest(join(import.meta.dir, "..", "..", "config", "platform-schema.yaml"));
  const of = async (name: string) => table(await platform, `platform.${name}`);

  it("declares append-only definitions with one current key per entity", async () => {
    const definitions = await of("extension_field_definitions");
    expect(definitions).toMatchObject({ tenantScoped: true, domainInternal: true, generatedCrudEligible: false });
    // The worker's grants here are column-precise (apps/api worker-role.ts), never blanket DML.
    for (const name of ["extension_field_definitions", "extension_field_dependencies", "extension_field_backfills"]) {
      expect((await of(name)).workerDml).toBeUndefined();
    }
    expect(definitions.columns.map((column) => `${column.name}:${column.type}${column.required ? "!" : ""}`)).toEqual([
      "id:uuid", "tenant_id:uuid!", "field_id:uuid!", "entity:text!", "key:text!", "version:integer!", "kind:text!",
      "definition:jsonb!", "applies_when:jsonb", "state:text!", "position:integer!", "is_current:boolean!",
      "created_at:timestamptz!", "created_by:uuid",
    ]);
    expect(definitions.indexes).toEqual([
      { name: "extension_field_definitions_version_uidx", columns: ["tenant_id", "field_id", "version"], unique: true },
      { name: "extension_field_definitions_current_key_uidx", columns: ["tenant_id", "entity", "key"], unique: true, where: "is_current AND state <> 'deleted'" },
      { name: "extension_field_definitions_current_entity_idx", columns: ["tenant_id", "entity"], where: "is_current" },
      // One current version per field, whatever writes it.
      { name: "extension_field_definitions_current_field_uidx", columns: ["tenant_id", "field_id"], unique: true, where: "is_current" },
    ]);
  });

  it("keeps a dependency unique whether or not it goes through a reference", async () => {
    const dependencies = await of("extension_field_dependencies");
    expect(dependencies.columns.find((column) => column.name === "via_field")?.required).toBeUndefined();
    expect(dependencies.indexes?.filter((index) => index.unique).map((index) => [index.columns.length, index.where])).toEqual([
      [5, "via_field IS NOT NULL"], [4, "via_field IS NULL"],
    ]);
  });

  it("records backfill progress with defaults a new row needs", async () => {
    const backfills = await of("extension_field_backfills");
    expect(backfills.columns.filter((column) => column.default !== undefined).map((column) => [column.name, column.default])).toEqual([
      ["id", "gen_random_uuid()"], ["state", "'queued'"], ["processed", "0"], ["total", "0"],
      ["created_at", "now()"], ["updated_at", "now()"],
    ]);
  });

  it("closes the kind, state and operation vocabularies with compiler-owned checks", async () => {
    const manifest = await platform;
    const registry = collectPluginMigrationRegistry({ ...manifest, tables: manifest.tables.filter((entry) => entry.name.startsWith("extension_field_")) }, []);
    const sql = registry.migrations.map((migration) => migration.sql).join("\n");
    expect(registry.migrations.every((migration) => migration.plugin === "osf-compiler")).toBe(true);
    expect(sql).toContain("CHECK (kind IN ('stored', 'formula', 'lookup', 'rollup'))");
    expect(sql).toContain("CHECK (state IN ('updating', 'ready', 'deprecated', 'suspended', 'deleted'))");
    expect(sql).toContain("CHECK (operation IN ('retype', 'delete', 'unique', 'formula', 'lookup', 'rollup', 'rebuild'))");
    expect(sql).toContain("CHECK (state IN ('queued', 'running', 'done', 'failed'))");
  });
});
