// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import type { TrustedSessionContext } from "../../auth/trusted-context.js";
import { createModuleSessionCapability } from "../../modules/platform.js";
import type { StatefulMcpAuthorization } from "../stateful-session-authorization.js";
import {
  createStatefulMcpSessionContext,
  sameStatefulMcpAuthorization,
  withFreshRelationGroupMemberships,
} from "../stateful-session-authorization.js";

function authorization(
  overrides: Partial<StatefulMcpAuthorization> = {},
): StatefulMcpAuthorization {
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
    const established = authorization() as StatefulMcpAuthorization & {
      relationGroupIds?: readonly string[];
    };
    const current = authorization() as StatefulMcpAuthorization & {
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

  it("still refuses identity, claim, scope, and credential changes", () => {
    const original = authorization();
    expect(
      sameStatefulMcpAuthorization(original, authorization({ userId: "different-user" })),
    ).toBe(false);
    expect(sameStatefulMcpAuthorization(original, authorization({ roles: [] }))).toBe(false);
    expect(sameStatefulMcpAuthorization(original, authorization({ oauthScopes: [] }))).toBe(false);
    expect(sameStatefulMcpAuthorization(original, authorization({ groups: [] }))).toBe(false);
    expect(sameStatefulMcpAuthorization(original, authorization({ scope: "self" }))).toBe(false);
    expect(
      sameStatefulMcpAuthorization(original, authorization({ credential: "api-key" })),
    ).toBe(false);
  });
});
