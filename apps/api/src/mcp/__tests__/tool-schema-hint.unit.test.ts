// SPDX-License-Identifier: BUSL-1.1
/**
 * An unknown property is answered with the names that are allowed there, so
 * a caller corrects the call from the error instead of reading the contract.
 */
import { expect, test } from "bun:test";
import { assertSchemaValid } from "../tool-schema.js";

const schema = {
  type: "object",
  properties: {
    filter: { type: "object", properties: { displayName: { type: "string" }, location: { type: "string" } }, additionalProperties: false },
    first: { type: "integer" },
  },
  additionalProperties: false,
};

test("names the allowed properties where an unknown one was sent", () => {
  expect(() => assertSchemaValid(schema, { filter: { name: "Zuidveld" } }, "arguments"))
    .toThrow('/filter must NOT have additional properties ("name"); allowed here: displayName, location');
  expect(() => assertSchemaValid(schema, { query: "Zuidveld" }, "arguments"))
    .toThrow('arguments must NOT have additional properties ("query"); allowed here: filter, first');
});

test("leaves every other violation as it was", () => {
  expect(() => assertSchemaValid(schema, { first: "ten" }, "arguments")).toThrow("/first must be integer");
});
