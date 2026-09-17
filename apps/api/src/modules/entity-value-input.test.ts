// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import type { RuntimeEntityValueCarrier } from "@openshapeforge/plugin-runtime";
import { runtimeJsonSchemas } from "./field-schemas.js";
import { projectEntityValue, splitEntityValueInput } from "./entity-value-input.js";

const carrier: RuntimeEntityValueCarrier = {
  entityName: "Block", fieldKey: "values", definitionField: "definitionKey", definitionColumn: "definition_key",
  schema: "erp", table: "blocks", valuesColumn: "values",
  definitions: {
    Example: {
      entityName: "Example", schemaVersion: 1, definitionHash: "a".repeat(64), fields: [{ key: "caption", osfType: "string", defaultValue: "Example" }],
      valueSchema: { type: "object", properties: { caption: { type: "string", minLength: 1, "x-osf-i18n": { title: { en: "Caption", nl: "Bijschrift" } } } }, required: ["caption"], additionalProperties: false },
      references: [{ fieldKey: "document", targetEntity: "Document", schema: "erp", table: "documents", column: "example_document_id", required: true }],
    },
  },
};
const id = "10000000-0000-4000-8000-000000000001";

describe("logical entity-value storage boundary", () => {
  test("stores symbolic arguments separately from fixed relational IDs", () => {
    const bindable = { ...carrier, definitions: { Example: { ...carrier.definitions.Example!, references: [{ ...carrier.definitions.Example!.references[0]!, parameterColumn: "example_document_parameter" }] } } };
    const result = splitEntityValueInput(bindable, "Example", { document: { parameter: "document" } }, runtimeJsonSchemas);
    expect(result).toEqual({ values: { caption: "Example" }, columns: { example_document_id: null, example_document_parameter: "document" }, references: [] });
    expect(projectEntityValue(bindable, { definition_key: "Example", values: result.values, ...result.columns })).toEqual({ caption: "Example", document: { parameter: "document" } });
    expect(splitEntityValueInput(bindable, "Example", { document: id }, runtimeJsonSchemas).columns).toEqual({ example_document_id: id, example_document_parameter: null });
    for (const document of [{ parameter: "" }, { parameter: "a.b" }, { parameter: "document", id }, { parameter: 3 }]) {
      expect(() => splitEntityValueInput(bindable, "Example", { document }, runtimeJsonSchemas)).toThrow();
    }
    expect(() => splitEntityValueInput(carrier, "Example", { document: { parameter: "document" } }, runtimeJsonSchemas)).toThrow();
    expect(() => projectEntityValue(bindable, { definition_key: "Example", values: {}, example_document_id: id, example_document_parameter: "document" })).toThrow();
  });
  test("splits a logical relationship into an FK and returns exact authorization targets", () => {
    expect(splitEntityValueInput(carrier, "Example", { document: id }, runtimeJsonSchemas)).toEqual({
      values: { caption: "Example" }, columns: { example_document_id: id },
      references: [{ fieldKey: "document", entityName: "Document", id }],
    });
  });
  test("enforces canonical value constraints and refuses caller-selected physical columns", () => {
    for (const input of [{ document: id, caption: "" }, { document: id, example_document_id: id }, { document: "bad" }, {}]) {
      expect(() => splitEntityValueInput(carrier, "Example", input, runtimeJsonSchemas)).toThrow();
    }
    expect(() => splitEntityValueInput(carrier, "constructor", { document: id }, runtimeJsonSchemas)).toThrow();
    expect(() => splitEntityValueInput(carrier, "Example", JSON.parse(`{"document":"${id}","__proto__":{}}`), runtimeJsonSchemas)).toThrow();
  });
  test("projects references into the normal field shape and rejects IDs smuggled into JSON", () => {
    expect(projectEntityValue(carrier, { definition_key: "Example", values: { caption: "Saved" }, example_document_id: id })).toEqual({ caption: "Saved", document: id });
    expect(() => projectEntityValue(carrier, { definition_key: "Example", values: { document: id }, example_document_id: id })).toThrow();
    expect(() => projectEntityValue(carrier, { definition_key: "Example", values: {}, example_document_id: null })).toThrow();
  });
});
