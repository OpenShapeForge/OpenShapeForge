// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import type { CompiledField } from "./authoring/types.js";
import {
  compiledFieldSchema,
  compiledFieldSchemaWithoutDefinitions,
  compiledObjectSchema,
  rebaseJsonSchemaReferences,
} from "./field-json-schema.js";
import type {
  FieldDefinition,
  FieldDefinitionSemanticTypeKind,
  McpDeclarativeAdapterUrls,
  McpDeclarativeOperationUrl,
  McpDeclarativeRequestMapping,
} from "./index.js";

const packageRootFieldDefinition = {
  key: "definition",
  valueType: "object",
} satisfies FieldDefinition;
const packageRootSemanticTypeKind: FieldDefinitionSemanticTypeKind = "object";
const packageRootAdapterUrls = {
  baseUrlTemplate: "https://default.example.test",
  baseUrlTemplates: { secondary: "https://secondary.example.test" },
} satisfies McpDeclarativeAdapterUrls;
const packageRootOperationUrl = {
  baseUrlKey: "secondary",
} satisfies McpDeclarativeOperationUrl;
const packageRootRequestMapping = {
  headers: [{ field: "version", header: "If-Match" }],
} satisfies McpDeclarativeRequestMapping;

function field(overrides: Partial<CompiledField> & Pick<CompiledField, "key">): CompiledField {
  const { key, ...rest } = overrides;
  return {
    key,
    valueType: "string",
    cardinality: "single",
    required: false,
    label: { en: key },
    render: { component: "Input" },
    ...rest,
  };
}

