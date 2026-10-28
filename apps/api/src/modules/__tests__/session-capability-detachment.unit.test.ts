// SPDX-License-Identifier: BUSL-1.1
/**
 * What a hostile runtime module can do to the session capability core hands
 * it — and what core's own session looks like afterwards.
 *
 * The capability is the whole basis of the module-facing authorization
 * services: they accept one object, by identity, and read the verified facts
 * off it. So the question here is not whether the OUTER object is frozen —
 * it always was — but whether anything reachable THROUGH it is still a
 * reference into core's verified session. One mutable nested object is
 * enough: `appPrincipal.integrationId` is what `platform.principals
 * .application` reports as verified, what `applyDbSession` writes to
 * `app.app_principal_id`, and therefore which application's record-action
 * grants `app.record_action_allows` answers for. `grant` is what a capability
 * session may reach, and `administrator` is the audited control actor.
 *
 * Every test here mutates through the capability the way plugin code would,
 * then asks two things: did the write land, and is core's session still the
 * one the credential resolved to.
 */
import { describe, expect, it } from "bun:test";
import type { TrustedSessionContext } from "../../auth/trusted-context.js";
import { createDbSessionContext, resolvePrincipalClass } from "../../db/session.js";
import { createModuleSessionCapability } from "../platform.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const ACTOR = "22222222-2222-4222-8222-222222222222";
const INTEGRATION = "33333333-3333-4333-8333-333333333333";
const VICTIM_INTEGRATION = "44444444-4444-4444-8444-444444444444";
const RELATION = "55555555-5555-4555-8555-555555555555";
const IDENTITY = "66666666-6666-4666-8666-666666666666";

/** The session auth/api-key/resolve.ts produces for a resolved key. */
function apiKeySession(): TrustedSessionContext {
  return {
    tenantId: TENANT,
    userId: ACTOR,
    issuer: "https://issuer.invalid/realms/openshapeforge",
    roles: ["General.All.Read"],
    issuerRoles: ["General.All.Read"],
    groups: [],
    relationGroupIds: [],
    oauthScopes: [],
    scope: "self",
    credential: "api-key",
    principalKind: "service",
    appPrincipal: { integrationId: INTEGRATION },
  };
}

/** A capability-grant session, whose reach is written on the grant itself. */
function grantSession(): TrustedSessionContext {
  return {
    tenantId: TENANT,
    userId: "77777777-7777-4777-8777-777777777777",
    roles: [],
    groups: [],
    relationGroupIds: [],
    scope: "self",
    credential: "grant",
    grant: {
      id: "77777777-7777-4777-8777-777777777777",
      subject: { entity: "Notebook", id: "88888888-8888-4888-8888-888888888888" },
      recipient: { kind: "email" },
      operations: ["Notebook.deliver"],
      records: [{
        entity: "Notebook",
        id: "99999999-9999-4999-8999-999999999999",
        intents: ["get"],
      }],
      expiresAt: "2026-12-31T00:00:00.000Z",
      maxUses: 1,
    },
  };
}

/** A verified platform operator: the audited actor of a control Operation. */
function controlSession(): TrustedSessionContext {
  return {
    tenantId: null,
    userId: "operator-subject",
    roles: ["platform-operator"],
    groups: [],
    scope: "self",
    credential: "control-bearer",
    administrator: {
      subject: "operator-subject",
      issuer: "https://issuer.invalid/realms/openshapeforge-control",
      username: "operator",
      name: "Operator",
      email: null,
      authorizedParty: "openshapeforge-admin-gateway",
      expiresAtMs: null,
    },
  };
}

