// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import type { CompiledField } from "./authoring/types.js";
import { compiledFieldSchema, compiledObjectSchema } from "./field-json-schema.js";

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
  it("projects descriptions, validation, defaults, and reference-data enums", () => {
    const schema = compiledFieldSchema(
      field({
        key: "status",
        required: true,
        description: { en: "Lifecycle status." },
        validation: { minLength: 1, maxLength: { value: 50 } },
        defaultValue: "active",
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
      description: "Lifecycle status. Allowed values: active (Active), closed (Closed).",
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
        cardinalityBounds: { min: 2, max: 5 },
        description: { en: "Ordered actions." },
        validation: { minItems: 1 },
        item: action,
      }),
    );

    expect(schema.type).toBe("array");
    expect(schema.title).toBe("actions");
    expect(schema.minItems).toBe(2);
    expect(schema.maxItems).toBe(5);
    expect(schema.description).toBe("Ordered actions.");
    expect(schema.items).toMatchObject({
      type: "object",
      required: ["key", "kind"],
      additionalProperties: false,
      properties: {
        key: { type: "string", minLength: 1 },
        kind: { type: "string", enum: ["task", "workflow"] },
      },
    });
  });

  it("requires structural fields only when the caller requests it", () => {
    const fields = [field({ key: "name", required: true }), field({ key: "notes" })];
    expect(compiledObjectSchema(fields, {}, { requireRequired: true }).required).toEqual([
      "name",
    ]);
    expect(compiledObjectSchema(fields, {}, { requireRequired: false }).required).toBeUndefined();
  });
});
