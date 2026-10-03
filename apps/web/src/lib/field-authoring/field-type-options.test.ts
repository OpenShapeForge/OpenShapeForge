// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import {
  FIELD_DEFINITION_COLLECTION_VALUE,
  allFieldTypeOptions,
  fieldTypeOptions,
  findFieldTypeOption,
} from "./field-type-options";

describe("field-type picker options come from the compiled contract", () => {
  for (const lang of ["en", "nl"] as const) {
    test(`${lang}: base value types, the two collection shapes, and every meaning`, () => {
      const options = allFieldTypeOptions(lang);
      const base = options.filter((option) => option.kind === "base");
      expect(base.map((option) => option.value)).toEqual([
        "string", "integer", "number", "boolean", "object", "date", "datetime", "array", FIELD_DEFINITION_COLLECTION_VALUE,
      ]);
      expect(findFieldTypeOption(lang, "string")?.label).toBe(lang === "nl" ? "Tekst" : "Text");
      expect(findFieldTypeOption(lang, "array")).toMatchObject({ label: lang === "nl" ? "Lijst" : "List", cardinality: "collection" });
      expect(findFieldTypeOption(lang, FIELD_DEFINITION_COLLECTION_VALUE)).toMatchObject({
        osfType: "fieldDefinition", valueType: "object", cardinality: "collection",
        label: lang === "nl" ? "Velddefinities" : "Field definitions",
      });

      const semantic = options.filter((option) => option.kind === "semantic");
      expect(semantic.length).toBeGreaterThan(50);
      expect(findFieldTypeOption(lang, "semantic:email")).toMatchObject({
        osfType: "email", baseType: "string", valueType: "string", label: lang === "nl" ? "E-mail" : "Email",
      });
      // A reference to an entity is its identity alias: a stored field
      // definition holds an inline identifier, not a relationship.
      expect(findFieldTypeOption(lang, "semantic:relationId")).toMatchObject({
        osfType: "relationId", baseType: "string", label: lang === "nl" ? "Relatie" : "Relation",
      });
      // Meanings are sorted by their label in the picker's language.
      const labels = semantic.map((option) => option.label);
      expect(labels).toEqual([...labels].sort((left, right) => left.localeCompare(right, lang)));
    });

    test(`${lang}: search narrows by label and key, exclusions withhold profile type keys, limit bounds`, () => {
      const byLabel = fieldTypeOptions(lang, { search: lang === "nl" ? "e-mail" : "email" });
      expect(byLabel.map((option) => option.value)).toContain("semantic:email");
      expect(fieldTypeOptions(lang, { search: "EMAIL" }).map((option) => option.value)).toContain("semantic:email");
      expect(fieldTypeOptions(lang, { search: "no such type" })).toEqual([]);

      const withoutCollections = fieldTypeOptions(lang, { excludedFieldTypes: ["collection", "fieldDefinition", "object"] });
      expect(withoutCollections.some((option) => option.value === "array")).toBe(false);
      expect(withoutCollections.some((option) => option.value === FIELD_DEFINITION_COLLECTION_VALUE)).toBe(false);
      expect(withoutCollections.some((option) => option.value === "object")).toBe(false);
      expect(withoutCollections.some((option) => option.value === "string")).toBe(true);

      expect(fieldTypeOptions(lang, { limit: 3 })).toHaveLength(3);
    });
  }
});
