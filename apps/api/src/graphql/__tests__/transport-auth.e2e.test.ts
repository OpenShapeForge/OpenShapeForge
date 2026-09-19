// SPDX-License-Identifier: BUSL-1.1
/**
 * Entity-independent transport and authentication behavior: the public
 * health query, fail-closed bearer verification, and a real Keycloak
 * password-grant token driving the CRUD path (skipped when Keycloak is
 * not reachable).
 *
 * The entities are chosen by the token's grants and by shape, never by
 * position: each bearer spec runs once per entity shape the token can drive,
 * so the JWT → roles → Operation path is proven for v1 and canonical entities
 * alike (through e2e/gql-shapes.ts, lease and confirmation included).
 */
import { beforeAll, expect } from "bun:test";
import {
  createdRows,
  describe,
  ensureKeycloakTokenPeople,
  getKeycloakToken,
  getRolelessKeycloakToken,
  keycloakTokenFor,
  gql,
  registerSuiteLifecycle,
  test,
  type GeneratedTable,
  type Identity,
} from "./e2e/harness.js";
import {
  columnInput,
  foreignKeyTargets,
  graphqlTables as tables,
  untrackRow,
} from "./e2e/entity-factory.js";
import {
  collectionOf,
  createDoc,
  expectDeleted,
  expectOperationError,
  fetchRecord,
  getDoc,
  listDoc,
  recordOf,
} from "./e2e/gql-shapes.js";
import { isCanonical, isEntityBackedCreate } from "./e2e/operations.js";
import { membershipRolesOf } from "./e2e/keycloak.js";
import { realmFromIssuer } from "../../auth/identity.js";
import { expandRoleComposites } from "../../auth/person-roles.js";

registerSuiteLifecycle();
const keycloakToken = await getKeycloakToken();
const rolelessToken = await getRolelessKeycloakToken();
// Same role, different tenant — the pair that isolates tenancy from authorization.
const tenantAToken = await keycloakTokenFor("tenant-a-user");
const tenantBToken = await keycloakTokenFor("tenant-b-user");

beforeAll(() =>
  ensureKeycloakTokenPeople([
    keycloakToken,
    rolelessToken,
    tenantAToken,
    tenantBToken,
  ]),
);

type TokenClaims = {
  iss?: string;
  tid?: string;
  sub?: string;
  realm_access?: { roles?: string[] };
  resource_access?: Record<string, { roles?: string[] }>;
};

function claimsOf(token: string): TokenClaims {
  return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as TokenClaims;
}

/**
 * The roles the API gives a session for this token: realm roles from the
 * token, organization roles from the membership row the harness seeded for
 * it (`seedKeycloakTokenPeople`), expanded through the realm's composites the
 * way auth/person-roles.ts does. Never the token's `resource_access`.
 */
function tokenRoles(token: string): Set<string> {
  const payload = claimsOf(token);
  return new Set([
    ...(payload.realm_access?.roles ?? []),
    ...expandRoleComposites(realmFromIssuer(payload.iss), membershipRolesOf(token)),
  ]);
}

/**
 * The harness identity a token stands for, so a row the bearer created is
 * cleaned up by the run like any other fixture — the token itself may hold
 * no delete grant, and cleanup is not what these specs measure.
 */
function trackBearerRow(table: GeneratedTable, id: string, token: string) {
  const claims = claimsOf(token);
  const identity: Identity = {
    tenantId: claims.tid ?? "",
    userId: claims.sub ?? "",
    roles: [...tokenRoles(token)],
  };
  createdRows.push({ table, id, identity });
}

const SHAPES = [
  { shape: "v1", matches: (table: GeneratedTable) => !isCanonical(table) },
  { shape: "canonical", matches: isCanonical },
] as const;

/**
 * One table per shape that the token's roles may drive through every
 * operation in `grants`, and whose row the bearer can build on its own (no
 * required parent rows: a bearer session cannot borrow the harness
 * identities to create dependencies). tables[0] is whatever sorts first in
 * the manifest — since the complete catalog contains entities the focused
 * test role can only read, a spec must pick its entity by the token's actual
 * grants instead of by position.
 */
function tablesWritableWith(
  token: string | null,
  grants: readonly ("read" | "create" | "delete")[],
): { shape: string; table: GeneratedTable }[] {
  if (!token) return [];
  const roles = tokenRoles(token);
  return SHAPES.flatMap(({ shape, matches }) => {
    const table = tables.find((candidate) => {
      const allow = candidate.source?.authorization?.roles;
      const parents = foreignKeyTargets(candidate);
      return (
        matches(candidate) &&
        isEntityBackedCreate(candidate) &&
        candidate.columns.every((column) => !column.required || !parents.has(column.name)) &&
        grants.every((grant) => (allow?.[grant] ?? []).some((role) => roles.has(role)))
      );
    });
    return table ? [{ shape, table }] : [];
  });
}

/**
 * A bearer-only create input: the required scalar columns, sampled. The
 * tables above have no required parents, so columnInput creates nothing on
 * the way; the identity it is handed is therefore never used.
 */
function bearerInput(table: GeneratedTable) {
  return columnInput(table, { tenantId: "", userId: "", roles: [] });
}

