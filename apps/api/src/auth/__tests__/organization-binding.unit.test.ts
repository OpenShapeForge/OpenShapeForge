// SPDX-License-Identifier: BUSL-1.1
/**
 * The three checks that admit a token to `/api/mcp/organizations/<alias>`,
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
  organizationMcpPath,
  organizationResourceScopes,
} from "../../mcp/organization-resource.js";

const HUBBLE = "http://127.0.0.1:3161/api/mcp/organizations/hubble";
const ZEROCOPTER = "http://127.0.0.1:3161/api/mcp/organizations/zerocopter-dev";
const ZEROCOPTER_ORG = "8ba94fb8-08d3-4907-9af3-5bd1e2018f46";
const HUBBLE_ORG = "2e45b405-2acc-4199-b1e3-9a9dc1236ec3";

const membership = (id: string | null) => ({ id, groups: [], roles: [], clientRoles: {} });

/** A Zerocopter admin's token as Keycloak mints it for the Zerocopter resource. */
const zerocopterIdentity = {
  tenantId: null,
  organizations: { "zerocopter-dev": membership(ZEROCOPTER_ORG) },
};
const zerocopterClaims = { aud: ["hubble-api", ZEROCOPTER, "account"] };

const registry = async (realm: string, organizationId: string) =>
  realm === "openshapeforge" && organizationId === ZEROCOPTER_ORG
    ? "33333333-3333-4333-8333-333333333333"
    : realm === "openshapeforge" && organizationId === HUBBLE_ORG
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

  test("a Zerocopter token on Hubble's resource is refused exactly like an unknown alias", () => {
    const onHubble = refusal(() =>
      selectBoundOrganization(zerocopterIdentity, zerocopterClaims, {
        alias: "hubble",
        resource: HUBBLE,
      }),
    );
    const onUnknown = refusal(() =>
      selectBoundOrganization(zerocopterIdentity, zerocopterClaims, {
        alias: "no-such-org",
        resource: "http://127.0.0.1:3161/api/mcp/organizations/no-such-org",
      }),
    );
    expect(onHubble.status).toBe(403);
    expect(onHubble.code).toBe("ORGANIZATION_RESOURCE_FORBIDDEN");
    expect(onUnknown.code).toBe(onHubble.code);
    // Same wording modulo the alias the caller chose; nothing about whether
    // `hubble` exists or who is in it.
    expect(onHubble.message.replaceAll("hubble", "X")).toBe(
      onUnknown.message.replaceAll("no-such-org", "X"),
    );
    expect(onHubble.message).not.toContain(ZEROCOPTER_ORG);
    expect(onHubble.message).toContain("must be a member");
  });

  test("the refusal names the scopes to request for this resource", () => {
    const error = refusal(() =>
      selectBoundOrganization(zerocopterIdentity, { aud: ["hubble-api"] }, {
        alias: "zerocopter-dev",
        resource: ZEROCOPTER,
      }),
    );
    expect(error.scopes).toEqual(["organization:zerocopter-dev", "mcp-resource:zerocopter-dev"]);
    expect(error.message).toContain("`organization:zerocopter-dev`");
    expect(error.message).toContain("`mcp-resource:zerocopter-dev`");
    expect(error.message).toBe(
      organizationBindingRefusalMessage({ alias: "zerocopter-dev", resource: ZEROCOPTER }),
    );
    expect(error.reason).toContain("audience");
  });

  test("membership is required even when Keycloak minted the audience for a non-member", () => {
    // Keycloak issues `mcp-resource:hubble` to anyone who asks; only the
    // `organization` claim says who is actually in Hubble.
    const error = refusal(() =>
      selectBoundOrganization(
        zerocopterIdentity,
        { aud: ["hubble-api", HUBBLE] },
        { alias: "hubble", resource: HUBBLE },
      ),
    );
    expect(error.reason).toContain("no membership");
  });

  test("audience must name THIS resource: another origin or another alias is not it", () => {
    for (const aud of [
      "http://127.0.0.1:3121/api/mcp/organizations/zerocopter-dev", // other origin
      HUBBLE, // other organization
      "http://127.0.0.1:3161/api/mcp", // legacy resource
      "http://127.0.0.1:3161/api/mcp/organizations/zerocopter-dev/", // trailing slash
    ]) {
      const error = refusal(() =>
        selectBoundOrganization(
          zerocopterIdentity,
          { aud: ["hubble-api", aud] },
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
        hubble: membership(HUBBLE_ORG),
      },
    };
    expect(
      selectBoundOrganization(multi, { aud: [HUBBLE] }, { alias: "hubble", resource: HUBBLE }).id,
    ).toBe(HUBBLE_ORG);
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
    const resource = "http://127.0.0.1:3161/api/mcp/organizations/orphan";
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
  });
});

describe("organization resource paths", () => {
  test("alias grammar matches Keycloak's URL-safe aliases and nothing else", () => {
    for (const ok of ["hubble", "zerocopter-dev", "a", "Acme.Corp_1"]) {
      expect(isOrganizationAlias(ok)).toBe(true);
    }
    for (const bad of ["", "-hubble", "hubble-", "a/b", "a b", "a?b", "a:b", "..", 42, null]) {
      expect(isOrganizationAlias(bad)).toBe(false);
    }
  });

  test("reads the alias off a resource URL, ignoring the query string", () => {
    expect(organizationAliasFromPath("/api/mcp/organizations/hubble")).toBe("hubble");
    expect(organizationAliasFromPath("/api/mcp/organizations/hubble?org=zerocopter")).toBe("hubble");
    expect(organizationAliasFromPath("/api/mcp")).toBeNull();
    expect(organizationAliasFromPath("/api/mcp/organizations/")).toBeNull();
    expect(organizationAliasFromPath("/api/mcp/organizations/a/b")).toBeNull();
    expect(organizationAliasFromPath("/api/mcp/organizations")).toBeNull();
    expect(organizationMcpPath("hubble")).toBe("/api/mcp/organizations/hubble");
    expect(organizationResourceScopes("hubble")).toEqual(["organization:hubble", "mcp-resource:hubble"]);
  });
});
