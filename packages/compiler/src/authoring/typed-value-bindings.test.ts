// SPDX-License-Identifier: BUSL-1.1
/**
 * What the compiler owns of the typed-variable runtime: the typed-value pair a
 * field authors with `typedBy`, and the one server-owned bindings map an
 * entity with a bindable field gets. Both are metadata the runtime resolves
 * from the manifest alone, so what is proven here is that the manifest, the
 * DDL and the published contract agree about them.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { compileAuthoringBackendManifest } from "./backend-manifest.js";
import { generateArtifacts } from "../generate.js";
import {
  bindableEntityFields,
  entityBindingControlProperties,
  entityOperationJsonSchemas,
  entityRecordOutputSchema,
  withEntityBindingControls,
} from "../entity-operation-json-schema.js";
import { FIELD_BINDINGS_COLUMN, FIELD_BINDINGS_FIELD } from "@openshapeforge/operations";
import type { CoreEntity, Field } from "./types.js";
import type { CompiledEntityContract } from "./types/compiled.js";
import type { PlatformSchemaManifest } from "../schema.js";

const entityOperation = (action: string) => ({
  name: action, description: action, implementation: { type: "entity", action },
  effects: { data: action === "get" ? "read" : "write", external: "none" },
  reliability: { idempotency: { mode: action === "get" ? "natural" : "none" } },
  confirmation: { mode: "none" },
});
const id: Field = {
  key: "id", osfType: "string", required: true,
  validation: { format: "uuid" }, persisted: { column: "id", storageClass: "core" },
};

function entity(name: string, fields: Field[]): CoreEntity {
  return {
    schemaVersion: 3, kind: "coreEntity", module: "core", entity: name, title: name,
    language: "en", domains: ["example"], baseEntity: false,
    authorization: { roles: { read: ["Example.Read"], create: ["Example.Write"], update: ["Example.Write"] } },
    fields: [id, ...fields],
    operations: { get: entityOperation("get"), create: entityOperation("create"), update: entityOperation("update") },
    interfaces: { rest: {}, mcp: { tools: "generic" } },
  } as CoreEntity;
}

/** A tenant global: a value typed by the FieldDefinition stored beside it. */
function globals(): Field[] {
  return [
    { key: "key", osfType: "string", required: true, persisted: { column: "key", storageClass: "core" } },
    { key: "definition", osfType: "fieldDefinition", required: true, persisted: { column: "definition", storageClass: "core" } },
    {
      key: "value", osfType: "typedValue", required: true, typedBy: { definitionField: "definition" },
      persisted: { column: "value", storageClass: "core" },
    },
  ];
}

/** A record with two fields that accept a variable, and one that does not. */
function bindable(): Field[] {
  return [
    { key: "title", osfType: "string", required: true, variables: "whole", persisted: { column: "title", storageClass: "core" } },
    { key: "body", osfType: "markdown", variables: "template", persisted: { column: "body", storageClass: "core" } },
    { key: "note", osfType: "string", persisted: { column: "note", storageClass: "core" } },
  ];
}

function corpus(): CoreEntity[] {
  return [entity("Variable", globals()), entity("Memo", bindable())];
}

