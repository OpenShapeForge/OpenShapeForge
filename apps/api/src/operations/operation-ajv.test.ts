// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { createOperationAjv } from "./operation-ajv.js";

test("default template annotations compile without applying validation defaults", () => {
  const ajv = createOperationAjv();
  const validate = ajv.compile({type: "object", properties: {name: {type: "string", "x-osf-default-template": "{{fiscalYear.code}}"}}, additionalProperties: false});
  const input = {};
  expect(validate(input)).toBe(true);
  expect(input).toEqual({});
  expect(validate({name: 2028})).toBe(false);
  expect(() => ajv.compile({type: "string", "x-osf-default-template": {field: "code"}})).toThrow();
});

describe("the x-osf-choice annotation", () => {
  test("is accepted in its string and object forms and refused when malformed", () => {
    const ajv = createOperationAjv();
    expect(() => ajv.compile({ type: "string", "x-osf-choice": "field" })).not.toThrow();
    expect(() => ajv.compile({ type: "string", "x-osf-choice": { kind: "operation", scope: "record" } })).not.toThrow();
    expect(() => ajv.compile({ type: "string", "x-osf-choice": "widget" })).toThrow();
    expect(() => ajv.compile({ type: "string", "x-osf-choice": { kind: "operation", scope: "collection" } })).not.toThrow();
    expect(() => ajv.compile({ type: "string", "x-osf-choice": { kind: "field" } })).toThrow();
    // Unscoped is the string form; an object without a scope is a mistake.
    expect(() => ajv.compile({ type: "string", "x-osf-choice": { kind: "operation" } })).toThrow();
  });
});

test("presentation annotations never coerce or round an exact numeric input", () => {
  const amount = "9007199254740993.995";
  const schema = {type:"object",properties:{amount:{type:["number","string"],"x-osf-exact":{},"x-osf-presentation":{component:"FieldMoney",props:{currency:"EUR",decimalPlaces:0,scale:"millions"}}}},additionalProperties:false};
  const value = {amount};
  const validate = createOperationAjv().compile(schema);
  expect(validate(value)).toBe(true);
  expect(value.amount).toBe(amount);
  expect(validate({amount:"not a number"})).toBe(false);
});
