// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import type { CompiledEntityContract, CompiledField } from "./authoring/types.js";
import { materializeEntityInputSources, resolveEntityInputSources } from "./entity-input-sources.js";

const fields: CompiledField[] = [{
  key: "title", osfType: "string", baseType: "string", cardinality: "single", required: true,
  label: { en: "Title" }, render: { component: "Input" }, validation: { minLength: 1, maxLength: 80 },
}, {
  key: "serverValue", osfType: "string", baseType: "string", cardinality: "single", required: false,
  label: { en: "Server" }, render: { component: "Input" }, writtenBy: ["example.server"],
}];
const contract = { entity: { name: "Example" }, model: { fields, relationships: [] }, storage: { columns: [] } } as unknown as CompiledEntityContract;
const input = { type: "object", properties: {
  record: { "x-osf-entityInput": { entity: "Example", fields: ["title"] } },
}, required: ["record"], additionalProperties: false };

test("nested input gets the canonical entity field constraints and requiredness", () => {
  const result = resolveEntityInputSources(input, [contract], {});
  expect(result).toMatchObject({ properties: { record: {
    type: "object", properties: { title: { type: "string", minLength: 1, maxLength: 80 } },
    required: ["title"], additionalProperties: false,
  } } });
  expect(JSON.stringify(result)).not.toContain("x-osf-entityInput");
  expect(JSON.stringify(input)).toContain("x-osf-entityInput");
  const changed = { ...contract, model: { ...contract.model, fields: [{ ...fields[0]!, validation: { maxLength: 30 } }] } };
  expect(resolveEntityInputSources(input, [changed], {})).toMatchObject({ properties: { record: { properties: { title: { maxLength: 30 } } } } });
});

test("references cannot override rules or select missing or server-owned fields", () => {
  const reference = (entity: string, selected: string[]) => ({ "x-osf-entityInput": { entity, fields: selected } });
  expect(() => resolveEntityInputSources(reference("Missing", ["title"]), [contract], {})).toThrow("Unknown");
  expect(() => resolveEntityInputSources(reference("Example", ["missing"]), [contract], {})).toThrow("Unavailable");
  expect(() => resolveEntityInputSources(reference("Example", ["serverValue"]), [contract], {})).toThrow("Unavailable");
  expect(() => resolveEntityInputSources(reference("Example", ["id"]), [contract], {})).toThrow("Unavailable");
  expect(() => resolveEntityInputSources(reference("Example", ["title", "title"]), [contract], {})).toThrow("unique");
  expect(() => resolveEntityInputSources({ ...reference("Example", ["title"]), additionalProperties: true }, [contract], {})).toThrow("override");
});

test("collection input admits only a matching owned collection and canonical item source", () => {
  const owner = { ...contract, entity: { ...contract.entity, name: "Owner" }, model: { ...contract.model,
    relationships: [{ key: "items", kind: "hasMany", ownership: "owned", target: "Example" }],
  } } as unknown as CompiledEntityContract;
  const collection = { type: "array", "x-osf-collection": { entity: "Owner", field: "items" },
    items: { "x-osf-entityInput": { entity: "Example", fields: ["title"] } } };
  const compiled = resolveEntityInputSources(collection, [owner, contract], {});
  expect(compiled).toMatchObject({
    "x-osf-collection": { entity: "Owner", field: "items" }, items: { properties: { title: { minLength: 1 } } },
  });
  expect(resolveEntityInputSources(compiled, [owner, contract], {})).toEqual(compiled);
  expect(() => resolveEntityInputSources({ ...collection, type: "object" }, [owner, contract], {})).toThrow("requires an array");
  expect(() => resolveEntityInputSources({ ...collection, "x-osf-collection": { entity: "Owner", field: "missing" } }, [owner, contract], {})).toThrow("owned collection");
  const nonOwned = { ...owner, model: { ...owner.model, relationships: [{ ...owner.model.relationships[0]!, ownership: "reference" as const }] } };
  expect(() => resolveEntityInputSources(collection, [nonOwned, contract], {})).toThrow("owned collection");
  expect(() => resolveEntityInputSources({ ...collection, items: { "x-osf-entityInput": { entity: "Other", fields: ["title"] } } }, [owner, contract], {})).toThrow("matching canonical items");
});

