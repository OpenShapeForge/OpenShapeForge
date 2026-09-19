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
import type { ServiceAccountTokenProvider } from "../keycloak-service-account.js";

const config: KeycloakServiceAccountConfig = {
  baseUrl: "http://keycloak.test:8080",
  tenantRealm: "openshapeforge",
  clientId: "openshapeforge-auth-api",
  clientSecret: "s3cret",
};

describe('first-administrator preflight reads', () => {
  it('requires host and sender but exposes no SMTP credentials', async () => {
    for (const smtpServer of [{}, { host: 'smtp.example' }, { host: 'smtp.example', from: 'invite@example.com', password: 'private' }]) {
      const { fetch } = stubFetch(() => Response.json({ smtpServer }));
      expect(await createKeycloakOrganizationMembersClient(config, { fetch }).hasInvitationMailConfiguration())
        .toBe('from' in smtpServer);
    }
  });
  it('reads only the exact organization members and their effective audience-client roles, including pagination', async () => {
    const calls: string[] = [];
    const fetch = (async (input: unknown) => {
      const url = String(input); calls.push(url);
      if (url.includes('/token')) return Response.json({ access_token: 'test', expires_in: 60 });
      if (url.includes('/clients?')) return Response.json([{ id: 'role-client', clientId: 'api' }]);
      if (url.includes('/members?first=0')) return Response.json(Array.from({ length: 100 }, (_, i) => ({ id: `user-${i}`, email: `user${i}@example.com` })));
      if (url.includes('/members?first=100')) return Response.json([]);
      if (url.includes('/users/user-99/')) return Response.json([{ name: 'Organization.All.ReadWrite' }]);
      return Response.json([]);
    }) as typeof globalThis.fetch;
    expect(await createKeycloakOrganizationMembersClient(config, { fetch }).organizationAdministrators('org/acme', 'api', 'Organization.All.ReadWrite'))
      .toEqual([{ email: 'user99@example.com' }]);
    expect(calls.some(url => url.includes('/organizations/org%2Facme/members?first=100'))).toBe(true);
    expect(calls.filter(url => url.includes('/role-mappings/')).every(url => url.endsWith('/clients/role-client/composite'))).toBe(true);
  });
  it('fails closed when the role client cannot be resolved', async () => {
    const { fetch } = stubFetch(() => Response.json([]));
    await expect(createKeycloakOrganizationMembersClient(config, { fetch }).organizationAdministrators('acme', 'api', 'Organization.All.ReadWrite'))
      .rejects.toMatchObject({ code: 'KEYCLOAK_ADMIN_REJECTED' });
  });
});

type Call = { url: string; init: RequestInit };

