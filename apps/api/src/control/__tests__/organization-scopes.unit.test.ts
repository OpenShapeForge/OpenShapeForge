// SPDX-License-Identifier: BUSL-1.1
/**
 * The per-organization MCP audience scope, against an in-memory Keycloak and a
 * stub fetch.
 *
 * What is pinned, in order of how badly it fails if it regresses:
 *   1. a fresh Organization gets a scope with one audience per origin, attached
 *      to every configured client and to the realm default optional scopes;
 *   2. a replay of a converged scope WRITES NOTHING — provisioning replays and
 *      reconciliation both depend on that being literally true;
 *   3. an origin change converges: the stale mapper goes, the new one comes,
 *      the unchanged one is left alone;
 *   4. a scope whose Organization is gone is removed, and NOT removed when the
 *      listing that would prove it gone was truncated;
 *   5. the read-only comparison names exactly what the reconcile would change;
 *   6. a 403 from the admin API names `manage-clients`, because `manage-realm`
 *      alone is the deployment fault that produces it;
 *   7. the scope is added to the realm's anonymous `Allowed Client Scopes`
 *      client-registration policy without disturbing what is already allowed,
 *      because a self-registering MCP client is refused otherwise — and a realm
 *      with no such policy is a no-op, not a failure.
 *
 * Run (cwd apps/api):
 *   set -o pipefail; bun test src/control/__tests__/organization-scopes.unit.test.ts 2>&1
 */
import { describe, expect, it } from "bun:test";
import { fakeOrganizationScopes } from "../../db/__tests__/__fixtures__/control-keycloak-fakes.js";
import { KeycloakAdminError } from "../keycloak-organization-admin.js";
import type { KeycloakServiceAccountConfig } from "../keycloak-service-account.js";
import {
  organizationResourceScopeNames,
  organizationResourceScopes,
} from "../../mcp/organization-resource.js";
import {
  ALLOWED_CLIENT_SCOPES_CONFIG,
  compareOrganizationScopes,
  createOrganizationScopeAdminClient,
  ensureOrganizationScope,
  organizationAliasOfScope,
  reconcileOrganizationScopes,
  resourceAudience,
  type OrganizationScopeSettings,
} from "../organization-scopes.js";

const settings: OrganizationScopeSettings = {
  origins: ["http://127.0.0.1:3361", "https://api.example.com"],
  clients: ["codex", "openshapeforge-gateway", "openshapeforge-inspector", "absent-client"],
};

const audiences = (alias: string, origins = settings.origins) =>
  origins.map((origin) => resourceAudience(origin, alias)).sort();

