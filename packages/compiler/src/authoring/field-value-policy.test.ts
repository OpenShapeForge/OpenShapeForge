// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { generateArtifacts } from "../generate.js";
import { compileProtectedFieldsFixture } from "./field-value-policy.fixtures.js";
import { compileFieldValuePolicy, fieldValuePolicySchema } from "./field-value-policy.js";
import type { CompiledField } from "./types/compiled.js";
import type { CompiledEntityContract } from "./types/compiled.js";
import { entityRecordOutputSchema, entityValuesSchema } from "../entity-operation-json-schema.js";
import { Ajv } from "ajv";
import addFormats from "ajv-formats";
import { FIELD_ITEM_ID } from "@openshapeforge/operations";

test("nested protections keep their paths and explicit read/write grants reach runtime", () => {
  const manifest = compileProtectedFieldsFixture();
  const table = manifest.tables.find((table) => table.name === "protected_fields_fixtures")!;
  const columns = new Map(table.columns.map((column) => [column.name, column]));
  expect(columns.get("label")?.classification).toBeUndefined();
  expect(columns.get("label")?.immutable).toBeUndefined();
  expect(columns.get("data")?.classification).toBeUndefined();
  expect(columns.get("data")?.fieldPolicy).toMatchObject({ children: {
    label: { classification: "pii" },
    restricted: { readRoles: ["Sensitive.Read"], writeRoles: ["Sensitive.Write"] },
    fixed: { immutable: true },
    contacts: { itemKey: FIELD_ITEM_ID, children: { private: { readRoles: ["Sensitive.Read"], writeRoles: ["Sensitive.Write"] } } },
  } });
  expect(columns.get("explicit_secret")?.fieldPolicy).toEqual({
    readRoles: ["Sensitive.Read"], writeRoles: ["Sensitive.Write"],
  });
  const output = generateArtifacts(manifest);
  const runtime = JSON.parse(output.find((artifact) => artifact.path.endsWith("db/manifest.json"))!.contents);
  expect(runtime.tables[0].columns.find((column: { name: string }) => column.name === "data").fieldPolicy)
    .toEqual(columns.get("data")?.fieldPolicy);
});

test("protected object updates accept member patches while create keeps structural requiredness", () => {
  let contract!: CompiledEntityContract;
  compileProtectedFieldsFixture((candidate) => { contract = candidate.contract; });
  const update = entityValuesSchema(contract, "update", [contract], {}).values;
  const create = entityValuesSchema(contract, "create", [contract], {}).values;
  const validate = (schema: Record<string, unknown>, value: unknown) => addFormats.default(new Ajv({ strict: false })).compile(schema)(value);
  expect(validate(update, { data: { visible: "changed" } })).toBe(true);
  expect(validate(create, { label: "Record", explicitSecret: "secret", data: { visible: "changed" } })).toBe(false);
  expect(validate(update, { data: { visible: 123 } })).toBe(false);
});

test("collection items and operation writers retain their policy without polluting sibling keys", () => {
  const policy = compileFieldValuePolicy({ key: "items", baseType: "object", cardinality: "collection", item: {
    key: "value", baseType: "object", cardinality: "single", writtenBy: ["Fixture.review"], children: [{ key: "secret", immutable: true }],
  } } as CompiledField);
  expect(policy).toEqual({ itemKey: FIELD_ITEM_ID, item: { writtenBy: ["Fixture.review"], children: { secret: { immutable: true } } } });
});

test("required protected values can be null in record output without losing the record", () => {
  let contract!: CompiledEntityContract;
  compileProtectedFieldsFixture((candidate) => { contract = candidate.contract; });
  const schema = entityRecordOutputSchema(contract);
  expect((schema.properties as Record<string, unknown>).explicitSecret).toMatchObject({
    anyOf: [{ type: "string" }, { type: "null" }],
  });
  const fieldSchema = (schema.properties as Record<string, object>).explicitSecret!;
  expect(new Ajv({ strict: false }).compile(fieldSchema)(null)).toBe(true);
});

test("nested writtenBy bindings must resolve to an actual canonical Operation", () => {
  const manifest = compileProtectedFieldsFixture();
  manifest.tables[0]!.columns.find((column) => column.name === "data")!.fieldPolicy!.children!.reviewed = {
    writtenBy: ["Fixture.missing"],
  };
  expect(() => generateArtifacts(manifest)).toThrow("compiled operations were not supplied");
  expect(() => generateArtifacts(manifest, { operations: [] })).toThrow("no compiled operation has that key");
});

