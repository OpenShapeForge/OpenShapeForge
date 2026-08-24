// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import type { CompiledEntityContract, CompiledField } from "./authoring/types.js";
import { renderOpenApiSpec } from "./generate-openapi.js";
import type { PlatformSchemaManifest } from "./schema.js";

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

const contract = {
  entity: {
    name: "Relation",
    title: "Relation",
    labels: { en: "Relation", nl: "Relatie" },
    description: {
      en: "Canonical relation aggregate.",
      nl: "Canonieke relatie-aggregate.",
    },
  },
  model: {
    fields: [
      field({
        key: "displayName",
        required: true,
        label: { en: "Display name" },
        description: { en: "Human-readable relation name." },
        validation: { minLength: 1, maxLength: 200 },
        defaultValue: "Unnamed relation",
      }),
      field({
        key: "relationType",
        required: true,
        label: { en: "Relation type" },
        render: {
          component: "ReferenceSelect",
          props: { referentieGroep: "RELATIONTYPE" },
        },
      }),
      field({
        key: "metadata",
        valueType: "object",
        label: { en: "Metadata" },
        children: [
          field({
            key: "source",
            required: true,
            label: { en: "Source" },
            defaultValue: "api",
          }),
          field({ key: "notes", label: { en: "Notes" } }),
        ],
      }),
      field({
        key: "externalId",
        immutable: true,
        label: { en: "External ID" },
        description: { en: "Identifier in the owning external system." },
        relationship: { kind: "belongsTo", entity: "ExternalSystem" },
        hints: { aiInstructions: "Resolve this with the external-system list tool." },
      }),
      field({
        key: "iban",
        label: { en: "IBAN" },
        description: { en: "International bank account number." },
        validation: { maxLength: 34 },
        classification: { sensitivity: "confidential" },
      }),
    ],
  },
  rest: {
    basePath: "relations",
    operations: { list: true, get: true, create: true, update: true, delete: true },
  },
} as unknown as CompiledEntityContract;

const manifest: PlatformSchemaManifest = {
  version: 1,
  tables: [
    {
      schema: "erp",
      name: "relations",
      tenantScoped: true,
      generatedCrud: true,
      columns: [
        { name: "id", type: "uuid", primaryKey: true },
        { name: "tenant_id", type: "uuid", required: true },
        { name: "display_name", type: "text", required: true, sourceField: "displayName" },
        { name: "relation_type", type: "text", required: true, sourceField: "relationType" },
        { name: "metadata", type: "jsonb", sourceField: "metadata" },
        { name: "external_id", type: "text", sourceField: "externalId", immutable: true },
        { name: "iban", type: "text", sourceField: "iban" },
        { name: "relation_group_id", type: "uuid", sourceField: "relationGroupId" },
        { name: "created_at", type: "timestamptz", required: true },
      ],
      source: {
        authoringEntityName: "Relation",
        rest: contract.rest!,
      },
    },
  ],
};

function spec() {
  return JSON.parse(
    renderOpenApiSpec(manifest, "fixture", {
      entities: [{ contract }],
      referentiedata: {
        RELATIONTYPE: [
          { value: "person", label: { en: "Person", nl: "Persoon" } },
          { value: "organization", label: { en: "Organization", nl: "Organisatie" } },
        ],
      },
    }),
  ) as {
    tags: Array<{ name: string; description?: string }>;
    paths: Record<string, Record<string, { tags?: string[] }>>;
    components: { schemas: Record<string, Record<string, unknown>> };
  };
}

describe("rich generated REST OpenAPI", () => {
  it("keeps response properties storage-derived while retaining entity documentation", () => {
    const generated = spec();
    const relation = generated.components.schemas.Relation as {
      description?: string;
      properties: Record<string, Record<string, unknown>>;
    };

    expect(relation.description).toBe("Canonical relation aggregate.");
    expect(relation.properties.displayName).toEqual({ type: "string" });
    expect(relation.properties.relationType).toEqual({ type: "string" });
    expect(relation.properties.metadata).toEqual({});
    expect(relation.properties.iban).toEqual({ type: "string" });
    expect(relation.properties.relationGroupId).toEqual({ type: "string", format: "uuid" });
  });

  it("models create requiredness, partial PATCH, immutability, and nested JSON", () => {
    const schemas = spec().components.schemas;
    const create = schemas.RelationInput as {
      required?: string[];
      properties: Record<string, Record<string, unknown>>;
    };
    const update = schemas.RelationUpdateInput as {
      required?: string[];
      properties: Record<string, Record<string, unknown>>;
    };

    expect(create.required).toEqual(["displayName", "relationType"]);
    expect(create.properties.externalId).toBeDefined();
    expect(create.properties.displayName).toMatchObject({
      type: "string",
      title: "Display name",
      description: "Human-readable relation name.",
      minLength: 1,
      maxLength: 200,
      default: "Unnamed relation",
    });
    expect(create.properties.relationType).toMatchObject({
      type: "string",
      enum: ["person", "organization"],
      title: "Relation type",
    });
    expect(create.properties.externalId?.description).toBe(
      "Identifier in the owning external system. References the ExternalSystem entity.",
    );
    expect(create.properties.iban).toEqual({ type: "string" });
    expect(update.required).toBeUndefined();
    expect(update.properties.externalId).toBeUndefined();
    expect(update.properties.displayName?.default).toBeUndefined();
    expect(create.properties.metadata).toMatchObject({
      type: "object",
      required: ["source"],
      additionalProperties: false,
      properties: {
        source: { type: "string", title: "Source" },
        notes: { type: "string", title: "Notes" },
      },
    });
    expect(
      (
        (update.properties.metadata?.properties as Record<
          string,
          Record<string, unknown>
        >)?.source
      )?.default,
    ).toBeUndefined();
  });

  it("tags operations with the compiled entity description", () => {
    const generated = spec();
    expect(generated.tags).toEqual([
      { name: "Relation", description: "Canonical relation aggregate." },
    ]);
    expect(generated.paths["/api/rest/v1/relations"]?.post?.tags).toEqual(["Relation"]);
  });
});
