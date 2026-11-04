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
import { availableTenantQueryFields } from "../available-tenants.js";
import { currentTenantQueryFields } from "../current-tenant.js";
import {
  generatedEntityMutationFields,
  generatedEntityQueryFields,
} from "../generated-entity-schema.js";
import { buildGraphqlSchema, sortRootFieldDefinitions } from "../schema.js";
import operationCatalog from "../../generated/operations/catalog.json" with { type: "json" };

function sortedFields(fields: string): string[] {
  return declaredFieldNames(fields).sort();
}

const CORE_OPERATION_PLUGINS = ["osf-billing", "osf-extensions", "osf-jobs", "osf-transitions"];

/**
 * The core Operations of one root type, in codepoint order, as the
 * operation contribution merges them. The jobs, transition and billing ones named here
 * exist in every composition; the tenant field Operations (`osf-extensions`:
 * the definitions of each extensible entity and the referencedBy read of
 * each target) only where an entity is extensible.
 */
function operationContribution(kind: "query" | "mutation", named: string[]): string[] {
  const fields = operationCatalog.operations
    .filter((operation) => CORE_OPERATION_PLUGINS.includes(operation.plugin) && operation.transports.graphql.enabled &&
      operation.transports.graphql.kind === kind)
    .map((operation) => operation.transports.graphql.field as string)
    .sort();
  expect(fields.filter((field) => named.includes(field))).toEqual(named);
  expect(fields.filter((field) => !named.includes(field)).every((field) =>
    operationCatalog.operations.some((operation) => operation.plugin === "osf-extensions" && operation.transports.graphql.field === field))).toBe(true);
  return fields;
}

function expectedRootOrder() {
  return {
    query: [
      ...["health", "entityPageConfigs", ...declaredFieldNames(currentTenantQueryFields), ...declaredFieldNames(availableTenantQueryFields)].sort(),
      ...sortedFields(generatedEntityQueryFields),
      ...sortedFields(`${connectorQueryFields}\n${connectorNamespaceQueryFields}`),
      ...sortedFields(apiKeyQueryFields),
      // The core `osf-jobs` Operations project in every process (jobs.md),
      // after the module groups, as the operation contribution is merged last.
      ...operationContribution("query", ["job", "jobs"]),
    ],
    mutation: [
      ...sortedFields(generatedEntityMutationFields),
      ...sortedFields(`${connectorMutationFields}\n${connectorNamespaceMutationFields}`),
      ...sortedFields(apiKeyMutationFields),
      // Likewise the core `osf-transitions`, `osf-billing` and `osf-jobs`
      // Operations, merged last in the same order.
      ...operationContribution("mutation", [
        "agreementMilestoneCancel",
        "agreementMilestoneInvoice",
        "agreementMilestoneTrigger",
        "billingRunExecute",
        "jobRetry",
      ]),
    ],
  };
}

describe("GraphQL root ordering", () => {
  test("uses locale-independent codepoint order for case and underscore", () => {
    expect(declaredFieldNames(sortRootFieldDefinitions(`
      zeta: String
      _internal: String
      alpha: String
      Alpha: String
    `))).toEqual(["Alpha", "_internal", "alpha", "zeta"]);
  });
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
  }, 30_000);
});
