// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import type { TrustedSessionContext } from "../../auth/trusted-context.js";
import { createModuleSessionCapability } from "../../modules/platform.js";
import type { StatefulMcpAuthorization } from "../stateful-session-authorization.js";
import {
  createRequestFreshContext,
  createStatefulMcpSessionContext,
  sameStatefulMcpAuthorization,
  withFreshRelationGroupMemberships,
} from "../stateful-session-authorization.js";

describe("createRequestFreshContext", () => {
  it("isolates concurrent requests and drops authority retained after settlement", async () => {
    const context = createRequestFreshContext({ roles: [] as string[] });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let releaseLate!: () => void;
    const lateGate = new Promise<void>((resolve) => { releaseLate = resolve; });
    const retained = context.view;
    let lateRead!: Promise<readonly string[]>;

    const first = context.run({ roles: ["first"] }, async () => {
      lateRead = (async () => {
        await lateGate;
        return retained.roles;
      })();
      await firstGate;
      return retained.roles;
    });
    const second = context.run({ roles: ["second"] }, async () => {
      const observed = context.current().roles;
      releaseFirst();
      return observed;
    });

    expect(await first).toEqual(["first"]);
    expect(await second).toEqual(["second"]);
    releaseLate();
    expect(await lateRead).toEqual([]);
    expect(retained.roles).toEqual([]);
    expect(context.current().roles).toEqual([]);
  });
});

type TestAuthorization = StatefulMcpAuthorization & Pick<TrustedSessionContext, "roles" | "scope">;

function authorization(overrides: Partial<TestAuthorization> = {}): TestAuthorization {
  return {
    tenantId: "33333333-3333-4333-8333-333333333333",
    userId: "22222222-2222-4222-8222-222222222222",
    roles: ["org_employee", "Workflow.All.Read"],
    oauthScopes: ["openid", "profile"],
    groups: ["11111111-1111-4111-8111-111111111111"],
    scope: "tenant",
    credential: "bearer",
    loginSessionBinding: "login-session-a",
    ...overrides,
  };
}