describe("ensureOrganizationScope", () => {
  it("creates the scope, its audience mappers, and attaches it everywhere", async () => {
    const keycloak = fakeOrganizationScopes();

    const state = await ensureOrganizationScope(keycloak, "acme", settings);

    expect(state.scope).toBe("mcp-resource:acme");
    expect(state.audiences).toEqual([
      "http://127.0.0.1:3361/api/mcp/organizations/acme",
      "https://api.example.com/api/mcp/organizations/acme",
    ]);
    expect(state.actions.map((action) => action.kind)).toEqual([
      "SCOPE_CREATED",
      "AUDIENCE_ADDED",
      "AUDIENCE_ADDED",
      "CLIENT_ATTACHED",
      "CLIENT_ATTACHED",
      "CLIENT_ATTACHED",
      "REALM_ATTACHED",
      "POLICY_ALLOWED",
      "POLICY_ALLOWED",
    ]);
    expect(state.registrationPolicyPresent).toBe(true);
    expect(keycloak.audiencesOf("mcp-resource:acme")).toEqual(audiences("acme"));
    for (const clientId of ["codex", "openshapeforge-gateway", "openshapeforge-inspector"]) {
      expect(keycloak.clients.get(clientId)!.optionalScopes).toEqual(["mcp-resource:acme"]);
    }
    expect(keycloak.realm.optionalScopes).toEqual(["mcp-resource:acme"]);
    // The client the realm does not have is skipped, not an error and not created.
    expect(keycloak.clients.has("absent-client")).toBe(false);
  });

  it("writes nothing on a replay of a converged scope", async () => {
    const keycloak = fakeOrganizationScopes();
    await ensureOrganizationScope(keycloak, "acme", settings);
    const writesBefore = keycloak.writes.length;

    const replay = await ensureOrganizationScope(keycloak, "acme", settings);

    expect(replay.actions).toEqual([]);
    expect(keycloak.writes.length).toBe(writesBefore);
    // Trailing slashes and duplicates in the settings do not count as a change.
    const noisy = await ensureOrganizationScope(keycloak, "acme", {
      origins: ["http://127.0.0.1:3361/", "https://api.example.com", "https://api.example.com/"],
      clients: [" codex ", "openshapeforge-gateway", "openshapeforge-inspector", "codex"],
    });
    expect(noisy.actions).toEqual([]);
    expect(keycloak.writes.length).toBe(writesBefore);
  });

  it("reconciles the audience mappers when the origins change", async () => {
    const keycloak = fakeOrganizationScopes();
    await ensureOrganizationScope(keycloak, "acme", settings);

    const changed = await ensureOrganizationScope(keycloak, "acme", {
      ...settings,
      origins: ["https://api.example.com", "https://ingress-2.example.com"],
    });

    expect(changed.actions).toEqual([
      {
        kind: "AUDIENCE_REMOVED",
        scope: "mcp-resource:acme",
        subject: "http://127.0.0.1:3361/api/mcp/organizations/acme",
      },
      {
        kind: "AUDIENCE_ADDED",
        scope: "mcp-resource:acme",
        subject: "https://ingress-2.example.com/api/mcp/organizations/acme",
      },
    ]);
    expect(keycloak.audiencesOf("mcp-resource:acme")).toEqual([
      "https://api.example.com/api/mcp/organizations/acme",
      "https://ingress-2.example.com/api/mcp/organizations/acme",
    ]);
  });

  it("replaces a duplicate mapper and one that does not land in the access token", async () => {
    const keycloak = fakeOrganizationScopes();
    await ensureOrganizationScope(keycloak, "acme", settings);
    const scope = keycloak.scopeNamed("mcp-resource:acme")!;
    const [firstId, first] = [...scope.mappers.entries()][0]!;
    // A hand-edited mapper: right audience, id token only.
    scope.mappers.set(firstId, { ...first, accessTokenClaim: false });
    // And a duplicate of the other one.
    const second = [...scope.mappers.values()][1]!;
    scope.mappers.set("dup", { ...second });

    const repaired = await ensureOrganizationScope(keycloak, "acme", settings);

    expect(repaired.actions.map((action) => action.kind).sort()).toEqual([
      "AUDIENCE_ADDED",
      "AUDIENCE_REMOVED",
      "AUDIENCE_REMOVED",
    ]);
    expect(keycloak.audiencesOf("mcp-resource:acme")).toEqual(audiences("acme"));
    expect(scope.mappers.size).toBe(2);
  });

  it("leaves a scope a client holds as DEFAULT alone", async () => {
    const keycloak = fakeOrganizationScopes();
    keycloak.clients.get("codex")!.defaultScopes.push("mcp-resource:acme");
    keycloak.realm.defaultScopes.push("mcp-resource:acme");

    const state = await ensureOrganizationScope(keycloak, "acme", settings);

    expect(state.actions.map((action) => action.kind)).toEqual([
      "SCOPE_CREATED",
      "AUDIENCE_ADDED",
      "AUDIENCE_ADDED",
      "CLIENT_ATTACHED",
      "CLIENT_ATTACHED",
      "POLICY_ALLOWED",
      "POLICY_ALLOWED",
    ]);
    expect(keycloak.clients.get("codex")!.optionalScopes).toEqual([]);
    expect(keycloak.realm.optionalScopes).toEqual([]);
  });
});

