// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { parseAuthIdentity, parseOrganizations } from "./claims.js";

describe("parseOrganizations", () => {
  test("reads the Organization Membership mapper's object shape, keyed by alias", () => {
    const organizations = parseOrganizations({
      organization: {
        "zerocopter-dev": { id: "7d0a0a1e-1c6e-4a0e-9d3c-3a3b6b2d1f10" },
        "hubble-isolation-dev": {},
      },
    });
    expect(organizations).toEqual({
      "zerocopter-dev": {
        id: "7d0a0a1e-1c6e-4a0e-9d3c-3a3b6b2d1f10",
        groups: [],
        roles: [],
        clientRoles: {},
      },
      "hubble-isolation-dev": { id: null, groups: [], roles: [], clientRoles: {} },
    });
  });

  test("keeps organization-local roles nested and never on the top-level identity", () => {
    const claims = {
      sub: "user-1",
      organization: {
        acme: {
          id: "org-1",
          groups: ["/Admins"],
          realm_access: { roles: ["tenant-admin"] },
          resource_access: { "erp-provider": { roles: ["Relations.All.ReadWrite"] } },
        },
      },
    };
    expect(parseOrganizations(claims).acme).toEqual({
      id: "org-1",
      groups: ["/Admins"],
      roles: ["tenant-admin"],
      clientRoles: { "erp-provider": ["Relations.All.ReadWrite"] },
    });
    const identity = parseAuthIdentity(claims);
    expect(identity.roles).toEqual([]);
    expect(identity.clientRoles).toEqual({});
    expect(identity.organizations?.acme?.id).toBe("org-1");
  });

  test("ignores the legacy tid-attribute array under the same claim name", () => {
    // The generated dev realm maps the `tid` user attribute to a multivalued
    // `organization` claim; that is not a membership and must not become one.
    expect(parseOrganizations({ organization: ["33333333-3333-4333-8333-333333333333"] })).toEqual({});
    expect(parseOrganizations({ organization: "acme" })).toEqual({});
    expect(parseOrganizations(undefined)).toEqual({});
  });

  test("parseAuthIdentity omits `organizations` when the token carries none", () => {
    const identity = parseAuthIdentity({ sub: "user-1", tid: "tenant-1" });
    expect(identity.tenantId).toBe("tenant-1");
    expect("organizations" in identity).toBe(false);
  });
});
