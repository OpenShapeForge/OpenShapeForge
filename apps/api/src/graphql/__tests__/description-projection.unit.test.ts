// SPDX-License-Identifier: BUSL-1.1
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSchema,
  graphql,
} from "graphql";
import {
  createGraphqlDocumentationIndex,
  renderMutationFields,
  renderQueryFields,
  renderTypeDefinition,
} from "../generated-entity-schema.js";

const ENTITY_DESCRIPTION =
  "Entity description changed in the authoring YAML for transport verification.";
const FIELD_DESCRIPTION =
  "Field description changed in the authoring YAML for transport verification.";
const RICH_FIELD_DESCRIPTION =
  `${FIELD_DESCRIPTION} Allowed values: alpha (Alpha), beta (Beta).`;
const FIXTURE_DIR = join(
  import.meta.dir,
  "../../../../../packages/compiler/src/authoring/__fixtures__/rowaccess",
);
const COMPILER_SOURCE_DIR = join(
  import.meta.dir,
  "../../../../../packages/compiler/src",
);
const temporaryDirectories: string[] = [];

type CompilerFunctions = {
  compileAuthoringBackendManifest: (...args: any[]) => any;
  buildGraphqlDocumentationCatalog: (...args: any[]) => any;
  buildMcpCatalog: (...args: any[]) => any;
  renderGraphqlDocumentationCatalog: (...args: any[]) => string;
  renderOpenApiSpec: (...args: any[]) => string;
};

async function loadCompilerFunctions(): Promise<CompilerFunctions> {
  // Computed specifiers keep the API typecheck inside apps/api/src while Bun
  // still executes the real compiler source for this repository-level contract
  // test. Static imports would make tsc traverse packages/compiler outside the
  // API project's rootDir.
  const backendManifestSpecifier = `${COMPILER_SOURCE_DIR}/authoring/backend-manifest.ts`;
  const graphqlSpecifier = `${COMPILER_SOURCE_DIR}/generate-graphql.ts`;
  const mcpSpecifier = `${COMPILER_SOURCE_DIR}/generate-mcp.ts`;
  const openApiSpecifier = `${COMPILER_SOURCE_DIR}/generate-openapi.ts`;
  const [backendManifest, graphql, mcp, openApi] = await Promise.all([
    import(backendManifestSpecifier),
    import(graphqlSpecifier),
    import(mcpSpecifier),
    import(openApiSpecifier),
  ]);
  return {
    compileAuthoringBackendManifest: backendManifest.compileAuthoringBackendManifest,
    buildGraphqlDocumentationCatalog: graphql.buildGraphqlDocumentationCatalog,
    renderGraphqlDocumentationCatalog: graphql.renderGraphqlDocumentationCatalog,
    buildMcpCatalog: mcp.buildMcpCatalog,
    renderOpenApiSpec: openApi.renderOpenApiSpec,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function changedAuthoringDirectory(): string {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "openshapeforge-description-projection-"),
  );
  temporaryDirectories.push(temporaryDirectory);
  const authoringDirectory = join(temporaryDirectory, "authoring");
  cpSync(FIXTURE_DIR, authoringDirectory, { recursive: true });

  const entityPath = join(authoringDirectory, "entities/rest-enabled.yaml");
  const original = readFileSync(entityPath, "utf8");
  const changed = original
    .replace(
      /^description:.*$/m,
      `description:\n  en: ${JSON.stringify(ENTITY_DESCRIPTION)}`,
    )
    .replace("rest: true\n", "rest: true\nmcp: true\n")
    .replace(
      "    label:\n      en: Name\n    persisted:",
      `    label:\n      en: Name\n    description:\n      en: ${JSON.stringify(FIELD_DESCRIPTION)}\n    options:\n      type: static\n      items:\n        - value: alpha\n          label: { en: Alpha }\n        - value: beta\n          label: { en: Beta }\n    persisted:`,
    );

  expect(changed).not.toBe(original);
  expect(changed).toContain(ENTITY_DESCRIPTION);
  expect(changed).toContain(FIELD_DESCRIPTION);
  writeFileSync(entityPath, changed, "utf8");
  return authoringDirectory;
}

