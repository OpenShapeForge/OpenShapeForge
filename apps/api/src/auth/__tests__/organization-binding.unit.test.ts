// SPDX-License-Identifier: BUSL-1.1
/**
 * The three checks that admit a token to `/<alias>`,
 * exercised without a verifier or a database: membership, audience, registry.
 */
import { describe, expect, test } from "bun:test";
import {
  bindOrganizationResource,
  OrganizationBindingError,
  organizationBindingRefusalMessage,
  selectBoundOrganization,
} from "../organization-binding.js";
import {
  isOrganizationAlias,
  organizationAliasFromPath,
  organizationMcpExplicitPath,
  organizationMcpPath,
  rewriteShortAddress,
  organizationResourceScopeNames,
  organizationResourceScopes,
} from "../../mcp/organization-resource.js";

const BETA = "http://127.0.0.1:3161/beta";
const ZEROCOPTER = "http://127.0.0.1:3161/zerocopter-dev";
const ZEROCOPTER_ORG = "8ba94fb8-08d3-4907-9af3-5bd1e2018f46";
const BETA_ORG = "2e45b405-2acc-4199-b1e3-9a9dc1236ec3";

const membership = (id: string | null) => ({ id, groups: [], roles: [], clientRoles: {} });

/** A Zerocopter admin's token as Keycloak mints it for the Zerocopter resource. */
const zerocopterIdentity = {
  tenantId: null,
  organizations: { "zerocopter-dev": membership(ZEROCOPTER_ORG) },
};
const zerocopterClaims = { aud: ["example-api", ZEROCOPTER, "account"] };

const registry = async (realm: string, organizationId: string) =>
  realm === "openshapeforge" && organizationId === ZEROCOPTER_ORG
    ? "33333333-3333-4333-8333-333333333333"
    : realm === "openshapeforge" && organizationId === BETA_ORG
      ? "292a5b94-76f4-43f2-82cd-df09656e912f"
      : null;

function refusal(fn: () => unknown): OrganizationBindingError {
  try {
    fn();
  } catch (error) {
    if (error instanceof OrganizationBindingError) return error;
    throw error;
  }
  throw new Error("expected an OrganizationBindingError");
}

