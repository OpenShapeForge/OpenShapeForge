// SPDX-License-Identifier: BUSL-1.1
import { __setRoleCompositesForTests, expandRoleComposites, personSessionRoles } from "./person-roles.js";
import { applyTrustedContextHeaders } from "@openshapeforge/auth";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __resetSessionResolverForTests,
  mergeIdentityRoles,
  resolveSessionContext,
} from "./identity.js";
import { SessionAuthenticationUnavailableError } from "./session-unavailable.js";
import { realmFromIssuer, selectOrganizationMembership } from "./tenant-resolution.js";

const MANAGED_ENV = [
  "OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI",
  "OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER",
  "OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE",
  "OPENSHAPEFORGE_API_VERIFY_BEARER_AUTHORIZED_PARTIES",
  "OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET",
] as const;

const CONTEXT_SECRET = "identity-test-context-secret";

const EMPTY = {
  tenantId: null,
  userId: null,
  roles: [] as string[],
  groups: [] as string[],
  relationGroupIds: [] as string[],
  scope: "self" as const,
  credential: "none" as const,
};

describe("resolveSessionContext bearer fail-closed", () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of MANAGED_ENV) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    __resetSessionResolverForTests();
  });

  afterEach(() => {
    for (const key of MANAGED_ENV) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    __resetSessionResolverForTests();
  });

  test("rejects a bearer credential when no verifier is configured, even when a valid trusted-context is also present", async () => {
    // A validly HMAC-signed trusted context that WOULD authenticate on its own.
    process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET = CONTEXT_SECRET;
    __resetSessionResolverForTests();

    const headers = new Headers();
    applyTrustedContextHeaders(
      headers,
      { tenantId: "tenant-a", userId: "user-a", roles: ["Platform.TenantAdmin"] },
      { secret: CONTEXT_SECRET },
    );
    // Sanity: without a bearer header this exact context authenticates.
    const trustedOnly = await resolveSessionContext(new Headers(headers));
    expect(trustedOnly.tenantId).toBe("tenant-a");
    expect(trustedOnly.userId).toBe("user-a");

    // Now the caller signals bearer auth. With no verifier configured, the
    // bearer signal must NOT downgrade to the (valid) trusted context —
    // otherwise the bearer signal would be downgrade-attackable — and must not
    // run as nobody either: a browser whose host forwards its token would
    // silently lose its session. It is the deployment that is unavailable.
    headers.set("authorization", "Bearer some.jwt.token");
    await expect(resolveSessionContext(headers)).rejects.toMatchObject({ status: 503, code: "AUTHENTICATION_UNAVAILABLE" });
  });

  test("reports an unconfigured bearer verifier as unavailable, whether or not the caller asked for that", async () => {
    const headers = new Headers({ authorization: "Bearer some.jwt.token" });
    await expect(resolveSessionContext(headers)).rejects.toBeInstanceOf(SessionAuthenticationUnavailableError);
    await expect(resolveSessionContext(headers, { failOnUnavailable: true }))
      .rejects.toBeInstanceOf(SessionAuthenticationUnavailableError);
  });

  test("can distinguish an unavailable remote verifier from an invalid credential", async () => {
    const jwks = Bun.serve({
      port: 0,
      fetch: () => new Response(null, { status: 503 }),
    });
    process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI = new URL("/jwks", jwks.url).href;
    process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER = "https://issuer.example.test";
    process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE = "api";
    __resetSessionResolverForTests();
    const token = [
      Buffer.from(JSON.stringify({ alg: "RS256", kid: "missing" })).toString("base64url"),
      Buffer.from(JSON.stringify({ iss: "https://issuer.example.test", aud: "api" })).toString("base64url"),
      "AA",
    ].join(".");
    const headers = new Headers({ authorization: `Bearer ${token}` });
    try {
      await expect(resolveSessionContext(headers)).resolves.toEqual(EMPTY);
      await expect(resolveSessionContext(headers, { failOnUnavailable: true }))
        .rejects.toBeInstanceOf(SessionAuthenticationUnavailableError);
    } finally {
      jwks.stop(true);
    }
  });

  test("reports a refused JWKS connection as unavailable", async () => {
    const listener = Bun.serve({ port: 0, fetch: () => new Response("unused") });
    process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI = new URL("/jwks", listener.url).href;
    process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER = "https://issuer.example.test";
    process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE = "api";
    listener.stop(true);
    __resetSessionResolverForTests();

    const token = [
      Buffer.from(JSON.stringify({ alg: "RS256", kid: "missing" })).toString("base64url"),
      Buffer.from(JSON.stringify({
        iss: "https://issuer.example.test",
        aud: "api",
      })).toString("base64url"),
      "AA",
    ].join(".");
    const headers = new Headers({ authorization: `Bearer ${token}` });

    await expect(resolveSessionContext(headers, { failOnUnavailable: true }))
      .rejects.toBeInstanceOf(SessionAuthenticationUnavailableError);
  });

  test("keeps a malformed bearer credential as an ordinary authentication failure", async () => {
    process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI = "http://127.0.0.1:9/jwks";
    process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER = "https://issuer.example.test";
    process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE = "api";
    __resetSessionResolverForTests();

    const headers = new Headers({ authorization: "Bearer not-a-jwt" });
    await expect(resolveSessionContext(headers, { failOnUnavailable: true }))
      .resolves.toEqual(EMPTY);
  });

  test("reports unusable matching remote key material as unavailable", async () => {
    const jwks = Bun.serve({
      port: 0,
      fetch: () => Response.json({
        keys: [{ kty: "RSA", kid: "broken", alg: "RS256", n: "bad", e: "AQAB" }],
      }),
    });
    process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI = new URL("/jwks", jwks.url).href;
    process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER = "https://issuer.example.test";
    process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE = "api";
    __resetSessionResolverForTests();
    const token = [
      Buffer.from(JSON.stringify({ alg: "RS256", kid: "broken" })).toString("base64url"),
      Buffer.from(JSON.stringify({
        iss: "https://issuer.example.test",
        aud: "api",
      })).toString("base64url"),
      "AA",
    ].join(".");

    try {
      await expect(resolveSessionContext(
        new Headers({ authorization: `Bearer ${token}` }),
        { failOnUnavailable: true },
      )).rejects.toBeInstanceOf(SessionAuthenticationUnavailableError);
    } finally {
      jwks.stop(true);
    }
  });

  test("non-bearer authorization schemes still fall through to trusted-context", async () => {
    // Only `Bearer` is the bearer signal. A non-bearer Authorization header
    // (e.g. Basic) must not trip the fail-closed branch.
    process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET = CONTEXT_SECRET;
    __resetSessionResolverForTests();

    const headers = new Headers();
    applyTrustedContextHeaders(
      headers,
      { tenantId: "tenant-a", userId: "user-a", roles: [] },
      { secret: CONTEXT_SECRET },
    );
    headers.set("authorization", "Basic dXNlcjpwYXNz");

    const session = await resolveSessionContext(headers);
    expect(session.tenantId).toBe("tenant-a");
    expect(session.userId).toBe("user-a");
  });

  test("trusted-context-only requests (no Authorization header) resolve normally", async () => {
    process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET = CONTEXT_SECRET;
    __resetSessionResolverForTests();

    const headers = new Headers();
    applyTrustedContextHeaders(
      headers,
      { tenantId: "tenant-b", userId: "user-b", roles: [] },
      { secret: CONTEXT_SECRET },
    );

    const session = await resolveSessionContext(headers);
    expect(session.tenantId).toBe("tenant-b");
    expect(session.userId).toBe("user-b");
  });
});