function compileFixture(
  mutate: (entities: CoreEntity[]) => void = () => {},
  onCandidate?: (contract: CompiledEntityContract) => void,
): PlatformSchemaManifest {
  const dir = mkdtempSync(join(tmpdir(), "typed-value-bindings-"));
  const write = (path: string, value: unknown) => writeFileSync(join(dir, path), JSON.stringify(value));
  try {
    mkdirSync(join(dir, "entities")); mkdirSync(join(dir, "catalogs"));
    write("catalogs/components.yaml", { defaults: {}, components: {} });
    write("catalogs/transforms.yaml", { transforms: {} });
    write("catalogs/osf-types.yaml", { types: {
      fieldDefinition: { kind: "object", baseType: "object", label: { en: "Field definition" } },
      typedValue: { kind: "object", baseType: "object", label: { en: "Typed value" } },
      markdown: { kind: "scalar", baseType: "string", label: { en: "Markdown" } },
    } });
    const entities = corpus(); mutate(entities);
    for (const entry of entities) write(`entities/${entry.entity.toLowerCase()}.yaml`, entry);
    return compileAuthoringBackendManifest(dir, {
      mode: "promote", entityAllowlist: entities.map((entry) => entry.entity.toLowerCase()),
      generatedCrudAllowlist: entities.map((entry) => entry.entity.toLowerCase()),
      sourcePathPrefix: "fixtures/typed-value-bindings",
      onCandidate: ({ contract }) => onCandidate?.(contract),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const named = (entities: CoreEntity[], name: string) => entities.find((entry) => entry.entity === name)!;
const tableOf = (manifest: PlatformSchemaManifest, name: string) =>
  manifest.tables.find((table) => table.source?.authoringEntityName === name)!;
const columnOf = (manifest: PlatformSchemaManifest, entityName: string, column: string) =>
  tableOf(manifest, entityName).columns.find((candidate) => candidate.name === column);
const schemaSql = (manifest: PlatformSchemaManifest) =>
  generateArtifacts(manifest).find((artifact) => artifact.path.endsWith("schema.sql"))!.contents;

function contractOf(name: string, mutate: (entities: CoreEntity[]) => void = () => {}): CompiledEntityContract {
  let found: CompiledEntityContract | undefined;
  compileFixture(mutate, (contract) => {
    if (contract.entity.name === name) found = contract;
  });
  return found!;
}

describe("a value typed by the definition stored beside it", () => {
  it("resolves the pair to columns the write path can read from the manifest alone", () => {
    const manifest = compileFixture();
    expect(columnOf(manifest, "Variable", "value")).toMatchObject({
      type: "jsonb",
      typedBy: { definitionField: "definition", definitionColumn: "definition" },
    });
    // Both halves are JSON, which is what makes the stored definition the
    // only contract the value has.
    expect(columnOf(manifest, "Variable", "definition")?.type).toBe("jsonb");
    // Nothing else claims to be typed at runtime.
    expect(tableOf(manifest, "Memo").columns.some((column) => column.typedBy)).toBe(false);
  });

  it("refuses a pair that would leave the value without a contract", () => {
    const valueField = (entities: CoreEntity[]) =>
      named(entities, "Variable").fields.find((field) => field.key === "value")!;
    expect(() => compileFixture((entities) => {
      valueField(entities).typedBy = { definitionField: "key" };
    })).toThrow(/definitionField must name a required persisted single fieldDefinition field/);
    expect(() => compileFixture((entities) => {
      named(entities, "Variable").fields.find((field) => field.key === "definition")!.required = false;
    })).toThrow(/definitionField must name a required persisted single fieldDefinition field/);
    expect(() => compileFixture((entities) => {
      delete valueField(entities).typedBy;
    })).toThrow(/typedValue requires typedBy definitionField metadata/);
    expect(() => compileFixture((entities) => {
      valueField(entities).cardinality = { min: 0, max: 4 };
    })).toThrow(/typedBy requires a single typedValue/);
  });
});

describe("one server-owned bindings map per bindable entity", () => {
  it("lists the bindable fields with the mode each one authored, and nothing else", () => {
    const manifest = compileFixture();
    expect(columnOf(manifest, "Memo", FIELD_BINDINGS_COLUMN)).toMatchObject({
      type: "jsonb",
      fieldBindings: {
        fields: [
          { field: "body", column: "body", variables: "template" },
          { field: "title", column: "title", variables: "whole" },
        ],
      },
    });
    expect(columnOf(manifest, "Memo", FIELD_BINDINGS_COLUMN)?.required).not.toBe(true);
    // The map is server-owned: it backs no authored field, so no transport
    // accepts it as a value.
    expect(columnOf(manifest, "Memo", FIELD_BINDINGS_COLUMN)?.sourceField).toBeUndefined();
    // An entity whose fields take literals only keeps the table it had.
    expect(columnOf(manifest, "Variable", FIELD_BINDINGS_COLUMN)).toBeUndefined();
  });

  it("backs the map with a CHECK that admits only this entity's bindable fields", () => {
    const manifest = compileFixture();
    const constraint = tableOf(manifest, "Memo").constraints!
      .find((candidate) => candidate.name.includes(`${FIELD_BINDINGS_COLUMN}_bindings`))!;
    expect(constraint.kind).toBe("check");
    if (constraint.kind !== "check") throw new Error("Expected the compiler-owned bindings CHECK");
    expect(constraint.expression).toContain("jsonb_typeof");
    expect(constraint.expression).toContain("'body'");
    expect(constraint.expression).toContain("'title'");
    expect(constraint.expression).not.toContain("'note'");
    expect(schemaSql(manifest)).toContain(FIELD_BINDINGS_COLUMN);
  });

  it("refuses an authored column that would collide with the map", () => {
    expect(() => compileFixture((entities) => {
      named(entities, "Memo").fields.push({
        key: "fieldBindings", osfType: "string",
        persisted: { column: FIELD_BINDINGS_COLUMN, storageClass: "core" },
      });
    })).toThrow(new RegExp(`${FIELD_BINDINGS_COLUMN} column is owned by the field-binding runtime`));
  });
});

describe("the published contract of a bindable entity", () => {
  it("offers the two binding controls beside values, shaped by each field's mode", () => {
    const contract = contractOf("Memo");
    expect(bindableEntityFields(contract)).toEqual([
      { key: "body", variables: "template" },
      { key: "title", variables: "whole" },
    ]);
    const controls = entityBindingControlProperties(contract) as {
      bindings: { properties: Record<string, Record<string, unknown>> };
      unbind: { items: { enum: string[] } };
    };
    // A whole-value field takes a reference; a template field takes the
    // authored text its tokens are filled from. Neither takes the other.
    expect(controls.bindings.properties.title).toMatchObject({ type: "string" });
    expect(controls.bindings.properties.title!.pattern).toContain("chips");
    expect(controls.bindings.properties.body).toMatchObject({
      type: "object", required: ["template"], additionalProperties: false,
    });
    expect(controls.unbind.items.enum).toEqual(["body", "title"]);
    // A field that authors no variable mode is not offered at all.
    expect(Object.keys(controls.bindings.properties)).toEqual(["body", "title"]);
    // An entity without a bindable field keeps the contract it had.
    expect(entityBindingControlProperties(contractOf("Variable"))).toEqual({});
  });

  it("merges the same controls into a flat transport input, once", () => {
    const contract = contractOf("Memo");
    const flat = withEntityBindingControls({ type: "object", properties: { title: { type: "string" } } }, contract);
    expect(Object.keys(flat.properties as Record<string, unknown>)).toEqual(["title", "bindings", "unbind"]);
    expect(withEntityBindingControls({ type: "object" }, contractOf("Variable"))).toEqual({ type: "object" });
  });

  it("a required field may arrive as a literal or a binding on nested and flat inputs", () => {
    const contract = contractOf("Memo");
    const ajv = new Ajv2020.default({ strict: false });
    addFormats.default(ajv);
    const nested = ajv.compile(entityOperationJsonSchemas(contract, contract.entityOperations.create!, [contract], {}).inputSchema);
    expect(nested({ values: { title: "Literal" } })).toBe(true);
    expect(nested({ values: {}, bindings: { title: "chips.title" } })).toBe(true);
    expect(nested({ values: {} })).toBe(false);
    expect(nested({ values: {}, bindings: { body: { template: "Not the required field" } } })).toBe(false);
    const flat = ajv.compile(withEntityBindingControls({ type: "object", properties: { title: { type: "string" } }, required: ["title"] }, contract));
    expect(flat({ title: "Literal" })).toBe(true);
    expect(flat({ bindings: { title: "chips.title" } })).toBe(true);
    expect(flat({})).toBe(false);
  });

  it("returns the binding beside the value it resolved to, so a reader can tell them apart", () => {
    const output = entityRecordOutputSchema(contractOf("Memo"));
    const properties = output.properties as Record<string, Record<string, unknown>>;
    const bindings = properties[FIELD_BINDINGS_FIELD]!;
    expect(bindings).toBeDefined();
    // Nullable: a record with nothing bound says so rather than omitting it.
    expect(JSON.stringify(bindings)).toContain("null");
    expect(JSON.stringify(bindings)).toContain("template");
    expect(output.required as string[]).not.toContain(FIELD_BINDINGS_FIELD);
    expect((entityRecordOutputSchema(contractOf("Variable")).properties as Record<string, unknown>)[FIELD_BINDINGS_FIELD])
      .toBeUndefined();
  });
});
