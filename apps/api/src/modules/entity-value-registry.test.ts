// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { createEntityValueRegistry } from "./entity-value-registry.js";

const fixture = () => ({ version: 1, carriers: [{
  entityName: "Block", fieldKey: "values", definitionField: "definitionKey",
  schema: "erp", table: "blocks", valuesColumn: "values", definitionColumn: "definition_key",
  definitions: {
    Include: {
      entityName: "Include", schemaVersion: 1, definitionHash: "a".repeat(64), fields: [{ key: "version", valueType: "string" }],
      valueSchema: { type: "object", properties: {} },
      references: [{ fieldKey: "version", targetEntity: "TemplateVersion", schema: "erp", table: "template_versions", column: "include_version_id", required: true }],
    },
  },
}], collections: [{ entityName: "TemplateVariant", fieldKey: "blocks", targetEntity: "Block", allowedDefinitions: ["Include"] }] });

describe("generated entity-value metadata", () => {
  test("returns immutable detached metadata without any data authority", () => {
    const source = fixture();
    const registry = createEntityValueRegistry(source);
    source.carriers[0]!.definitions.Include.references[0]!.column = "changed";
    const resolved = registry.get("Block", "values")!;
    expect(resolved.definitions.Include!.references[0]!.column).toBe("include_version_id");
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.definitions.Include!.fields)).toBe(true);
    expect(registry.get("Block", "unknown")).toBeUndefined();
    expect(registry.get("toString", "values")).toBeUndefined();
    expect(registry.collection("TemplateVariant", "blocks")?.allowedDefinitions).toEqual(["Include"]);
    expect(Object.isFrozen(registry.collection("TemplateVariant", "blocks")?.allowedDefinitions)).toBe(true);
  });
  test("rejects ambiguous carriers and unsafe physical identifiers", () => {
    const duplicate = fixture();
    duplicate.carriers.push(duplicate.carriers[0]!);
    expect(() => createEntityValueRegistry(duplicate)).toThrow("invalid");
    const invalid = fixture();
    invalid.carriers[0]!.definitions.Include.references[0]!.column = 'id" from secrets --';
    expect(() => createEntityValueRegistry(invalid)).toThrow("invalid");
    for (const parameterColumn of ["values", "id", "include_version_id"]) {
      const collision = fixture();
      Object.assign(collision.carriers[0]!.definitions.Include.references[0]!, { parameterColumn });
      expect(() => createEntityValueRegistry(collision)).toThrow("invalid");
    }
  });
  test("rejects unknown allowed definitions, duplicate collections and missing fingerprints", () => {
    const unknown = fixture();
    unknown.collections[0]!.allowedDefinitions = ["Unknown"];
    expect(() => createEntityValueRegistry(unknown)).toThrow("invalid");
    const duplicate = fixture();
    duplicate.collections.push(duplicate.collections[0]!);
    expect(() => createEntityValueRegistry(duplicate)).toThrow("invalid");
    const hash = fixture();
    hash.carriers[0]!.definitions.Include.definitionHash = "";
    expect(() => createEntityValueRegistry(hash)).toThrow("invalid");
  });
  test("rejects malformed or mismatched definitions, not silently dropping them", () => {
    const invalid = fixture();
    invalid.carriers[0]!.definitions.Include.entityName = "Different";
    expect(() => createEntityValueRegistry(invalid)).toThrow("invalid");
    expect(() => createEntityValueRegistry({ version: 2, carriers: [] })).toThrow("invalid");
    expect(() => createEntityValueRegistry({ version: 1, carriers: [null] })).toThrow("invalid");
  });
});
