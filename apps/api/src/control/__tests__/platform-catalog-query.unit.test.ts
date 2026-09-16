// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import {
  type PlatformTenant,
  queryPlatformTenants,
} from "../platform-catalog.js";

function tenant(slug: string, overrides: Partial<PlatformTenant> = {}): PlatformTenant {
  return {
    id: `id-${slug}`,
    slug,
    name: slug[0]!.toUpperCase() + slug.slice(1),
    status: "active",
    tenantKind: "standard",
    relationId: null,
    relationLabel: null,
    keycloakOrganizationId: `org-${slug}`,
    organizationAlias: slug,
    installedEntries: 0,
    overriddenEntries: 0,
    updatesAvailable: 0,
    ...overrides,
  };
}

const tenants = [
  tenant("zerocopter", { name: "Zerocopter", relationLabel: "Zerocopter B.V." }),
  tenant("acme", { name: "Acme", relationLabel: "ACME Holdings" }),
  tenant("blueprints", { name: "Blueprint library", tenantKind: "blueprint", organizationAlias: null }),
];

describe("platform tenant collection query", () => {
  test("filters case-insensitively on offered fields and sorts by an offered column", () => {
    expect(queryPlatformTenants(tenants, { relationLabel: "cOpTeR" }).tenants.map((item) => item.slug))
      .toEqual(["zerocopter"]);
    expect(queryPlatformTenants(tenants, { sortField: "name", sortDirection: "desc" }).tenants.map((item) => item.name))
      .toEqual(["Zerocopter", "Blueprint library", "Acme"]);
  });

  test("returns a bounded page, total count and reusable opaque cursor", () => {
    const first = queryPlatformTenants(tenants, { first: 2 });
    expect(first).toMatchObject({ totalCount: 3 });
    expect(first.tenants.map((item) => item.slug)).toEqual(["acme", "blueprints"]);
    expect(first.nextCursor).toBeTruthy();
    const second = queryPlatformTenants(tenants, { first: 2, after: first.nextCursor! });
    expect(second.tenants.map((item) => item.slug)).toEqual(["zerocopter"]);
    expect(second.nextCursor).toBeNull();
  });

  test("rejects unsupported sort keys, page sizes and cursors", () => {
    expect(() => queryPlatformTenants(tenants, { sortField: "installedEntries" })).toThrow("sortField must be one of");
    expect(() => queryPlatformTenants(tenants, { first: 101 })).toThrow("first must be an integer");
    expect(() => queryPlatformTenants(tenants, { after: "not-a-cursor" })).toThrow("nextCursor");
  });
});
