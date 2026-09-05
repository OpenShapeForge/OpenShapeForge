// SPDX-License-Identifier: BUSL-1.1
/**
 * The organization-members invite client, driven with a stub fetch. What is
 * worth pinning here, verified against the running Keycloak 26.5.3:
 *   1. the call shape — form-urlencoded body, not JSON, to
 *      `/organizations/{id}/members/invite-user`;
 *   2. success is `204` with an empty body, not a JSON payload to parse;
 *   3. the realm's own "Failed to send invite email" (no SMTP configured) is
 *      classified as a deployment fault (UNAVAILABLE), not a caller mistake —
 *      the caller's input was fine, the realm just cannot mail it;
 *   4. a service-account rejection is never presented as the operator's 403.
 */
import { describe, expect, it } from "bun:test";
import {
  createKeycloakOrganizationMembersClient,
} from "../keycloak-organization-members.js";
import { KeycloakAdminError } from "../keycloak-organization-admin.js";
import type { KeycloakServiceAccountConfig } from "../keycloak-service-account.js";

const config: KeycloakServiceAccountConfig = {
  baseUrl: "http://keycloak.test:8080",
  tenantRealm: "openshapeforge",
  clientId: "openshapeforge-auth-api",
  clientSecret: "s3cret",
};

type Call = { url: string; init: RequestInit };

function stubFetch(admin: () => Response): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch = (async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("/protocol/openid-connect/token")) {
      return Response.json({ access_token: "service-account-token", expires_in: 900 });
    }
    return admin();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("inviting a member", () => {
  it("posts form-urlencoded fields to the invite-user endpoint with the service-account token", async () => {
    const { fetch, calls } = stubFetch(() => new Response(null, { status: 204 }));
    await createKeycloakOrganizationMembersClient(config, { fetch }).inviteUser("acme", {
      email: "new-colleague@example.com",
      firstName: "New",
      lastName: "Colleague",
    });

    const call = calls[1]!;
    expect(call.url).toBe(
      "http://keycloak.test:8080/admin/realms/openshapeforge/organizations/acme/members/invite-user",
    );
    expect((call.init.headers as Record<string, string>).authorization).toBe(
      "Bearer service-account-token",
    );
    expect((call.init.headers as Record<string, string>)["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const body = new URLSearchParams(call.init.body as string);
    expect(body.get("email")).toBe("new-colleague@example.com");
    expect(body.get("firstName")).toBe("New");
    expect(body.get("lastName")).toBe("Colleague");
  });

  it("omits firstName/lastName from the body when not given", async () => {
    const { fetch, calls } = stubFetch(() => new Response(null, { status: 204 }));
    await createKeycloakOrganizationMembersClient(config, { fetch }).inviteUser("acme", {
      email: "solo@example.com",
    });
    const body = new URLSearchParams(calls[1]!.init.body as string);
    expect(body.get("firstName")).toBeNull();
    expect(body.get("lastName")).toBeNull();
  });

  it("percent-encodes the organization id", async () => {
    const { fetch, calls } = stubFetch(() => new Response(null, { status: 204 }));
    await createKeycloakOrganizationMembersClient(config, { fetch }).inviteUser("acme/emea", {
      email: "x@example.com",
    });
    expect(calls[1]!.url).toContain("/organizations/acme%2Femea/members/invite-user");
  });

  it("classifies the realm's own SMTP failure as a deployment fault, not a rejection", async () => {
    const { fetch } = stubFetch(
      () => Response.json({ errorMessage: "Failed to send invite email" }, { status: 500 }),
    );
    const client = createKeycloakOrganizationMembersClient(config, { fetch });
    await expect(client.inviteUser("acme", { email: "x@example.com" })).rejects.toMatchObject({
      code: "KEYCLOAK_ADMIN_UNAVAILABLE",
    });
    try {
      await client.inviteUser("acme", { email: "x@example.com" });
      throw new Error("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(KeycloakAdminError);
      expect((error as KeycloakAdminError).message).toContain("Failed to send invite email");
    }
  });

  it("treats 401/403 as the service account's own fault, not the caller's, and invalidates the token", async () => {
    let calls = 0;
    const fetch = (async (input: unknown, init: RequestInit = {}) => {
      const url = String(input);
      if (url.includes("/protocol/openid-connect/token")) {
        calls += 1;
        return Response.json({ access_token: `token-${calls}`, expires_in: 900 });
      }
      return Response.json({ error: "unauthorized" }, { status: 403 });
    }) as unknown as typeof globalThis.fetch;

    const client = createKeycloakOrganizationMembersClient(config, { fetch });
    await expect(client.inviteUser("acme", { email: "x@example.com" })).rejects.toMatchObject({
      code: "KEYCLOAK_ADMIN_UNAUTHORIZED",
    });
    // The cached token was dropped: a second call mints a fresh one rather than
    // presenting the credential Keycloak already refused.
    await expect(client.inviteUser("acme", { email: "x@example.com" })).rejects.toBeInstanceOf(
      KeycloakAdminError,
    );
    expect(calls).toBe(2);
  });

  it("names the organization as not found on 404", async () => {
    const { fetch } = stubFetch(() => new Response(null, { status: 404 }));
    await expect(
      createKeycloakOrganizationMembersClient(config, { fetch }).inviteUser("missing", {
        email: "x@example.com",
      }),
    ).rejects.toMatchObject({ code: "KEYCLOAK_ADMIN_ORGANIZATION_NOT_FOUND" });
  });

  it("rejects a malformed request (400) as caller-actionable", async () => {
    const { fetch } = stubFetch(() => Response.json({ error: "invalid" }, { status: 400 }));
    await expect(
      createKeycloakOrganizationMembersClient(config, { fetch }).inviteUser("acme", {
        email: "not-an-email",
      }),
    ).rejects.toMatchObject({ code: "KEYCLOAK_ADMIN_REJECTED" });
  });
});