test("post-merge value schemas retain the same current reference-data constraints as canonical inputs", () => {
  let contract!: CompiledEntityContract;
  const referentiedata = {
    fixtureStatuses: [
      { value: "approved", label: { en: "Approved", nl: "Goedgekeurd" } },
      { value: "rejected", label: { en: "Rejected", nl: "Afgekeurd" } },
    ],
  };
  const manifest = compileProtectedFieldsFixture((candidate) => { contract = candidate.contract; }, {
    referentiedata,
    configureFields: (fields) => fields.find((field) => field.key === "data")!.children!.push({
      key: "status", osfType: "string", required: true,
      options: { type: "referentiedata", referentieGroep: "fixtureStatuses" },
    }),
  });
  const savedSchema = manifest.tables[0]!.columns.find((column) => column.name === "data")!.fieldPolicy!.valueSchema!;
  const inputSchema = (entityValuesSchema(contract, "create", [contract], referentiedata).values.properties as Record<string, Record<string, unknown>>).data!;
  expect(savedSchema).toEqual(inputSchema);
  const validateSaved = addFormats.default(new Ajv({ strict: false })).compile(savedSchema);
  const validateInput = addFormats.default(new Ajv({ strict: false })).compile(inputSchema);
  const valid = { visible: "Public", restricted: "Secret", fixed: "Permanent", status: "approved" };
  expect(validateSaved(valid)).toBe(true);
  expect(validateInput(valid)).toBe(true);
  expect(validateSaved({ ...valid, status: "not-in-catalog" })).toBe(false);
  expect(validateInput({ ...valid, status: "not-in-catalog" })).toBe(false);
});

test("one-sided field authorization preserves the established fail-closed missing side", () => {
  for (const side of ["read", "write"] as const) {
    let contract!: CompiledEntityContract;
    const manifest = compileProtectedFieldsFixture((candidate) => { contract = candidate.contract; }, {
      configureFields: (fields) => {
        fields.find((field) => field.key === "explicitSecret")!.authorization = { roles: { [side]: ["Sensitive.Explicit"] } };
      },
    });
    const expected = side === "read"
      ? { readRoles: ["Sensitive.Explicit"], writeRoles: [] }
      : { readRoles: [], writeRoles: ["Sensitive.Explicit"] };
    expect(contract.authorization.fieldAuthorizations.find((field) => field.fieldKey === "explicitSecret"))
      .toEqual({ fieldKey: "explicitSecret", ...expected });
    expect(manifest.tables[0]!.columns.find((column) => column.name === "explicit_secret")!.fieldPolicy).toEqual(expected);
  }
});

test("protected object items accept optional runtime UUIDs in create, update and complete saved schemas", () => {
  let contract!: CompiledEntityContract;
  const manifest = compileProtectedFieldsFixture((candidate) => { contract = candidate.contract; }, {
    configureFields: (fields) => fields.push({
      key: "rows", osfType: "object", cardinality: "collection", persisted: { column: "rows", storageClass: "core" },
      item: { key: "row", osfType: "object", children: [
        { key: "name", osfType: "string", required: true },
        { key: "fixed", osfType: "string", immutable: true, required: true },
      ] },
    }, {
      key: "publicRows", osfType: "object", cardinality: "collection", persisted: { column: "public_rows", storageClass: "core" },
      children: [{ key: "name", osfType: "string" }],
    }),
  });
  const columns = new Map(manifest.tables[0]!.columns.map((column) => [column.name, column]));
  const create = entityValuesSchema(contract, "create", [contract], {}).values;
  const update = entityValuesSchema(contract, "update", [contract], {}).values;
  const createProperties = create.properties as Record<string, Record<string, unknown>>;
  const updateProperties = update.properties as Record<string, Record<string, unknown>>;
  const uuid = "11111111-1111-4111-8111-111111111111";
  const ajv = addFormats.default(new Ajv({ strict: false }));
  const createRows = ajv.compile(createProperties.rows!);
  const updateRows = ajv.compile(updateProperties.rows!);
  const savedRows = ajv.compile(columns.get("rows")!.fieldPolicy!.valueSchema!);
  expect(columns.get("rows")!.fieldPolicy!.itemKey).toBe(FIELD_ITEM_ID);
  expect(columns.get("public_rows")!.fieldPolicy).toBeUndefined();
  const full = [{ name: "One", fixed: "Permanent", [FIELD_ITEM_ID]: uuid }];
  expect(createRows(full)).toBe(true);
  expect(updateRows([{ name: "Changed", [FIELD_ITEM_ID]: uuid }])).toBe(true);
  expect(savedRows(full)).toBe(true);
  expect(createRows([{ name: "New", fixed: "Permanent" }])).toBe(true);
  expect(createRows([{ name: "One", [FIELD_ITEM_ID]: uuid }])).toBe(false);
  expect(savedRows([{ name: "One", [FIELD_ITEM_ID]: uuid }])).toBe(false);
  for (const validate of [createRows, updateRows, savedRows]) {
    expect(validate([{ name: "One", fixed: "Permanent", [FIELD_ITEM_ID]: "invalid" }])).toBe(false);
    expect(validate([{ ...full[0], unexpected: true }])).toBe(false);
  }
  expect(ajv.compile(createProperties.publicRows!)([{ name: "Public", [FIELD_ITEM_ID]: uuid }])).toBe(false);
  const data = { visible: "Public", restricted: "Secret", fixed: "Permanent", contacts: [
    { name: "One", private: "Secret", [FIELD_ITEM_ID]: uuid },
  ] };
  expect(ajv.compile(createProperties.data!)(data)).toBe(true);
  expect(ajv.compile(updateProperties.data!)({ contacts: [{ name: "Changed", [FIELD_ITEM_ID]: uuid }] })).toBe(true);
  expect(ajv.compile(columns.get("data")!.fieldPolicy!.valueSchema!)(data)).toBe(true);
});

