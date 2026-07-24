// SPDX-License-Identifier: BUSL-1.1
/**
 * Entity-independent transport and authentication behavior: the public
 * health query, fail-closed bearer verification, and a real Keycloak
 * password-grant token driving the CRUD path (skipped when Keycloak is
 * not reachable).
 */
import { expect } from "bun:test";
import {
  describe,
  getKeycloakToken,
  gql,
  registerSuiteLifecycle,
  seed,
  test,
} from "./e2e/harness.js";
import {
  fieldName,
  foreignKeyTargets,
  isMutableColumn,
  sampleValue,
  tables,
} from "./e2e/entity-factory.js";

registerSuiteLifecycle();
const keycloakToken = await getKeycloakToken();

describe("transport and authentication", () => {
  test("health responds without authentication", async () => {
    const result = await gql(null, "{ health { status role } }");
    expect(result.errors ?? []).toEqual([]);
    expect(result.data?.health).toEqual({ status: "ok", role: "api" });
  });

  test("an invalid bearer token fails closed", async () => {
    const graphql = tables[0]!.source!.graphql!;
    const result = await gql(
      null,
      `{ ${graphql.listQueryName}(first: 1) { totalCount } }`,
      undefined,
      { bearer: "not-a-real-token" },
    );
    expect(result.errors?.[0]?.extensions?.code).toBe("UNAUTHENTICATED");
  });

  test.skipIf(!keycloakToken)(
    "a real Keycloak bearer token drives the full CRUD path",
    async () => {
      const table = tables[0]!;
      const graphql = table.source!.graphql!;
      const input: Record<string, unknown> = {};
      for (const column of table.columns) {
        if (
          isMutableColumn(column) &&
          column.required &&
          !foreignKeyTargets(table).has(column.name)
        ) {
          input[fieldName(column)] = sampleValue(column, `bearer-${seed}`);
        }
      }
      const bearer = keycloakToken!;
      const created = await gql(
        null,
        `mutation($input: Create${graphql.typeName}Input!) {
           ${graphql.createMutationName}(input: $input) { id }
         }`,
        { input },
        { bearer },
      );
      expect(created.errors ?? []).toEqual([]);
      const id = created.data?.[graphql.createMutationName]?.id as string;
      expect(id).toBeTruthy();

      const fetched = await gql(
        null,
        `query($id: ID!) { ${graphql.singleQueryName}(id: $id) { id } }`,
        { id },
        { bearer },
      );
      expect(fetched.data?.[graphql.singleQueryName]?.id).toBe(id);

      const deleted = await gql(
        null,
        `mutation($id: ID!) { ${graphql.deleteMutationName}(id: $id) }`,
        { id },
        { bearer },
      );
      expect(deleted.data?.[graphql.deleteMutationName]).toBe(true);
    },
  );
});
