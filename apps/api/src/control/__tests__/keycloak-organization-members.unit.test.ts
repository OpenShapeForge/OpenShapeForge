// SPDX-License-Identifier: BUSL-1.1
/**
 * The organization-members client, driven with a stub fetch. What is worth
 * pinning here, verified against the running Keycloak 26.5.3:
 *   1. the call shape — form-urlencoded body, not JSON, to
 *      `/organizations/{id}/members/invite-user`;
 *   2. success is `204` with an empty body, not a JSON payload to parse;
 *   3. the realm's own "Failed to send invite email" (no SMTP configured) is
 *      classified as a deployment fault (UNAVAILABLE), not a caller mistake —
 *      the caller's input was fine, the realm just cannot mail it;
 *   4. a service-account rejection is never presented as the operator's 403;
 *   5. a listed invitation is carried through WITHOUT `inviteLink` — that field
 *      is a redeemable action token, and this file is where its absence is
 *      pinned so a later "just pass the row through" cannot leak it;
 *   6. cancelling answers a boolean, not void: `204` is "I un-sent it" and
 *      Keycloak's `404 Invitation not found` is "there was nothing left to
 *      un-send", which is a converged outcome and not a failure.
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

/**
 * The row shape Keycloak 26.5.3 actually answers with, copied from a real
 * `GET /organizations/{id}/invitations` against the local realm — `sentDate`
 * and `expiresAt` in epoch SECONDS, and an `inviteLink` carrying a signed
 * ORGIVT action token whose `jti` is the invitation id.
 */
const invitationRow = {
  id: "77e9e1af-12ed-44a9-b8fa-485bf12f485e",
  organizationId: "29cdea1c-f9c7-46be-89f7-700e3465087d",
  email: "nieuwkomer@example.com",
  firstName: "Nieuw",
  lastName: "Komer",
  sentDate: 1788647960,
  expiresAt: 1788691160,
  status: "PENDING",
  inviteLink:
    "https://auth.hubble.localhost/realms/openshapeforge/protocol/openid-connect/" +
    "registrations?response_type=code&client_id=account&token=eyJhbGciOiJIUzI1NiJ9.ORGIVT-SECRET",
};

describe("listing pending invitations", () => {
  it("gets the organization's invitations resource with the service-account token", async () => {
    const { fetch, calls } = stubFetch(() => Response.json([]));
    const invitations = await createKeycloakOrganizationMembersClient(config, {
      fetch,
    }).listInvitations("acme");

    const call = calls[1]!;
    expect(call.url).toBe(
      "http://keycloak.test:8080/admin/realms/openshapeforge/organizations/acme/invitations",
    );
    expect(call.init.method).toBe("GET");
    expect((call.init.headers as Record<string, string>).authorization).toBe(
      "Bearer service-account-token",
    );
    // No pending invitation is an empty list, not an error.
    expect(invitations).toEqual([]);
  });

  it("maps Keycloak's row onto the invitation, dates in epoch seconds as reported", async () => {
    const { fetch } = stubFetch(() => Response.json([invitationRow]));
    const invitations = await createKeycloakOrganizationMembersClient(config, {
      fetch,
    }).listInvitations("acme");

    expect(invitations).toEqual([
      {
        id: "77e9e1af-12ed-44a9-b8fa-485bf12f485e",
        email: "nieuwkomer@example.com",
        firstName: "Nieuw",
        lastName: "Komer",
        status: "PENDING",
        sentDate: 1788647960,
        expiresAt: 1788691160,
      },
    ]);
  });

  it("drops inviteLink, so the redeemable action token cannot leave this module", async () => {
    const { fetch } = stubFetch(() => Response.json([invitationRow]));
    const [invitation] = await createKeycloakOrganizationMembersClient(config, {
      fetch,
    }).listInvitations("acme");

    expect(invitation).not.toHaveProperty("inviteLink");
    // Not just the field: nothing anywhere in the mapped row may carry the
    // token, because a log line or a tool response serialises the whole object.
    expect(JSON.stringify(invitation)).not.toContain("ORGIVT-SECRET");
  });

  it("reports fields Keycloak omitted as null rather than as empty values", async () => {
    const { fetch } = stubFetch(() =>
      Response.json([{ id: "inv-1", email: "solo@example.com" }]),
    );
    const [invitation] = await createKeycloakOrganizationMembersClient(config, {
      fetch,
    }).listInvitations("acme");

    expect(invitation).toEqual({
      id: "inv-1",
      email: "solo@example.com",
      firstName: null,
      lastName: null,
      status: null,
      sentDate: null,
      expiresAt: null,
    });
  });

  it("drops a row without an id, which nothing could cancel or refer to", async () => {
    const { fetch } = stubFetch(() =>
      Response.json([{ email: "ghost@example.com" }, invitationRow]),
    );
    const invitations = await createKeycloakOrganizationMembersClient(config, {
      fetch,
    }).listInvitations("acme");
    expect(invitations.map((invitation) => invitation.id)).toEqual([
      "77e9e1af-12ed-44a9-b8fa-485bf12f485e",
    ]);
  });

  it("names the organization as not found on 404", async () => {
    const { fetch } = stubFetch(() => new Response(null, { status: 404 }));
    await expect(
      createKeycloakOrganizationMembersClient(config, { fetch }).listInvitations("missing"),
    ).rejects.toMatchObject({ code: "KEYCLOAK_ADMIN_ORGANIZATION_NOT_FOUND" });
  });

  it("treats 401 on the listing as the service account's own fault and invalidates the token", async () => {
    let calls = 0;
    const fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("/protocol/openid-connect/token")) {
        calls += 1;
        return Response.json({ access_token: `token-${calls}`, expires_in: 900 });
      }
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }) as unknown as typeof globalThis.fetch;

    const client = createKeycloakOrganizationMembersClient(config, { fetch });
    await expect(client.listInvitations("acme")).rejects.toMatchObject({
      code: "KEYCLOAK_ADMIN_UNAUTHORIZED",
    });
    // The refused credential was dropped rather than presented a second time.
    await expect(client.listInvitations("acme")).rejects.toBeInstanceOf(KeycloakAdminError);
    expect(calls).toBe(2);
  });
});