test("scalar collections keep their existing value contract and reserved item identity cannot be authored", () => {
  expect(compileFieldValuePolicy({ key: "values", baseType: "string", cardinality: "collection", item: {
    key: "value", baseType: "string", cardinality: "single", immutable: true,
  } } as CompiledField)).toEqual({ item: { immutable: true } });
  expect(() => compileProtectedFieldsFixture(undefined, { configureFields: (fields) => {
    const contacts = fields.find((field) => field.key === "data")!.children!.find((field) => field.key === "contacts")!;
    contacts.children!.push({ key: FIELD_ITEM_ID, osfType: "string" });
  } })).toThrow(FIELD_ITEM_ID);
  const schema = { type: "array", items: { type: "object", properties: { [FIELD_ITEM_ID]: { type: "string" } } } };
  expect(() => fieldValuePolicySchema(schema, { itemKey: FIELD_ITEM_ID }))
    .toThrow("compiler-managed and cannot be authored");
  expect(schema.items.properties[FIELD_ITEM_ID]).toEqual({ type: "string" });
});

test("whole protected object items can move with only their identity on update", () => {
  let contract!: CompiledEntityContract;
  const manifest = compileProtectedFieldsFixture((candidate) => { contract = candidate.contract; }, {
    configureFields: (fields) => fields.push({
      key: "restrictedRows", osfType: "object", cardinality: "collection",
      persisted: { column: "restricted_rows", storageClass: "core" },
      item: {
        key: "row", osfType: "object",
        authorization: { roles: { read: ["Sensitive.Read"], write: ["Sensitive.Write"] } },
        children: [{ key: "name", osfType: "string", required: true }],
      },
    }),
  });
  const policy = manifest.tables[0]!.columns.find((column) => column.name === "restricted_rows")!.fieldPolicy!;
  expect(policy).toMatchObject({ itemKey: FIELD_ITEM_ID, item: {
    readRoles: ["Sensitive.Read"], writeRoles: ["Sensitive.Write"],
  } });
  expect(policy.item!.children).toBeUndefined();
  const property = (operation: "create" | "update") =>
    (entityValuesSchema(contract, operation, [contract], {}).values.properties as Record<string, Record<string, unknown>>).restrictedRows!;
  const ajv = addFormats.default(new Ajv({ strict: false }));
  const create = ajv.compile(property("create"));
  const update = ajv.compile(property("update"));
  const saved = ajv.compile(policy.valueSchema!);
  const identity = { [FIELD_ITEM_ID]: "11111111-1111-4111-8111-111111111111" };
  expect(update([identity])).toBe(true);
  expect(create([identity])).toBe(false);
  expect(saved([identity])).toBe(false);
  for (const validate of [create, update, saved]) {
    expect(validate([{ ...identity, name: "Stored" }])).toBe(true);
    expect(validate([{ name: "New" }])).toBe(true);
    expect(validate([{ ...identity, name: 123 }])).toBe(false);
    expect(validate([{ ...identity, unexpected: true }])).toBe(false);
    expect(validate([{ [FIELD_ITEM_ID]: "invalid" }])).toBe(false);
  }
  expect(update([{}])).toBe(false);
  const outputProperty = (entityRecordOutputSchema(contract).properties as Record<string, Record<string, unknown>>).restrictedRows!;
  expect(ajv.compile(outputProperty)([identity])).toBe(true);
  expect(contract.graphql.fields.find((field) => field.name === "restrictedRows")!.type).toBe("[JSON]");
});
