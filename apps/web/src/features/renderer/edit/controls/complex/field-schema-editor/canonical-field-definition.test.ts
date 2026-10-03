// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import type { Field } from "@/generated/compiler/field-contract";
import { variableSuggestionFromFieldDefinitionRow } from "@/features/renderer/components/renderer/field-renderers/variable-suggestions";
import { storedFieldDefinitionBaseType } from "@/lib/field-contract/stored-field-definition";
import { isFieldDefinitionDefaultValue } from "./default-value-helpers";
import { normalizeFieldSchemaDraft } from "./draft-normalization";
import { variableSuggestionFromStoredFieldDefinitionRow } from "./editor-rows";

const empty = (): Field => ({
  key: "",
  osfType: "string",
  cardinality: { min: 0, max: 1 },
  required: false,
});

test("stored FieldDefinitions reject both retired type keys instead of normalizing them", () => {
  for (const legacy of [
    { key: "legacy", osfType: "string", valueType: "string" },
    { key: "legacy", osfType: "string", semanticType: "email" },
  ]) {
    expect(() => normalizeFieldSchemaDraft(legacy, empty)).toThrow(/removed legacy key/);
    expect(() => storedFieldDefinitionBaseType(legacy)).toThrow(/removed legacy key/);
    expect(isFieldDefinitionDefaultValue(legacy)).toBe(false);
  }
});

test("web FieldDefinition readers reject retired keys at every recursive field position", () => {
  for (const legacy of [
    {
      key: "group",
      osfType: "object",
      shape: [{ key: "legacy", osfType: "string", valueType: "string" }],
    },
    {
      key: "group",
      osfType: "object",
      children: [{ key: "legacy", osfType: "email", semanticType: "email" }],
    },
    {
      key: "items",
      osfType: "object",
      item: { key: "legacy", osfType: "string", valueType: "string" },
    },
  ]) {
    expect(() => normalizeFieldSchemaDraft(legacy, empty)).toThrow(/removed legacy key/);
    expect(() => storedFieldDefinitionBaseType(legacy)).toThrow(/removed legacy key/);
    expect(isFieldDefinitionDefaultValue(legacy)).toBe(false);
    expect(() => variableSuggestionFromStoredFieldDefinitionRow({
      ...legacy,
      kind: "variable",
      source: "{{legacy}}",
      label: { en: "Legacy" },
    }, "en")).toThrow(/removed legacy key/);
  }
});

test("canonical definitions and variable-source rows use osfType with derived baseType", () => {
  const normalized = normalizeFieldSchemaDraft(
    { key: "email", osfType: "email", label: { en: "Email" } },
    empty,
  );
  expect(normalized).toMatchObject({ key: "email", osfType: "email" });
  expect(normalized).not.toHaveProperty("valueType");
  expect(normalized).not.toHaveProperty("semanticType");
  expect(isFieldDefinitionDefaultValue(normalized)).toBe(true);

  const source = {
    kind: "variable",
    source: "{{invoice.total}}",
    key: "total",
    label: { en: "Total", nl: "Totaal" },
    osfType: "integer",
    baseType: "integer",
  };
  expect(storedFieldDefinitionBaseType(source)).toBe("integer");
  expect(variableSuggestionFromStoredFieldDefinitionRow(source, "en")).toMatchObject({
    path: "invoice.total",
    osfType: "integer",
    fieldType: "integer",
    valueType: "number",
  });
  expect(variableSuggestionFromFieldDefinitionRow(source)).toMatchObject({
    path: "invoice.total",
    osfType: "integer",
    fieldType: "integer",
    valueType: "number",
  });
});

test("canonical variable-source metadata refuses a baseType that disagrees with osfType", () => {
  expect(() => storedFieldDefinitionBaseType({
    key: "amount",
    osfType: "integer",
    baseType: "string",
  })).toThrow(/does not match osfType/);
  expect(() => storedFieldDefinitionBaseType({
    key: "amount",
    osfType: "integer",
    baseType: "money",
  })).toThrow(/unsupported canonical baseType/);
});
