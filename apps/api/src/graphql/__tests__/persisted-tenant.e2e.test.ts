// SPDX-License-Identifier: BUSL-1.1
import { expect } from "bun:test";
import { applyTrustedContextHeaders } from "@openshapeforge/auth";
import { getOperationAST, parse } from "graphql";
import persistedManifest from "../../generated/graphql/persisted-operations.json" with { type: "json" };
import { createApiApp } from "../../roles/api.js";
import { createRow, tables, untrackRow } from "./e2e/entity-factory.js";
import {
  describe,
  registerSuiteLifecycle,
  remoteUrl,
  tenantA,
  tenantB,
  test,
  type GqlResponse,
  type Identity,
} from "./e2e/harness.js";

registerSuiteLifecycle();

const contextSecret = process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET!;

function operation(operationName: string): { hash: string; query: string } {
  const candidates = Object.entries(persistedManifest.operations)
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
  const app = createApiApp({
    cors: false,
    databaseUrl: process.env.DATABASE_URL!,
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/graphql/persisted",
      headers: Object.fromEntries(headers),
      payload,
    });
    return response.json() as GqlResponse;
  } finally {
    await app.close();
  }
}

describe("persisted operations with live tenant data", () => {
  test("preserve authenticated query, mutation, and cross-tenant isolation", async () => {
    const table = tables[0]!;
    const graphql = table.source!.graphql!;
    const id = await createRow(table, tenantA);
    const own = await requestPersisted(tenantA, `Get${graphql.typeName}`, { id });
    expect(own.errors ?? []).toEqual([]);
    expect(own.data?.[graphql.singleQueryName]?.id).toBe(id);

    const foreign = await requestPersisted(tenantB, `Get${graphql.typeName}`, { id });
    expect(foreign.errors?.[0]?.extensions?.code).not.toBe("FORBIDDEN");
    expect(foreign.data?.[graphql.singleQueryName]).toBeNull();

    const deleted = await requestPersisted(tenantA, `Delete${graphql.typeName}`, { id });
    expect(deleted.errors ?? []).toEqual([]);
    expect(deleted.data?.[graphql.deleteMutationName]).toBe(true);
    untrackRow(id);
  });
});
