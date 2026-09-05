// SPDX-License-Identifier: BUSL-1.1
/**
 * `createMemberRoleAdminClient`, driven with a stub fetch — the piece
 * `set_member_role` (mcp/identity-link-tools.ts) uses to grant a real
 * Keycloak client role onto a signed-in person.
 */
import { describe, expect, it } from "bun:test";
import { KeycloakAdminError } from "../keycloak-organization-admin.js";
import { createMemberRoleAdminClient } from "../member-role-admin.js";
import type { KeycloakServiceAccountConfig } from "../keycloak-service-account.js";

const config: KeycloakServiceAccountConfig = {
  baseUrl: "http://keycloak.test:8080",
  tenantRealm: "openshapeforge",
  clientId: "openshapeforge-auth-api",
  clientSecret: "s3cret",
};

type Call = { url: string; init: RequestInit };

function stubFetch(admin: Array<() => Response>): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;
  const fetch = (async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("/protocol/openid-connect/token")) {
      return Response.json({ access_token: "service-account-token", expires_in: 900 });
    }
    const next = admin[Math.min(index++, admin.length - 1)];
    return next ? next() : Response.json([]);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("granting a client role onto a person's user", () => {
  it("resolves the client, checks the role exists, then POSTs the role-mapping", async () => {
    const { fetch, calls } = stubFetch([
      () => Response.json([{ id: "client-uuid", clientId: "hubble-api" }]),
      () =>
        Response.json([
          { id: "role-1", name: "Organization.All.ReadWrite" },
          { id: "role-2", name: "General.All.Read" },
        ]),
      () => new Response(null, { status: 204 }),
    ]);

    await createMemberRoleAdminClient(config, { fetch }).grantClientRoles(
      "user-sub-123",
      "hubble-api",
      ["Organization.All.ReadWrite"],
    );

    expect(calls[1]!.url).toBe(
      "http://keycloak.test:8080/admin/realms/openshapeforge/clients?clientId=hubble-api",
    );
    expect(calls[2]!.url).toBe(
      "http://keycloak.test:8080/admin/realms/openshapeforge/clients/client-uuid/roles",
    );
    const roleMappingCall = calls[3]!;
    expect(roleMappingCall.url).toBe(
      "http://keycloak.test:8080/admin/realms/openshapeforge/users/user-sub-123/role-mappings/clients/client-uuid",
    );
    expect(roleMappingCall.init.method).toBe("POST");
    expect(JSON.parse(roleMappingCall.init.body as string)).toEqual([
      { id: "role-1", name: "Organization.All.ReadWrite" },
    ]);
  });

  it("does nothing when handed no role names", async () => {
    const { fetch, calls } = stubFetch([]);
    await createMemberRoleAdminClient(config, { fetch }).grantClientRoles(
      "user-sub-123",
      "hubble-api",
      [],
    );
    expect(calls.length).toBe(0);
  });

  it("refuses a role name that does not exist on the client, rather than silently granting fewer", async () => {
    const { fetch } = stubFetch([
      () => Response.json([{ id: "client-uuid", clientId: "hubble-api" }]),
      () => Response.json([{ id: "role-1", name: "General.All.Read" }]),
    ]);

    const error = (await createMemberRoleAdminClient(config, { fetch })
      .grantClientRoles("user-sub-123", "hubble-api", ["Organization.All.ReadWrite"])
      .catch((caught: unknown) => caught)) as KeycloakAdminError;

    expect(error).toBeInstanceOf(KeycloakAdminError);
    expect(error.code).toBe("KEYCLOAK_ADMIN_REJECTED");
    expect(error.message).toContain("Organization.All.ReadWrite");
  });

  it("reports 403 as a manage-users-specific unauthorized error", async () => {
    const { fetch } = stubFetch([
      () => Response.json({ error: "access_denied" }, { status: 403 }),
    ]);

    const error = (await createMemberRoleAdminClient(config, { fetch })
      .grantClientRoles("user-sub-123", "hubble-api", ["General.All.Read"])
      .catch((caught: unknown) => caught)) as KeycloakAdminError;

    expect(error.code).toBe("KEYCLOAK_ADMIN_UNAUTHORIZED");
    expect(error.message).toContain("manage-users");
  });

  it("errors when the target client does not exist in the realm", async () => {
    const { fetch } = stubFetch([() => Response.json([])]);

    const error = (await createMemberRoleAdminClient(config, { fetch })
      .grantClientRoles("user-sub-123", "no-such-client", ["General.All.Read"])
      .catch((caught: unknown) => caught)) as KeycloakAdminError;

    expect(error.code).toBe("KEYCLOAK_ADMIN_REJECTED");
    expect(error.message).toContain("no-such-client");
  });
});