describe("cancelling an invitation", () => {
  it("deletes the invitation by id and reports that it un-sent one", async () => {
    const { fetch, calls } = stubFetch(() => new Response(null, { status: 204 }));
    const cancelled = await createKeycloakOrganizationMembersClient(config, {
      fetch,
    }).deleteInvitation("acme", "77e9e1af-12ed-44a9-b8fa-485bf12f485e");

    expect(cancelled).toBe(true);
    const call = calls[1]!;
    expect(call.url).toBe(
      "http://keycloak.test:8080/admin/realms/openshapeforge/organizations/acme/" +
        "invitations/77e9e1af-12ed-44a9-b8fa-485bf12f485e",
    );
    expect(call.init.method).toBe("DELETE");
  });

  it("percent-encodes the invitation id", async () => {
    const { fetch, calls } = stubFetch(() => new Response(null, { status: 204 }));
    await createKeycloakOrganizationMembersClient(config, { fetch }).deleteInvitation(
      "acme",
      "inv/1",
    );
    expect(calls[1]!.url).toContain("/invitations/inv%2F1");
  });

  it("reports Keycloak's 404 'Invitation not found' as nothing left to cancel, not as a failure", async () => {
    const { fetch } = stubFetch(() =>
      Response.json({ errorMessage: "Invitation not found" }, { status: 404 }),
    );
    // A repeat cancel, or an id the realm never issued: the invitation is gone,
    // which is what the caller asked for — only the wording of the answer differs.
    await expect(
      createKeycloakOrganizationMembersClient(config, { fetch }).deleteInvitation(
        "acme",
        "00000000-0000-0000-0000-000000000000",
      ),
    ).resolves.toBe(false);
  });

  it("still throws when the delete fails for any other reason", async () => {
    const { fetch } = stubFetch(() =>
      Response.json({ errorMessage: "boom" }, { status: 500 }),
    );
    const client = createKeycloakOrganizationMembersClient(config, { fetch });
    await expect(
      client.deleteInvitation("acme", "77e9e1af-12ed-44a9-b8fa-485bf12f485e"),
    ).rejects.toMatchObject({ code: "KEYCLOAK_ADMIN_UNAVAILABLE" });
    try {
      await client.deleteInvitation("acme", "77e9e1af-12ed-44a9-b8fa-485bf12f485e");
      throw new Error("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(KeycloakAdminError);
      expect((error as KeycloakAdminError).message).toContain("boom");
    }
  });
});

describe("finding a pending invitation by e-mail", () => {
  it("matches case-insensitively, the way the realm treats the address", async () => {
    const { fetch } = stubFetch(() => Response.json([invitationRow]));
    const found = await createKeycloakOrganizationMembersClient(config, {
      fetch,
    }).findPendingInvitationByEmail("acme", "  NieuwKomer@Example.COM ");
    expect(found?.id).toBe("77e9e1af-12ed-44a9-b8fa-485bf12f485e");
  });

  it("answers null when no invitation is pending for that address", async () => {
    const { fetch } = stubFetch(() => Response.json([invitationRow]));
    const found = await createKeycloakOrganizationMembersClient(config, {
      fetch,
    }).findPendingInvitationByEmail("acme", "someone-else@example.com");
    expect(found).toBeNull();
  });
});