describe("selectBoundOrganization (membership + audience)", () => {
  test("admits the membership the path names when the token was minted for that resource", () => {
    expect(
      selectBoundOrganization(zerocopterIdentity, zerocopterClaims, {
        alias: "zerocopter-dev",
        resource: ZEROCOPTER,
      }),
    ).toEqual({ alias: "zerocopter-dev", id: ZEROCOPTER_ORG });
  });

  test("a Zerocopter token on Beta's resource is refused exactly like an unknown alias", () => {
    const onBeta = refusal(() =>
      selectBoundOrganization(zerocopterIdentity, zerocopterClaims, {
        alias: "beta",
        resource: BETA,
      }),
    );
    const onUnknown = refusal(() =>
      selectBoundOrganization(zerocopterIdentity, zerocopterClaims, {
        alias: "no-such-org",
        resource: "http://127.0.0.1:3161/no-such-org",
      }),
    );
    expect(onBeta.status).toBe(403);
    expect(onBeta.code).toBe("ORGANIZATION_RESOURCE_FORBIDDEN");
    expect(onUnknown.code).toBe(onBeta.code);
    // Same wording modulo the alias the caller chose; nothing about whether
    // `beta` exists or who is in it.
    expect(onBeta.message.replaceAll("beta", "X")).toBe(
      onUnknown.message.replaceAll("no-such-org", "X"),
    );
    expect(onBeta.message).not.toContain(ZEROCOPTER_ORG);
    expect(onBeta.message).toContain("must be a member");
  });

  test("the refusal names the scopes to request for this resource", () => {
    const error = refusal(() =>
      selectBoundOrganization(zerocopterIdentity, { aud: ["example-api"] }, {
        alias: "zerocopter-dev",
        resource: ZEROCOPTER,
      }),
    );
    // `organization`, not `organization:zerocopter-dev`: the refusal tells a
    // client what to request, and a client that has to REGISTER first can only
    // ask for scopes the realm can name. See organization-resource.ts.
    expect(error.scopes).toEqual(["organization", "mcp-resource:zerocopter-dev"]);
    expect(error.message).toContain("`organization`");
    expect(error.message).not.toContain("`organization:zerocopter-dev`");
    expect(error.message).toContain("`mcp-resource:zerocopter-dev`");
    expect(error.message).toBe(
      organizationBindingRefusalMessage({ alias: "zerocopter-dev", resource: ZEROCOPTER }),
    );
    expect(error.reason).toContain("audience");
  });

  test("membership is required even when Keycloak minted the audience for a non-member", () => {
    // Keycloak issues `mcp-resource:beta` to anyone who asks; only the
    // `organization` claim says who is actually in Beta.
    const error = refusal(() =>
      selectBoundOrganization(
        zerocopterIdentity,
        { aud: ["example-api", BETA] },
        { alias: "beta", resource: BETA },
      ),
    );
    expect(error.reason).toContain("no membership");
  });

  test("audience must name THIS resource: another origin or another alias is not it", () => {
    for (const aud of [
      "http://127.0.0.1:3121/zerocopter-dev", // other origin
      BETA, // other organization
      "http://127.0.0.1:3161/api/mcp", // legacy resource
      "http://127.0.0.1:3161/zerocopter-dev/", // trailing slash
    ]) {
      const error = refusal(() =>
        selectBoundOrganization(
          zerocopterIdentity,
          { aud: ["example-api", aud] },
          { alias: "zerocopter-dev", resource: ZEROCOPTER },
        ),
      );
      expect(error.reason).toContain("audience");
    }
    // A string `aud` is accepted as a one-element list.
    expect(
      selectBoundOrganization(zerocopterIdentity, { aud: ZEROCOPTER }, {
        alias: "zerocopter-dev",
        resource: ZEROCOPTER,
      }).id,
    ).toBe(ZEROCOPTER_ORG);
  });

  test("a membership without the organization id cannot be linked and is refused", () => {
    const error = refusal(() =>
      selectBoundOrganization(
        { organizations: { "zerocopter-dev": membership(null) } },
        zerocopterClaims,
        { alias: "zerocopter-dev", resource: ZEROCOPTER },
      ),
    );
    expect(error.reason).toContain("no organization id");
  });

  test("other memberships in the token do not matter: the path picks", () => {
    const multi = {
      tenantId: null,
      organizations: {
        "zerocopter-dev": membership(ZEROCOPTER_ORG),
        beta: membership(BETA_ORG),
      },
    };
    expect(
      selectBoundOrganization(multi, { aud: [BETA] }, { alias: "beta", resource: BETA }).id,
    ).toBe(BETA_ORG);
    expect(
      selectBoundOrganization(multi, { aud: [ZEROCOPTER] }, {
        alias: "zerocopter-dev",
        resource: ZEROCOPTER,
      }).id,
    ).toBe(ZEROCOPTER_ORG);
  });
});

describe("bindOrganizationResource (+ registry)", () => {
  test("pins the session to the tenant linked to the organization", async () => {
    await expect(
      bindOrganizationResource(
        zerocopterIdentity,
        zerocopterClaims,
        { alias: "zerocopter-dev", resource: ZEROCOPTER },
        "openshapeforge",
        registry,
      ),
    ).resolves.toEqual({
      tenantId: "33333333-3333-4333-8333-333333333333",
      organizationId: ZEROCOPTER_ORG,
    });
  });

  test("refuses when no tenant links to the organization, or the realm is not known", async () => {
    const orphan = {
      tenantId: null,
      organizations: { orphan: membership("00000000-0000-4000-8000-000000000000") },
    };
    const resource = "http://127.0.0.1:3161/orphan";
    await expect(
      bindOrganizationResource(orphan, { aud: [resource] }, { alias: "orphan", resource }, "openshapeforge", registry),
    ).rejects.toBeInstanceOf(OrganizationBindingError);
    await expect(
      bindOrganizationResource(
        zerocopterIdentity,
        zerocopterClaims,
        { alias: "zerocopter-dev", resource: ZEROCOPTER },
        undefined,
        registry,
      ),
    ).rejects.toBeInstanceOf(OrganizationBindingError);
    // Same realm check as the legacy path: a row provisioned for one realm is
    // unreachable from a token of another.
    await expect(
      bindOrganizationResource(
        zerocopterIdentity,
        zerocopterClaims,
        { alias: "zerocopter-dev", resource: ZEROCOPTER },
        "other-realm",
        registry,
      ),
    ).rejects.toBeInstanceOf(OrganizationBindingError);
  });

  test("a `tid` that disagrees with the registry is a provisioning fault, not a choice", async () => {
    await expect(
      bindOrganizationResource(
        { ...zerocopterIdentity, tenantId: "292a5b94-76f4-43f2-82cd-df09656e912f" },
        zerocopterClaims,
        { alias: "zerocopter-dev", resource: ZEROCOPTER },
        "openshapeforge",
        registry,
      ),
    ).rejects.toBeInstanceOf(OrganizationBindingError);
    await expect(
      bindOrganizationResource(
        { ...zerocopterIdentity, tenantId: "33333333-3333-4333-8333-333333333333" },
        zerocopterClaims,
        { alias: "zerocopter-dev", resource: ZEROCOPTER },
        "openshapeforge",
        registry,
      ),
    ).resolves.toMatchObject({ tenantId: "33333333-3333-4333-8333-333333333333" });
    // A uuid typed in upper case by whoever set the user attribute is the
    // same tenant — compared the way every other tid comparison is.
    await expect(
      bindOrganizationResource(
        { ...zerocopterIdentity, tenantId: "33333333-3333-4333-8333-333333333333".toUpperCase() },
        zerocopterClaims,
        { alias: "zerocopter-dev", resource: ZEROCOPTER },
        "openshapeforge",
        registry,
      ),
    ).resolves.toMatchObject({ tenantId: "33333333-3333-4333-8333-333333333333" });
  });
});