describe("mergeIdentityRoles (bearer effective roles)", () => {
  test("merges realm roles with every resource_access client's roles, deduplicated and sorted", () => {
    // Mirrors a dev-realm token: an audience client composite is expanded by
    // Keycloak into entity client roles under resource_access.
    expect(
      mergeIdentityRoles({
        roles: ["default-roles-openshapeforge"],
        clientRoles: {
          "erp-provider": ["Test.Admin", "Relations.All.ReadWrite", "Relations.All.Read"],
          account: ["manage-account", "Relations.All.Read"],
        },
      }),
    ).toEqual([
      "Relations.All.Read",
      "Relations.All.ReadWrite",
      "Test.Admin",
      "default-roles-openshapeforge",
      "manage-account",
    ]);
  });

  test("returns realm roles unchanged when the token carries no client roles", () => {
    expect(mergeIdentityRoles({ roles: ["realm-reader"] })).toEqual(["realm-reader"]);
    expect(mergeIdentityRoles({ roles: [], clientRoles: {} })).toEqual([]);
  });
});

describe("personSessionRoles (a person's effective roles in the selected organization)", () => {
  const identity = {
    roles: ["default-roles-openshapeforge", "Platform.ApiKeys.Manage"],
    clientRoles: { "erp-provider": ["Organization.All.ReadWrite", "Relations.All.ReadWrite"] },
  };
  const realm = "openshapeforge";

  test("unions realm roles with the membership row's roles and ignores client roles entirely", () => {
    expect(
      personSessionRoles(identity, { roles: ["General.All.Read"], needsRoleAssignment: false }, realm),
    ).toEqual(["General.All.Read", "Platform.ApiKeys.Manage", "default-roles-openshapeforge"]);
  });

  test("a membership row with nothing recorded yet yields the just-in-time minimum beside the realm roles", () => {
    expect(personSessionRoles(identity, { roles: [], needsRoleAssignment: true }, realm)).toEqual([
      "General.All.Read",
      "Platform.ApiKeys.Manage",
      "default-roles-openshapeforge",
    ]);
  });

  test("the shipped realm expands the personas the invitation path records", () => {
    // From the generated artifact, i.e. the base authorization.yaml: what an
    // invited administrator and employee actually hold.
    expect(expandRoleComposites(realm, ["org_admin"])).toEqual([
      "General.All.Read",
      "General.All.ReadWrite",
      "Organization.All.Read",
      "Organization.All.ReadWrite",
      "Platform.ApiKeys.Manage",
      "Platform.Jobs.Manage",
      "Relations.All.Read",
      "Relations.All.ReadWrite",
      "org_admin",
    ]);
    expect(expandRoleComposites(realm, ["org_employee"])).toEqual([
      "General.All.Read",
      "Relations.All.Read",
      "org_employee",
    ]);
    // The dev layer's administrator composite, transitively.
    expect(expandRoleComposites(realm, ["Test.Admin"])).toContain("Relations.All.ReadWrite");
    // A realm the artifact does not know expands nothing.
    expect(expandRoleComposites("other-realm", ["org_admin"])).toEqual(["org_admin"]);
    expect(expandRoleComposites(undefined, ["org_admin"])).toEqual(["org_admin"]);
  });

  test("expansion follows each member into its own namespace, never a same-named role of another client", () => {
    __setRoleCompositesForTests({
      [realm]: {
        realm: { reader: [{ client: "erp-provider", role: "Records.Read" }] },
        clients: {
          "erp-provider": {
            org_admin: [{ realm: "reader" }, { client: "other", role: "org_admin" }],
          },
          other: {
            // The persona of ANOTHER client named org_admin: reachable only
            // as a member, and its own members are other's, not erp-provider's.
            org_admin: [{ client: "other", role: "x" }],
            "Records.Read": [{ client: "other", role: "leak" }],
          },
        },
      },
    });
    try {
      expect(expandRoleComposites(realm, ["org_admin"])).toEqual(["Records.Read", "org_admin", "reader", "x"]);
      expect(expandRoleComposites(realm, ["org_admin"], "other")).toEqual(["org_admin", "x"]);
    } finally {
      __setRoleCompositesForTests(null);
    }
  });
});

