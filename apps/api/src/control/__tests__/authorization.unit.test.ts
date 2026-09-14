// SPDX-License-Identifier: BUSL-1.1
/**
 * Who gets through the control-plane door, and what an operator becomes on the
 * other side of it.
 *
 * The elevation this file guards is the sharpest edge in S3: an authenticated
 * operator is granted `Platform.SystemBypass`, which disables row-level security
 * across every tenant. Three things therefore have to hold, and each has its own
 * test below:
 *
 *   1. nothing but a verified CONTROL-realm bearer gets in — no trusted-context
 *      fallback, no unverified token, no missing subject;
 *   2. the marker role is looked for in `realm_access` ONLY, so a client that
 *      defines a role called `platform-operator` cannot mint control access;
 *   3. the elevation is attached to a session object, with an issuer-qualified
 *      actor and a non-empty reason, and never back onto the token.
 */
import { describe, expect, it } from "bun:test";
import { SYSTEM_BYPASS_ROLE } from "../../db/session.js";
import {
  ControlAuthorizationError,
  PLATFORM_OPERATOR_ROLE,
  resolveControlOperator,
  systemSessionForOperator,
} from "../authorization.js";
import type { ControlPlaneConfig } from "../config.js";

const ISSUER = "http://localhost:8181/realms/openshapeforge-control";
const CLIENT = "openshapeforge-admin-gateway";

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
    clientId: "openshapeforge-admin-gateway",
  },
  mcpResource: { origins: ["http://127.0.0.1:3001"], clients: ["codex"] },
};

/** A verifier stub, so no JWKS is fetched and no key material is needed. */
const verifierFor = (claims: Record<string, unknown>) =>
  (async () => ({ identity: {} as never, claims })) as never;

const rejectingVerifier = (async () => {
  throw new Error("signature verification failed");
}) as never;

const bearer = (token = "any") =>
  new Headers({ authorization: `Bearer ${token}` });

const operatorClaims = {
  sub: "8f8e0c86-3c4f-4a2f-9f3a-0f1a2b3c4d5e",
  azp: CLIENT,
  preferred_username: "platform-operator",
  realm_access: { roles: [PLATFORM_OPERATOR_ROLE, "default-roles-openshapeforge-control"] },
};

