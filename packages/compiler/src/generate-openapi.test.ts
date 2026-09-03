// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import type {
  CompiledEntityContract,
  CompiledField,
} from "./authoring/types.js";
import { renderOpenApiSpec } from "./generate-openapi.js";
import type { PlatformSchemaManifest } from "./schema.js";

function field(
  overrides: Partial<CompiledField> & Pick<CompiledField, "key">,
): CompiledField {
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
        hints: {
          aiInstructions: "Resolve this with the external-system list tool.",
        },
      }),
      field({
        key: "iban",
        label: { en: "IBAN" },
        description: { en: "International bank account number." },
        validation: { maxLength: 34 },
        classification: { sensitivity: "confidential" },
      }),
      field({ key: "first", description: { en: "Business sequence value." } }),
      field({ key: "status", description: { en: "Current status." } }),
      field({ key: "statusIn", description: { en: "Status import marker." } }),
      field({
        key: "isOptedIn",
        valueType: "boolean",
        description: { en: "Whether the relation opted in." },
      }),
    ],
  },
  rest: {
    basePath: "relations",
    operations: {
      list: true,
      get: true,
      create: true,
      update: true,
      delete: true,
    },
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
        {
          name: "display_name",
          type: "text",
          required: true,
          sourceField: "displayName",
        },
        {
          name: "relation_type",
          type: "text",
          required: true,
          sourceField: "relationType",
        },
        { name: "metadata", type: "jsonb", sourceField: "metadata" },
        {
          name: "external_id",
          type: "text",
          sourceField: "externalId",
          immutable: true,
        },
        { name: "iban", type: "text", sourceField: "iban" },
        { name: "business_first", type: "text", sourceField: "first" },
        { name: "status", type: "text", sourceField: "status" },
        { name: "status_in", type: "text", sourceField: "statusIn" },
        { name: "is_opted_in", type: "boolean", sourceField: "isOptedIn" },
        { name: "marker", type: "text", sourceField: "marker" },
        {
          name: "marker_in",
          type: "text",
          sourceField: "markerIn",
          classification: "confidential",
        },
        {
          name: "private_marker",
          type: "text",
          sourceField: "privateMarker",
          classification: "pii",
        },
        {
          name: "sequence_number",
          type: "bigint",
          sourceField: "sequenceNumber",
        },
        {
          name: "relation_group_id",
          type: "uuid",
          sourceField: "relationGroupId",
        },
        { name: "created_at", type: "timestamptz", required: true },
      ],
      source: {
        authoringEntityName: "Relation",
        rest: contract.rest!,
        mcp: {
          toolPrefix: "relation",
          tools: "dedicated",
          operations: {
            list: true,
            get: true,
            create: true,
            update: true,
            delete: true,
          },
          elicitOnCreate: {
            sourceField: "externalId",
            sourceEntity: "ExternalSystem",
            definitionsField: "metadata",
            into: "metadata",
          },
        },
      },
    },
  ],
};

type TestParameter = {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  style?: string;
  explode?: boolean;
  schema: Record<string, unknown>;
};

type TestOperation = {
  tags?: string[];
  parameters?: TestParameter[];
};

function spec() {
  return JSON.parse(
    renderOpenApiSpec(manifest, "fixture", {
      entities: [{ contract }],
      referentiedata: {
        RELATIONTYPE: [
          { value: "person", label: { en: "Person", nl: "Persoon" } },
          {
            value: "organization",
            label: { en: "Organization", nl: "Organisatie" },
          },
        ],
      },
    }),
  ) as {
    tags: Array<{ name: string; description?: string }>;
    paths: Record<
      string,
      {
        parameters?: TestParameter[];
        get?: TestOperation;
        post?: TestOperation;
        patch?: TestOperation;
        delete?: TestOperation;
      }
    >;
    components: { schemas: Record<string, Record<string, unknown>> };
  };
}

