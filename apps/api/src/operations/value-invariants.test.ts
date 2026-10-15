// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { operationFieldObjectSchema, type OperationFieldSchemaRegistry } from "@openshapeforge/operations";
import { runtimeJsonSchemas } from "../modules/field-schemas.js";
import { createOperationAjv } from "./operation-ajv.js";

const catalogue = parse(readFileSync(new URL("../../../../packages/compiler/config/authoring/catalogs/osf-types.yaml", import.meta.url), "utf8"));
const registry: OperationFieldSchemaRegistry = { osfTypes: catalogue.types };
const schema = operationFieldObjectSchema([
  { key: "range", osfType: "numericRange", required: true },
  { key: "dates", osfType: "dateRange", required: true },
  { key: "zone", osfType: "timeZone", required: true },
  { key: "map", osfType: "keyValueMap", required: true },
  { key: "rows", osfType: "object", cardinality: "collection", required: true,
    validation: { uniqueBy: "id" }, children: [
      { key: "id", osfType: "integer", required: true },
      { key: "name", osfType: "string", required: true },
    ] },
], registry);
const validate = createOperationAjv().compile(schema);
function valid() {
  return { range: { from: "9007199254740993.01", to: "9007199254740993.02" },
    dates: { from: "2026-02-28", to: "2026-03-01" }, zone: "Europe/Amsterdam",
    map: { customer: "secret-customer" }, rows: [{ id: "1", name: "first" }, { id: "2", name: "second" }] };
}

test("real catalogue invariants validate at both canonical and dynamic schema boundaries", () => {
  expect(validate(valid())).toBe(true);
  expect(runtimeJsonSchemas.validate(schema, valid()).valid).toBe(true);
  const invalid = [
    { ...valid(), range: { from: "9007199254740993.02", to: "9007199254740993.01" } },
    { ...valid(), range: { from: "1" } },
    { ...valid(), range: { from: "1", to: "2", secret: "secret-customer" } },
    { ...valid(), dates: { from: "2026-03-01", to: "2026-02-28" } },
    { ...valid(), dates: { from: "2026-02-30", to: "2026-03-01" } },
    { ...valid(), zone: "Mars/Olympus" },
    { ...valid(), map: { customer: 42 } },
    { ...valid(), map: JSON.parse('{"__proto__":"secret-customer"}') },
    { ...valid(), rows: [{ id: "1.0", name: "first" }, { id: 1, name: "second" }] },
  ];
  for (const value of invalid) {
    expect(validate(value)).toBe(false);
    const result = runtimeJsonSchemas.validate(schema, value);
    expect(result.valid).toBe(false);
    expect(JSON.stringify(result)).not.toContain("secret-customer");
  }
});

test("authored decimal bounds stay exact beyond the safe integer range", () => {
  const bounded = operationFieldObjectSchema([{key:"amount",osfType:"number",required:true,
    validation:{min:"9007199254740993.01",max:"9007199254740993.02"}}]);
  const accepts = createOperationAjv().compile(bounded);
  expect(accepts({amount:"9007199254740993.01"})).toBe(true);
  expect(accepts({amount:"9007199254740993.02"})).toBe(true);
  for (const amount of ["9007199254740993.00", "9007199254740993.03",9007199254740992]) {
    expect(accepts({amount})).toBe(false);
    expect(runtimeJsonSchemas.validate(bounded,{amount}).valid).toBe(false);
  }
});