describe("resolveControlOperator", () => {
  it("accepts a verified control-realm token holding the operator role", async () => {
    const operator = await resolveControlOperator(bearer(), config, {
      verifier: verifierFor(operatorClaims),
    });

    expect(operator).toEqual({
      subject: operatorClaims.sub,
      issuer: ISSUER,
      username: "platform-operator",
    });
  });

  it("refuses a request with no bearer header", async () => {
    const error = (await resolveControlOperator(new Headers(), config, {
      verifier: verifierFor(operatorClaims),
    }).catch((caught: unknown) => caught)) as ControlAuthorizationError;

    expect(error.code).toBe("UNAUTHENTICATED");
  });

  it("refuses trusted-context headers, which the tenant surface would accept", async () => {
    // No fallback by design: anything holding the shared context secret could
    // otherwise claim to be a platform operator on a cross-tenant surface.
    const headers = new Headers({
      "x-openshapeforge-user-id": operatorClaims.sub,
      "x-openshapeforge-roles": PLATFORM_OPERATOR_ROLE,
    });

    await expect(
      resolveControlOperator(headers, config, { verifier: verifierFor(operatorClaims) }),
    ).rejects.toThrow(/requires an Authorization: Bearer token/);
  });

  it("refuses a token the verifier rejects, without saying why", async () => {
    const error = (await resolveControlOperator(bearer(), config, {
      verifier: rejectingVerifier,
    }).catch((caught: unknown) => caught)) as ControlAuthorizationError;

    expect(error.code).toBe("UNAUTHENTICATED");
    // The distinction between "wrong signature", "wrong issuer" and "expired" is
    // an oracle for a prober, so it stays in the log.
    expect(error.message).not.toContain("signature");
  });

  it("refuses a valid-issuer token minted for the built-in admin-cli client", async () => {
    // The reason the azp pin exists. `admin-cli` is a PUBLIC client present on
    // every Keycloak realm, so any realm user can mint a token through it with a
    // direct-access grant and NO client secret. Without this check, holding an
    // operator's password alone would be enough to reach the control plane —
    // the gateway client's secret would stop being a factor.
    const error = (await resolveControlOperator(bearer(), config, {
      verifier: verifierFor({ ...operatorClaims, azp: "admin-cli" }),
    }).catch((caught: unknown) => caught)) as ControlAuthorizationError;

    expect(error.code).toBe("UNAUTHENTICATED");
    expect(error.message).toContain("not issued for the control plane's client");
  });

  it("refuses a token carrying no azp at all", async () => {
    const { azp: _dropped, ...withoutAzp } = operatorClaims;
    await expect(
      resolveControlOperator(bearer(), config, { verifier: verifierFor(withoutAzp) }),
    ).rejects.toThrow(/not issued for the control plane's client/);
  });

  it("refuses a token with no subject", async () => {
    await expect(
      resolveControlOperator(bearer(), config, {
        verifier: verifierFor({ azp: CLIENT, realm_access: { roles: [PLATFORM_OPERATOR_ROLE] } }),
      }),
    ).rejects.toThrow(/carries no subject/);
  });

  it("refuses an authenticated operator without the marker role", async () => {
    // The control realm ships `platform-noaccess` for exactly this: without it
    // there is no way to tell "the control plane checks the role" from "the
    // control plane lets in anyone who can reach the login page".
    const error = (await resolveControlOperator(bearer(), config, {
      verifier: verifierFor({ azp: CLIENT, sub: operatorClaims.sub, realm_access: { roles: [] } }),
    }).catch((caught: unknown) => caught)) as ControlAuthorizationError;

    expect(error.code).toBe("FORBIDDEN");
    expect(error.message).toContain(PLATFORM_OPERATOR_ROLE);
  });

  it("does not accept the marker role from resource_access", async () => {
    // identity.ts merges client roles for tenant sessions because entity roles
    // only exist there. Here that merge would let ANY client that defines a role
    // named `platform-operator` confer control-plane access.
    await expect(
      resolveControlOperator(bearer(), config, {
        verifier: verifierFor({
          azp: CLIENT,
          sub: operatorClaims.sub,
          realm_access: { roles: [] },
          resource_access: { "some-client": { roles: [PLATFORM_OPERATOR_ROLE] } },
        }),
      }),
    ).rejects.toThrow(/Not authorized to use the control plane/);
  });

  it("tolerates a token with no preferred_username", async () => {
    const operator = await resolveControlOperator(bearer(), config, {
      verifier: verifierFor({
        azp: CLIENT,
        sub: operatorClaims.sub,
        realm_access: { roles: [PLATFORM_OPERATOR_ROLE] },
      }),
    });

    expect(operator.username).toBeUndefined();
  });
});

describe("systemSessionForOperator", () => {
  const operator = {
    subject: operatorClaims.sub,
    issuer: ISSUER,
    username: "platform-operator",
  };

  it("attaches the bypass role the control realm deliberately does not mint", () => {
    const session = systemSessionForOperator(operator, 'create tenant slug="acme"');

    expect(session.roles).toEqual([SYSTEM_BYPASS_ROLE]);
  });

  it("qualifies the actor by issuer, because sub is only unique within one", () => {
    const session = systemSessionForOperator(operator, "create tenant");

    expect(session.actorSubject).toBe(`${ISSUER}#${operatorClaims.sub} (platform-operator)`);
  });

  it("falls back to the bare qualified subject when there is no username", () => {
    const session = systemSessionForOperator(
      { ...operator, username: undefined },
      "create tenant",
    );

    expect(session.actorSubject).toBe(`${ISSUER}#${operatorClaims.sub}`);
  });

  it("records a reason naming the control plane and the operation", () => {
    const session = systemSessionForOperator(operator, 'create tenant slug="acme"');

    expect(session.reason).toBe('control-plane: create tenant slug="acme"');
    expect(session.reason.trim().length).toBeGreaterThan(0);
  });

  it("claims no tenant scope, because the writes are cross-tenant", () => {
    // A bypass session naming a tenant reads as scoped to it. The registry row
    // IS the tenant and may not exist yet, so claiming a scope would make the
    // audit trail misleading rather than more precise.
    expect(systemSessionForOperator(operator, "create tenant").tenantId).toBeUndefined();
  });

  it("refuses an empty reason", () => {
    expect(() => systemSessionForOperator(operator, "   ")).toThrow(/non-empty reason/);
  });
});