test("input and output sources lower identically in both canonical operation projections", () => {
  const operation = () => ({ input: { kind: "json-schema", schema: structuredClone(input) }, output: { kind: "json-schema", schema: structuredClone(input) } });
  const entity = { ...contract, entityOperations: { create: operation() },
    pluginOperations: [{ definition: { input: { schema: structuredClone(input) }, output: { schema: structuredClone(input) } } }],
  } as unknown as CompiledEntityContract;
  const expected = resolveEntityInputSources(input, [entity], {});
  materializeEntityInputSources([entity], {});
  const create = entity.entityOperations.create!;
  const plugin = entity.pluginOperations![0]!.definition;
  expect(create.input).toEqual({ kind: "json-schema", schema: expected });
  expect(create.output).toEqual({ kind: "json-schema", schema: expected });
  expect(plugin.input!.schema).toEqual(expected);
  expect(plugin.output!.schema).toEqual(expected);
  const once = JSON.stringify(entity);
  materializeEntityInputSources([entity], {});
  expect(JSON.stringify(entity)).toBe(once);
  expect(once).not.toContain("x-osf-entityInput");
});

test("managed choices fail closed for missing or incompatible canonical sources", () => {
  const source = (entity: string, valueField?: string) => ({ ...contract,
    entityOperations: {}, model: { ...contract.model, fields: [{ ...fields[0]!,
      options: { type: "entity" as const, source: entity, ...(valueField ? { valueField } : {}) },
    }] },
  });
  expect(() => materializeEntityInputSources([source("Example", "title")], {})).not.toThrow();
  expect(() => materializeEntityInputSources([source("Example")], {})).not.toThrow();
  expect(() => materializeEntityInputSources([source("Missing")], {})).toThrow("Invalid entity option source");
  expect(() => materializeEntityInputSources([source("Example", "missing")], {})).toThrow("Invalid entity option source");
  const incompatible = source("Example", "title");
  incompatible.model.fields[0]!.baseType = "boolean";
  expect(() => materializeEntityInputSources([incompatible], {})).toThrow("Invalid entity option source");
});

test("version-sourced fields resolve only a stored field-definition collection on the versioned head", () => {
  const head = { ...contract, entity: { ...contract.entity, name: "Head" }, versioning: { versionEntity: "HeadVersion" },
    storage: { columns: [{ field: "schema", column: "schema_definitions", type: "jsonb" }] },
    model: { ...contract.model, fields: [{ key: "schema", osfType: "fieldDefinition", cardinality: "collection" }] }, entityOperations: {} } as unknown as CompiledEntityContract;
  const value = { ...contract, entity: { ...contract.entity, name: "Value", valueDefinition: true }, entityOperations: {}, model: { ...contract.model, fields: [
    { key: "version", cardinality: "single", relationship: { target: "HeadVersion" } },
    { key: "values", baseType: "object", cardinality: "single", valueFieldsFrom: { reference: "version", field: "schema" } },
  ] } } as unknown as CompiledEntityContract;
  materializeEntityInputSources([head, value], {});
  expect(value.model.fields[1]!.valueFieldsFrom).toEqual({ reference: "version", field: "schema", snapshotColumn: "schema_definitions", headEntity: "Head" });
  const bad = structuredClone(value);
  bad.model.fields[1]!.valueFieldsFrom!.field = "missing";
  expect(() => materializeEntityInputSources([head, bad], {})).toThrow("stored FieldDefinition collection");
  const ordinary = structuredClone(value);
  ordinary.entity.valueDefinition = false;
  expect(() => materializeEntityInputSources([head, ordinary], {})).toThrow("only on entity-value definitions");
});

test("entity CRUD uses record view groups instead of silently ignoring an operation form", () => {
  const entity = { ...contract, entityOperations: { create: {
    id: "Example.create", implementation: { type: "entity" }, interfaces: { web: { form: { groups: [{ title: { en: "Main", nl: "Basis" }, fields: ["title"] }] } } },
  } } } as unknown as CompiledEntityContract;
  expect(() => materializeEntityInputSources([entity], {})).toThrow("use record create or update groups");
});
