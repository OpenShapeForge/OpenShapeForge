// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileAuthoringBackendManifest } from "./backend-manifest.js";
import { generateArtifacts } from "../generate.js";
import { collectPluginMigrationRegistry } from "../generate-plugin-migrations.js";
import type { CoreEntity, Field } from "./types.js";
import type { FieldDefinitionInverseCollection } from "./types/field-definition.js";
import type { PlatformSchemaManifest } from "../schema.js";
import type { CompiledEntityContract } from "./types/compiled.js";
import { buildWebManifest, renderWebManifest } from "./web-manifest.js";
import { deriveEntityOsfTypes, normalizeEntityFields } from "./entity-fields.js";

const entityOperation = (action: string) => ({
  name: action, description: action, implementation: { type: "entity", action },
  effects: { data: "read", external: "none" },
  reliability: { idempotency: { mode: "natural" } }, confirmation: { mode: "none" },
});
const materialize = {
  name: "Materialize", description: "Project resolved fields",
  implementation: { type: "plugin", plugin: "example", handler: "project" },
  target: { scope: "collection" },
  input: { schema: { type: "object", properties: { values: { type: "object" } } } },
  output: { schema: { type: "object" } }, errors: [],
  auth: { mode: "session", roles: ["Example.Read"] }, tenancy: { mode: "required" },
  effects: { data: "read", external: "none" },
  reliability: { idempotency: { mode: "natural" } }, confirmation: { mode: "none" },
};
const id: Field = { key: "id", osfType: "string", required: true, validation: { format: "uuid" }, persisted: { column: "id", storageClass: "core" } };

function entity(name: string, fields: Field[], definition = false): CoreEntity {
  return {
    schemaVersion: 3, kind: "coreEntity", module: "core", entity: name, title: name,
    language: "en", domains: ["example"], baseEntity: false,
    authorization: { roles: { read: ["Example.Read"] } },
    fields: [...(definition ? [] : [id]), ...fields],
    operations: definition ? { materialize: structuredClone(materialize) } : { get: entityOperation("get") },
    interfaces: { rest: {}, mcp: { tools: "generic" } },
  } as CoreEntity;
}
function corpus(): CoreEntity[] {
  return [
    entity("Page", []),
    entity("Placement", [
      { key: "page", osfType: "Page", required: true,
        relationship: { inverse: { key: "placements", ownership: "owned", sortable: true, allowedDefinitions: ["Copy", "Link"] } } },
      { key: "definitionKey", osfType: "string", required: true, persisted: { column: "definition_key", storageClass: "core" } },
      { key: "values", osfType: "entityValue", required: true, entityValue: { definitionField: "definitionKey" }, persisted: { column: "values", storageClass: "core" } },
    ]),
    entity("Resource", [{ key: "name", osfType: "string", persisted: { column: "name", storageClass: "core" } }]),
    entity("Copy", [{ key: "body", osfType: "shortText", required: true }, { key: "tags", osfType: "string", cardinality: { min: 0, max: 4 } }], true),
    entity("Link", [{ key: "label", osfType: "string", required: true }, { key: "resource", osfType: "Resource", required: true }], true),
  ];
}

