// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { hasSensitiveOutput, assertSensitiveOutputSchema, splitSensitiveOutput } from "./sensitive-output.js";
const secret = { type: "string", "x-osf-classification": { sensitivity: "confidential" } };
test("key issuance separates secrets from declared public metadata and drops undeclared fields", () => {
  const schema = { type: "object", properties: { id: { type: "string" }, credential: { type: "object", properties: { secret } } } };
  const split = splitSensitiveOutput(schema, { id: "safe", credential: { secret: "synthetic-secret" }, surprise: "synthetic-secret" });
  expect(hasSensitiveOutput(schema)).toBe(true);
  expect(split.publicValue).toEqual({ id: "safe", credential: {} });
  expect(split.privateFields).toEqual([{ path: "/credential/secret", label: "/credential/secret", value: "synthetic-secret" }]);
});
test("recovery codes use the same contract for arrays and nested labels", () => {
  const split = splitSensitiveOutput({ type: "object", properties: { codes: { type: "array", items: { ...secret, "x-osf-i18n": { title: { en: "Recovery code" } } } } } }, { codes: ["code-one", "code-two"] });
  expect(JSON.stringify(split.publicValue)).not.toContain("code-");
  expect(split.privateFields.map(f => f.value)).toEqual(["code-one", "code-two"]);
});
test("ambiguous or misspelled classification never silently becomes public output", () => {
  expect(() => assertSensitiveOutputSchema({ ...secret, $ref: "#/other" })).toThrow("references");
  expect(() => assertSensitiveOutputSchema({ "x-osf-classification": { sensitivity: "confidentail" } })).toThrow("confidential");
  expect(() => assertSensitiveOutputSchema({ oneOf: [secret, { type: "number" }] })).toThrow("conditional");
});

test("unsupported confidential value shapes are refused before execution", () => {
  expect(() => assertSensitiveOutputSchema({ ...secret, type: "object" })).toThrow("must declare a string");
  expect(() => assertSensitiveOutputSchema({ type: "object", additionalProperties: secret })).toThrow("explicit properties");
  let nested: Record<string, unknown> = secret;
  for (let i = 0; i < 40; i++) nested = { type: "object", properties: { child: nested } };
  expect(() => assertSensitiveOutputSchema(nested)).toThrow("inspection bound");
});
