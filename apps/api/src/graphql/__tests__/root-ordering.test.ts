// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { graphql } from "graphql";
import { resolve } from "node:path";
import { apiKeyMutationFields, apiKeyQueryFields } from "../../auth/api-key/graphql-schema.js";
import {
  connectorMutationFields,
  connectorNamespaceMutationFields,
  connectorNamespaceQueryFields,
  connectorQueryFields,
} from "../../connectors/graphql-schema.js";
import { declaredFieldNames } from "../../modules/graphql-composition.js";
import { currentTenantQueryFields } from "../current-tenant.js";
import {
  generatedEntityMutationFields,
  generatedEntityQueryFields,
} from "../generated-entity-schema.js";
import { buildGraphqlSchema } from "../schema.js";

function sortedFields(fields: string): string[] {
  return declaredFieldNames(fields).sort((left, right) => left.localeCompare(right));
}

function expectedRootOrder() {
  return {
    query: [
      ...["health", "entityPageConfigs", ...declaredFieldNames(currentTenantQueryFields)].sort(),
      ...sortedFields(generatedEntityQueryFields),
      ...sortedFields(`${connectorQueryFields}\n${connectorNamespaceQueryFields}`),
      ...sortedFields(apiKeyQueryFields),
    ],
    mutation: [
      ...sortedFields(generatedEntityMutationFields),
      ...sortedFields(`${connectorMutationFields}\n${connectorNamespaceMutationFields}`),
      ...sortedFields(apiKeyMutationFields),
    ],
  };
}

describe("GraphQL root ordering", () => {
  test("introspection preserves stable groups and descriptions across schema builds", async () => {
    const expected = expectedRootOrder();
    const snapshots = await Promise.all(
      [buildGraphqlSchema(), buildGraphqlSchema()].map(async (schema) => {
        const result = await graphql({
          schema,
          source: `{
            __schema {
              queryType { fields { name description } }
              mutationType { fields { name description } }
            }
          }`,
        });
        expect(result.errors).toBeUndefined();
        const schemaData = (result.data as {
          __schema: {
            queryType: { fields: Array<{ name: string; description: string | null }> };
            mutationType: { fields: Array<{ name: string; description: string | null }> };
          };
        }).__schema;
        return {
          query: schemaData.queryType.fields,
          mutation: schemaData.mutationType.fields,
        };
      }),
    );

    expect(snapshots[0]).toEqual(snapshots[1]);
    expect(snapshots[0]!.query.map(({ name }) => name)).toEqual(expected.query);
    expect(snapshots[0]!.mutation.map(({ name }) => name)).toEqual(expected.mutation);
    expect(snapshots[0]!.query.find(({ name }) => name === "entityPageConfigs")?.description)
      .toContain("Generated presentation configuration");
  });

  test("is identical across two clean process starts", async () => {
    const repoRoot = resolve(import.meta.dir, "../../../../..");
    const script = `
      import { graphql } from "graphql";
      import { buildGraphqlSchema } from "./src/graphql/schema.ts";
      const result = await graphql({
        schema: buildGraphqlSchema(),
        source: "{ __schema { queryType { fields { name description } } mutationType { fields { name description } } } }",
      });
      process.stdout.write(JSON.stringify(result));
    `;
    const inspect = async () => {
      const child = Bun.spawn([process.execPath, "-e", script], {
        cwd: resolve(repoRoot, "apps/api"),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      return JSON.parse(stdout);
    };
    expect(await inspect()).toEqual(await inspect());
  });
});
