// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import {
  hasApplicationTenantContext,
  parseAuthorizationRoles,
  resolveInitialGroups,
  resolveInitialTenantId,
} from "./claims";

describe("web authentication claims", () => {
  test("accepts tenant identities without hard-coded product personas", () => {
    expect(hasApplicationTenantContext({ tid: "tenant-a" }, undefined, undefined)).toBe(true);
    expect(hasApplicationTenantContext(undefined, { tid: "tenant-b" }, undefined)).toBe(true);
    expect(hasApplicationTenantContext(undefined, undefined, { tid: "  " })).toBe(false);
    expect(hasApplicationTenantContext(undefined, undefined, undefined)).toBe(false);
  });

  test("keeps every authored realm and client role for generated UI authorization", () => {
    expect(parseAuthorizationRoles({
      realm_access: { roles: ["realm-reader"] },
      resource_access: {
        "resource-api": { roles: ["Data.All.Read"] },
        "application-api": { roles: ["Application.Editor"] },
      },
    })).toEqual(["realm-reader", "Data.All.Read", "Application.Editor"]);
  });

  test("uses only claims for groups and tenant context", () => {
    expect(resolveInitialGroups(undefined, { groups: ["/tenant-a/editors"] }, undefined)).toEqual([
      "/tenant-a/editors",
    ]);
    expect(resolveInitialGroups(undefined, undefined, { tid: "tenant-a" })).toEqual([]);
    expect(resolveInitialTenantId({ tid: 7 }, { tid: "tenant-a" }, undefined)).toBe("tenant-a");
  });
});
