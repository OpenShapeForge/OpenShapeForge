// SPDX-License-Identifier: BUSL-1.1
/**
 * What an API-key session says it IS.
 *
 * The record-action axis matches an `integrations` subject against the
 * session's verified application principal, so where that principal comes
 * from is load-bearing: it must be the integration row the store resolved,
 * and it must appear on no other carrier. These tests pin both ends — the
 * value, and the fact that it is read from the row rather than from anything
 * the holder presented.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mintApiKey } from "./format.js";
import type { ResolvedApiKey } from "./store.js";

const tenantId = randomUUID();
const integrationId = randomUUID();
const serviceAccountUserId = randomUUID();

let resolved: ResolvedApiKey | undefined;
let exchangeCalls = 0;

mock.module("./store.js", () => ({
  resolveApiKey: async () =>
    resolved ? { ok: true as const, key: resolved } : { ok: false as const, reason: "unknown" as const },
  recordApiKeyUse: async () => undefined,
  parseRoleSubset: (value: unknown) => (Array.isArray(value) ? value : null),
}));
mock.module("./exchange.js", () => ({
  exchangeForToken: async () => {
    exchangeCalls += 1;
    return "exchanged-token";
  },
}));

const { resolveApiKeySession } = await import("./resolve.js");

function key(overrides: Partial<ResolvedApiKey> = {}): ResolvedApiKey {
  return {
    keyId: randomUUID(),
    tenantId,
    integrationId,
    roleSubset: null,
    keycloakClientId: "integration-client",
    displayName: "Partner integration",
    clientSecret: { ciphertext: "x", keyId: "k", algorithm: "a" } as ResolvedApiKey["clientSecret"],
    ...overrides,
  };
}

function deps(identity: Partial<{ tenantId: string | null; userId: string | null; roles: string[]; groups: string[] }> = {}) {
  return {
    db: {} as never,
    keyring: {} as never,
    issuer: "https://identity.example/realms/test",
    verifyToken: async () => ({
      tenantId, userId: serviceAccountUserId, roles: ["Relations.All.Read"], groups: [],
      ...identity,
    }),
    resolveScope: () => "tenant" as const,
  };
}

beforeEach(() => {
  resolved = key();
  exchangeCalls = 0;
});

describe("the application principal on an API-key session", () => {
  test("names the integration the store resolved, not the key or its label", async () => {
    const session = await resolveApiKeySession(deps(), mintApiKey().token);
    expect(session).toBeDefined();
    expect(session!.credential).toBe("api-key");
    expect(session!.principalKind).toBe("service");
    expect(session!.appPrincipal).toEqual({ integrationId });
    // The key id and the display name are NOT the principal: one is rotated,
    // the other is renamed, and a policy that named either would drift.
    expect(session!.appPrincipal!.integrationId).not.toBe(resolved!.keyId);
    expect(session!.appPrincipal!.integrationId).not.toBe(resolved!.displayName);
    expect(exchangeCalls).toBe(1);
  });

  test("follows the integration, not the credential, across a rotation", async () => {
    const first = await resolveApiKeySession(deps(), mintApiKey().token);
    // A second credential of the SAME integration: new key id, same principal.
    resolved = key({ keyId: randomUUID() });
    const second = await resolveApiKeySession(deps(), mintApiKey().token);
    expect(second!.appPrincipal).toEqual(first!.appPrincipal);
    expect(second!.appPrincipal).toEqual({ integrationId });
  });

  test("a different integration is a different principal", async () => {
    const other = randomUUID();
    resolved = key({ integrationId: other });
    const session = await resolveApiKeySession(deps(), mintApiKey().token);
    expect(session!.appPrincipal).toEqual({ integrationId: other });
  });

  test("no session at all means no principal, on every refusal path", async () => {
    // An unparsable credential, an unknown one, and a service account whose
    // own tenant disagrees with the row: all undefined, so nothing downstream
    // can see a principal without a verified integration behind it.
    expect(await resolveApiKeySession(deps(), "not-an-api-key")).toBeUndefined();
    resolved = undefined;
    expect(await resolveApiKeySession(deps(), mintApiKey().token)).toBeUndefined();
    resolved = key();
    expect(await resolveApiKeySession(deps({ tenantId: randomUUID() }), mintApiKey().token))
      .toBeUndefined();
    expect(await resolveApiKeySession(deps({ userId: null }), mintApiKey().token))
      .toBeUndefined();
  });
});

describe("no other carrier produces an application principal", () => {
  test("a signed trusted-context bundle cannot name one", async () => {
    const { readTrustedSessionContext } = await import("../trusted-context.js");
    // Everything a web tier may hand on, plus every spelling of the field a
    // caller might hope is read. The reader builds its own object, so none of
    // it can reach the session.
    const headers = new Headers({
      "x-osf-tenant-id": tenantId,
      "x-osf-user-id": serviceAccountUserId,
      "x-osf-roles": "Relations.All.Read",
      "x-osf-app-principal": integrationId,
      "x-osf-app-principal-id": integrationId,
      "x-osf-integration-id": integrationId,
      "x-osf-principal-class": "application",
      "x-osf-principal-kind": "service",
    });
    const session = readTrustedSessionContext(headers, { allowUnsigned: true });
    expect(session.credential).toBe("trusted-context");
    expect(session.appPrincipal).toBeUndefined();
    expect(session.principalKind).toBeUndefined();
    expect(JSON.stringify(session)).not.toContain(integrationId);
  });

  test("the database session derives the class from the server's own decision", async () => {
    const { resolvePrincipalClass } = await import("../../db/session.js");
    expect(resolvePrincipalClass({ tenantId, userId: serviceAccountUserId })).toBe("unknown");
    expect(resolvePrincipalClass({
      tenantId, userId: serviceAccountUserId, principalKind: "service",
    })).toBe("service");
    expect(resolvePrincipalClass({
      tenantId, userId: serviceAccountUserId, principalKind: "person",
    })).toBe("person");
    // An application outranks the service kind its own token carries.
    expect(resolvePrincipalClass({
      tenantId, userId: serviceAccountUserId, principalKind: "service",
      appPrincipal: { integrationId },
    })).toBe("application");
    // A verified service account cannot be re-read as a person by attaching a
    // Relation to it; the stated kind wins over the link.
    expect(resolvePrincipalClass({
      tenantId, userId: serviceAccountUserId, principalKind: "service",
      relation: {
        identityId: randomUUID(), issuer: "https://identity.example/realms/test",
        subject: serviceAccountUserId, status: "linked",
      },
    } as never)).toBe("service");
    // A link belonging to someone else classifies nobody.
    expect(resolvePrincipalClass({
      tenantId, userId: serviceAccountUserId,
      relation: {
        identityId: randomUUID(), issuer: "https://identity.example/realms/test",
        subject: randomUUID(), status: "linked",
      },
    } as never)).toBe("unknown");
  });
});