describe("organization resource paths", () => {
  test("alias grammar matches Keycloak's URL-safe aliases and nothing else", () => {
    for (const ok of ["beta", "zerocopter-dev", "a", "Acme.Corp_1"]) {
      expect(isOrganizationAlias(ok)).toBe(true);
    }
    for (const bad of ["", "-beta", "beta-", "a/b", "a b", "a?b", "a:b", "..", 42, null]) {
      expect(isOrganizationAlias(bad)).toBe(false);
    }
  });

  test("reads the alias off a resource URL, ignoring the query string", () => {
    expect(organizationAliasFromPath("/api/mcp")).toBeNull();
    // The pre-rename spelling is no longer a resource; `api` is reserved.
    expect(organizationAliasFromPath("/api/mcp/organizations/beta")).toBeNull();
    // The alias IS the path.
    expect(organizationAliasFromPath("/beta")).toBe("beta");
    expect(organizationAliasFromPath("/beta/mcp")).toBe("beta");
    expect(organizationAliasFromPath("/beta/api/rest/v1/quotes")).toBe("beta");
    expect(organizationAliasFromPath("/beta?org=zerocopter")).toBe("beta");
    expect(organizationAliasFromPath("/")).toBeNull();
    // The server's own names are never an organization, whatever Keycloak
    // would accept as an alias.
    for (const reserved of ["/api/rest/v1", "/graphql", "/admin", "/admin/mcp", "/assets/main.js", "/.well-known/x", "/healthz"]) {
      expect(organizationAliasFromPath(reserved)).toBeNull();
    }
    expect(organizationMcpPath("beta")).toBe("/beta");
    expect(organizationMcpExplicitPath("beta")).toBe("/beta/mcp");
    // The rewrite: the MCP resource is routed as spelled, the other surfaces
    // are mapped onto the routes the server already has.
    expect(rewriteShortAddress("/beta")).toBe("/beta");
    expect(rewriteShortAddress("/beta/mcp")).toBe("/beta/mcp");
    expect(rewriteShortAddress("/beta/api/rest/v1/quotes?a=1")).toBe("/api/rest/v1/quotes?a=1");
    expect(rewriteShortAddress("/beta/graphql")).toBe("/api/graphql");
    expect(rewriteShortAddress("/admin/mcp")).toBe("/api/control/mcp");
    expect(rewriteShortAddress("/api/rest/v1/quotes")).toBeNull();
    expect(rewriteShortAddress("/graphql")).toBeNull();
    expect(rewriteShortAddress("/beta/nonsense")).toBeNull();
    expect(organizationResourceScopes("beta")).toEqual(["organization", "mcp-resource:beta"]);
    // Every advertised scope must be a client scope a realm can allow-list,
    // or a self-registering client is refused before it ever authorizes.
    expect(organizationResourceScopeNames("beta")).toEqual(organizationResourceScopes("beta"));
  });
});
