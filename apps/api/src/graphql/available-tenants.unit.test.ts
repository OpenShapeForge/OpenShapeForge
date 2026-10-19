// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { readAvailableTenants } from "./available-tenants.js";
import type { GraphqlContext } from "./context.js";
const session = { tenantId: crypto.randomUUID(), userId: crypto.randomUUID(), issuer: "https://identity.example/realms/test", credential: "bearer", principalKind: "person", roles: [], groups: [], scope: "self" };
const context = { session, db: {} } as unknown as GraphqlContext;
test("only a verified human bearer may discover their own organisations", async () => {
  for (const mutation of [{ credential: "none" }, { credential: "api-key" }, { credential: "trusted-context" }, { credential: "control-bearer" }, { principalKind: "service" }, { principalKind: undefined }, { userId: null }, { issuer: undefined }]) {
    await expect(readAvailableTenants({ ...context, session: { ...session, ...mutation } } as GraphqlContext,
      () => { throw Error("Provider must not run"); })).rejects.toMatchObject({ extensions: { code: "UNAUTHENTICATED" } });
  }
});
test("uses exactly the verified subject and configured realm, with no partial or cached membership answer", async () => {
  const subjects: string[] = [];
  const provider = () => ({ realm: "test", issuer: session.issuer, list: async (subject: string) => { subjects.push(subject); return []; } });
  expect(await readAvailableTenants(context, provider)).toEqual([]);
  expect(await readAvailableTenants(context, provider)).toEqual([]);
  expect(subjects).toEqual([session.userId!, session.userId!]);
  await expect(readAvailableTenants(context, () => ({ realm: "other", issuer: session.issuer, list: async () => [] }))).rejects.toMatchObject({ extensions: { code: "ORGANIZATION_DISCOVERY_UNAVAILABLE" } });
  await expect(readAvailableTenants(context, () => ({ realm: "test", issuer: session.issuer, list: async () => { throw Error("provider offline"); } }))).rejects.toMatchObject({ extensions: { code: "ORGANIZATION_DISCOVERY_UNAVAILABLE" } });
  await expect(readAvailableTenants(context, () => ({ realm: "test", issuer: session.issuer, list: async () => Array.from({ length: 101 }, () => ({ id: "a", enabled: true })) }))).rejects.toThrow("Organizations could not be loaded");
});

test("rejects a different configured issuer even when the realm name and subject match", async () => {
  let reads = 0;
  for (const issuer of ["https://other.example/realms/test", "https://identity.example/other/realms/test"]) {
    await expect(readAvailableTenants(context, () => ({ realm: "test", issuer, list: async () => { reads++; return []; } })))
      .rejects.toMatchObject({ extensions: { code: "ORGANIZATION_DISCOVERY_UNAVAILABLE" } });
  }
  expect(reads).toBe(0);
});
