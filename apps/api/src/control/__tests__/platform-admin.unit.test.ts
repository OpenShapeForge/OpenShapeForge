// SPDX-License-Identifier: BUSL-1.1
/**
 * Who gets through the platform administrator MCP's door.
 *
 * The same shape as authorization.unit.test.ts, for the same elevation, with
 * the two things this surface does differently pinned: the authorized party
 * is an allow-list (admin gateway AND the platform's public PKCE client), and
 * the marker role is `platform_admin`, looked for in `realm_access` only.
 */
import { describe, expect, it } from "bun:test";
import { SYSTEM_BYPASS_ROLE } from "../../db/session.js";
import { ControlAuthorizationError, PLATFORM_OPERATOR_ROLE } from "../authorization.js";
import { platformMcpAuthorizedParties, readControlPlaneConfig, type ControlPlaneConfig } from "../config.js";
import {
  PLATFORM_ADMIN_ROLE,
  resolvePlatformAdministrator,
  systemSessionForAdministrator,
} from "../platform-admin.js";

const ISSUER = "http://localhost:8181/realms/openshapeforge-control";
const GATEWAY = "openshapeforge-admin-gateway";
const CODEX = "codex-platform";

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
  platformMcp: { authorizedParties: [GATEWAY, CODEX] },
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
  preferred_username: "hubble-platform-admin",
  name: "Hubble Platform admin",
  email: "hubble-platform-admin@example.com",
  exp: 1_800_000_000,
  realm_access: { roles: [PLATFORM_ADMIN_ROLE, "default-roles-openshapeforge-control"] },
};

async function refusal(claims: Record<string, unknown> | null, cfg = config) {
  return (await resolvePlatformAdministrator(bearer(), cfg, {
    verifier: claims ? verifierFor(claims) : rejectingVerifier,
  }).catch((caught: unknown) => caught)) as ControlAuthorizationError;
}

describe("resolvePlatformAdministrator", () => {
  it("admits a control-realm token from the PKCE client holding platform_admin", async () => {
    const admin = await resolvePlatformAdministrator(bearer(), config, {
      verifier: verifierFor(adminClaims),
    });
    expect(admin).toEqual({
      subject: adminClaims.sub,
      issuer: ISSUER,
      username: "hubble-platform-admin",
      name: "Hubble Platform admin",
      email: "hubble-platform-admin@example.com",
      authorizedParty: CODEX,
      expiresAtMs: 1_800_000_000_000,
    });
  });

  it("admits the admin gateway too — the allow-list has two parties", async () => {
    const admin = await resolvePlatformAdministrator(bearer(), config, {
      verifier: verifierFor({ ...adminClaims, azp: GATEWAY }),
    });
    expect(admin.authorizedParty).toBe(GATEWAY);
  });

  it("refuses no bearer, trusted-context headers and an API key alike, before any role check", async () => {
    for (const headers of [
      new Headers(),
      new Headers({ "x-openshapeforge-user-id": adminClaims.sub, "x-openshapeforge-roles": PLATFORM_ADMIN_ROLE }),
      new Headers({ authorization: "ApiKey osf_live_abcdef" }),
    ]) {
      const error = (await resolvePlatformAdministrator(headers, config, {
        verifier: verifierFor(adminClaims),
      }).catch((caught: unknown) => caught)) as ControlAuthorizationError;
      expect(error).toBeInstanceOf(ControlAuthorizationError);
      expect(error.code).toBe("UNAUTHENTICATED");
    }
  });

  it("refuses a token the verifier rejects with the same code and no reason", async () => {
    // A tenant-realm token lands here: wrong issuer, wrong keys. It must not be
    // told which realm this surface trusts.
    const error = await refusal(null);
    expect(error.code).toBe("UNAUTHENTICATED");
    expect(error.message).not.toContain("signature");
    expect(error.message).not.toContain("openshapeforge-control");
  });

  it("refuses admin-cli and any party off the allow-list", async () => {
    for (const azp of ["admin-cli", "codex", undefined]) {
      const { azp: _dropped, ...rest } = adminClaims;
      const error = await refusal(azp === undefined ? rest : { ...rest, azp });
      expect(error.code).toBe("UNAUTHENTICATED");
      expect(error.message).toContain("not issued for the platform administrator MCP");
    }
  });

  it("refuses a token with no subject", async () => {
    const { sub: _dropped, ...withoutSub } = adminClaims;
    await expect(
      resolvePlatformAdministrator(bearer(), config, { verifier: verifierFor(withoutSub) }),
    ).rejects.toThrow(/carries no subject/);
  });

  it("refuses an authenticated control-realm user without platform_admin — the operator role is not enough", async () => {
    const error = await refusal({
      ...adminClaims,
      realm_access: { roles: [PLATFORM_OPERATOR_ROLE] },
    });
    expect(error.code).toBe("FORBIDDEN");
    expect(error.message).toContain(PLATFORM_ADMIN_ROLE);
  });

  it("does not accept platform_admin from resource_access", async () => {
    const error = await refusal({
      ...adminClaims,
      realm_access: { roles: [] },
      resource_access: { "some-client": { roles: [PLATFORM_ADMIN_ROLE] } },
    });
    expect(error.code).toBe("FORBIDDEN");
  });

  it("falls back to the operator client when no MCP parties are configured", async () => {
    const { platformMcp: _dropped, ...withoutList } = config;
    const gateway = await resolvePlatformAdministrator(bearer(), withoutList, {
      verifier: verifierFor({ ...adminClaims, azp: GATEWAY }),
    });
    expect(gateway.authorizedParty).toBe(GATEWAY);
    const codex = await refusal(adminClaims, withoutList);
    expect(codex.code).toBe("UNAUTHENTICATED");
  });

  it("tolerates a token without name, email, username or expiry", async () => {
    const admin = await resolvePlatformAdministrator(bearer(), config, {
      verifier: verifierFor({ sub: adminClaims.sub, azp: CODEX, realm_access: { roles: [PLATFORM_ADMIN_ROLE] } }),
    });
    expect(admin.name).toBeNull();
    expect(admin.email).toBeNull();
    expect(admin.username).toBeUndefined();
    expect(admin.expiresAtMs).toBeNull();
  });
});

