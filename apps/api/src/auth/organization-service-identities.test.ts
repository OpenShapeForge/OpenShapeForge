// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import { configuredOrganizationServiceAccount, organizationServiceIdentities, serviceIdentityEndpoint } from "./organization-service-identities.js";

const entry = { tenantId: "11111111-1111-4111-8111-111111111111", clientId: "org-worker", clientSecret: "private-test-secret" };
const env = (items: unknown) => ({ OPENSHAPEFORGE_ORGANIZATION_SERVICE_IDENTITIES: JSON.stringify(items) });

describe("host-owned organization service identities", () => {
  test("accepts only one explicit account per tenant; absence gives no authority", () => {
    expect(organizationServiceIdentities({})).toEqual([]);
    expect(organizationServiceIdentities(env([entry]))).toEqual([entry]);
    expect(organizationServiceIdentities(env([{
      ...entry,
      tenantId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
    }]))[0]?.tenantId).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(() => organizationServiceIdentities(env([entry, entry]))).toThrow("unambiguous");
    expect(() => organizationServiceIdentities(env([
      { ...entry, tenantId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" },
      { ...entry, tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", clientId: "other" },
    ]))).toThrow("unambiguous");
    expect(() => organizationServiceIdentities(env([{ ...entry, roles: ["admin"] }]))).toThrow("Invalid");
    expect(() => organizationServiceIdentities(env([{ ...entry, tenantId: null }]))).toThrow("Invalid");
    expect(() => organizationServiceIdentities({ OPENSHAPEFORGE_ORGANIZATION_SERVICE_IDENTITIES: "secret-invalid-json" })).toThrow("Invalid");
  });
  test("a username prefix or another client/tenant is not an automatic identity", () => {
    const claims = { sub: "service-subject", azp: entry.clientId, preferred_username: `service-account-${entry.clientId}` };
    expect(configuredOrganizationServiceAccount(claims, entry.tenantId, [entry])).toEqual(entry);
    expect(configuredOrganizationServiceAccount(
      claims,
      entry.tenantId.toUpperCase(),
      [entry],
    )).toEqual(entry);
    expect(configuredOrganizationServiceAccount({ ...claims, azp: "web" }, entry.tenantId, [entry])).toBeUndefined();
    expect(configuredOrganizationServiceAccount({ ...claims, preferred_username: "human" }, entry.tenantId, [entry])).toBeUndefined();
    expect(configuredOrganizationServiceAccount(claims, "22222222-2222-4222-8222-222222222222", [entry])).toBeUndefined();
    expect(configuredOrganizationServiceAccount(claims, entry.tenantId, [])).toBeUndefined();
  });
  test("refuses insecure remote credential endpoints and embedded credentials", () => {
    expect(serviceIdentityEndpoint("http://127.0.0.1:3121", "API").port).toBe("3121");
    expect(serviceIdentityEndpoint("https://api.example.test", "API").protocol).toBe("https:");
    for (const endpoint of ["http://api.example.test", "https://u:p@api.example.test", "https://api.example.test?secret=x", "ftp://127.0.0.1"]) {
      expect(() => serviceIdentityEndpoint(endpoint, "API")).toThrow("HTTPS");
    }
  });
});