describe("rich generated REST OpenAPI", () => {
  it("puts committed host onboarding before generic safe-start guidance and provenance", () => {
    const rendered = JSON.parse(renderOpenApiSpec(manifest, "fixture", {
      entities: [{ contract }],
      documentation: {
        title: "Example Product API",
        version: "2026-09",
        description: "Use this API to synchronize records.",
        externalDocs: {
          description: "Developer guide",
          url: "https://example.com/developers",
        },
      },
    })) as {
      info: { title: string; version: string; description: string };
      externalDocs: { description: string; url: string };
    };

    expect(rendered.info.title).toBe("Example Product API");
    expect(rendered.info.version).toBe("2026-09");
    expect(rendered.info.description).toStartWith("Use this API to synchronize records.");
    expect(rendered.info.description.indexOf("## Start here")).toBeGreaterThan(
      rendered.info.description.indexOf("Use this API to synchronize records."),
    );
    expect(rendered.info.description).toContain("```text");
    expect(rendered.info.description).toEndWith(
      "Generated by @openshapeforge/compiler. Source: fixture. Do not edit by hand.",
    );
    expect(rendered.externalDocs).toEqual({
      description: "Developer guide",
      url: "https://example.com/developers",
    });
  });

  it("keeps generic developer onboarding for hosts without committed REST API copy", () => {
    const rendered = JSON.parse(renderOpenApiSpec({ version: 1, tables: [] }, "fixture")) as {
      info: { title: string; version: string; description: string };
      paths: Record<string, unknown>;
    };

    expect(rendered.paths).toEqual({});
    expect(rendered.info.title).toBe("OpenShapeForge generated REST API");
    expect(rendered.info.version).toBe("1");
    expect(rendered.info.description).toContain("## Start here");
    expect(rendered.info.description).toContain("## Starter prompt");
    expect(rendered.info.description).toContain("Choose a documented operation");
    expect(rendered.info.description).toContain("Prefer a documented GET while exploring");
    expect(rendered.info.description).not.toContain("GET /api/rest/v1/{entity}");
    expect(rendered.info.description).not.toContain("Pick an entity");
    expect(rendered.info.description).toContain("public or custom authentication");
    expect(rendered.info.description).toContain("session-authenticated entity or operation");
    expect(rendered.info.description).not.toContain("Every operation needs a bearer token");
    expect(rendered.info.description).not.toContain("For a protected operation, the caller's roles");
    expect(rendered.info.description).toContain("Do not invent");
    expect(rendered.info.description).toEndWith(
      "Generated by @openshapeforge/compiler. Source: fixture. Do not edit by hand.",
    );
    expect((rendered as any).security).toEqual([{ bearerAuth: [] }]);
    expect((rendered as any).components.securitySchemes).toMatchObject({
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
    });
    expect((rendered as any).components.securitySchemes.bearerAuth.description).toBeUndefined();
    expect((rendered as any).components.securitySchemes.oauth2Auth).toBeUndefined();
  });

  it("emits host-authored OAuth Authorization Code metadata and public Swagger configuration", () => {
    const rendered = JSON.parse(renderOpenApiSpec(manifest, "fixture", {
      entities: [{ contract }],
      documentation: {
        title: "Example Product API",
        description: "Authenticate before using protected operations.",
        bearerDescription: "Paste an access token issued for this API.",
        oauth2: {
          description: "Sign in through the host identity provider using Authorization Code with PKCE.",
          authorizationUrl: "https://identity.example.com/oauth/authorize",
          tokenUrl: "https://identity.example.com/oauth/token",
          clientId: "public-docs-client",
          scopes: {
            openid: "Sign in",
            profile: "Read profile claims",
          },
          redirectUrl: "https://api.example.com/api/rest/docs/oauth2-redirect.html",
        },
      },
    })) as any;

    expect(rendered.security).toEqual([{ bearerAuth: [] }, { oauth2Auth: [] }]);
    expect(rendered.components.securitySchemes.bearerAuth.description).toBe(
      "Paste an access token issued for this API.",
    );
    expect(rendered.components.securitySchemes.oauth2Auth).toEqual({
      type: "oauth2",
      description: "Sign in through the host identity provider using Authorization Code with PKCE.",
      flows: {
        authorizationCode: {
          authorizationUrl: "https://identity.example.com/oauth/authorize",
          tokenUrl: "https://identity.example.com/oauth/token",
          scopes: {
            openid: "Sign in",
            profile: "Read profile claims",
          },
        },
      },
      "x-swagger-ui-client-id": "public-docs-client",
      "x-swagger-ui-redirect-url":
        "https://api.example.com/api/rest/docs/oauth2-redirect.html",
    });
    expect(JSON.stringify(rendered)).not.toContain("clientSecret");
  });

  it("emits only allowed routes for a partial policy hidden from legacy runtimes", () => {
    const partial = structuredClone(manifest);
    const table = partial.tables[0]!;
    table.generatedCrudEligible = true;
    table.generatedCrud = false;
    table.source!.rest!.operations = {
      list: true,
      get: true,
      create: false,
      update: false,
      delete: false,
    };
    const rendered = JSON.parse(
      renderOpenApiSpec(partial, "fixture", {
        entities: [{ contract }],
      }),
    ) as { paths: Record<string, Record<string, unknown>> };
    expect(Object.keys(rendered.paths["/api/rest/v1/relations"]!)).toEqual([
      "get",
    ]);
    expect(Object.keys(rendered.paths["/api/rest/v1/relations/{id}"]!)).toEqual(
      ["parameters", "get"],
    );
  });

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
    expect(relation.properties.relationGroupId).toEqual({
      type: "string",
      format: "uuid",
    });
  });

  it("models create requiredness, partial PATCH, immutability, and secure fields", () => {
    const schemas = spec().components.schemas;
    const create = schemas.RelationInput as {
      required?: string[];
      properties: Record<string, Record<string, unknown>>;
    };
    const update = schemas.RelationUpdateInput as {
      required?: string[];
      properties: Record<string, Record<string, unknown>>;
    };

    expect(create.required).toEqual(["relationType"]);
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
    expect(create.properties.metadata).toBeUndefined();
    expect(update.properties.metadata).toBeUndefined();
  });

  it("bundles the recursive FieldDefinition contract in generated request schemas", () => {
    const semanticContract = structuredClone(contract);
    semanticContract.model.fields.push(
      field({
        key: "definition",
        valueType: "object",
        semanticType: "fieldDefinition",
      }),
    );
    const semanticManifest = structuredClone(manifest);
    semanticManifest.tables[0]!.columns.push({
      name: "definition",
      type: "jsonb",
      sourceField: "definition",
    });
    const generated = JSON.parse(
      renderOpenApiSpec(semanticManifest, "fixture", {
        entities: [{ contract: semanticContract }],
      }),
    ) as { components: { schemas: Record<string, Record<string, unknown>> } };
    const create = generated.components.schemas.RelationInput as {
      properties: Record<string, Record<string, unknown>>;
      $defs?: Record<string, unknown>;
    };
    const fieldDefinition = generated.components.schemas
      .OpenShapeForgeFieldDefinition as {
      $ref?: string;
      $defs?: Record<string, unknown>;
    };

    expect(create.properties.definition?.$ref).toBe(
      "#/components/schemas/OpenShapeForgeFieldDefinition/$defs/fieldDefinition",
    );
    expect(create.$defs).toBeUndefined();
    expect(fieldDefinition.$ref).toBe(
      "#/components/schemas/OpenShapeForgeFieldDefinition/$defs/fieldDefinition",
    );
    expect(fieldDefinition.$defs).toMatchObject({
      fieldDefinition: {
        allOf: [
          {
            $ref: "#/components/schemas/OpenShapeForgeFieldDefinition/$defs/fieldDefinitionProperties",
          },
        ],
      },
    });
  });

  it("tags operations with the compiled entity description", () => {
    const generated = spec();
    expect(generated.tags).toEqual([
      { name: "Relation", description: "Canonical relation aggregate." },
    ]);
    expect(generated.paths["/api/rest/v1/relations"]?.post?.tags).toEqual([
      "Relation",
    ]);
  });

  it("documents pagination and sorting with the runtime defaults and supported fields", () => {
    const parameters =
      spec().paths["/api/rest/v1/relations"]?.get?.parameters ?? [];
    const byName = new Map(
      parameters.map((parameter) => [parameter.name, parameter]),
    );

    expect(byName.get("first")).toEqual({
      name: "first",
      in: "query",
      description:
        "Number of records to return. When absent it defaults to 50; supplied values are clamped to 1-200.",
      schema: { type: "integer", default: 50 },
    });
    expect(byName.get("after")?.description).toContain("nextCursor");
    expect(byName.get("sortField")?.schema).toEqual({
      type: "string",
      enum: [
        "id",
        "displayName",
        "relationType",
        "externalId",
        "first",
        "status",
        "statusIn",
        "isOptedIn",
        "marker",
        "sequenceNumber",
        "relationGroupId",
        "createdAt",
      ],
      default: "id",
    });
    expect(byName.get("sortDirection")?.schema).toEqual({
      type: "string",
      enum: ["asc", "desc"],
      default: "asc",
    });
  });

  it("projects scalar field semantics into direct and explicit IN filters", () => {
    const parameters =
      spec().paths["/api/rest/v1/relations"]?.get?.parameters ?? [];
    const byName = new Map(
      parameters.map((parameter) => [parameter.name, parameter]),
    );

    expect(byName.get("displayName")).toMatchObject({
      description:
        "Human-readable relation name. Matches a case-insensitive substring. Repeat this parameter to instead match exactly against any supplied value.",
      schema: { type: "string" },
    });
    expect(byName.get("displayName")?.schema.default).toBeUndefined();
    expect(byName.get("displayNameIn")?.schema).toEqual({
      type: "array",
      items: { type: "string" },
    });
    expect(byName.get("relationType")?.schema).toEqual({ type: "string" });
    expect(byName.get("relationType")?.description).not.toContain(
      "Allowed values:",
    );
    expect(byName.get("relationTypeIn")?.description).not.toContain(
      "Allowed values:",
    );
    expect(byName.get("relationTypeIn")).toMatchObject({
      style: "form",
      explode: true,
      schema: {
        type: "array",
        items: { type: "string" },
      },
    });
    expect(byName.get("relationGroupId")?.schema).toEqual({
      type: "string",
      format: "uuid",
    });
    expect(byName.has("metadata")).toBe(false);
    expect(byName.has("metadataIn")).toBe(false);
    expect(byName.has("iban")).toBe(false);
    expect(byName.has("ibanIn")).toBe(false);
    expect(byName.has("tenantId")).toBe(false);
    expect(byName.has("tenantIdIn")).toBe(false);
    expect(byName.has("privateMarker")).toBe(false);
    expect(byName.has("privateMarkerIn")).toBe(false);
    expect(byName.get("sequenceNumber")?.schema).toEqual({ type: "integer" });
  });

  it("avoids transport and explicit-IN parameter name collisions", () => {
    const parameters =
      spec().paths["/api/rest/v1/relations"]?.get?.parameters ?? [];
    const names = parameters.map((parameter) => parameter.name);
    const byName = new Map(
      parameters.map((parameter) => [parameter.name, parameter]),
    );

    expect(new Set(names).size).toBe(names.length);
    expect(names.filter((name) => name === "first")).toHaveLength(1);
    expect(byName.get("first")?.description).toContain("Number of records");
    expect(byName.get("firstIn")?.description).toContain(
      "Business sequence value.",
    );
    expect(byName.has("statusIn")).toBe(false);
    expect(byName.get("statusInIn")?.description).toContain(
      "Status import marker.",
    );
    expect(byName.has("isOptedIn")).toBe(false);
    expect(byName.get("isOptedInIn")?.schema).toEqual({
      type: "array",
      items: { type: "boolean" },
    });
    expect(byName.has("markerIn")).toBe(false);
  });

  it("documents the item path identifier", () => {
    const parameters = spec().paths["/api/rest/v1/relations/{id}"]?.parameters;
    expect(parameters).toEqual([
      {
        name: "id",
        in: "path",
        required: true,
        description: "Unique identifier of the Relation record.",
        schema: { type: "string", format: "uuid" },
      },
    ]);
  });
});