describe("platformMcpAuthorizedParties", () => {
  it("reads a comma-separated list from the environment and trims it", () => {
    const result = readControlPlaneConfig({
      OPENSHAPEFORGE_CONTROL_KEYCLOAK_BASE_URL: "http://localhost:8181",
      KEYCLOAK_CLIENT_SECRET_OPENSHAPEFORGE_AUTH_API: "s",
      OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_ISSUER: ISSUER,
      OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_JWKS_URI: `${ISSUER}/certs`,
      OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_CLIENT_ID: GATEWAY,
      OPENSHAPEFORGE_CONTROL_MCP_AUTHORIZED_PARTIES: ` ${GATEWAY}, ${CODEX} ,`,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(platformMcpAuthorizedParties(result.config)).toEqual([GATEWAY, CODEX]);
  });

  it("defaults to the operator client alone", () => {
    expect(platformMcpAuthorizedParties({ ...config, platformMcp: { authorizedParties: [] } })).toEqual([GATEWAY]);
  });
});

describe("systemSessionForAdministrator", () => {
  const admin = {
    subject: adminClaims.sub,
    issuer: ISSUER,
    username: "hubble-platform-admin",
    name: "Hubble Platform admin",
    email: null,
    authorizedParty: CODEX,
    expiresAtMs: null,
  };

  it("elevates to the bypass role with an issuer-qualified actor and a platform-mcp reason", () => {
    const session = systemSessionForAdministrator(admin, "publish_catalog_entry service/record-finding");
    expect(session.roles).toEqual([SYSTEM_BYPASS_ROLE]);
    expect(session.actorSubject).toBe(`${ISSUER}#${adminClaims.sub} (hubble-platform-admin)`);
    expect(session.reason).toBe("platform-mcp: publish_catalog_entry service/record-finding");
    expect(session.tenantId).toBeUndefined();
  });

  it("refuses an empty reason", () => {
    expect(() => systemSessionForAdministrator(admin, " ")).toThrow(/non-empty reason/);
  });
});
