// SPDX-License-Identifier: BUSL-1.1
/**
 * Persisted operations against live tenant data: current canonical Get/Delete
 * documents drive a real row through a fixture client's persisted deployment,
 * and cross-tenant isolation holds there too.
 *
 * The fixture derives its documents from the compiled entity/Operation catalog.
 * The readers come from e2e/gql-shapes.ts.
 */
import { expect } from "bun:test";
import { applyTrustedContextHeaders } from "@openshapeforge/auth";
import { getOperationAST, parse } from "graphql";
import { persistedOperationFixture } from "./persisted-fixture.js";
import compiledManifest from "../../generated/graphql/persisted-operations.json" with { type: "json" };
import type { PersistedOperationManifest } from "../yoga.js";
import {
  createRow,
  graphqlTables as tables,
  untrackRow,
} from "./e2e/entity-factory.js";
import { deletedOf, deleteVariables, recordOf, getDoc, deleteDoc } from "./e2e/gql-shapes.js";
import {
  describe,
  registerSuiteLifecycle,
  remoteUrl,
  tenantA,
  tenantB,
  test,
  apiApp,
  registerPersistedFixture,
  type GqlResponse,
  type Identity,
} from "./e2e/harness.js";
import { acquireLease, isEntityBackedCreate, operationContractFor, challengeFieldFor } from "./e2e/operations.js";
import { isGeneratedCrudOperationEnabled } from "../generated-crud.js";

registerSuiteLifecycle();

const contextSecret = process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET!;
const fixtureTables = tables.filter(table =>
  (["create", "get", "delete"] as const).every(intent => isGeneratedCrudOperationEnabled(table, intent))
  && isEntityBackedCreate(table)
  && (["create", "get", "delete"] as const).every(intent => !operationContractFor(table, intent)?.prerequisites?.length)
  && !challengeFieldFor(table, "delete"));
// A headless host intentionally emits an empty persisted catalog. This suite
// represents its own first-party client using the current canonical documents.
// Interactive provider setup and typed destructive confirmation belong to
// their bearer-login journeys, rather than this trusted tenant-isolation case.
const persistedFixture = remoteUrl
  ? compiledManifest as PersistedOperationManifest
  : persistedOperationFixture(fixtureTables.flatMap(table => [
  getDoc(table).replace(/^query/, `query Get${table.source!.graphql!.typeName}`),
  deleteDoc(table).replace(/^mutation/, `mutation Delete${table.source!.graphql!.typeName}`),
]));
const persistedOperations = persistedFixture.operations;
if (!remoteUrl) registerPersistedFixture(persistedFixture);

const persistedNames = new Set(
  Object.values(persistedOperations).flatMap((query) => {
    const name = getOperationAST(parse(query))?.name?.value;
    return name ? [name] : [];
  }),
);

/** The first entity the manifest persists a Get and a Delete for. */
const table = fixtureTables.find(
  (candidate) =>
    isEntityBackedCreate(candidate) &&
    persistedNames.has(`Get${candidate.source!.graphql!.typeName}`) &&
    persistedNames.has(`Delete${candidate.source!.graphql!.typeName}`),
);

function operation(operationName: string): { hash: string; query: string } {
  const candidates = Object.entries(persistedOperations)
    .filter(([, query]) => getOperationAST(parse(query))?.name?.value === operationName)
    .sort((left, right) => left[1].length - right[1].length);
  const [hash, query] = candidates[0] ?? [];
  if (!hash || !query) throw new Error(`Missing persisted operation ${operationName}.`);
  return { hash, query };
}

async function requestPersisted(
  identity: Identity,
  operationName: string,
  variables: Record<string, unknown>,
): Promise<GqlResponse> {
  const headers = new Headers({ "content-type": "application/json" });
  applyTrustedContextHeaders(headers, identity, { secret: contextSecret });
  const { hash } = operation(operationName);
  const payload = {
    operationName,
    variables,
    extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
  };
  if (remoteUrl) {
    const response = await fetch(`${remoteUrl}/api/graphql/persisted`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    return response.json() as Promise<GqlResponse>;
  }
  const app = await apiApp();
  const response = await app.inject({
    method: "POST",
    url: "/api/graphql/persisted",
    headers: Object.fromEntries(headers),
    payload,
  });
  return response.json() as GqlResponse;
}

describe("persisted operations with live tenant data", () => {
  test("the manifest persists a Get and a Delete for at least one entity", () => {
    expect(table).toBeDefined();
  });

  test("preserve authenticated query, mutation, and cross-tenant isolation", async () => {
    const graphql = table!.source!.graphql!;
    const id = await createRow(table!, tenantA);
    const own = await requestPersisted(tenantA, `Get${graphql.typeName}`, { id });
    expect(recordOf(table!, own, graphql.singleQueryName)?.id).toBe(id);

    const foreign = await requestPersisted(tenantB, `Get${graphql.typeName}`, { id });
    expect(foreign.errors?.[0]?.extensions?.code).not.toBe("FORBIDDEN");
    expect(recordOf(table!, foreign, graphql.singleQueryName)).toBeNull();

    // A delete carries its lease controls in the persisted input.
    const controls = await acquireLease(tenantA, table!, id, "delete");
    const deleted = await requestPersisted(
      tenantA,
      `Delete${graphql.typeName}`,
      deleteVariables(table!, id, controls),
    );
    expect(deletedOf(table!, deleted)).toBe(true);
    untrackRow(id);
  });
});