describe("reconcileOrganizationScopes", () => {
  it("ensures every listed Organization and removes the scope of one that is gone", async () => {
    const keycloak = fakeOrganizationScopes();
    await ensureOrganizationScope(keycloak, "old-name", settings);
    await ensureOrganizationScope(keycloak, "acme", settings);
    // A scope that is not this module's is never touched.
    await keycloak.createClientScope({ name: "profile", description: "" });

    const result = await reconcileOrganizationScopes(
      keycloak,
      { aliases: ["acme", "beta"], removeOrphans: true },
      settings,
    );

    expect(result.removed).toEqual(["mcp-resource:old-name"]);
    expect(result.states.map((state) => state.scope)).toEqual([
      "mcp-resource:acme",
      "mcp-resource:beta",
    ]);
    expect(result.actions.filter((action) => action.scope === "mcp-resource:acme")).toEqual([]);
    expect(keycloak.scopeNamed("mcp-resource:old-name")).toBeUndefined();
    expect(keycloak.scopeNamed("profile")).toBeDefined();
    expect(keycloak.audiencesOf("mcp-resource:beta")).toEqual(audiences("beta"));
    // Deleting the scope detached it everywhere, as Keycloak does.
    expect(keycloak.clients.get("codex")!.optionalScopes).toEqual([
      "mcp-resource:acme",
      "mcp-resource:beta",
    ]);

    // And a second run over the converged realm is a genuine no-op.
    const writes = keycloak.writes.length;
    const again = await reconcileOrganizationScopes(
      keycloak,
      { aliases: ["acme", "beta"], removeOrphans: true },
      settings,
    );
    expect(again.actions).toEqual([]);
    expect(keycloak.writes.length).toBe(writes);
  });

  it("removes no scope when the Organization listing was truncated", async () => {
    const keycloak = fakeOrganizationScopes();
    await ensureOrganizationScope(keycloak, "unlisted", settings);

    const result = await reconcileOrganizationScopes(
      keycloak,
      { aliases: ["acme"], removeOrphans: false },
      settings,
    );

    expect(result.removed).toEqual([]);
    expect(keycloak.scopeNamed("mcp-resource:unlisted")).toBeDefined();
    expect(keycloak.scopeNamed("mcp-resource:acme")).toBeDefined();
  });
});

describe("compareOrganizationScopes", () => {
  it("names exactly what a reconcile would change", async () => {
    const keycloak = fakeOrganizationScopes();
    await ensureOrganizationScope(keycloak, "acme", settings);
    await ensureOrganizationScope(keycloak, "old-name", settings);
    await ensureOrganizationScope(keycloak, "stale", {
      ...settings,
      origins: ["http://127.0.0.1:3121"],
    });
    keycloak.clients.get("codex")!.optionalScopes = keycloak.clients
      .get("codex")!
      .optionalScopes.filter((name) => name !== "mcp-resource:acme");

    const drift = await compareOrganizationScopes(
      keycloak,
      { aliases: ["acme", "missing", "stale"], removeOrphans: true },
      settings,
    );

    expect(drift.map((item) => [item.code, item.scope])).toEqual([
      ["ORGANIZATION_SCOPE_ORPHANED", "mcp-resource:old-name"],
      ["ORGANIZATION_SCOPE_NOT_ATTACHED", "mcp-resource:acme"],
      ["ORGANIZATION_SCOPE_MISSING", "mcp-resource:missing"],
      ["ORGANIZATION_SCOPE_AUDIENCE_MISMATCH", "mcp-resource:stale"],
    ]);
    expect(drift[1]!.actual).toBe("codex");
    expect(drift[3]!.expected).toBe(audiences("stale").join(" "));
    expect(drift[3]!.actual).toBe("http://127.0.0.1:3121/api/mcp/organizations/stale");

    await reconcileOrganizationScopes(
      keycloak,
      { aliases: ["acme", "missing", "stale"], removeOrphans: true },
      settings,
    );
    expect(
      await compareOrganizationScopes(
        keycloak,
        { aliases: ["acme", "missing", "stale"], removeOrphans: true },
        settings,
      ),
    ).toEqual([]);
  });
});