describe("tenant from Keycloak Organization membership", () => {
  test("realmFromIssuer reads the realm off a Keycloak issuer URL and nothing else", () => {
    expect(realmFromIssuer("http://localhost:8181/realms/openshapeforge")).toBe("openshapeforge");
    expect(realmFromIssuer("https://id.example.com/auth/realms/acme-prod/")).toBe("acme-prod");
    expect(realmFromIssuer("https://id.example.com/realms/acme/protocol/openid-connect")).toBeUndefined();
    expect(realmFromIssuer("https://accounts.example.com")).toBeUndefined();
    expect(realmFromIssuer(undefined)).toBeUndefined();
  });

  test("selects the single membership that carries an organization id", () => {
    expect(
      selectOrganizationMembership({
        organizations: { "zerocopter-dev": { id: "org-1" } },
      }),
    ).toEqual({ alias: "zerocopter-dev", id: "org-1" });
  });

  test("fails closed without an id, and on several memberships with no organization:<alias> scope", () => {
    expect(
      selectOrganizationMembership({
        organizations: { acme: { id: null } },
      }),
    ).toBeNull();
    const two = {
      acme: { id: "org-1", groups: [], roles: [], clientRoles: {} },
      beta: { id: "org-2", groups: [], roles: [], clientRoles: {} },
    };
    expect(selectOrganizationMembership({ organizations: two })).toBeNull();
    expect(selectOrganizationMembership({ organizations: two, scopes: ["organization:*"] })).toBeNull();
    expect(selectOrganizationMembership({ organizations: {} })).toBeNull();
  });

  test("honours the organization:<alias> scope Keycloak echoes for a selected organization", () => {
    const two = {
      acme: { id: "org-1", groups: [], roles: [], clientRoles: {} },
      beta: { id: "org-2", groups: [], roles: [], clientRoles: {} },
    };
    expect(
      selectOrganizationMembership({ organizations: two, scopes: ["email", "organization:beta"] }),
    ).toEqual({ alias: "beta", id: "org-2" });
    // A scope naming an organization the token is not a member of selects nothing.
    expect(
      selectOrganizationMembership({ organizations: two, scopes: ["organization:gamma"] }),
    ).toBeNull();
  });
});