function stubFetch(admin: (url: string) => Response): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch = (async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("/protocol/openid-connect/token")) {
      return Response.json({ access_token: "service-account-token", expires_in: 900 });
    }
    return admin(url);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("inviting a member", () => {
  it("identifies the timed-out admin subcall without carrying request data", async () => {
    const readings = [0, 10, 10_010];
    const tokens: ServiceAccountTokenProvider = {
      get: async () => "service-account-token",
      invalidate: () => undefined,
    };
    const fetch = (async () => {
      throw new DOMException("The operation was aborted", "TimeoutError");
    }) as unknown as typeof globalThis.fetch;

    let error: KeycloakAdminError;
    try {
      await createKeycloakOrganizationMembersClient(config, {
        fetch,
        tokens,
        now: () => readings.shift() ?? 10_010,
      }).inviteUser("private-organization-id", { email: "private@example.com" });
      throw new Error("expected a rejection");
    } catch (caught) {
      error = caught as KeycloakAdminError;
    }

    expect(error).toMatchObject({
      code: "KEYCLOAK_ADMIN_UNAVAILABLE",
      operation: "invite_member",
      durationMs: 10_000,
      status: undefined,
    });
    expect(JSON.stringify({ operation: error.operation, durationMs: error.durationMs, code: error.code }))
      .not.toContain("private");
  });

  it("distinguishes a service-account token failure from the admin request", async () => {
    const readings = [100, 10_100];
    const tokens: ServiceAccountTokenProvider = {
      get: async () => {
        throw new KeycloakAdminError("KEYCLOAK_ADMIN_UNAVAILABLE", "secret token endpoint detail");
      },
      invalidate: () => undefined,
    };

    let error: KeycloakAdminError;
    try {
      await createKeycloakOrganizationMembersClient(config, {
        tokens,
        now: () => readings.shift() ?? 10_100,
      }).inviteUser("private-organization-id", { email: "private@example.com" });
      throw new Error("expected a rejection");
    } catch (caught) {
      error = caught as KeycloakAdminError;
    }

    expect(error).toMatchObject({
      operation: "service_account_token",
      durationMs: 10_000,
      status: undefined,
    });
  });

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
      "http://keycloak.test:8080/admin/realms/openshapeforge/organizations/acme/invitations?first=0&max=100",
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

  it("refuses a malformed row instead of returning an incomplete administrative list", async () => {
    const { fetch } = stubFetch(() =>
      Response.json([{ email: "ghost@example.com" }, invitationRow]),
    );
    await expect(
      createKeycloakOrganizationMembersClient(config, { fetch }).listInvitations("acme"),
    ).rejects.toMatchObject({ code: "KEYCLOAK_ADMIN_UNAVAILABLE" });
  });

  it("reads subsequent invitation pages and omits secret links on every page", async () => {
    const { fetch, calls } = stubFetch((url) =>
      Response.json(
        url.includes("first=100")
          ? [{ ...invitationRow, id: "last" }]
          : Array.from({ length: 100 }, (_, index) => ({ ...invitationRow, id: `invite-${index}` })),
      ),
    );
    const rows = await createKeycloakOrganizationMembersClient(config, { fetch }).listInvitations("acme");
    expect(rows).toHaveLength(101);
    expect(calls).toHaveLength(3);
    expect(JSON.stringify(rows)).not.toContain("ORGIVT-SECRET");
  });

  it("uses the native resend endpoint without changing recipient or role", async () => {
    const { fetch, calls } = stubFetch(() => new Response(null, { status: 204 }));
    await createKeycloakOrganizationMembersClient(config, { fetch }).resendInvitation!(
      "acme",
      "invite-1",
    );
    expect(calls[1]!.url).toEndWith("/organizations/acme/invitations/invite-1/resend");
    expect(calls[1]!.init.method).toBe("POST");
    expect(calls[1]!.init.body).toBeUndefined();
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

describe("tenant member and credential administration", () => {
  it("finds an existing organization member by e-mail without reading roles", async () => {
    const { fetch, calls } = stubFetch((url) => {
      if (url.includes("first=0")) {
        return Response.json(Array.from({ length: 100 }, (_, index) => ({
          id: `member-${index}`,
          email: index === 99 ? "Hans@Example.com" : `person-${index}@example.com`,
        })));
      }
      return Response.json([]);
    });
    const client = createKeycloakOrganizationMembersClient(config, { fetch });

    await expect(client.hasMemberByEmail("acme", " hans@example.COM ")).resolves.toBe(true);
    await expect(client.hasMemberByEmail("acme", "absent@example.com")).resolves.toBe(false);
    expect(calls.some(({ url }) => url.includes("/organizations/acme/members?first=100&max=100")))
      .toBe(true);
    expect(calls.some(({ url }) => url.includes("role-mappings"))).toBe(false);
  });

  it("lists only members of the named organization, and never reads their Keycloak user roles", async () => {
    const { fetch, calls } = stubFetch((url) => {
      if (url.includes("/organizations/acme/members?")) return Response.json([{
        id: "member-1", username: "hans", email: "hans@example.com", firstName: "Hans", lastName: "Eilers",
        enabled: true, emailVerified: true,
      }]);
      return Response.json([]);
    });
    const members = await createKeycloakOrganizationMembersClient(config, { fetch }).listMembers("acme");
    expect(members).toEqual([{
      memberId: "member-1", username: "hans", email: "hans@example.com", firstName: "Hans", lastName: "Eilers",
      enabled: true, emailVerified: true,
    }]);
    expect(calls.some(({ url }) => url.includes("/organizations/acme/members?first=0&max=100"))).toBe(true);
    // A member's roles are the tenant's record, not a Keycloak user mapping.
    expect(calls.some(({ url }) => url.includes("role-mappings"))).toBe(false);
  });

  it("returns safe credential metadata and never provider secrets", async () => {
    const { fetch } = stubFetch((url) => url.endsWith("/users/member-1/credentials")
      ? Response.json([{ id: "credential-1", type: "webauthn-passwordless", userLabel: "MacBook", createdDate: 123, secretData: "private" }])
      : Response.json([]));
    const credentials = await createKeycloakOrganizationMembersClient(config, { fetch }).listCredentials("member-1");
    expect(credentials).toEqual([{ credentialId: "credential-1", type: "webauthn-passwordless", label: "MacBook", createdAt: 123 }]);
    expect(JSON.stringify(credentials)).not.toContain("private");
  });

  it("sends only the fixed passwordless registration action with a short lifetime", async () => {
    const { fetch, calls } = stubFetch(() => new Response(null, { status: 204 }));
    await createKeycloakOrganizationMembersClient(config, { fetch }).sendPasskeyRecovery("member/1");
    expect(calls[1]!.url).toEndWith("/users/member%2F1/execute-actions-email?lifespan=900");
    expect(calls[1]!.init.method).toBe("PUT");
    expect(calls[1]!.init.body).toBe('["webauthn-register-passwordless"]');
  });

  it("removes only the organization membership and treats an absent credential as converged", async () => {
    const { fetch, calls } = stubFetch(() => new Response(null, { status: 404 }));
    const client = createKeycloakOrganizationMembersClient(config, { fetch });
    await expect(client.removeMember("acme", "member-1")).resolves.toBe(false);
    await expect(client.deleteCredential("member-1", "credential-1")).resolves.toBe(false);
    expect(calls[1]!.url).toEndWith("/organizations/acme/members/member-1");
    expect(calls[2]!.url).toEndWith("/users/member-1/credentials/credential-1");
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