describe("the module session capability is a detached snapshot", () => {
  it("hands a module no reference into core's verified application principal", () => {
    const verified = apiKeySession();
    const before = structuredClone(verified.appPrincipal);
    const capability = createModuleSessionCapability(verified);

    expect(capability.appPrincipal).toEqual({ integrationId: INTEGRATION });
    expect(capability.appPrincipal).not.toBe(verified.appPrincipal);
    expect(Object.isFrozen(capability.appPrincipal)).toBe(true);

    // The write a module would make. Module code is strict-mode ESM, so a
    // frozen target raises rather than silently dropping the assignment.
    expect(() => {
      (capability.appPrincipal as { integrationId: string }).integrationId =
        VICTIM_INTEGRATION;
    }).toThrow(TypeError);
    // Replacing the whole field is refused for the same reason.
    expect(() => {
      (capability as { appPrincipal?: unknown }).appPrincipal = {
        integrationId: VICTIM_INTEGRATION,
      };
    }).toThrow(TypeError);

    // Core's own session is untouched, and still classifies and projects as
    // the integration the credential resolved to.
    expect(verified.appPrincipal).toEqual(before);
    expect(capability.appPrincipal?.integrationId).toBe(INTEGRATION);
    expect(resolvePrincipalClass(capability)).toBe("application");
    expect(createDbSessionContext(capability).appPrincipalId).toBe(INTEGRATION);
    expect(createDbSessionContext(verified).appPrincipalId).toBe(INTEGRATION);
  });

  it("detaches a capability grant's subject, records and intents", () => {
    const verified = grantSession();
    const before = structuredClone(verified.grant);
    const capability = createModuleSessionCapability(verified);
    const grant = capability.grant!;

    expect(grant).not.toBe(verified.grant);
    expect(grant.subject).not.toBe(verified.grant!.subject);
    expect(grant.records).not.toBe(verified.grant!.records);
    expect(Object.isFrozen(grant.records)).toBe(true);
    expect(Object.isFrozen(grant.records[0])).toBe(true);
    expect(Object.isFrozen(grant.records[0]!.intents)).toBe(true);
    expect(Object.isFrozen(grant.operations)).toBe(true);

    // Widening the grant: a new delegated record, a new intent on an existing
    // one, another Operation, a different subject, more uses.
    expect(() => (grant.records as unknown as unknown[]).push({
      entity: "Notebook",
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      intents: ["update"],
    })).toThrow(TypeError);
    expect(() => (grant.records[0]!.intents as string[]).push("update"))
      .toThrow(TypeError);
    expect(() => (grant.operations as string[]).push("Notebook.publish"))
      .toThrow(TypeError);
    expect(() => {
      (grant.subject as { id: string }).id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    }).toThrow(TypeError);
    expect(() => { (grant as { maxUses: number | null }).maxUses = null; })
      .toThrow(TypeError);

    expect(verified.grant).toEqual(before);
  });

  it("detaches the audited control administrator", () => {
    const verified = controlSession();
    const before = structuredClone(verified.administrator);
    const capability = createModuleSessionCapability(verified);
    const administrator = capability.administrator!;

    expect(administrator).not.toBe(verified.administrator);
    expect(Object.isFrozen(administrator)).toBe(true);
    // Both halves of the audit actor, which name the system-bypass audit row.
    expect(() => { (administrator as { subject: string }).subject = "someone-else"; })
      .toThrow(TypeError);
    expect(() => { (administrator as { issuer: string }).issuer = "https://evil.invalid"; })
      .toThrow(TypeError);
    expect(verified.administrator).toEqual(before);
  });

  it("detaches the acting Relation on every read, and stays request-fresh", () => {
    const verified = apiKeySession();
    verified.relation = {
      identityId: IDENTITY,
      issuer: "https://issuer.invalid/realms/openshapeforge",
      subject: ACTOR,
      status: "linked",
      relationId: RELATION,
      displayName: "Acting party",
      relationType: "person",
      candidateRelationId: null,
      linkedBy: null,
      needsRoleAssignment: false,
      roles: ["General.All.Read"],
    };
    const before = structuredClone(verified.relation);
    const capability = createModuleSessionCapability(verified);

    const link = capability.relation!;
    expect(link).not.toBe(verified.relation);
    expect(Object.isFrozen(link)).toBe(true);
    expect(Object.isFrozen(link.roles)).toBe(true);
    expect(() => { (link as { relationId: string | null }).relationId = RELATION; })
      .toThrow(TypeError);
    expect(() => (link.roles as string[]).push("Organization.All.ReadWrite"))
      .toThrow(TypeError);
    expect(verified.relation).toEqual(before);

    // Still the LIVE link, not a snapshot taken when the capability was minted:
    // an administrator re-linking the person takes effect on the next read.
    verified.relation = null;
    expect(capability.relation).toBeNull();
  });

  it("detaches every remaining authority-bearing collection", () => {
    const verified = apiKeySession();
    verified.groups = ["/team"];
    verified.oauthScopes = ["records:read"];
    verified.relationGroupIds = [RELATION];
    const capability = createModuleSessionCapability(verified);

    for (const field of ["roles", "issuerRoles", "groups", "oauthScopes", "relationGroupIds"] as const) {
      const value = capability[field] as readonly string[];
      expect([field, Object.isFrozen(value)]).toEqual([field, true]);
      expect([field, value === verified[field]]).toEqual([field, false]);
      expect(() => (value as string[]).push("forged")).toThrow(TypeError);
    }
    expect(capability.roles).toEqual(["General.All.Read"]);
    expect(capability.issuerRoles).toEqual(["General.All.Read"]);
    expect(verified.groups).toEqual(["/team"]);
  });

  it("leaves no enumerable own property shared with core's session", () => {
    const verified = apiKeySession();
    verified.relation = {
      identityId: IDENTITY,
      issuer: "https://issuer.invalid/realms/openshapeforge",
      subject: ACTOR,
      status: "linked",
      relationId: RELATION,
      displayName: "Acting party",
      relationType: "person",
      candidateRelationId: null,
      linkedBy: null,
      needsRoleAssignment: false,
      roles: [],
    };
    const capability = createModuleSessionCapability(verified) as
      unknown as Record<string, unknown>;
    const source = verified as unknown as Record<string, unknown>;

    // The guarantee as a sweep rather than as a list: whatever the session
    // carries now, and whatever a later field adds, no object a module can
    // reach through the capability is an object core still holds.
    const shared = Object.keys(capability).filter((key) => {
      const value = capability[key];
      return value !== null && typeof value === "object" && value === source[key];
    });
    expect(shared).toEqual([]);
    expect(Object.isFrozen(capability)).toBe(true);
  });
});
