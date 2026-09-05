// SPDX-License-Identifier: BUSL-1.1
/**
 * The organization admin client, driven with a stub fetch.
 *
 * What is worth pinning here, in order of how badly it fails if it regresses:
 *   1. a write is READ-MODIFY-WRITE, and the representation goes back WHOLE —
 *      the `openshapeforge.*` attributes are the only thing holding the sub-org
 *      tree together, and a partial PUT that Keycloak decided to treat as a
 *      replacement would silently flatten it;
 *   2. re-asserting the state an organization is already in writes nothing, so
 *      replaying a suspend is genuinely idempotent;
 *   3. a 404 is drift (the registry holds an id Keycloak does not have), not a
 *      bad request, and says what heals it;
 *   4. a service-account rejection is a deployment fault, never the operator's
 *      403 — the same rule the SPI client follows.
 */
import { describe, expect, it } from "bun:test";
import {
  createKeycloakOrganizationAdminClient,
  KeycloakAdminError,
} from "../keycloak-organization-admin.js";
import type { KeycloakServiceAccountConfig } from "../keycloak-service-account.js";

const config: KeycloakServiceAccountConfig = {
  baseUrl: "http://keycloak.test:8080",
  tenantRealm: "openshapeforge",
  clientId: "openshapeforge-auth-api",
  clientSecret: "s3cret",
};

type Call = { url: string; init: RequestInit };

/** The representation Keycloak 26.5.3 actually answers with, attributes and all. */
const representation = (enabled: boolean) => ({
  id: "acme",
  name: "acme",
  alias: "acme",
  enabled,
  attributes: {
    "openshapeforge.organizationLevel": ["root"],
    "openshapeforge.rootOrganizationId": ["acme"],
    "openshapeforge.organizationPath": ["acme"],
    "openshapeforge.sourceAuthority": ["keycloak"],
  },
});