describe("the client-registration allow-list", () => {
  it("appends the scopes a self-registering client needs and keeps what was allowed", async () => {
    const keycloak = fakeOrganizationScopes();

    const state = await ensureOrganizationScope(keycloak, "acme", settings);

    // Appended, never rewritten: `openid` and `offline_access` are the realm's
    // own policy, and dropping them would break every other client that
    // registers itself.
    expect(keycloak.allowedClientScopes()).toEqual([
      "openid",
      "offline_access",
      "organization",
      "mcp-resource:acme",
    ]);
    expect(
      state.actions.filter((action) => action.kind === "POLICY_ALLOWED"),
    ).toEqual([
      { kind: "POLICY_ALLOWED", scope: "mcp-resource:acme", subject: "organization" },
      { kind: "POLICY_ALLOWED", scope: "mcp-resource:acme", subject: "mcp-resource:acme" },
    ]);
    // Only the one key is written; `allow-default-scopes` survives the update.
    expect(keycloak.policy!.config["allow-default-scopes"]).toEqual(["true"]);
  });

  it("allows exactly the client scopes the protected-resource metadata advertises", () => {
    // The allow-list is derived from `scopes_supported`, not written out twice.
    // `organization:<alias>` is the one member Keycloak stores under another
    // name — the client scope it instantiates — because a registration policy
    // entry has to name a client scope that exists.
    expect(organizationResourceScopes("acme")).toEqual([
      "organization:acme",
      "mcp-resource:acme",
    ]);
    expect(organizationResourceScopeNames("acme")).toEqual(["organization", "mcp-resource:acme"]);
    expect(organizationResourceScopeNames("acme")).toHaveLength(
      organizationResourceScopes("acme").length,
    );
  });

  it("adds `organization` once, however many Organizations the realm has", async () => {
    const keycloak = fakeOrganizationScopes();

    await reconcileOrganizationScopes(
      keycloak,
      { aliases: ["acme", "beta", "gamma"], removeOrphans: true },
      settings,
    );

    expect(keycloak.allowedClientScopes()).toEqual([
      "openid",
      "offline_access",
      "organization",
      "mcp-resource:acme",
      "mcp-resource:beta",
      "mcp-resource:gamma",
    ]);
  });

  it("writes nothing when every wanted entry is already allowed", async () => {
    const keycloak = fakeOrganizationScopes();
    await ensureOrganizationScope(keycloak, "acme", settings);
    const writesBefore = keycloak.writes.length;

    const replay = await ensureOrganizationScope(keycloak, "acme", settings);

    expect(replay.actions).toEqual([]);
    expect(keycloak.writes.length).toBe(writesBefore);
  });

  it("skips an entry the realm has no client scope for, rather than failing the write", async () => {
    // A realm without the organizations feature: `organization` does not exist,
    // and Keycloak would refuse the WHOLE list if it were sent. The scope this
    // module owns is still allowed.
    const keycloak = fakeOrganizationScopes({ realmScopes: ["offline_access"] });

    const state = await ensureOrganizationScope(keycloak, "acme", settings);

    expect(keycloak.allowedClientScopes()).toEqual([
      "openid",
      "offline_access",
      "mcp-resource:acme",
    ]);
    expect(state.registrationPolicyPresent).toBe(true);
  });

  it("is a documented no-op in a realm with no client-registration policy", async () => {
    const keycloak = fakeOrganizationScopes({ policy: null });

    const state = await ensureOrganizationScope(keycloak, "acme", settings);

    // Everything else still happens; only the allow-list step is skipped, and
    // the caller can see that it was.
    expect(state.registrationPolicyPresent).toBe(false);
    expect(state.actions.some((action) => action.kind === "POLICY_ALLOWED")).toBe(false);
    expect(keycloak.audiencesOf("mcp-resource:acme")).toEqual(audiences("acme"));
    // And no finding, because there is nothing a re-apply could repair.
    const drift = await compareOrganizationScopes(
      keycloak,
      { aliases: ["acme"], removeOrphans: true },
      settings,
    );
    expect(drift).toEqual([]);
    const reconciled = await reconcileOrganizationScopes(
      keycloak,
      { aliases: ["acme"], removeOrphans: true },
      settings,
    );
    expect(reconciled.registrationPolicyPresent).toBe(false);
  });

  it("reports a scope that is allowed nowhere, and the re-apply closes it", async () => {
    const keycloak = fakeOrganizationScopes();
    await ensureOrganizationScope(keycloak, "acme", settings);
    // The realm as it is before this module owned the list: the scope exists
    // and is attached, but a dynamically registering client may not ask for it.
    keycloak.policy!.config[ALLOWED_CLIENT_SCOPES_CONFIG] = ["openid", "offline_access"];

    const drift = await compareOrganizationScopes(
      keycloak,
      { aliases: ["acme"], removeOrphans: true },
      settings,
    );

    expect(drift.map((item) => [item.code, item.scope])).toEqual([
      ["ORGANIZATION_SCOPE_NOT_REGISTRABLE", "mcp-resource:acme"],
    ]);
    expect(drift[0]!.expected).toBe("organization mcp-resource:acme");
    expect(drift[0]!.actual).toBe("organization mcp-resource:acme");
    expect(drift[0]!.message).toContain("insufficient_scope");

    await reconcileOrganizationScopes(
      keycloak,
      { aliases: ["acme"], removeOrphans: true },
      settings,
    );

    expect(keycloak.allowedClientScopes()).toEqual([
      "openid",
      "offline_access",
      "organization",
      "mcp-resource:acme",
    ]);
    expect(
      await compareOrganizationScopes(
        keycloak,
        { aliases: ["acme"], removeOrphans: true },
        settings,
      ),
    ).toEqual([]);
  });

  it("revokes an orphan entry and leaves every other entry alone", async () => {
    const keycloak = fakeOrganizationScopes();
    await ensureOrganizationScope(keycloak, "acme", settings);
    await ensureOrganizationScope(keycloak, "old-name", settings);

    const drift = await compareOrganizationScopes(
      keycloak,
      { aliases: ["acme"], removeOrphans: true },
      settings,
    );
    // One finding for the orphan, naming both places it survives.
    expect(drift.map((item) => item.code)).toEqual(["ORGANIZATION_SCOPE_ORPHANED"]);
    expect(drift[0]!.message).toContain('anonymous "Allowed Client Scopes" policy');

    const result = await reconcileOrganizationScopes(
      keycloak,
      { aliases: ["acme"], removeOrphans: true },
      settings,
    );

    expect(result.actions).toContainEqual({
      kind: "POLICY_REVOKED",
      scope: "mcp-resource:old-name",
      subject: null,
    });
    // `organization` is shared and is NOT this module's to revoke.
    expect(keycloak.allowedClientScopes()).toEqual([
      "openid",
      "offline_access",
      "organization",
      "mcp-resource:acme",
    ]);
  });

  it("leaves an allow-list entry alone when the listing that would prove it orphaned was truncated", async () => {
    const keycloak = fakeOrganizationScopes();
    await ensureOrganizationScope(keycloak, "unlisted", settings);

    await reconcileOrganizationScopes(
      keycloak,
      { aliases: ["acme"], removeOrphans: false },
      settings,
    );

    expect(keycloak.allowedClientScopes()).toContain("mcp-resource:unlisted");
  });
});

