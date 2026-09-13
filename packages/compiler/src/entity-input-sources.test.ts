// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import type { CompiledEntityContract, CompiledField } from "./authoring/types.js";
import { resolveEntityInputSources } from "./entity-input-sources.js";

const fields: CompiledField[] = [{
  key: "title", valueType: "string", cardinality: "single", required: true,
  label: { en: "Title" }, render: { component: "Input" }, validation: { minLength: 1, maxLength: 80 },
}, {
  key: "serverValue", valueType: "string", cardinality: "single", required: false,
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
