// SPDX-License-Identifier: BUSL-1.1
/**
 * Who gets a control-realm session, and what it carries.
 *
 * The union of the two doors this resolver replaces: the REST control plane's
 * pinned operator client and the platform MCP's party allow-list and resource
 * audience both admit; the token's realm roles are carried as they are, and a
 * token with no control-realm role at all is refused before any Operation is
 * looked at.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { ControlAuthorizationError, PLATFORM_OPERATOR_ROLE } from "../authorization.js";
import type { ControlPlaneConfig } from "../config.js";
import {
  bearerIssuerOf,
  controlAdmittedParties,
  controlSessionHttpError,
  isControlSession,
  resolveControlSession,
} from "../control-session.js";

const ISSUER = "http://localhost:8181/realms/openshapeforge-control";
const GATEWAY = "openshapeforge-admin-gateway";
const CODEX = "codex-platform";
const RESOURCE = "http://127.0.0.1:3001/admin/mcp";

const config: ControlPlaneConfig = {
  keycloak: {
    baseUrl: "http://localhost:8181",
    tenantRealm: "openshapeforge",
    clientId: "openshapeforge-auth-api",
    clientSecret: "s3cret",
  },
  operator: {
    issuer: ISSUER,
    jwksUri: `${ISSUER}/protocol/openid-connect/certs`,
    clientId: GATEWAY,
  },
  mcpResource: { origins: ["http://127.0.0.1:3001"], clients: ["codex"] },
  // The MCP allow-list deliberately omits the gateway: the union must still admit it.
  platformMcp: { authorizedParties: [CODEX] },
};

const verifierFor = (claims: Record<string, unknown>) =>
  (async () => ({ identity: {} as never, claims })) as never;
const rejectingVerifier = (async () => {
  throw new Error("signature verification failed");
}) as never;
const bearer = (token = "any") => new Headers({ authorization: `Bearer ${token}` });

const adminClaims = {
  sub: "0b2a3f1e-8a6b-4f30-9d2f-5f1c7a8e9b10",
  azp: CODEX,
  preferred_username: "platform-admin",
  name: "Platform admin",
  email: "platform-admin@example.com",
  exp: 1_800_000_000,
  realm_access: { roles: [PLATFORM_OPERATOR_ROLE, "default-roles-openshapeforge-control"] },
};

async function refusal(claims: Record<string, unknown> | null, options: { resource?: string } = {}) {
  return (await resolveControlSession(bearer(), config, {
    verifier: claims ? verifierFor(claims) : rejectingVerifier,
    ...options,
  }).catch((caught: unknown) => caught)) as ControlAuthorizationError;
}

const previousContext = process.env.OPENSHAPEFORGE_ORGANIZATION_CONTEXT;
afterEach(() => {
  if (previousContext === undefined) delete process.env.OPENSHAPEFORGE_ORGANIZATION_CONTEXT;
  else process.env.OPENSHAPEFORGE_ORGANIZATION_CONTEXT = previousContext;
});

describe("resolveControlSession", () => {
  it("mints a control-bearer session with no tenant, the subject as user, every realm role and the administrator", async () => {
    const session = await resolveControlSession(bearer(), config, { verifier: verifierFor(adminClaims) });
    expect(isControlSession(session)).toBe(true);
    expect(session).toMatchObject({
      tenantId: null,
      userId: adminClaims.sub,
      roles: [PLATFORM_OPERATOR_ROLE, "default-roles-openshapeforge-control"],
      groups: [],
      scope: "self",
      credential: "control-bearer",
      administrator: {
        subject: adminClaims.sub,
        issuer: ISSUER,
        username: "platform-admin",
        name: "Platform admin",
        email: "platform-admin@example.com",
        authorizedParty: CODEX,
        expiresAtMs: 1_800_000_000_000,
      },
    });
  });

  it("admits the pinned operator client AND every party on the MCP allow-list", async () => {
    expect(controlAdmittedParties(config)).toEqual([GATEWAY, CODEX]);
    for (const azp of [GATEWAY, CODEX]) {
      const session = await resolveControlSession(bearer(), config, {
        verifier: verifierFor({ ...adminClaims, azp, realm_access: { roles: [PLATFORM_OPERATOR_ROLE] } }),
      });
      expect(session.administrator?.authorizedParty).toBe(azp);
      expect(session.roles).toEqual([PLATFORM_OPERATOR_ROLE]);
    }
  });

  it("admits a self-registered client on its resource audience, and only for that resource", async () => {
    const claims = { ...adminClaims, azp: "dcr-minted-client", aud: [RESOURCE] };
    const session = await resolveControlSession(bearer(), config, {
      verifier: verifierFor(claims),
      resource: RESOURCE,
    });
    expect(session.administrator?.authorizedParty).toBe("dcr-minted-client");
    expect((await refusal(claims)).code).toBe("UNAUTHENTICATED");
    expect((await refusal(claims, { resource: "http://127.0.0.1:3001/other/mcp" })).code).toBe("UNAUTHENTICATED");
  });

  it("refuses admin-cli, the tenant PKCE client and a missing party before any role check", async () => {
    for (const azp of ["admin-cli", "codex", undefined]) {
      const { azp: _dropped, ...rest } = adminClaims;
      const error = await refusal(azp === undefined ? rest : { ...rest, azp });
      expect(error).toBeInstanceOf(ControlAuthorizationError);
      expect(error.code).toBe("UNAUTHENTICATED");
      expect(error.message).not.toContain("openshapeforge-control");
    }
  });

  it("refuses no bearer, trusted-context headers, an API key and a rejected token alike", async () => {
    for (const headers of [
      new Headers(),
      new Headers({ "x-openshapeforge-user-id": adminClaims.sub, "x-openshapeforge-roles": PLATFORM_OPERATOR_ROLE }),
      new Headers({ authorization: "ApiKey osf_live_abcdef" }),
    ]) {
      const error = (await resolveControlSession(headers, config, {
        verifier: verifierFor(adminClaims),
      }).catch((caught: unknown) => caught)) as ControlAuthorizationError;
      expect(error.code).toBe("UNAUTHENTICATED");
    }
    const rejected = await refusal(null);
    expect(rejected.code).toBe("UNAUTHENTICATED");
    expect(rejected.message).not.toContain("signature");
  });

  it("refuses a token with no subject and a member holding no control-realm role", async () => {
    const { sub: _dropped, ...withoutSub } = adminClaims;
    expect((await refusal(withoutSub)).code).toBe("UNAUTHENTICATED");
    const noRole = await refusal({ ...adminClaims, realm_access: { roles: ["default-roles-openshapeforge-control"] } });
    expect(noRole.code).toBe("FORBIDDEN");
    const clientRoleOnly = await refusal({
      ...adminClaims,
      realm_access: { roles: [] },
      resource_access: { [CODEX]: { roles: [PLATFORM_OPERATOR_ROLE] } },
    });
    expect(clientRoleOnly.code).toBe("FORBIDDEN");
  });

  it("projects Keycloak's built-in realm admin as the single control role in host-organization mode", async () => {
    process.env.OPENSHAPEFORGE_ORGANIZATION_CONTEXT = "host";
    const hostIssuer = "https://identity.example.test/realms/example";
    const hostConfig: ControlPlaneConfig = {
      keycloak: { baseUrl: "https://identity.example.test", tenantRealm: "example", clientId: "auth-api", clientSecret: "test-only" },
      operator: { issuer: hostIssuer, jwksUri: `${hostIssuer}/certs`, clientId: "admin-web" },
      mcpResource: { origins: ["https://app.example.test"], clients: ["web"] },
    };
    const session = await resolveControlSession(bearer(), hostConfig, {
      verifier: verifierFor({ sub: "host-admin", azp: "admin-web", resource_access: { "realm-management": { roles: ["realm-admin"] } } }),
    });
    expect(session.roles).toEqual([PLATFORM_OPERATOR_ROLE]);
    const legacy = (await resolveControlSession(bearer(), hostConfig, {
      verifier: verifierFor({ sub: "host-admin", azp: "admin-web", realm_access: { roles: [PLATFORM_OPERATOR_ROLE] } }),
    }).catch((caught: unknown) => caught)) as ControlAuthorizationError;
    expect(legacy.code).toBe("FORBIDDEN");
  });
});

describe("controlSessionHttpError", () => {
  it("maps the three refusal codes to their statuses and leaves anything else to propagate", () => {
    expect(controlSessionHttpError(new ControlAuthorizationError("UNAUTHENTICATED", "no")).status).toBe(401);
    expect(controlSessionHttpError(new ControlAuthorizationError("FORBIDDEN", "no")).status).toBe(403);
    expect(controlSessionHttpError(new ControlAuthorizationError("CONTROL_PLANE_NOT_CONFIGURED", "no")).status).toBe(503);
    expect(() => controlSessionHttpError(new Error("driver said something"))).toThrow("driver said something");
  });
});

describe("bearerIssuerOf", () => {
  it("reads iss from an unverified JWT and nothing from anything else", () => {
    const payload = Buffer.from(JSON.stringify({ iss: ISSUER, sub: "x" })).toString("base64url");
    expect(bearerIssuerOf(new Headers({ authorization: `Bearer aGVhZGVy.${payload}.c2ln` }))).toBe(ISSUER);
    expect(bearerIssuerOf(new Headers({ authorization: "Bearer not-a-jwt" }))).toBeNull();
    expect(bearerIssuerOf(new Headers({ authorization: "ApiKey osf_live_abc" }))).toBeNull();
    expect(bearerIssuerOf(new Headers())).toBeNull();
  });
});