describe("sameStatefulMcpAuthorization", () => {
  it("refreshes RelationGroup memberships without treating them as token claims", async () => {
    const established = authorization() as TestAuthorization & {
      relationGroupIds?: readonly string[];
    };
    const current = authorization() as TestAuthorization & {
      relationGroupIds?: readonly string[];
    };
    established.relationGroupIds = ["11111111-1111-4111-8111-111111111111"];
    current.relationGroupIds = [];

    expect(sameStatefulMcpAuthorization(established, current)).toBe(true);
    const stateful = createStatefulMcpSessionContext(established);
    const moduleCapability = createModuleSessionCapability(stateful);
    expect(stateful.relationGroupIds).toEqual([]);
    expect(moduleCapability.relationGroupIds).toEqual([]);
    await withFreshRelationGroupMemberships(established, async () => {
      expect(stateful.relationGroupIds).toEqual(established.relationGroupIds);
      expect(moduleCapability.relationGroupIds).toEqual(established.relationGroupIds);
    });
    await withFreshRelationGroupMemberships(current, async () => {
      expect(stateful.relationGroupIds).toEqual([]);
      expect(Object.isFrozen(stateful.relationGroupIds)).toBe(true);
      expect(moduleCapability.relationGroupIds).toEqual([]);
    });
    expect(stateful.relationGroupIds).toEqual([]);
  });

  it("keeps concurrent request memberships isolated", async () => {
    const stateful = createStatefulMcpSessionContext(authorization());
    const first = authorization() as TrustedSessionContext;
    const second = authorization() as TrustedSessionContext;
    first.relationGroupIds = ["11111111-1111-4111-8111-111111111111"];
    second.relationGroupIds = ["22222222-2222-4222-8222-222222222222"];

    let releaseFirst!: () => void;
    const firstCanRead = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const one = withFreshRelationGroupMemberships(first, async () => {
      await firstCanRead;
      return stateful.relationGroupIds;
    });
    const two = withFreshRelationGroupMemberships(second, async () => {
      const observed = stateful.relationGroupIds;
      releaseFirst();
      return observed;
    });

    expect(await one).toEqual(first.relationGroupIds);
    expect(await two).toEqual(second.relationGroupIds);
  });

  it("drops memberships from async callbacks retained after request settlement", async () => {
    const stateful = createStatefulMcpSessionContext(authorization());
    const current = authorization() as TrustedSessionContext;
    current.relationGroupIds = ["11111111-1111-4111-8111-111111111111"];
    let releaseLate!: () => void;
    const lateGate = new Promise<void>((resolve) => {
      releaseLate = resolve;
    });
    let lateRead!: Promise<readonly string[]>;

    await withFreshRelationGroupMemberships(current, () => {
      lateRead = (async () => {
        await lateGate;
        return stateful.relationGroupIds ?? [];
      })();
      expect(stateful.relationGroupIds).toEqual(current.relationGroupIds);
    });
    releaseLate();

    expect(await lateRead).toEqual([]);
  });

  it("carries the identity ↔ Relation link per request, never from the initialize snapshot", async () => {
    const link = (relationId: string): NonNullable<TrustedSessionContext["relation"]> => ({
      identityId: "44444444-4444-4444-8444-444444444444",
      issuer: "http://kc/realms/r",
      subject: "22222222-2222-4222-8222-222222222222",
      status: "linked",
      relationId,
      displayName: "Someone",
      relationType: "person",
      candidateRelationId: null,
      linkedBy: "jit",
      needsRoleAssignment: false,
      roles: ["General.All.Read"],
    });
    const established = { ...authorization(), relation: link("relation-at-initialize") } as TrustedSessionContext;
    const stateful = createStatefulMcpSessionContext(established);
    // No request: no link authority, and the initialize snapshot is not it.
    expect(stateful.relation).toBeNull();

    // An administrator re-linked the person between two requests; the second
    // request resolved the new link, and that is what the session answers.
    const relinked = { ...authorization(), relation: link("relation-after-relink") } as TrustedSessionContext;
    await withFreshRelationGroupMemberships(relinked, async () => {
      expect(stateful.relation?.relationId).toBe("relation-after-relink");
      // A tool updating the link mid-request (confirm_my_link) is seen by the
      // rest of that request only.
      stateful.relation = link("relation-confirmed-now");
      expect(stateful.relation?.relationId).toBe("relation-confirmed-now");
    });
    expect(stateful.relation).toBeNull();
    const unlinked = { ...authorization(), relation: null } as TrustedSessionContext;
    await withFreshRelationGroupMemberships(unlinked, async () => {
      expect(stateful.relation).toBeNull();
    });
  });

  it("accepts access-token renewal within the same login session", () => {
    expect(
      sameStatefulMcpAuthorization(
        authorization(),
        authorization({
          roles: ["Workflow.All.Read", "org_employee"],
          // Keycloak may repeat a default scope on a refresh grant. Claims
          // are authorization sets; duplicates do not widen authority.
          oauthScopes: ["profile", "openid", "openid"],
        }),
      ),
    ).toBe(true);
  });

  it("refuses reuse from a different login session", () => {
    expect(
      sameStatefulMcpAuthorization(
        authorization(),
        authorization({ loginSessionBinding: "login-session-b" }),
      ),
    ).toBe(false);
  });

  it("refuses both present-to-missing login binding transitions", () => {
    const withoutLoginBinding = authorization();
    delete withoutLoginBinding.loginSessionBinding;
    expect(
      sameStatefulMcpAuthorization(
        authorization(),
        withoutLoginBinding,
      ),
    ).toBe(false);
    expect(
      sameStatefulMcpAuthorization(
        withoutLoginBinding,
        authorization(),
      ),
    ).toBe(false);
  });

  it("preserves sessions when both non-bearer login bindings are absent", () => {
    const established = authorization({ credential: "api-key" });
    const current = authorization({ credential: "api-key" });
    delete established.loginSessionBinding;
    delete current.loginSessionBinding;
    expect(
      sameStatefulMcpAuthorization(established, current),
    ).toBe(true);
  });

  it("carries roles and scope per request, so a role change applies in place instead of ending the session", async () => {
    const established = authorization({ roles: ["General.All.Read", "org_employee"], scope: "self" }) as TrustedSessionContext;
    const stateful = createStatefulMcpSessionContext(established);
    // Outside a request: what the session was established with, so the
    // server built at initialize sees a complete session.
    expect(stateful.roles).toEqual(["General.All.Read", "org_employee"]);
    expect(stateful.scope).toBe("self");
    // A role change between requests is not a reason to reinitialize...
    const promoted = authorization({ roles: ["Organization.All.ReadWrite", "org_admin"], scope: "tenant" }) as TrustedSessionContext;
    expect(sameStatefulMcpAuthorization(established, promoted)).toBe(true);
    // ...and the request that carries it sees the new roles.
    await withFreshRelationGroupMemberships(promoted, async () => {
      expect(stateful.roles).toEqual(["Organization.All.ReadWrite", "org_admin"]);
      expect(stateful.scope).toBe("tenant");
    });
    expect(stateful.roles).toEqual(["General.All.Read", "org_employee"]);
  });

  it("still refuses identity, claim, and credential changes", () => {
    const original = authorization();
    expect(
      sameStatefulMcpAuthorization(original, authorization({ userId: "different-user" })),
    ).toBe(false);
    expect(sameStatefulMcpAuthorization(original, authorization({ oauthScopes: [] }))).toBe(false);
    expect(sameStatefulMcpAuthorization(original, authorization({ groups: [] }))).toBe(false);
    expect(
      sameStatefulMcpAuthorization(original, authorization({ credential: "api-key" })),
    ).toBe(false);
  });
});
