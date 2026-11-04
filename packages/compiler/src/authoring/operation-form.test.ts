// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { operationForm } from "./operation-form-presentation.js";

const title = { en: "Main", nl: "Hoofdzaak" };
const schema = { type: "object", required: ["record"], properties: {
  record: { type: "object", required: ["title"], properties: { title: { type: "string" }, note: { type: "string" } } },
  optional: { type: "object", properties: { field: { type: "string" } } },
} };

test("form groups project logical paths without changing the input contract", () => {
  const form = { groups: [{ title, fields: ["record.title"] }, { title, fields: ["record.note"], collapsed: true }] };
  expect(operationForm(form, schema, "Thing.create")).toEqual(form);
  expect(() => operationForm({ groups: [{ title, fields: ["record.missing"] }] }, schema, "Thing.create")).toThrow("unknown form field");
  expect(() => operationForm({ groups: [{ title, fields: ["record", "record.title"] }] }, schema, "Thing.create")).toThrow("overlapping form field");
  expect(() => operationForm({ groups: [{ title, fields: ["optional.field"] }] }, schema, "Thing.create")).toThrow("optional object");
  expect(() => operationForm({ groups: [{ title, fields: ["record.title"], collapsed: true }] }, schema, "Thing.create")).toThrow("cannot start collapsed");
});