describe("organizationAliasOfScope", () => {
  it("parses the alias off a scope this module owns and nothing else", () => {
    expect(organizationAliasOfScope("mcp-resource:acme")).toBe("acme");
    expect(organizationAliasOfScope("mcp-resource:acme--550e8400-e29b-41d4")).toBe(
      "acme--550e8400-e29b-41d4",
    );
    expect(organizationAliasOfScope("organization:acme")).toBeNull();
    expect(organizationAliasOfScope("mcp-resource:")).toBeNull();
    expect(organizationAliasOfScope("mcp-resource:not/an/alias")).toBeNull();
  });
});

describe("the admin client", () => {
  const config: KeycloakServiceAccountConfig = {
    baseUrl: "http://keycloak.test:8080",
    tenantRealm: "openshapeforge",
    clientId: "openshapeforge-auth-api",
    clientSecret: "s3cret",
  };

  function stubFetch(handle: (url: string, init: RequestInit) => Response) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetch = (async (input: unknown, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/protocol/openid-connect/token")) {
        return Response.json({ access_token: "service-account-token", expires_in: 900 });
      }
      return handle(url, init);
    }) as unknown as typeof globalThis.fetch;
    return { fetch, calls };
  }

  it("creates a scope and reads its id off the Location header", async () => {
    const { fetch, calls } = stubFetch((url, init) => {
      if (init.method === "POST" && url.endsWith("/client-scopes")) {
        return new Response(null, {
          status: 201,
          headers: { location: `${url}/9c1a2b3c-scope` },
        });
      }
      throw new Error(`unexpected ${init.method} ${url}`);
    });

    const scope = await createOrganizationScopeAdminClient(config, { fetch }).createClientScope({
      name: "mcp-resource:acme",
      description: "d",
    });

    expect(scope).toEqual({ id: "9c1a2b3c-scope", name: "mcp-resource:acme" });
    // The token grant is a POST too; the create is the one on the admin path.
    const create = calls.find(
      (call) => call.init.method === "POST" && call.url.endsWith("/client-scopes"),
    )!;
    expect(create.url).toBe(
      "http://keycloak.test:8080/admin/realms/openshapeforge/client-scopes",
    );
    expect((create.init.headers as Record<string, string>).authorization).toBe(
      "Bearer service-account-token",
    );
    const body = JSON.parse(String(create.init.body)) as {
      attributes: Record<string, string>;
    };
    expect(body.attributes["include.in.token.scope"]).toBe("true");
    expect(body.attributes["display.on.consent.screen"]).toBe("false");
    expect(body.attributes["include.in.openid.provider.metadata"]).toBe("false");
  });

  it("reads audience mappers and ignores every other mapper type", async () => {
    const { fetch } = stubFetch(() =>
      Response.json([
        {
          id: "m1",
          protocolMapper: "oidc-audience-mapper",
          config: {
            "included.custom.audience": "http://127.0.0.1:3361/api/mcp/organizations/acme",
            "access.token.claim": "true",
          },
        },
        { id: "m2", protocolMapper: "oidc-hardcoded-claim-mapper", config: {} },
        {
          id: "m3",
          protocolMapper: "oidc-audience-mapper",
          config: { "included.client.audience": "erp-provider", "access.token.claim": "false" },
        },
      ]),
    );

    const mappers = await createOrganizationScopeAdminClient(config, {
      fetch,
    }).listAudienceMappers("sid");

    expect(mappers).toEqual([
      {
        id: "m1",
        audience: "http://127.0.0.1:3361/api/mcp/organizations/acme",
        accessTokenClaim: true,
      },
      { id: "m3", audience: null, accessTokenClaim: false },
    ]);
  });

  it("finds a client by exact clientId and addresses the attach by its uuid", async () => {
    const { fetch, calls } = stubFetch((url, init) => {
      if (url.includes("/clients?clientId=codex")) {
        return Response.json([
          {
            id: "codex-uuid",
            clientId: "codex",
            defaultClientScopes: ["profile"],
            optionalClientScopes: ["mcp-resource:acme"],
          },
        ]);
      }
      if (init.method === "PUT") return new Response(null, { status: 204 });
      throw new Error(`unexpected ${init.method} ${url}`);
    });
    const client = createOrganizationScopeAdminClient(config, { fetch });

    const found = await client.findClient("codex");
    expect(found).toEqual({
      id: "codex-uuid",
      clientId: "codex",
      defaultClientScopes: ["profile"],
      optionalClientScopes: ["mcp-resource:acme"],
    });
    await client.addOptionalClientScope("codex-uuid", "scope-uuid");
    expect(calls.at(-1)!.url).toBe(
      "http://keycloak.test:8080/admin/realms/openshapeforge/clients/codex-uuid/optional-client-scopes/scope-uuid",
    );
    expect(calls.at(-1)!.init.method).toBe("PUT");
  });

  it("picks the anonymous allowed-client-templates component out of the policies", async () => {
    const { fetch, calls } = stubFetch((url) => {
      if (url.includes("/components?type=")) {
        return Response.json([
          // Same provider, other subType — governs authenticated updates, not
          // anonymous registration, and is not this module's to edit.
          {
            id: "authenticated-id",
            providerId: "allowed-client-templates",
            subType: "authenticated",
            config: { "allowed-client-scopes": ["everything"] },
          },
          // Same subType, other provider.
          { id: "hosts-id", providerId: "trusted-hosts", subType: "anonymous", config: {} },
          {
            id: "anonymous-id",
            providerId: "allowed-client-templates",
            subType: "anonymous",
            config: {
              "allow-default-scopes": ["true"],
              "allowed-client-scopes": ["openid", "offline_access"],
            },
          },
        ]);
      }
      throw new Error(`unexpected ${url}`);
    });

    const policy = await createOrganizationScopeAdminClient(config, {
      fetch,
    }).findRegistrationPolicy();

    expect(policy).toEqual({ id: "anonymous-id", allowedScopes: ["openid", "offline_access"] });
    expect(calls.at(-1)!.url).toBe(
      "http://keycloak.test:8080/admin/realms/openshapeforge/components?type=" +
        encodeURIComponent(
          "org.keycloak.services.clientregistration.policy.ClientRegistrationPolicy",
        ),
    );
  });

  it("is null when the realm has no client-registration policy", async () => {
    const { fetch } = stubFetch(() => Response.json([]));

    expect(
      await createOrganizationScopeAdminClient(config, { fetch }).findRegistrationPolicy(),
    ).toBeNull();
  });

  it("rewrites only the allowed scopes and sends the component back whole", async () => {
    const component = {
      id: "anonymous-id",
      name: "Allowed Client Scopes",
      providerId: "allowed-client-templates",
      providerType: "org.keycloak.services.clientregistration.policy.ClientRegistrationPolicy",
      parentId: "realm-id",
      subType: "anonymous",
      config: {
        "allow-default-scopes": ["true"],
        "allowed-client-scopes": ["openid"],
      },
    };
    const { fetch, calls } = stubFetch((url, init) => {
      if (init.method === "GET" && url.endsWith("/components/anonymous-id")) {
        return Response.json(component);
      }
      if (init.method === "PUT") return new Response(null, { status: 204 });
      throw new Error(`unexpected ${init.method} ${url}`);
    });

    await createOrganizationScopeAdminClient(config, { fetch }).setRegistrationPolicyScopes(
      "anonymous-id",
      ["openid", "mcp-resource:acme"],
    );

    const put = calls.find((call) => call.init.method === "PUT")!;
    expect(put.url).toBe(
      "http://keycloak.test:8080/admin/realms/openshapeforge/components/anonymous-id",
    );
    // The update REPLACES the component, so everything that identifies it and
    // every other config key has to travel with the one changed list.
    expect(JSON.parse(String(put.init.body))).toEqual({
      ...component,
      config: {
        "allow-default-scopes": ["true"],
        "allowed-client-scopes": ["openid", "mcp-resource:acme"],
      },
    });
  });

  it("names manage-clients when the admin API refuses the service account", async () => {
    const { fetch } = stubFetch(() =>
      Response.json({ error: "HTTP 403 Forbidden" }, { status: 403 }),
    );

    const attempt = createOrganizationScopeAdminClient(config, { fetch }).listClientScopes();

    await expect(attempt).rejects.toBeInstanceOf(KeycloakAdminError);
    await attempt.catch((error: KeycloakAdminError) => {
      expect(error.code).toBe("KEYCLOAK_ADMIN_UNAUTHORIZED");
      expect(error.status).toBe(403);
      expect(error.message).toContain("manage-clients");
      expect(error.message).toContain("openshapeforge-auth-api");
    });
  });
});
