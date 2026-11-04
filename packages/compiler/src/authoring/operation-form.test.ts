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
  const choice = { ...schema, properties: { ...schema.properties, record: { ...schema.properties.record, oneOf: [{ properties: { kind: { const: "a" } } }] } } };
  expect(() => operationForm({ groups: [{ title, fields: ["record.title"] }] }, choice, "Thing.create")).toThrow("traverses a choice");
  expect(() => operationForm({ groups: [{ title: {}, fields: ["record.title"] }] }, schema, "Thing.create")).toThrow("requires an English or Dutch title");
});

test("compact create forms require valid defaults for hidden required inputs", () => {
  const input = { type: "object", required: ["record", "version", "requestKey"], properties: {
    record: { type: "object", required: ["title", "status"], properties: { title: { type: "string" }, status: { type: "string", enum: ["draft"] }, note: { type: "string" } } },
    version: { type: "object", required: ["label", "status"], properties: { label: { type: "string" }, status: { type: "string", enum: ["draft"] } } },
    requestKey: { type: "string" },
  } };
  const groups = [{ title, fields: ["record.title"] }];
  const defaults = { record: { status: "draft" }, version: { label: "1", status: "draft" } };
  expect(operationForm({ showOnlyGroupedFields: true, defaults, groups }, input, "Thing.create", ["requestKey"])).toEqual({ showOnlyGroupedFields: true, defaults, groups });
  expect(() => operationForm({ showOnlyGroupedFields: true, defaults: { record: { status: "draft" }, version: { label: "1" } }, groups }, input, "Thing.create", ["requestKey"])).toThrow("invalid form defaults");
  expect(() => operationForm({ showOnlyGroupedFields: true, defaults: { record: { status: "published" }, version: defaults.version }, groups }, input, "Thing.create", ["requestKey"])).toThrow("invalid form defaults");
  expect(() => operationForm({ showOnlyGroupedFields: true, defaults: { ...defaults, missing: 1 }, groups }, input, "Thing.create", ["requestKey"])).toThrow("invalid form defaults");
});

test("compact defaults validate optional objects, locale, formats and cross-field restrictions", () => {
  const input = { type: "object", additionalProperties: false, required: ["title"], properties: {
    title: { type: "string" },
    content: { type: "object", required: ["locale", "channel"], properties: { locale: { type: "string", enum: ["en", "nl"] }, channel: { type: "string" } } },
    artifact: { type: "string", format: "uuid" },
  }, not: { required: ["content", "artifact"] } };
  const groups = [{ title, fields: ["title"] }];
  const content = { locale: { from: "uiLocale" }, channel: "document" };
  expect(operationForm({ showOnlyGroupedFields: true, defaults: { content }, groups }, input, "Thing.create")?.defaults).toEqual({ content });
  expect(() => operationForm({ showOnlyGroupedFields: true, defaults: { content: { locale: { from: "uiLocale" } } }, groups }, input, "Thing.create")).toThrow("invalid form defaults");
  expect(() => operationForm({ showOnlyGroupedFields: true, defaults: { artifact: "invalid" }, groups }, input, "Thing.create")).toThrow("invalid form defaults");
  expect(() => operationForm({ showOnlyGroupedFields: true, defaults: { content, artifact: "28ea0204-a8e4-4765-a1c3-bfb5864a512a" }, groups }, input, "Thing.create")).toThrow("invalid form defaults");
  expect(() => operationForm({ showOnlyGroupedFields: true, groups }, { ...input, allOf: [{ required: ["artifact"] }] }, "Thing.create")).toThrow("conditional or composed");
});

test("defaults validate required properties of supplied array items", () => {
  const input = { type: "object", required: ["name"], properties: {
    name: { type: "string" }, items: { type: "array", items: { type: "object", required: ["kind"], properties: { kind: { type: "string" } } } },
  } };
  const groups = [{ title, fields: ["name"] }];
  expect(() => operationForm({ showOnlyGroupedFields: true, groups, defaults: { items: [{}] } }, input, "Thing.create")).toThrow("invalid form defaults");
  expect(operationForm({ showOnlyGroupedFields: true, groups, defaults: { items: [{ kind: "text" }] } }, input, "Thing.create")?.defaults).toEqual({ items: [{ kind: "text" }] });
});