function compileFixture(
  mutate: (entities: CoreEntity[]) => void = () => {},
  profileFields: Field[] = [],
  onCandidate?: (contract: CompiledEntityContract) => void,
): PlatformSchemaManifest {
  const dir = mkdtempSync(join(tmpdir(), "entity-values-"));
  const write = (path: string, value: unknown) => writeFileSync(join(dir, path), JSON.stringify(value));
  try {
    mkdirSync(join(dir, "entities")); mkdirSync(join(dir, "catalogs"));
    write("catalogs/components.yaml", { defaults: {}, components: {} });
    write("catalogs/transforms.yaml", { transforms: {} });
    write("catalogs/osf-types.yaml", { types: {
      entityValue: { kind: "object", valueType: "object", label: { en: "Entity value" } },
      shortText: { kind: "scalar", valueType: "string", validation: { maxLength: 80 }, label: { en: "Text" } },
    } });
    const entities = corpus(); mutate(entities);
    for (const entry of entities) write(`entities/${entry.entity.toLowerCase()}.yaml`, entry);
    if (profileFields.length) {
      mkdirSync(join(dir, "contexts", "example", "partial"), { recursive: true });
      write("contexts/example/partial/copy.yaml", { schemaVersion: 3, kind: "entityProfile", entity: "Copy", extends: "Copy", profile: "example", fields: profileFields });
    }
    return compileAuthoringBackendManifest(dir, {
      mode: "promote", entityAllowlist: entities.map((entry) => entry.entity.toLowerCase()),
      generatedCrudAllowlist: entities.map((entry) => entry.entity.toLowerCase()),
      sourcePathPrefix: "fixtures/entity-values",
      onCandidate: ({ contract }) => onCandidate?.(contract),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const named = (entities: CoreEntity[], name: string) => entities.find((entity) => entity.entity === name)!;
/** The derived `Page.placements` collection is shaped on the referencing field. */
const placements = (entities: CoreEntity[]) => named(entities, "Placement").fields[1]!.relationship!.inverse as FieldDefinitionInverseCollection;
const carrier = (manifest: PlatformSchemaManifest) => manifest.entityValues!.carriers[0]!;
const table = (manifest: PlatformSchemaManifest) => manifest.tables.find((table) => table.source?.authoringEntityName === "Placement")!;
const artifacts = (manifest: PlatformSchemaManifest) => generateArtifacts(manifest);
const sql = (manifest: PlatformSchemaManifest) => artifacts(manifest).find((artifact) => artifact.path.endsWith("schema.sql"))!.contents;
const constraints = (manifest: PlatformSchemaManifest) => collectPluginMigrationRegistry(manifest, []).migrations.map((migration) => migration.sql).join("\n");

describe("entityValue compiled storage and registry", () => {
  it("content-addresses replaceable entity-value CHECK migrations", () => {
    const first = compileFixture();
    const firstChecks = table(first).constraints!.filter((constraint) => constraint.kind === "check");
    expect(firstChecks.every((constraint) => constraint.compilerOwned && constraint.replaceExisting)).toBe(true);
    expect(firstChecks.every((constraint) => /^0001_entity-value-.+-[a-f0-9]{12}$/.test(constraint.version))).toBe(true);

    const second = compileFixture((entities) => {
      named(entities, "Copy").fields.push({ key: "subtitle", osfType: "string" });
    });
    const firstVersion = firstChecks.find((constraint) => constraint.name.includes("copy_values"))!.version;
    const secondVersion = table(second).constraints!.find((constraint) => constraint.name.includes("copy_values"))!.version;
    expect(secondVersion).not.toBe(firstVersion);
  });

  it("compiles opt-in symbolic arguments alongside real foreign keys with exclusive storage", () => {
    const manifest = compileFixture(entities => {
      named(entities, "Placement").fields.find(field => field.key === "values")!.entityValue!.parameterBindings = true;
    });
    const reference = carrier(manifest).definitions.Link!.references[0]!;
    expect(reference.parameterColumn).toBeDefined();
    expect(table(manifest).columns.find(column => column.name === reference.parameterColumn)?.type).toBe("text");
    const generated = sql(manifest) + constraints(manifest);
    expect(generated).toContain(`num_nonnulls("${reference.column}", "${reference.parameterColumn}") = 1`);
    expect(generated).toContain(`FOREIGN KEY`);
    expect(generated).toContain(reference.column);
    expect(carrier(compileFixture()).definitions.Link!.references[0]!.parameterColumn).toBeUndefined();
  });
  for (const [policy, value] of Object.entries({
    classification: { sensitivity: "pii" },
    authorization: { roles: { read: ["Example.Read"] } },
    permissions: { read: ["Example.Read"] },
    writtenBy: ["materialize"],
    secureInput: { type: "secureInput" },
    immutable: true,
  })) {
    it(`rejects unsupported ${policy} policies on own fields, references and nested leaves`, () => {
      const protectedField = { key: "guarded", osfType: "string", [policy]: value } as Field;
      for (const field of [protectedField,
        { key: "nested", osfType: "object", children: [protectedField] } as Field,
        { key: "items", osfType: "object", cardinality: "collection", item: protectedField } as Field,
      ]) {
        expect(() => compileFixture((entities) => named(entities, "Copy").fields.push(field))).toThrow(`field policy ${policy}`);
      }
      expect(() => compileFixture((entities) => Object.assign(named(entities, "Link").fields[1]!, { [policy]: value }))).toThrow(`field policy ${policy}`);
    });
  }

  it("allows immutable:false but rejects inherited immutable:true on nested value fields", () => {
    expect(() => compileFixture((entities) => named(entities, "Copy").fields[0]!.immutable = false)).not.toThrow();
    const definition = entity("FixedValue", [{ key: "nested", osfType: "object", children: [{ key: "fixed", osfType: "fixedText" }] }], true);
    const fixedText = { kind: "scalar" as const, valueType: "string" as const, label: { en: "Fixed" }, immutable: true };
    expect(() => normalizeEntityFields(definition, deriveEntityOsfTypes([definition], { fixedText }))).toThrow("field policy immutable");
  });

  it("rejects guarded profile fields and semantic policies before model projection can erase them", () => {
    expect(() => compileFixture(undefined, [{ key: "profileSecret", osfType: "string", permissions: { read: ["Example.Read"] } }])).toThrow("field policy permissions");
    const definition = entity("SecureValue", [{ key: "nested", osfType: "object", children: [{ key: "sensitive", osfType: "privateText" }] }], true);
    const catalog = deriveEntityOsfTypes([definition], {
      privateText: { kind: "scalar", valueType: "string", label: { en: "Private" }, classification: { sensitivity: "pii" } },
    });
    expect(() => normalizeEntityFields(definition, catalog)).toThrow("field policy classification");
  });

  it("refuses guarded compiled definitions before emitting a standalone Web catalog", () => {
    const entries: Array<{ slug: string; contract: CompiledEntityContract }> = [];
    compileFixture(undefined, [], (contract) => entries.push({ slug: contract.entity.name.toLowerCase(), contract }));
    const copy = entries.find((entry) => entry.contract.entity.name === "Copy")!.contract;
    copy.model.fields[0]!.classification = { sensitivity: "pii" };
    expect(() => buildWebManifest(entries)).toThrow("field policy classification");
  });

  it("uses normal resolved entity definitions without standalone definition tables or CRUD", () => {
    const observed: CompiledEntityContract[] = [];
    const manifest = compileFixture(undefined, [], (contract) => observed.push(contract));
    expect(manifest.tables.map((table) => table.source?.authoringEntityName).sort()).toEqual(["Page", "Placement", "Resource"]);
    expect(Object.keys(observed.find((contract) => contract.entity.name === "Copy")!.entityOperations)).toEqual([]);
    expect(carrier(manifest)).toMatchObject({ entityName: "Placement", fieldKey: "values", definitionField: "definitionKey", schema: "erp", valuesColumn: "values", definitionColumn: "definition_key" });
    const copy = carrier(manifest).definitions.Copy!;
    expect(copy).toMatchObject({ schemaVersion: 1, references: [] });
    expect(copy.materializeOperationId).toContain("materialize");
    expect(copy.fields.find((field) => field.key === "body")).toMatchObject({ baseType: "string", validation: { maxLength: 80 } });
    expect(copy.fields.find((field) => field.key === "tags")!.cardinality).toEqual({ min: 0, max: 4 });
    expect(copy.valueSchema).toMatchObject({ type: "object", additionalProperties: false, required: ["body"] });
    expect(copy.definitionHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("emits real tenant-safe namespaced FK SQL and uses the existing FK/index planner", () => {
    const manifest = compileFixture();
    const ref = carrier(manifest).definitions.Link!.references[0]!;
    expect(ref).toMatchObject({ fieldKey: "resource", targetEntity: "Resource", schema: "erp", required: true, cardinality: "single" });
    expect(table(manifest).columns.find((column) => column.name === ref.column)).toMatchObject({ type: "uuid", references: { localColumns: ["tenant_id", ref.column], targetColumns: ["tenant_id", "id"] } });
    expect(table(manifest).indexes?.some((index) => index.columns.join() === `tenant_id,${ref.column}`)).toBe(true);
    expect(sql(manifest)).toContain(`FOREIGN KEY ("tenant_id", "${ref.column}")`);
    expect(sql(manifest)).toContain(`REFERENCES "erp"."${ref.table}"("tenant_id", "id")`);
    expect(table(manifest).columns.find((column) => column.name === "page_id_position")).toMatchObject({ type: "integer" });
    expect(carrier(manifest).definitions.Link!.valueSchema).toMatchObject({ properties: { label: { type: "string" } }, additionalProperties: false });
    expect((carrier(manifest).definitions.Link!.valueSchema.properties as object)).not.toHaveProperty("resource");
  });

  it("emits discriminator, conditional required/inactive FK and no-reference-JSON CHECK SQL", () => {
    const manifest = compileFixture();
    const ref = carrier(manifest).definitions.Link!.references[0]!;
    const ddl = constraints(manifest);
    expect(ddl).toContain('"definition_key" IN (\'Copy\', \'Link\')');
    expect(ddl).toContain(`CASE WHEN "definition_key" = 'Link' THEN "${ref.column}" IS NOT NULL ELSE "${ref.column}" IS NULL END`);
    expect(ddl).toContain(`("values" - ARRAY['label']::text[]) = '{}'::jsonb`);
    expect(ddl).toContain(`jsonb_typeof("values") = 'object'`);
    expect(collectPluginMigrationRegistry(manifest, []).migrations.every((entry) => entry.plugin === "osf-compiler")).toBe(true);
  });

  it("serializes the agreed registry into the actual runtime db/manifest.json", () => {
    const manifest = compileFixture();
    const output = JSON.parse(artifacts(manifest).find((artifact) => artifact.path.endsWith("db/manifest.json"))!.contents);
    expect(output.entityValues).toEqual(manifest.entityValues);
    expect(output.tables.some((table: { entity: string }) => table.entity === "Copy")).toBe(false);
    expect(output.entityValues.collections).toEqual([{ entityName: "Page", fieldKey: "placements", targetEntity: "Placement", allowedDefinitions: ["Copy", "Link"] }]);
  });

  it("includes profile-resolved value fields and references rather than a second registry", () => {
    const manifest = compileFixture(undefined, [{ key: "caption", osfType: "shortText" }, { key: "source", osfType: "Resource" }]);
    const copy = carrier(manifest).definitions.Copy!;
    expect(copy.fields.find((field) => field.key === "caption")).toMatchObject({ baseType: "string", validation: { maxLength: 80 } });
    expect(copy.references).toHaveLength(1);
    expect(copy.references[0]).toMatchObject({ fieldKey: "source", targetEntity: "Resource", required: false });
    expect(constraints(manifest)).toContain(`"definition_key" = 'Copy' OR "${copy.references[0]!.column}" IS NULL`);
  });

  it("projects the same logical definition fields into Web without SQL storage or standalone routes", () => {
    const entries: Array<{ slug: string; contract: CompiledEntityContract }> = [];
    const manifest = compileFixture(undefined, [{ key: "caption", osfType: "shortText" }],
      (contract) => entries.push({ slug: contract.entity.name.toLowerCase(), contract }));
    const web = JSON.parse(renderWebManifest(buildWebManifest(entries)));
    expect(web.entities.Copy).toBeUndefined();
    expect(web.entities.Link).toBeUndefined();
    expect(web.entityValueDefinitions.Copy.fields.map((field: { key: string }) => field.key)).toEqual(carrier(manifest).definitions.Copy!.fields.map((field) => field.key));
    expect(web.entityValueDefinitions.Copy.fields.find((field: { key: string }) => field.key === "caption")).toMatchObject({ baseType: "string", maxLength: 80 });
    expect(web.entityValueDefinitions.Link.fields.find((field: { key: string }) => field.key === "resource")).toMatchObject({ baseType: "string", osfType: "Resource", cardinality: "one", required: true, relationship: { targetEntityId: "Resource" } });
    expect(web.entityValueDefinitions.Link.materializeOperationId).toBe(carrier(manifest).definitions.Link!.materializeOperationId);
    const json = JSON.stringify(web.entityValueDefinitions);
    for (const physical of ["valuesColumn", "definitionColumn", "foreignKey", "references", '"table"', '"schema"', '"route"', '"operations"', carrier(manifest).definitions.Link!.references[0]!.column]) {
      expect(json).not.toContain(physical);
    }
  });

  it("produces deterministic metadata, SQL and hashes; fields and operations invalidate the hash", () => {
    const first = compileFixture(); const second = compileFixture();
    expect(artifacts(first)).toEqual(artifacts(second));
    expect(constraints(first)).toBe(constraints(second));
    const changed = compileFixture((entities) => named(entities, "Copy").fields[0]!.required = false);
    expect(carrier(changed).definitions.Copy!.definitionHash).not.toBe(carrier(first).definitions.Copy!.definitionHash);
    expect(carrier(changed).definitions.Link!.definitionHash).toBe(carrier(first).definitions.Link!.definitionHash);
    const opChanged = compileFixture((entities) => (named(entities, "Copy").operations!.materialize as any).implementation.handler = "otherProjection");
    expect(carrier(opChanged).definitions.Copy!.definitionHash).not.toBe(carrier(first).definitions.Copy!.definitionHash);
  });

  it("fails closed for missing/non-value definitions and direct references to identityless entities", () => {
    expect(() => compileFixture((entities) => placements(entities).allowedDefinitions = ["Missing"])).toThrow("unknown allowed definition");
    expect(() => compileFixture((entities) => named(entities, "Copy").fields.unshift(id))).toThrow("baseEntity:false without an id");
    expect(() => compileFixture((entities) => named(entities, "Resource").fields.push({ key: "bad", osfType: "Copy" }))).toThrow("identity-less entity Copy");
  });

  it("fails closed for standalone definition CRUD, record targets and mutating materialization", () => {
    expect(() => compileFixture((entities) => (named(entities, "Copy").operations as any).get = entityOperation("get"))).toThrow("standalone entity CRUD");
    expect(() => compileFixture((entities) => {
      const operation = named(entities, "Copy").operations!.materialize as any;
      operation.target = { scope: "record", inputField: "id" };
      operation.input.schema = { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } };
    })).toThrow("record target");
    expect(() => compileFixture((entities) => (named(entities, "Copy").operations!.materialize as any).effects.external = "write")).toThrow("read-only data effects");
  });

  it("fails closed for reference collections, absent target storage and JSON-hidden references", () => {
    expect(() => compileFixture((entities) => named(entities, "Link").fields[1]!.cardinality = "collection")).toThrow("inverse collections are derived");
    expect(() => compileFixture((entities) => entities.splice(entities.findIndex((entity) => entity.entity === "Resource"), 1))).toThrow("unknown osfType Resource");
    expect(() => compileFixture((entities) => named(entities, "Copy").fields.push({ key: "nested", osfType: "object", children: [{ key: "hidden", osfType: "Resource" }] }))).toThrow("not IDs inside JSON");
    expect(() => compileFixture((entities) => named(entities, "Copy").fields.push({ key: "nestedItems", osfType: "object", cardinality: "collection", item: { key: "hidden", osfType: "Resource" } }))).toThrow("not IDs inside JSON");
  });

  it("fails closed for unbounded collection definition choice and non-scalar discriminators", () => {
    expect(() => compileFixture((entities) => delete placements(entities).allowedDefinitions)).toThrow("identity-less entities must be used");
    expect(() => compileFixture((entities) => {
      const field = named(entities, "Placement").fields[2]!;
      field.osfType = "Resource";
    })).toThrow("required persisted scalar string");
  });

  it("namespaces the same reference field independently for different definitions and targets", () => {
    const manifest = compileFixture((entities) => named(entities, "Copy").fields.push({ key: "resource", osfType: "Page" }));
    const definitions = carrier(manifest).definitions;
    expect(definitions.Copy!.references[0]!.column).not.toBe(definitions.Link!.references[0]!.column);
    expect(definitions.Copy!.references[0]!.targetEntity).toBe("Page");
    expect(definitions.Link!.references[0]!.targetEntity).toBe("Resource");
    expect(constraints(manifest)).toContain(`num_nonnulls("page_id") = 1`);
  });

  it("constrains each owning collection independently and prevents orphan or double ownership", () => {
    const manifest = compileFixture((entities) => {
      placements(entities).allowedDefinitions = ["Copy"];
      const placement = named(entities, "Placement");
      placement.fields[1]!.required = false;
      placement.fields.push({ key: "linkPage", osfType: "Page", relationship: { inverse: { key: "links", ownership: "owned", allowedDefinitions: ["Link"] } } });
    });
    const ddl = constraints(manifest);
    expect(ddl).toContain(`"page_id" IS NULL OR "definition_key" IN ('Copy')`);
    expect(ddl).toContain(`"link_page_id" IS NULL OR "definition_key" IN ('Link')`);
    expect(ddl).toContain(`num_nonnulls("link_page_id", "page_id") = 1`);
  });

  it("allows generic projection without a materialize operation and refuses omitted mutation grants", () => {
    const manifest = compileFixture((entities) => {
      const copy = named(entities, "Copy");
      copy.operations = { inspect: copy.operations!.materialize! };
    });
    expect(carrier(manifest).definitions.Copy!.materializeOperationId).toBeUndefined();
    expect(() => compileFixture((entities) => {
      (named(entities, "Resource").operations as any).create = {
        ...entityOperation("create"), effects: { data: "write", external: "none" },
        reliability: { idempotency: { mode: "none" } },
      };
    })).toThrow("authorization.roles.create");
  });

  it("rejects duplicate profile fields and unsafe entityValue metadata shapes", () => {
    expect(() => compileFixture(undefined, [{ key: "body", osfType: "boolean" }])).toThrow("duplicate effective value fields");
    expect(() => compileFixture((entities) => named(entities, "Placement").fields[3]!.cardinality = "collection")).toThrow("single entityValue object");
    expect(() => compileFixture((entities) => delete named(entities, "Placement").fields[3]!.entityValue)).toThrow("definitionField metadata");
    expect(() => compileFixture((entities) => placements(entities).ownership = "reference")).toThrow("owned inverse collection");
  });
});