describe("compiled field JSON Schema projection", () => {
  it("rebases only refs and leaves matching prose untouched", () => {
    const source = {
      $ref: "https://example.test/schema#/$defs/value",
      description: "See https://example.test/schema for details.",
    };

    expect(
      rebaseJsonSchemaReferences(source, "https://example.test/schema", "#/$defs/rebased"),
    ).toEqual({
      $ref: "#/$defs/rebased#/$defs/value",
      description: source.description,
    });
  });

  it("exports the complete canonical contract from the package root", () => {
    expect(packageRootFieldDefinition.key).toBe("definition");
    expect(packageRootSemanticTypeKind).toBe("object");
    expect(packageRootAdapterUrls.baseUrlTemplates.secondary).toBe(
      "https://secondary.example.test",
    );
    expect(packageRootOperationUrl.baseUrlKey).toBe("secondary");
    expect(packageRootRequestMapping.headers[0]?.header).toBe("If-Match");
  });

  it("projects descriptions, validation, defaults, and reference-data enums", () => {
    const schema = compiledFieldSchema(
      field({
        key: "status",
        required: true,
        description: { en: "Lifecycle status." },
        validation: { minLength: 1, maxLength: { value: 50 } },
        defaultValue: "active",
        relationship: { kind: "belongsTo", entity: "StatusDefinition" },
        hints: { aiInstructions: "Choose the closest status." },
        render: { component: "ReferenceSelect", props: { referentieGroep: "STATUS" } },
      }),
      {
        STATUS: [
          { value: "active", label: { en: "Active", nl: "Actief" } },
          { value: "closed", label: { en: "Closed", nl: "Gesloten" } },
        ],
      },
    );

    expect(schema).toEqual({
      type: "string",
      minLength: 1,
      maxLength: 50,
      title: "status",
      enum: ["active", "closed"],
      description:
        "Lifecycle status. References the StatusDefinition entity. " +
        "Allowed values: active (Active), closed (Closed).",
      default: "active",
    });
  });

  it("projects nested objects and collection item shapes recursively", () => {
    const action = field({
      key: "action",
      valueType: "object",
      children: [
        field({ key: "key", required: true, validation: { minLength: 1 } }),
        field({
          key: "kind",
          required: true,
          options: {
            type: "static",
            items: [
              { value: "task", label: { en: "Task" } },
              { value: "workflow", label: { en: "Workflow" } },
            ],
          },
        }),
      ],
    });
    const schema = compiledFieldSchema(
      field({
        key: "actions",
        valueType: "object",
        cardinality: "collection",
        description: { en: "Ordered actions." },
        validation: { minItems: 1 },
        item: action,
      }),
    );

    expect(schema.type).toBe("array");
    expect(schema.title).toBe("actions");
    expect(schema.minItems).toBe(1);
    expect(schema.description).toBe("Ordered actions.");
    expect(schema.items).toMatchObject({
      allOf: [
        { type: "object" },
        {
          type: "object",
          required: ["key", "kind"],
          additionalProperties: false,
          properties: {
            key: { type: "string", minLength: 1 },
            kind: { type: "string", enum: ["task", "workflow"] },
          },
        },
      ],
    });
  });

  it("conjoins outer item constraints with an explicit item schema", () => {
    const schema = compiledFieldSchema(
      field({
        key: "codes",
        cardinality: "collection",
        validation: { maxLength: 8 },
        options: {
          type: "static",
          items: [
            { value: "primary", label: { en: "Primary" } },
            { value: "backup", label: { en: "Backup" } },
          ],
        },
        item: field({ key: "code", label: { en: "Code" } }),
      }),
    );

    expect(schema.items).toEqual({
      allOf: [
        { type: "string", maxLength: 8, enum: ["primary", "backup"] },
        { type: "string", title: "Code", description: "Code" },
      ],
    });
    expect(schema.description).toContain("Allowed values: primary (Primary), backup (Backup).");
  });

  it("places collection defaults at the level matching their value type", () => {
    const scalarDefault = compiledFieldSchema(
      field({ key: "tags", cardinality: "collection", defaultValue: "new" }),
    );
    const arrayDefault = compiledFieldSchema(
      field({ key: "tags", cardinality: "collection", defaultValue: ["new"] }),
    );

    expect(scalarDefault.default).toBeUndefined();
    expect(scalarDefault.items).toMatchObject({ default: "new" });
    expect(arrayDefault.default).toEqual(["new"]);
    expect((arrayDefault.items as Record<string, unknown>).default).toBeUndefined();
  });

  it("threads default and nested-required policy through recursive fields", () => {
    const schema = compiledFieldSchema(
      field({
        key: "metadata",
        valueType: "object",
        children: [field({ key: "source", required: true, defaultValue: "api" })],
      }),
      {},
      { includeDefault: false, requireNestedRequired: false },
    );

    expect(schema.required).toBeUndefined();
    expect(
      (schema.properties as Record<string, Record<string, unknown>>).source?.default,
    ).toBeUndefined();
  });

  it("requires structural fields only when the caller requests it", () => {
    const fields = [field({ key: "name", required: true }), field({ key: "notes" })];
    expect(compiledObjectSchema(fields, {}, { requireRequired: true }).required).toEqual([
      "name",
    ]);
    expect(compiledObjectSchema(fields, {}, { requireRequired: false }).required).toBeUndefined();
  });

  it("projects a field-definition value through the canonical recursive schema", () => {
    const schema = compiledFieldSchema(
      field({
        key: "definition",
        valueType: "object",
        semanticType: "fieldDefinition",
      }),
    );

    expect(schema.$ref).toBe("#/$defs/fieldDefinition");
    expect(schema.$defs).toBeDefined();

    const validate = new Ajv2020.default({ strict: false }).compile(schema);
    expect(
      validate({
        key: "address",
        valueType: "object",
        children: [
          { key: "street", valueType: "string" },
          {
            key: "residents",
            valueType: "object",
            cardinality: "collection",
            item: {
              key: "resident",
              valueType: "object",
              children: [{ key: "name", valueType: "string" }],
            },
          },
        ],
      }),
    ).toBe(true);
    expect(
      validate({
        key: "address",
        valueType: "object",
        children: [{ valueType: "string" }],
      }),
    ).toBe(false);
  });

  it("can project field metadata without cloning reusable definitions", () => {
    const schema = compiledFieldSchemaWithoutDefinitions(
      field({
        key: "definition",
        valueType: "object",
        semanticType: "fieldDefinition",
        description: { en: "Definition" },
      }),
    );

    expect(schema).toMatchObject({
      $ref: "#/$defs/fieldDefinition",
      description: "Definition",
    });
    expect(schema.$defs).toBeUndefined();
  });

  it("bundles one reusable definition for multiple single and collection fields", () => {
    const schema = compiledObjectSchema(
      [
        field({
          key: "definition",
          valueType: "object",
          semanticType: "fieldDefinition",
        }),
        field({
          key: "definitions",
          valueType: "object",
          cardinality: "collection",
          semanticType: "fieldDefinition",
        }),
      ],
      {},
      { requireRequired: true },
    );
    const properties = schema.properties as Record<string, Record<string, unknown>>;

    expect(properties.definition?.$ref).toBe("#/$defs/fieldDefinition");
    expect(properties.definitions?.items).toEqual({ $ref: "#/$defs/fieldDefinition" });
    expect(Object.keys(schema.$defs as object).filter((key) => key === "fieldDefinition")).toHaveLength(1);
    expect(() => new Ajv2020.default({ strict: false }).compile(schema)).not.toThrow();
  });
});
