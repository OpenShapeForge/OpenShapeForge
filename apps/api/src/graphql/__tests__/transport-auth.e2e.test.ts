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
  getRolelessKeycloakToken,
  keycloakTokenFor,
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
const rolelessToken = await getRolelessKeycloakToken();
// Same role, different tenant — the pair that isolates tenancy from authorization.
const acmeToken = await keycloakTokenFor("acme-verhuurconsulent");
const betaToken = await keycloakTokenFor("beta-verhuurconsulent");

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

  // The counterpart to the test above, and the one that gives it meaning.
  //
  // A token carrying the right role being ACCEPTED does not prove the roles
  // were read: an authorizer that ignored realm_access.roles and allowed
  // everything would pass that test unchanged. Only a token that is valid,
  // signed by the same issuer, from an enabled user — and must still be
  // REFUSED — separates "roles are enforced" from "requests are waved through".
  //
  // The identity comes from Keycloak rather than a synthetic trusted-context
  // header on purpose: the code path under test is the one that maps roles out
  // of a JWT, which trusted-context headers bypass entirely.
  test.skipIf(!rolelessToken)(
    "a real Keycloak token with no realm roles is refused every operation",
    async () => {
      const table = tables[0]!;
      const graphql = table.source!.graphql!;
      const bearer = rolelessToken!;

      const read = await gql(
        null,
        `{ ${graphql.listQueryName}(first: 1) { totalCount } }`,
        undefined,
        { bearer },
      );
      expect(read.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");

      const input: Record<string, unknown> = {};
      for (const column of table.columns) {
        if (
          isMutableColumn(column) &&
          column.required &&
          !foreignKeyTargets(table).has(column.name)
        ) {
          input[fieldName(column)] = sampleValue(column, `noaccess-${seed}`);
        }
      }
      const created = await gql(
        null,
        `mutation($input: Create${graphql.typeName}Input!) {
           ${graphql.createMutationName}(input: $input) { id }
         }`,
        { input },
        { bearer },
      );
      expect(created.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
      // Nothing may be written on a refused mutation.
      expect(created.data?.[graphql.createMutationName]).toBeFalsy();
    },
  );

  // Tenant isolation, driven entirely by real Keycloak identities.
  //
  // The two users hold the SAME realm role and differ only in the tenant their
  // token carries. That is what makes a denial here mean something: if they had
  // different roles, a refusal would prove role denial and say nothing about
  // tenant separation. The assertions below therefore insist the refusal is NOT
  // a FORBIDDEN — a role rejection would be the wrong mechanism, and would mask
  // an RLS policy that had stopped filtering.
  test.skipIf(!acmeToken || !betaToken)(
    "a token from another tenant cannot see this tenant's row",
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
          input[fieldName(column)] = sampleValue(column, `tenant-${seed}`);
        }
      }
      const created = await gql(
        null,
        `mutation($input: Create${graphql.typeName}Input!) {
           ${graphql.createMutationName}(input: $input) { id }
         }`,
        { input },
        { bearer: acmeToken! },
      );
      expect(created.errors ?? []).toEqual([]);
      const id = created.data?.[graphql.createMutationName]?.id as string;
      expect(id).toBeTruthy();

      try {
        // The other tenant may ask — its role permits reads — and must get
        // nothing back.
        const crossRead = await gql(
          null,
          `query($id: ID!) { ${graphql.singleQueryName}(id: $id) { id } }`,
          { id },
          { bearer: betaToken! },
        );
        expect(crossRead.errors?.[0]?.extensions?.code).not.toBe("FORBIDDEN");
        expect(crossRead.data?.[graphql.singleQueryName]).toBeNull();

        // And the row must not surface through a list either, which would be a
        // leak that a by-id lookup alone would miss.
        const crossList = await gql(
          null,
          `{ ${graphql.listQueryName}(first: 100) { nodes { id } } }`,
          undefined,
          { bearer: betaToken! },
        );
        const ids = (crossList.data?.[graphql.listQueryName]?.nodes ?? []).map(
          (n: { id: string }) => n.id,
        );
        expect(ids).not.toContain(id);

        // Sanity: the owning tenant still sees it, so the assertions above are
        // about isolation rather than the row having failed to persist.
        const ownRead = await gql(
          null,
          `query($id: ID!) { ${graphql.singleQueryName}(id: $id) { id } }`,
          { id },
          { bearer: acmeToken! },
        );
        expect(ownRead.data?.[graphql.singleQueryName]?.id).toBe(id);
      } finally {
        await gql(
          null,
          `mutation($id: ID!) { ${graphql.deleteMutationName}(id: $id) }`,
          { id },
          { bearer: acmeToken! },
        ).catch(() => {});
      }
    },
  );
});
