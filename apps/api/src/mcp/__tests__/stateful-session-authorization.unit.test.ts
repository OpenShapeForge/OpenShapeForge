// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import type { StatefulMcpAuthorization } from "../stateful-session-authorization.js";
import { sameStatefulMcpAuthorization } from "../stateful-session-authorization.js";

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