describe("authoring description projections", () => {
  test("one changed YAML entity and field description reaches OpenAPI, MCP, and GraphQL introspection", async () => {
    const {
      compileAuthoringBackendManifest,
      buildGraphqlDocumentationCatalog,
      buildMcpCatalog,
      renderGraphqlDocumentationCatalog,
      renderOpenApiSpec,
    } = await loadCompilerFunctions();
    const authoringDirectory = changedAuthoringDirectory();
    let contract: any;
    const manifest = compileAuthoringBackendManifest(authoringDirectory, {
      mode: "promote",
      entityAllowlist: ["rest-enabled"],
      generatedCrudAllowlist: ["rest-enabled"],
      schemaByModule: { core: "erp" },
      onCandidate: (candidate: any) => {
        contract = candidate.contract;
      },
    });

    expect(contract).toBeDefined();
    const compiled = contract!;
    const table = manifest.tables.find(
      (candidate: any) => candidate.source?.authoringEntityName === "RestEnabled",
    );
    expect(table).toBeDefined();

    const openApi = JSON.parse(
      renderOpenApiSpec(manifest, "description fixture", {
        entities: [{ contract: compiled }],
      }),
    ) as {
      tags: Array<{ name: string; description?: string }>;
      components: {
        schemas: Record<
          string,
          { description?: string; properties?: Record<string, { description?: string }> }
        >;
      };
    };
    expect(openApi.tags.find((tag) => tag.name === "RestEnabled")?.description).toBe(
      ENTITY_DESCRIPTION,
    );
    expect(openApi.components.schemas.RestEnabled?.description).toBe(ENTITY_DESCRIPTION);
    expect(
      openApi.components.schemas.RestEnabledInput?.properties?.name?.description,
    ).toBe(RICH_FIELD_DESCRIPTION);

    const mcp = buildMcpCatalog(
      [
        {
          slug: "rest-enabled",
          contract: compiled,
          table: `${table!.schema}.${table!.name}`,
        },
      ],
      "description fixture",
    );
    const mcpEntity = mcp.entities.find(
      (entity: any) => entity.entity === "RestEnabled",
    );
    expect(mcpEntity?.description).toBe(ENTITY_DESCRIPTION);
    expect(mcpEntity?.fields.find((field: any) => field.key === "name")?.description).toBe(
      FIELD_DESCRIPTION,
    );
    const createTool = mcp.tools.find(
      (tool: any) => tool.entity === "RestEnabled" && tool.operation === "create",
    );
    expect(
      (
        createTool?.inputSchema.properties as
          | Record<string, { description?: string }>
          | undefined
      )?.name?.description,
    ).toBe(RICH_FIELD_DESCRIPTION);

    const graphqlCatalog = buildGraphqlDocumentationCatalog(
      [compiled],
      "description fixture",
    );
    const graphqlArtifactPath = join(
      temporaryDirectories[0]!,
      "documentation.json",
    );
    writeFileSync(
      graphqlArtifactPath,
      renderGraphqlDocumentationCatalog([compiled], "description fixture"),
      "utf8",
    );
    const serializedGraphqlCatalog = JSON.parse(
      readFileSync(graphqlArtifactPath, "utf8"),
    );
    expect(serializedGraphqlCatalog).toEqual(graphqlCatalog);
    const documentationIndex = createGraphqlDocumentationIndex(
      serializedGraphqlCatalog,
    );
    const graphqlMetadata = table!.source!.graphql!;
    const schema = buildSchema(`
      scalar JSON
      type PageInfo { hasNextPage: Boolean, endCursor: String }
      type AggregateResult { count: Int! }
      ${renderTypeDefinition(
        table! as Parameters<typeof renderTypeDefinition>[0],
        documentationIndex,
      )}
      type Query {
        ${renderQueryFields(
          table! as Parameters<typeof renderQueryFields>[0],
          documentationIndex,
        )}
      }
      type Mutation {
        ${renderMutationFields(
          table! as Parameters<typeof renderMutationFields>[0],
          documentationIndex,
        )}
      }
    `);
    const introspection = await graphql({
      schema,
      source: `
        query DescriptionProjection {
          entity: __type(name: "RestEnabled") {
            description
            fields { name description }
          }
          createInput: __type(name: "CreateRestEnabledInput") {
            inputFields { name description }
          }
          updateInput: __type(name: "UpdateRestEnabledInput") {
            inputFields { name description }
          }
          filterInput: __type(name: "RestEnabledFilter") {
            inputFields { name description }
          }
          queryRoot: __type(name: "Query") {
            fields { name description }
          }
          mutationRoot: __type(name: "Mutation") {
            fields { name description }
          }
        }
      `,
    });
    expect(introspection.errors).toBeUndefined();
    const data = introspection.data as Record<string, any>;
    const descriptionFor = (type: string, field: string) =>
      data[type]?.fields?.find((candidate: any) => candidate.name === field)?.description ??
      data[type]?.inputFields?.find((candidate: any) => candidate.name === field)?.description;

    expect(data.entity?.description).toBe(ENTITY_DESCRIPTION);
    expect(descriptionFor("entity", "name")).toBe(RICH_FIELD_DESCRIPTION);
    expect(descriptionFor("createInput", "name")).toBe(RICH_FIELD_DESCRIPTION);
    expect(descriptionFor("updateInput", "name")).toBe(RICH_FIELD_DESCRIPTION);
    expect(descriptionFor("filterInput", "name")).toBe(
      `${FIELD_DESCRIPTION} Matches a case-insensitive substring.`,
    );
    expect(descriptionFor("filterInput", "nameIn")).toBe(
      `${RICH_FIELD_DESCRIPTION} Matches exactly against any supplied value.`,
    );
    expect(descriptionFor("queryRoot", graphqlMetadata.singleQueryName)).toBe(
      `${ENTITY_DESCRIPTION} Fetches one record by id.`,
    );
    expect(descriptionFor("queryRoot", graphqlMetadata.listQueryName)).toBe(
      `${ENTITY_DESCRIPTION} Returns a page of records.`,
    );
    expect(descriptionFor("mutationRoot", graphqlMetadata.createMutationName)).toBe(
      `${ENTITY_DESCRIPTION} Creates a record.`,
    );
    expect(descriptionFor("mutationRoot", graphqlMetadata.updateMutationName)).toBe(
      `${ENTITY_DESCRIPTION} Partially updates a record.`,
    );
    expect(descriptionFor("mutationRoot", graphqlMetadata.deleteMutationName)).toBe(
      `${ENTITY_DESCRIPTION} Deletes a record by id.`,
    );
  });
});
