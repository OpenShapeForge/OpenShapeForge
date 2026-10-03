// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import { withBlueprintCreate } from "./blueprint-create-schema.js";

test("flat REST and MCP inputs relax copied fields only for a nonempty blueprint source", () => {
  const schema = { type: "object", additionalProperties: false, properties: { name: { type: "string" }, customerContext: { type: "string" } }, required: ["name", "customerContext"] };
  const validate = new Ajv2020.default({ strict: false }).compile(withBlueprintCreate(schema, { fields: ["name"] }));
  expect(validate({ blueprintId: "standard", customerContext: "local" })).toBe(true);
  expect(validate({ blueprintId: "standard" })).toBe(false);
  expect(validate({ customerContext: "local" })).toBe(false);
  expect(validate({ blueprintId: "", customerContext: "local" })).toBe(false);
  expect(validate({ name: "Own", customerContext: "local" })).toBe(true);
  expect(withBlueprintCreate(schema, undefined)).toBe(schema);
});