function stubFetch(options: { admin?: Array<() => Response>; token?: () => Response }): {
  fetch: typeof globalThis.fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  let index = 0;
  const fetch = (async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("/protocol/openid-connect/token")) {
      return (
        options.token?.() ??
        Response.json({ access_token: "service-account-token", expires_in: 900 })
      );
    }
    const next = options.admin?.[Math.min(index++, (options.admin?.length ?? 1) - 1)];
    return next ? next() : Response.json(representation(true));
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("reading an organization", () => {
  it("addresses the admin API on the tenant realm with the service-account token", async () => {
    const { fetch, calls } = stubFetch({});
    const state = await createKeycloakOrganizationAdminClient(config, {
      fetch,
    }).getOrganization("acme");

    expect(calls[1]!.url).toBe(
      "http://keycloak.test:8080/admin/realms/openshapeforge/organizations/acme",
    );
    expect((calls[1]!.init.headers as Record<string, string>).authorization).toBe(
      "Bearer service-account-token",
    );
    expect(state).toEqual({ id: "acme", name: "acme", alias: "acme", enabled: true });
  });

  it("percent-encodes the organization id", async () => {
    // Keycloak generates a uuid since #294, but an id read out of the registry
    // is whatever was stamped there at provisioning time, so a deployment that
    // predates that fix still holds name-shaped ids. Encoded, not interpolated.
    const { fetch, calls } = stubFetch({
      admin: [() => Response.json({ ...representation(true), id: "acme--emea" })],
    });
    await createKeycloakOrganizationAdminClient(config, { fetch }).getOrganization(
      "acme/emea",
    );

    expect(calls[1]!.url).toEndWith("/organizations/acme%2Femea");
  });

  it("treats an absent `enabled` as enabled", async () => {
    // Keycloak omits the flag in some representations. Reading an omission as
    // "suspended" would report every such organization as down.
    const { fetch } = stubFetch({
      admin: [() => Response.json({ id: "acme", name: "acme", alias: "acme" })],
    });
    const state = await createKeycloakOrganizationAdminClient(config, {
      fetch,
    }).getOrganization("acme");

    expect(state.enabled).toBe(true);
  });
});

describe("changing the enabled flag", () => {
  it("writes the WHOLE representation back, attributes included", async () => {
    const { fetch, calls } = stubFetch({
      admin: [() => Response.json(representation(true)), () => new Response("", { status: 204 })],
    });

    const result = await createKeycloakOrganizationAdminClient(config, {
      fetch,
    }).setOrganizationEnabled("acme", false);

    expect(result.changed).toBe(true);
    expect(result.organization.enabled).toBe(false);

    const put = calls[2]!;
    expect(put.init.method).toBe("PUT");
    // Exactly the representation that was read, with one field changed. The
    // hierarchy attributes ride along rather than being staked on Keycloak
    // merging a partial body.
    expect(JSON.parse(String(put.init.body))).toEqual({
      ...representation(true),
      enabled: false,
    });
  });

  it("writes nothing when the flag already matches", async () => {
    const { fetch, calls } = stubFetch({ admin: [() => Response.json(representation(false))] });

    const result = await createKeycloakOrganizationAdminClient(config, {
      fetch,
    }).setOrganizationEnabled("acme", false);

    expect(result).toEqual({
      organization: { id: "acme", name: "acme", alias: "acme", enabled: false },
      changed: false,
    });
    // Token, then one GET. No PUT.
    expect(calls.length).toBe(2);
  });
});

describe("failure mapping", () => {
  const codeFor = async (respond: () => Response) => {
    const { fetch } = stubFetch({ admin: [respond] });
    const error = (await createKeycloakOrganizationAdminClient(config, { fetch })
      .getOrganization("acme")
      .catch((caught: unknown) => caught)) as KeycloakAdminError;
    expect(error).toBeInstanceOf(KeycloakAdminError);
    return error;
  };

  it("maps 404 to drift, naming the action that heals it", async () => {
    const error = await codeFor(() => new Response("", { status: 404 }));
    expect(error.code).toBe("KEYCLOAK_ADMIN_ORGANIZATION_NOT_FOUND");
    expect(error.message).toMatch(/Replay the tenant's provisioning create/);
  });

  it("maps 403 to a deployment fault, never the operator's 403", async () => {
    const error = await codeFor(() => new Response("", { status: 403 }));
    expect(error.code).toBe("KEYCLOAK_ADMIN_UNAUTHORIZED");
    expect(error.message).toMatch(/manage-realm/);
  });

  it("maps 400 to a caller-actionable rejection and 500 to unavailable", async () => {
    expect((await codeFor(() => Response.json({ errorMessage: "bad" }, { status: 400 }))).code).toBe(
      "KEYCLOAK_ADMIN_REJECTED",
    );
    expect((await codeFor(() => new Response("boom", { status: 500 }))).code).toBe(
      "KEYCLOAK_ADMIN_UNAVAILABLE",
    );
  });

  it("reports its own error family for a rejected credential, not the SPI's", async () => {
    // The token provider is shared with the SPI client, so it is handed the
    // caller's error constructors. A credential failure on this path must not
    // come back wearing a KEYCLOAK_SPI_ code that maps to a different remedy.
    const { fetch } = stubFetch({
      token: () => Response.json({ error: "unauthorized_client" }, { status: 401 }),
    });
    const error = (await createKeycloakOrganizationAdminClient(config, { fetch })
      .getOrganization("acme")
      .catch((caught: unknown) => caught)) as KeycloakAdminError;

    expect(error.code).toBe("KEYCLOAK_ADMIN_UNAUTHORIZED");
    expect(error.message).toContain("unauthorized_client");
  });

  it("drops the cached token on a 401 so a rotation is picked up", async () => {
    const { fetch, calls } = stubFetch({
      admin: [
        () => Response.json({ error: "expired" }, { status: 401 }),
        () => Response.json(representation(true)),
      ],
    });
    const client = createKeycloakOrganizationAdminClient(config, { fetch });

    await client.getOrganization("acme").catch(() => undefined);
    await client.getOrganization("acme");

    expect(calls.filter((call) => call.url.includes("/token")).length).toBe(2);
  });
});

describe("per-organization identity provider linking", () => {
  it("links an alias with a JSON-quoted string body on the native endpoint", async () => {
    // Verified against a running Keycloak 26.5.3: a bare unquoted alias with
    // text/plain answers 415; the JSON-quoted string with application/json
    // (the request() default) is what actually links it (204).
    const { fetch, calls } = stubFetch({ admin: [() => new Response(null, { status: 204 })] });
    await createKeycloakOrganizationAdminClient(config, { fetch }).linkIdentityProvider(
      "acme",
      "google-workspace",
    );

    const call = calls[1]!;
    expect(call.url).toBe(
      "http://keycloak.test:8080/admin/realms/openshapeforge/organizations/acme/identity-providers",
    );
    expect(call.init.method).toBe("POST");
    expect(call.init.body).toBe(JSON.stringify("google-workspace"));
    expect((call.init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("lists the identity providers linked to one organization", async () => {
    const { fetch, calls } = stubFetch({
      admin: [
        () =>
          Response.json([
            { alias: "google-workspace", providerId: "google", enabled: true },
          ]),
      ],
    });
    const idps = await createKeycloakOrganizationAdminClient(config, { fetch }).listIdentityProviders(
      "acme",
    );

    expect(calls[1]!.url).toBe(
      "http://keycloak.test:8080/admin/realms/openshapeforge/organizations/acme/identity-providers",
    );
    expect(idps).toEqual([{ alias: "google-workspace", providerId: "google", enabled: true }]);
  });

  it("does not confuse one organization's linked providers with another's", async () => {
    // Two independent stubs standing in for two organizations; the point is
    // that listIdentityProviders addresses each by its OWN organization id in
    // the URL, so nothing here could accidentally return the other's aliases.
    const acme = stubFetch({
      admin: [() => Response.json([{ alias: "google-workspace", providerId: "google" }])],
    });
    const other = stubFetch({ admin: [() => Response.json([])] });

    const acmeIdps = await createKeycloakOrganizationAdminClient(config, {
      fetch: acme.fetch,
    }).listIdentityProviders("acme");
    const otherIdps = await createKeycloakOrganizationAdminClient(config, {
      fetch: other.fetch,
    }).listIdentityProviders("other-tenant");

    expect(acmeIdps.map((idp) => idp.alias)).toEqual(["google-workspace"]);
    expect(otherIdps).toEqual([]);
  });

  it("unlinks an alias with a DELETE to the aliased sub-resource", async () => {
    const { fetch, calls } = stubFetch({ admin: [() => new Response(null, { status: 204 })] });
    await createKeycloakOrganizationAdminClient(config, { fetch }).unlinkIdentityProvider(
      "acme",
      "google-workspace",
    );

    expect(calls[1]!.url).toBe(
      "http://keycloak.test:8080/admin/realms/openshapeforge/organizations/acme/" +
        "identity-providers/google-workspace",
    );
    expect(calls[1]!.init.method).toBe("DELETE");
  });

  it("treats unlinking an already-unlinked alias as a no-op, not an error", async () => {
    const { fetch } = stubFetch({
      admin: [() => Response.json({ error: "not found" }, { status: 404 })],
    });
    await expect(
      createKeycloakOrganizationAdminClient(config, { fetch }).unlinkIdentityProvider(
        "acme",
        "never-linked",
      ),
    ).resolves.toBeUndefined();
  });
});