describe("transport and authentication", () => {
  test("health responds without authentication", async () => {
    const result = await gql(null, "{ health { status role } }");
    expect(result.errors ?? []).toEqual([]);
    expect(result.data?.health).toEqual({ status: "ok", role: "api" });
  });

  test("an invalid bearer token fails closed", async () => {
    // Any entity will do: the token is refused before the field is resolved.
    const table = tables[0]!;
    const result = await gql(
      null,
      listDoc(table, { args: "first: 1", totalCount: true }),
      undefined,
      { bearer: "not-a-real-token" },
    );
    expect(result.errors?.[0]?.extensions?.code).toBe("UNAUTHENTICATED");
  });

  const writable = tablesWritableWith(keycloakToken, ["read", "create", "delete"]);
  test.skipIf(!keycloakToken)("the full-access token can drive at least one entity", () => {
    expect(writable.length).toBeGreaterThan(0);
  });

  for (const { shape, table } of writable) {
    const graphql = table.source!.graphql!;
    test(`a real Keycloak bearer token drives the full CRUD path (${graphql.typeName}, ${shape})`, async () => {
      const bearer = keycloakToken!;
      const created = await gql(null, createDoc(table), { input: await bearerInput(table) }, { bearer });
      const id = recordOf(table, created, graphql.createMutationName)?.id as string;
      expect(id).toBeTruthy();
      trackBearerRow(table, id, bearer);

      const fetched = await fetchRecord(null, table, id, "id", { bearer });
      expect(fetched?.id).toBe(id);

      await expectDeleted(null, table, id, { bearer });
      untrackRow(id);
    });
  }

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
  for (const { shape, table } of rolelessToken ? SHAPES.flatMap(({ shape, matches }) => {
    const candidate = tables.find((entry) => matches(entry) && isEntityBackedCreate(entry));
    return candidate ? [{ shape, table: candidate }] : [];
  }) : []) {
    const graphql = table.source!.graphql!;
    test(`a real Keycloak token with no realm roles is refused every operation (${graphql.typeName}, ${shape})`, async () => {
      const bearer = rolelessToken!;

      const read = await gql(
        null,
        listDoc(table, { args: "first: 1", totalCount: true }),
        undefined,
        { bearer },
      );
      expectOperationError(table, read, graphql.listQueryName, "FORBIDDEN");

      // Nothing may be written on a refused mutation: the reader checks the
      // payload is empty at either shape.
      const created = await gql(null, createDoc(table), { input: await bearerInput(table) }, { bearer });
      expectOperationError(table, created, graphql.createMutationName, "FORBIDDEN");
    });
  }

  // Tenant isolation, driven entirely by real Keycloak identities.
  //
  // The two users hold the SAME realm role and differ only in the tenant their
  // token carries. That is what makes a denial here mean something: if they had
  // different roles, a refusal would prove role denial and say nothing about
  // tenant separation. The assertions below therefore insist the refusal is NOT
  // a FORBIDDEN — a role rejection would be the wrong mechanism, and would mask
  // an RLS policy that had stopped filtering.
  // Deleting is not this spec's subject; a token that may not delete leaves
  // the row to the run's cleanup.
  const tenantWritable = tenantBToken ? tablesWritableWith(tenantAToken, ["read", "create"]) : [];
  test.skipIf(!tenantAToken || !tenantBToken)("the tenant token can drive at least one entity", () => {
    expect(tenantWritable.length).toBeGreaterThan(0);
  });

  for (const { shape, table } of tenantWritable) {
    const graphql = table.source!.graphql!;
    test(`a token from another tenant cannot see this tenant's row (${graphql.typeName}, ${shape})`, async () => {
      const created = await gql(
        null,
        createDoc(table),
        { input: await bearerInput(table) },
        { bearer: tenantAToken! },
      );
      const id = recordOf(table, created, graphql.createMutationName)?.id as string;
      expect(id).toBeTruthy();
      trackBearerRow(table, id, tenantAToken!);

      {
        // The other tenant may ask — its role permits reads — and must get
        // nothing back.
        const crossRead = await gql(null, getDoc(table), { id }, { bearer: tenantBToken! });
        expect(crossRead.errors?.[0]?.extensions?.code).not.toBe("FORBIDDEN");
        expect(recordOf(table, crossRead, graphql.singleQueryName)).toBeNull();

        // And the row must not surface through a list either, which would be a
        // leak that a by-id lookup alone would miss. The list is a real page
        // of records, so an empty answer means "not visible", not "no field".
        const crossList = await gql(
          null,
          listDoc(table, { args: "first: 100", selection: "id" }),
          undefined,
          { bearer: tenantBToken! },
        );
        const ids = collectionOf(table, crossList, graphql.listQueryName).items.map(
          (row: { id: string }) => row.id,
        );
        expect(ids).not.toContain(id);

        // Sanity: the owning tenant still sees it, so the assertions above are
        // about isolation rather than the row having failed to persist.
        const ownRead = await fetchRecord(null, table, id, "id", { bearer: tenantAToken! });
        expect(ownRead?.id).toBe(id);
      }
    });
  }
});
