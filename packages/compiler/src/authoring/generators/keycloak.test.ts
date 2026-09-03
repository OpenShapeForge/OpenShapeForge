// SPDX-License-Identifier: BUSL-1.1
import { afterEach, describe, expect, it, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  generateAllKeycloakRealmArtifacts,
  generateKeycloakRealmArtifacts,
  isDevRealm,
  keycloakRealmOutputPath,
  normalizeKeycloakRoleName,
  resolveClientSecret,
} from "./keycloak.js";
import type { AuthorizationConfigFile } from "../types/authoring.js";
import type { CompiledEntityContract } from "../types/compiled.js";

function devConfig(
  overrides: Partial<AuthorizationConfigFile["keycloak"]> = {},
  realmOverrides: AuthorizationConfigFile["realm"] = {},
): AuthorizationConfigFile {
  return {
    schemaVersion: 2,
    kind: "authorizationConfig",
    realm: { name: "openshapeforge-dev", sslRequired: "none", ...realmOverrides },
    keycloak: {
      entityRoleClient: "erp-provider",
      clients: [
        {
          id: "gw",
          kind: "gateway",
          name: "Gateway",
          devSecret: "dev-secret",
          redirectUris: ["http://localhost:3001/*"],
          webOrigins: ["http://localhost:3001"],
        },
      ],
      ...overrides,
    },
  };
}

function gateway(config: AuthorizationConfigFile) {
  const artifacts = generateKeycloakRealmArtifacts([], config);
  const artifact = artifacts[0];
  if (!artifact) throw new Error("no realm artifact generated");
  const realm = JSON.parse(artifact.contents) as {
    clients: {
      clientId: string;
      redirectUris?: string[];
      webOrigins?: string[];
      secret?: string;
    }[];
  };
  return realm.clients.find((c) => c.clientId === "gw")!;
}

describe("keycloak realm generator — gateway redirect allow-list", () => {
  it("emits the explicit redirectUris/webOrigins from config", () => {
    const gw = gateway(devConfig());
    expect(gw.redirectUris).toEqual(["http://localhost:3001/*"]);
    expect(gw.webOrigins).toEqual(["http://localhost:3001"]);
  });

  it("throws when a gateway client has no redirectUris", () => {
    const config = devConfig({
      clients: [{ id: "gw", kind: "gateway", devSecret: "s", webOrigins: ["http://localhost:3001"] }],
    });
    expect(() => generateKeycloakRealmArtifacts([], config)).toThrow(/redirectUris must be an explicit allow-list/);
  });

  it("throws when redirectUris is empty", () => {
    const config = devConfig({
      clients: [
        { id: "gw", kind: "gateway", devSecret: "s", redirectUris: [], webOrigins: ["http://localhost:3001"] },
      ],
    });
    expect(() => generateKeycloakRealmArtifacts([], config)).toThrow(/redirectUris must be an explicit allow-list/);
  });

  it("allows a trailing path wildcard on a concrete origin", () => {
    const config = devConfig({
      clients: [
        {
          id: "gw",
          kind: "gateway",
          devSecret: "s",
          redirectUris: ["https://app.example.com/callback/*"],
          webOrigins: ["https://app.example.com"],
        },
      ],
    });
    expect(gateway(config).redirectUris).toEqual(["https://app.example.com/callback/*"]);
  });

  it("forbids a host wildcard redirectUri", () => {
    const config = devConfig({
      clients: [
        {
          id: "gw",
          kind: "gateway",
          devSecret: "s",
          redirectUris: ["https://*.example.com/*"],
          webOrigins: ["http://localhost:3001"],
        },
      ],
    });
    expect(() => generateKeycloakRealmArtifacts([], config)).toThrow(/open\/host wildcard, which is forbidden/);
  });

  it("forbids a bare wildcard redirectUri", () => {
    const config = devConfig({
      clients: [
        { id: "gw", kind: "gateway", devSecret: "s", redirectUris: ["*"], webOrigins: ["http://localhost:3001"] },
      ],
    });
    expect(() => generateKeycloakRealmArtifacts([], config)).toThrow(/open\/host wildcard, which is forbidden/);
  });

  it("forbids a wildcard webOrigin", () => {
    const config = devConfig({
      clients: [
        { id: "gw", kind: "gateway", devSecret: "s", redirectUris: ["http://localhost:3001/*"], webOrigins: ["*"] },
      ],
    });
    expect(() => generateKeycloakRealmArtifacts([], config)).toThrow(/open\/host wildcard, which is forbidden/);
  });
});

describe("keycloak realm generator — secret handling", () => {
  it("keeps a devSecret on a dev realm", () => {
    expect(gateway(devConfig()).secret).toBe("dev-secret");
  });

  it("rejects a devSecret on a non-dev realm", () => {
    const config = devConfig({}, { name: "openshapeforge-prod", sslRequired: "all" });
    expect(() => generateKeycloakRealmArtifacts([], config, "production")).toThrow(
      /only a devSecret is configured/,
    );
  });

  it("rejects a literal secret on a non-dev realm", () => {
    const config = devConfig(
      {
        clients: [
          {
            id: "gw",
            kind: "gateway",
            secret: "literal",
            redirectUris: ["https://app.example.com/*"],
            webOrigins: ["https://app.example.com"],
          },
        ],
      },
      { name: "openshapeforge-prod", sslRequired: "all" },
    );
    expect(() => generateKeycloakRealmArtifacts([], config, "production")).toThrow(
      /literal client secret is committed for a non-dev realm/,
    );
  });
});

describe("isDevRealm", () => {
  it("follows the mode, defaulting to development", () => {
    expect(isDevRealm(undefined, "development")).toBe(true);
    expect(isDevRealm({ name: "anything", sslRequired: "all" }, "development")).toBe(true);
    expect(isDevRealm(undefined, "production")).toBe(false);
  });

  // Regression guard. The default realm name no longer ends in "-dev", so any
  // inference from the NAME would classify a production realm using the default
  // name as development and silently allow committed secrets to ship.
  it("does NOT infer development from the realm name", () => {
    expect(isDevRealm({ name: "openshapeforge" }, "production")).toBe(false);
    expect(isDevRealm({ name: "anything-dev" }, "production")).toBe(false);
  });

  // Likewise sslRequired: the authored config carries "none" for local work and
  // production mode overrides it, so reading the authored value would make
  // production classify itself as development.
  it("does NOT infer development from sslRequired", () => {
    expect(isDevRealm({ name: "x", sslRequired: "none" }, "production")).toBe(false);
  });
});

describe("resolveClientSecret — env references", () => {
  const KEY = "OSF_KEYCLOAK_TEST_SECRET";
  afterEach(() => {
    delete process.env[KEY];
  });

  it("resolves ${env:VAR} from the environment on any realm", () => {
    process.env[KEY] = "resolved-value";
    expect(resolveClientSecret({ id: "c", kind: "serviceAccount", secret: `\${env:${KEY}}` }, false)).toBe(
      "resolved-value",
    );
  });

  it("uses the ${env:VAR:-fallback} default when unset, in DEVELOPMENT only", () => {
    expect(resolveClientSecret({ id: "c", kind: "serviceAccount", secret: `\${env:${KEY}:-fb}` }, true)).toBe("fb");
  });

  // The fallback is a literal written in the repository. Substituting it for a
  // production realm would ship the very credential the env indirection exists
  // to avoid, while looking configured — so an unset variable is an error there
  // even when a fallback is present.
  it("refuses to fall back to the committed default for a production realm", () => {
    expect(() =>
      resolveClientSecret({ id: "c", kind: "serviceAccount", secret: `\${env:${KEY}:-fb}` }, false),
    ).toThrow(/development-only and will not be used for a production realm/);
  });

  it("throws when an env ref is unset and has no fallback", () => {
    expect(() => resolveClientSecret({ id: "c", kind: "serviceAccount", secret: `\${env:${KEY}}` }, false)).toThrow(
      /is not set and no/,
    );
  });
});

function entityWithReadRoles(
  name: string,
  slug: string,
  readRoles: string[],
): CompiledEntityContract {
  return {
    entity: { name },
    authorization: {
      entitySlug: slug,
      roles: { read: readRoles, create: [], update: [], delete: [] },
      compositeRoles: [],
      fieldAuthorizations: [],
      profileAuthorizations: {},
    },
  } as unknown as CompiledEntityContract;
}

const authConfig = {
  keycloak: { entityRoleClient: "erp-provider" },
} as never;

describe("normalizeKeycloakRoleName", () => {
  it("rewrites known Dutch segments to their canonical English form", () => {
    expect(normalizeKeycloakRoleName("Vastgoed.All.Read")).toBe("RealEstate.All.Read");
  });
});

describe("generateKeycloakRealmArtifacts role-name collisions", () => {
  it("fails when two distinct authored roles normalize to the same name", () => {
    const contracts = [
      entityWithReadRoles("RealEstateEn", "real-estate-en", ["RealEstate.All.Read"]),
      entityWithReadRoles("RealEstateNl", "real-estate-nl", ["Vastgoed.All.Read"]),
    ];
    expect(() => generateKeycloakRealmArtifacts(contracts, authConfig)).toThrow(
      /role-name collision/i,
    );
  });

  it("does not fail when the same authored role name repeats across entities", () => {
    const contracts = [
      entityWithReadRoles("A", "a", ["Vastgoed.All.Read"]),
      entityWithReadRoles("B", "b", ["Vastgoed.All.Read"]),
    ];
    expect(() => generateKeycloakRealmArtifacts(contracts, authConfig)).not.toThrow();
  });

  it("fails on collisions declared via authConfig.clientRoles", () => {
    const config = {
      keycloak: { entityRoleClient: "erp-provider" },
      clientRoles: {
        "erp-provider": ["Vastgoed.All.Read", "RealEstate.All.Read"],
      },
    } as never;
    // Include an entity so a realm is actually emitted (the generator returns
    // early when there are no clients and no entity roles).
    const contracts = [entityWithReadRoles("A", "a", ["Cases.All.Read"])];
    expect(() => generateKeycloakRealmArtifacts(contracts, config)).toThrow(
      /role-name collision/i,
    );
  });
});

// A dev realm (name suffixed "-dev"), so authoring a literal client secret in
// these fixtures is permitted by the generator's non-dev-realm secret guard.
// The intent here is to verify synthetic service-account emission, not secret
// hardening (which has dedicated coverage above).
function baseConfig(): AuthorizationConfigFile {
  return {
    schemaVersion: 2,
    kind: "authorizationConfig",
    realm: { name: "test-realm-dev" },
    keycloak: { entityRoleClient: "erp-provider", clients: [] },
  };
}

function realmFrom(config: AuthorizationConfigFile) {
  const artifacts = generateKeycloakRealmArtifacts([], config);
  expect(artifacts).toHaveLength(1);
  return JSON.parse(artifacts[0]!.contents) as {
    users: Array<{
      username: string;
      serviceAccountClientId?: string;
      clientRoles?: Record<string, string[]>;
      credentials?: unknown;
    }>;
  };
}

describe("service-account client role grants", () => {
  test("emits a synthetic service-account user carrying the realm-management role", () => {
    const config = baseConfig();
    config.keycloak.clients = [
      {
        id: "openshapeforge-auth-api",
        kind: "serviceAccount",
        name: "Auth API",
        secret: "secret",
        serviceAccountClientRoles: { "realm-management": ["manage-realm"] },
      },
    ];

    const realm = realmFrom(config);
    const svc = realm.users.find(
      (u) => u.serviceAccountClientId === "openshapeforge-auth-api",
    );
    expect(svc).toBeDefined();
    expect(svc!.username).toBe("service-account-openshapeforge-auth-api");
    expect(svc!.clientRoles).toEqual({ "realm-management": ["manage-realm"] });
    // Service accounts are not login users — they must carry no credentials.
    expect(svc!.credentials).toBeUndefined();
  });

  test("does not emit a service-account user when no roles are granted", () => {
    const config = baseConfig();
    config.keycloak.clients = [
      { id: "seed-service", kind: "serviceAccount", name: "Seed", secret: "s" },
    ];

    const realm = realmFrom(config);
    expect(realm.users.some((u) => u.serviceAccountClientId)).toBe(false);
  });
});

describe("generated dev realm", () => {
  test("openshapeforge-auth-api service account holds realm-management manage-realm", () => {
    const realmPath = join(
      import.meta.dir,
      "../../../../../keycloak/openshapeforge-realm.json",
    );
    const realm = JSON.parse(readFileSync(realmPath, "utf8")) as {
      users: Array<{
        serviceAccountClientId?: string;
        clientRoles?: Record<string, string[]>;
      }>;
    };
    const svc = realm.users.find(
      (u) => u.serviceAccountClientId === "openshapeforge-auth-api",
    );
    expect(svc).toBeDefined();
    expect(svc!.clientRoles?.["realm-management"]).toContain("manage-realm");
  });
});

// ---------------------------------------------------------------------------
// Multi-realm generation (#288)
// ---------------------------------------------------------------------------

describe("keycloakRealmOutputPath", () => {
  it("names the file after the realm", () => {
    expect(keycloakRealmOutputPath("openshapeforge")).toBe(
      "keycloak/openshapeforge-realm.json",
    );
    expect(keycloakRealmOutputPath("openshapeforge-control")).toBe(
      "keycloak/openshapeforge-control-realm.json",
    );
  });

  // The realm name is authored YAML spliced into an output path. Without this
  // the authoring decides where on disk the compiler writes — outside the one
  // root check:generated polices, where no gate can see it.
  it.each(["../escape", "a/b", "a\\b", ".hidden", "", "with space"])(
    "refuses %p as a filename segment",
    (name) => {
      expect(() => keycloakRealmOutputPath(name)).toThrow(
        /cannot be used as an output filename/,
      );
    },
  );
});

describe("realm-derived output path", () => {
  it("emits to the path named by the realm, not a fixed one", () => {
    const artifacts = generateKeycloakRealmArtifacts(
      [],
      devConfig({}, { name: "some-other-realm" }),
    );
    expect(artifacts.map((a) => a.path)).toEqual([
      "keycloak/some-other-realm-realm.json",
    ]);
  });

  it("falls back to the default realm name when none is authored", () => {
    const config = devConfig();
    delete config.realm;
    expect(generateKeycloakRealmArtifacts([], config)[0]!.path).toBe(
      "keycloak/openshapeforge-realm.json",
    );
  });
});

describe("generateAllKeycloakRealmArtifacts", () => {
  function controlConfig(): AuthorizationConfigFile {
    // Shaped like the real control realm: no entityRoleClient, one gateway.
    return {
      schemaVersion: 2,
      kind: "authorizationConfig",
      realm: { name: "openshapeforge-control", sslRequired: "none" },
      keycloak: {
        clients: [
          {
            id: "openshapeforge-admin-gateway",
            kind: "gateway",
            devSecret: "admin-dev-secret",
            redirectUris: ["http://localhost:3002/*"],
            webOrigins: ["http://localhost:3002"],
          },
        ],
      },
      realmRoles: { "platform-operator": { description: "Platform operator" } },
    };
  }

  it("emits one file per authored realm, from one pass over the contracts", () => {
    const contracts = [entityWithReadRoles("A", "a", ["Cases.All.Read"])];
    const artifacts = generateAllKeycloakRealmArtifacts(contracts, [
      devConfig({}, { name: "openshapeforge" }),
      controlConfig(),
    ]);

    expect(artifacts.map((a) => a.path)).toEqual([
      "keycloak/openshapeforge-realm.json",
      "keycloak/openshapeforge-control-realm.json",
    ]);
  });

  // The realms are generated from ONE list of compiled contracts. A realm that
  // names no entityRoleClient must take nothing from them — otherwise the
  // control realm ships the tenant realm's entity roles on a client it never
  // declares, and Keycloak's strict composite validation is the only thing
  // between that and a broken import.
  it("gives entity-derived roles only to the realm that names an entityRoleClient", () => {
    const contracts = [entityWithReadRoles("A", "a", ["Cases.All.Read"])];
    const [tenant, control] = generateAllKeycloakRealmArtifacts(contracts, [
      devConfig({}, { name: "openshapeforge" }),
      controlConfig(),
    ]).map((artifact) => JSON.parse(artifact.contents) as {
      realm: string;
      roles: { client: Record<string, unknown[]> };
    });

    expect(tenant!.realm).toBe("openshapeforge");
    expect(tenant!.roles.client["erp-provider"]).toHaveLength(1);
    expect(control!.realm).toBe("openshapeforge-control");
    expect(control!.roles.client).toEqual({});
  });

  // Same output path, so one would silently overwrite the other — handing a
  // realm another realm's clients, secrets and users.
  it("refuses two documents that declare the same realm", () => {
    expect(() =>
      generateAllKeycloakRealmArtifacts([], [devConfig(), devConfig()]),
    ).toThrow(/Two authorizationConfig documents declare realm "openshapeforge-dev"/);
  });

  it("skips a null/absent config without emitting anything for it", () => {
    const artifacts = generateAllKeycloakRealmArtifacts([], [null, controlConfig()]);
    expect(artifacts.map((a) => a.path)).toEqual([
      "keycloak/openshapeforge-control-realm.json",
    ]);
  });

  // The secret guard is per-realm and mode-driven, so making generation plural
  // must not let a second realm slip past it.
  it("still refuses a dev-only secret on a non-dev realm, for the second realm too", () => {
    expect(() =>
      generateAllKeycloakRealmArtifacts(
        [],
        [devConfig({}, { name: "tenant-prod" }), controlConfig()],
        "production",
      ),
    ).toThrow(/only a devSecret is configured/);
  });
});

describe("a realm that does not participate in entity role generation", () => {
  function noEntityClientConfig(
    realmRoles: AuthorizationConfigFile["realmRoles"] = {},
  ): AuthorizationConfigFile {
    return {
      schemaVersion: 2,
      kind: "authorizationConfig",
      realm: { name: "control-test" },
      keycloak: {
        clients: [{ id: "svc", kind: "serviceAccount", devSecret: "s" }],
      },
      realmRoles,
    };
  }

  it("emits no client roles even when contracts carry entity authorizations", () => {
    const contracts = [entityWithReadRoles("A", "a", ["Cases.All.Read"])];
    const realm = JSON.parse(
      generateKeycloakRealmArtifacts(contracts, noEntityClientConfig())[0]!.contents,
    ) as { roles: { client: Record<string, unknown[]> } };
    expect(realm.roles.client).toEqual({});
  });

  // `includes` expands entity-derived composites onto the entity-role client.
  // With no such client the pattern resolves to nothing, which would read as a
  // grant while conferring none — fail instead of emitting the empty composite.
  it("refuses a realm role that uses `includes`", () => {
    const config = noEntityClientConfig({
      operator: { description: "Operator", includes: ["*:full"] },
    });
    expect(() => generateKeycloakRealmArtifacts([], config)).toThrow(
      /uses `includes`.*authors no.*entityRoleClient/s,
    );
  });
});

describe("generated control realm", () => {
  const realm = JSON.parse(
    readFileSync(
      join(import.meta.dir, "../../../../../keycloak/openshapeforge-control-realm.json"),
      "utf8",
    ),
  ) as {
    realm: string;
    organizationsEnabled?: boolean;
    clients: Array<{ clientId: string; redirectUris?: string[]; webOrigins?: string[] }>;
    roles: { realm: Array<{ name: string }>; client: Record<string, unknown[]> };
    users: Array<{ username: string; attributes?: Record<string, string[]> }>;
  };

  test("is a separate realm carrying no entity-derived client roles", () => {
    expect(realm.realm).toBe("openshapeforge-control");
    expect(realm.roles.client).toEqual({});
  });

  test("declares the platform operator realm role", () => {
    expect(realm.roles.realm.map((r) => r.name)).toContain("platform-operator");
  });

  // Operators administer tenants; they are not IN one. A `tid` here would put a
  // control-plane identity inside a tenant's isolation boundary.
  test("holds no tenant users — no user carries a tid", () => {
    expect(realm.users.every((u) => u.attributes?.tid === undefined)).toBe(true);
  });

  test("exposes exactly one gateway client, with concrete local-dev origins", () => {
    expect(realm.clients).toHaveLength(1);
    const gw = realm.clients[0]!;
    expect(gw.clientId).toBe("openshapeforge-admin-gateway");
    for (const value of [...(gw.redirectUris ?? []), ...(gw.webOrigins ?? [])]) {
      expect(value.startsWith("http://localhost:")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// External identity providers (#488)
// ---------------------------------------------------------------------------

import { isSecretLikeConfigKey } from "./keycloak.js";
import type { AuthorizationIdentityProvider } from "../types/authoring.js";

type RealmWithIdps = {
  identityProviders?: Record<string, unknown>[];
  identityProviderMappers?: Record<string, unknown>[];
};

function idpConfig(
  identityProviders: AuthorizationIdentityProvider[],
  realmName = "openshapeforge-dev",
): AuthorizationConfigFile {
  return devConfig({ identityProviders }, { name: realmName });
}

function realmOf(config: AuthorizationConfigFile, mode: "development" | "production" = "development"): RealmWithIdps {
  const artifacts = generateKeycloakRealmArtifacts([], config, mode);
  const artifact = artifacts[0];
  if (!artifact) throw new Error("no realm artifact generated");
  return JSON.parse(artifact.contents) as RealmWithIdps;
}

/** A production-shaped config: env-referenced client secret, no devSecret. */
function prodIdpConfig(identityProviders: AuthorizationIdentityProvider[]): AuthorizationConfigFile {
  return {
    schemaVersion: 2,
    kind: "authorizationConfig",
    realm: { name: "openshapeforge", sslRequired: "external" },
    keycloak: {
      clients: [
        {
          id: "gw",
          kind: "gateway",
          secret: "${env:KC_TEST_GW_SECRET}",
          redirectUris: ["https://app.example/*"],
          webOrigins: ["https://app.example"],
        },
      ],
      identityProviders,
    },
  };
}

/** `def` without its `secrets`, for development-mode variants. */
function withoutSecrets(def: AuthorizationIdentityProvider): AuthorizationIdentityProvider {
  const { secrets: _secrets, ...rest } = def;
  return rest;
}

const DEDICATED_OIDC: AuthorizationIdentityProvider = {
  alias: "customer-workforce",
  providerId: "oidc",
  displayName: "Continue with company account",
  firstBrokerLoginFlowAlias: "first broker login",
  config: {
    clientId: "customer-workforce",
    issuer: "https://identity.customer.example",
    authorizationUrl: "https://identity.customer.example/oauth2/authorize",
    tokenUrl: "https://identity.customer.example/oauth2/token",
    jwksUrl: "https://identity.customer.example/.well-known/jwks.json",
    useJwksUrl: true,
    defaultScope: "openid profile email custom:workforce",
  },
  secrets: { clientSecret: "${env:KC_TEST_IDP_CUSTOMER_WORKFORCE_CLIENT_SECRET}" },
  mappers: [
    {
      name: "department",
      identityProviderMapper: "oidc-user-attribute-idp-mapper",
      config: { claim: "dept", "user.attribute": "department", syncMode: "FORCE" },
    },
  ],
};

describe("identity providers — default posture", () => {
  it("emits no identityProviders key at all when none is authored", () => {
    const realm = realmOf(devConfig());
    expect(realm.identityProviders).toBeUndefined();
    expect(realm.identityProviderMappers).toBeUndefined();
  });

  it("the shipped realms enable no external provider", () => {
    const { parse } = require("yaml") as { parse: (s: string) => AuthorizationConfigFile };
    for (const file of ["authorization.yaml", "authorization.control.yaml"]) {
      const authored = parse(readFileSync(join(import.meta.dir, "../../../config/authoring", file), "utf8"));
      expect(authored.keycloak?.identityProviders ?? []).toEqual([]);
      const realm = realmOf(authored);
      expect(realm.identityProviders).toBeUndefined();
    }
  });
});

describe("identity providers — built-in providers", () => {
  it.each(["google", "microsoft", "github"])(
    "emits a %s provider with exactly the authored config and no OSF-supplied endpoints",
    (providerId) => {
      const realm = realmOf(
        idpConfig([
          {
            alias: providerId,
            providerId,
            displayName: `Sign in with ${providerId}`,
            config: { clientId: `${providerId}-client-id`, defaultScope: "openid email" },
            devSecrets: { clientSecret: "dev-only" },
          },
        ]),
      );
      expect(realm.identityProviders).toEqual([
        {
          alias: providerId,
          displayName: `Sign in with ${providerId}`,
          providerId,
          enabled: true,
          trustEmail: false,
          storeToken: false,
          linkOnly: false,
          hideOnLogin: false,
          config: {
            clientId: `${providerId}-client-id`,
            defaultScope: "openid email",
            clientSecret: "dev-only",
          },
        },
      ]);
      expect(realm.identityProviderMappers).toEqual([]);
      // No endpoint the host did not write.
      const keys = Object.keys((realm.identityProviders![0] as { config: object }).config);
      expect(keys.some((k) => /url|issuer/i.test(k))).toBe(false);
    },
  );

  it("defaults enabled to true and the trust/store/link/hide flags to false, honouring explicit values", () => {
    const realm = realmOf(
      idpConfig([
        { alias: "a", providerId: "google", devSecrets: { clientSecret: "x" } },
        {
          alias: "b",
          providerId: "google",
          enabled: false,
          trustEmail: true,
          storeToken: true,
          linkOnly: true,
          hideOnLogin: true,
          devSecrets: { clientSecret: "x" },
        },
      ]),
    );
    const [a, b] = realm.identityProviders!;
    expect(a).toMatchObject({ enabled: true, trustEmail: false, storeToken: false, linkOnly: false, hideOnLogin: false });
    expect(b).toMatchObject({ enabled: false, trustEmail: true, storeToken: true, linkOnly: true, hideOnLogin: true });
  });
});

describe("identity providers — dedicated generic OIDC provider (host override)", () => {
  const ENV = "KC_TEST_IDP_CUSTOMER_WORKFORCE_CLIENT_SECRET";
  afterEach(() => {
    delete process.env[ENV];
    delete process.env.KC_TEST_GW_SECRET;
  });

  it("keeps authored IDs, URLs, scopes and display name byte-for-byte in production", () => {
    process.env[ENV] = "resolved-workforce-secret";
    process.env.KC_TEST_GW_SECRET = "gw";
    const realm = realmOf(prodIdpConfig([DEDICATED_OIDC]), "production");
    const [idp] = realm.identityProviders!;
    expect(idp).toEqual({
      alias: "customer-workforce",
      displayName: "Continue with company account",
      providerId: "oidc",
      enabled: true,
      trustEmail: false,
      storeToken: false,
      linkOnly: false,
      hideOnLogin: false,
      firstBrokerLoginFlowAlias: "first broker login",
      config: {
        clientId: "customer-workforce",
        issuer: "https://identity.customer.example",
        authorizationUrl: "https://identity.customer.example/oauth2/authorize",
        tokenUrl: "https://identity.customer.example/oauth2/token",
        jwksUrl: "https://identity.customer.example/.well-known/jwks.json",
        useJwksUrl: "true",
        defaultScope: "openid profile email custom:workforce",
        clientSecret: "resolved-workforce-secret",
      },
    });
  });

  it("emits mappers flattened and bound to the provider alias, with scalars normalized", () => {
    const realm = realmOf(
      idpConfig([
        {
          ...withoutSecrets(DEDICATED_OIDC),
          devSecrets: { clientSecret: "dev" },
          mappers: [
            ...DEDICATED_OIDC.mappers!,
            {
              name: "workforce-role",
              identityProviderMapper: "hardcoded-role-idp-mapper",
              config: { role: "workforce", "are.attribute.values.regex": false, priority: 10 },
            },
          ],
        },
      ]),
    );
    expect(realm.identityProviderMappers).toEqual([
      {
        name: "department",
        identityProviderAlias: "customer-workforce",
        identityProviderMapper: "oidc-user-attribute-idp-mapper",
        config: { claim: "dept", "user.attribute": "department", syncMode: "FORCE" },
      },
      {
        name: "workforce-role",
        identityProviderAlias: "customer-workforce",
        identityProviderMapper: "hardcoded-role-idp-mapper",
        config: { role: "workforce", "are.attribute.values.regex": "false", priority: "10" },
      },
    ]);
  });

  it("preserves an arbitrary provider id and arbitrary config keys for an approved custom provider", () => {
    const realm = realmOf(
      idpConfig([
        {
          alias: "acme",
          providerId: "acme-custom-broker",
          config: { acmeTenant: "t-1", acmeRegion: "eu-west", retries: 3 },
        },
      ]),
    );
    expect(realm.identityProviders![0]).toMatchObject({
      providerId: "acme-custom-broker",
      config: { acmeTenant: "t-1", acmeRegion: "eu-west", retries: "3" },
    });
  });
});

describe("identity providers — Apple", () => {
  const apple = (config: Record<string, string | number | boolean>): AuthorizationIdentityProvider => ({
    alias: "apple",
    providerId: "apple",
    config: { clientId: "example.web.service-id", teamId: "TEAMID1234", keyId: "KEYID12345", ...config },
    devSecrets: { clientSecret: "p8" },
  });

  it("refuses an apple provider that enables token-exchange account linking", () => {
    expect(() => realmOf(idpConfig([apple({ tokenExchangeAccountLinkingEnabled: true })]))).toThrow(
      /config\.tokenExchangeAccountLinkingEnabled must be false, not true/,
    );
    expect(() => realmOf(idpConfig([apple({ tokenExchangeAccountLinkingEnabled: "true" })]))).toThrow(
      /must be false, not "true"/,
    );
    expect(() => realmOf(idpConfig([apple({ tokenExchangeAccountLinkingEnabled: "yes" })]))).toThrow(/must be false/);
  });

  it("refuses an apple provider that leaves the linking flag unauthored", () => {
    expect(() => realmOf(idpConfig([apple({})]))).toThrow(
      /config\.tokenExchangeAccountLinkingEnabled must be authored explicitly as false/,
    );
  });

  it("refuses it in production too, before any secret is resolved", () => {
    process.env.KC_TEST_GW_SECRET = "gw";
    try {
      const { devSecrets: _dev, ...prodApple } = apple({ tokenExchangeAccountLinkingEnabled: true });
      expect(() =>
        realmOf(prodIdpConfig([{ ...prodApple, secrets: { clientSecret: "${env:KC_TEST_UNSET_APPLE}" } }]), "production"),
      ).toThrow(/must be false, not true/);
    } finally {
      delete process.env.KC_TEST_GW_SECRET;
    }
  });

  it("accepts an explicit false (boolean or string) and emits it as the string \"false\"", () => {
    for (const value of [false, "false", "FALSE"] as const) {
      const realm = realmOf(idpConfig([apple({ tokenExchangeAccountLinkingEnabled: value })]));
      expect((realm.identityProviders![0] as { config: Record<string, string> }).config.tokenExchangeAccountLinkingEnabled).toBe(
        String(value),
      );
    }
  });

  it("does not impose the apple rule on other providers", () => {
    const realm = realmOf(idpConfig([{ alias: "g", providerId: "google", config: { clientId: "x" } }]));
    expect((realm.identityProviders![0] as { config: Record<string, string> }).config).toEqual({ clientId: "x" });
  });

  it("emits the apple provider with tokenExchangeAccountLinkingEnabled=false as authored", () => {
    const realm = realmOf(
      idpConfig([
        {
          alias: "apple",
          providerId: "apple",
          displayName: "Continue with Apple",
          config: {
            clientId: "example.web.service-id",
            teamId: "TEAMID1234",
            keyId: "KEYID12345",
            defaultScope: "name email",
            tokenExchangeAccountLinkingEnabled: false,
          },
          devSecrets: { clientSecret: "-----BEGIN PRIVATE KEY-----\ndev\n-----END PRIVATE KEY-----" },
        },
      ]),
    );
    const [apple] = realm.identityProviders!;
    expect(apple).toMatchObject({
      providerId: "apple",
      config: {
        clientId: "example.web.service-id",
        teamId: "TEAMID1234",
        keyId: "KEYID12345",
        tokenExchangeAccountLinkingEnabled: "false",
      },
    });
    expect((apple as { config: Record<string, string> }).config.clientSecret).toContain("BEGIN PRIVATE KEY");
  });
});

describe("identity providers — structural validation", () => {
  const base = (over: Partial<AuthorizationIdentityProvider>): AuthorizationIdentityProvider => ({
    alias: "x",
    providerId: "google",
    ...over,
  });

  it("rejects duplicate aliases within one realm", () => {
    expect(() => realmOf(idpConfig([base({ alias: "dup" }), base({ alias: "dup" })]))).toThrow(
      /alias "dup" is declared twice/,
    );
  });

  it("rejects a blank alias", () => {
    expect(() => realmOf(idpConfig([base({ alias: "  " })]))).toThrow(/alias must be a non-blank string/);
  });

  it("rejects a blank provider id", () => {
    expect(() => realmOf(idpConfig([base({ providerId: "" })]))).toThrow(/providerId must be a non-blank string/);
  });

  it("rejects a blank mapper name and a blank mapper type", () => {
    expect(() =>
      realmOf(idpConfig([base({ mappers: [{ name: "", identityProviderMapper: "oidc-user-attribute-idp-mapper" }] })])),
    ).toThrow(/mapper name must be a non-blank string/);
    expect(() => realmOf(idpConfig([base({ mappers: [{ name: "m", identityProviderMapper: " " }] })]))).toThrow(
      /identityProviderMapper must be a non-blank string/,
    );
  });

  it("rejects two mappers with the same name on one provider", () => {
    expect(() =>
      realmOf(
        idpConfig([
          base({
            mappers: [
              { name: "m", identityProviderMapper: "oidc-user-attribute-idp-mapper" },
              { name: "m", identityProviderMapper: "hardcoded-role-idp-mapper" },
            ],
          }),
        ]),
      ),
    ).toThrow(/mapper name "m" is declared twice/);
  });

  it("rejects a key authored in both config and secrets", () => {
    expect(() =>
      realmOf(idpConfig([base({ config: { clientId: "a" }, devSecrets: { clientId: "b" } })])),
    ).toThrow(/"clientId" is authored in both config and secrets/);
  });

  it("allows the same alias in two different realms", () => {
    const a = idpConfig([base({ alias: "google" })], "realm-a");
    const b = idpConfig([base({ alias: "google", displayName: "B" })], "realm-b");
    const artifacts = generateAllKeycloakRealmArtifacts([], [a, b], "development");
    expect(artifacts.map((x) => x.path)).toEqual(["keycloak/realm-a-realm.json", "keycloak/realm-b-realm.json"]);
    const [ra, rb] = artifacts.map((x) => JSON.parse(x.contents) as RealmWithIdps);
    expect(ra!.identityProviders![0]).not.toHaveProperty("displayName");
    expect(rb!.identityProviders![0]).toMatchObject({ displayName: "B" });
  });
});

describe("identity providers — secret-like keys in config", () => {
  it("flags a secret segment anywhere in the key name, not only as a suffix", () => {
    for (const key of [
      "clientSecret", "client_secret", "secret", "password", "privateKey", "private_key", "p8Key", "p8-key",
      "token", "accessToken", "refresh_token",
      // Longer names that a suffix-only rule let through.
      "clientSecretValue", "passwordCredential", "accessTokenValue", "secretKeyBase64", "privateKeyPem",
      "p8KeyContent", "tokenValue", "PASSWORD_HASH", "my-secret-thing",
    ]) {
      expect(isSecretLikeConfigKey(key)).toBe(true);
    }
  });

  it("allows only the exact known non-secret keys that mention a secret word", () => {
    for (const key of ["tokenUrl", "tokenIntrospectionUrl", "accessTokenIsJwt", "tokenExchangeAccountLinkingEnabled"]) {
      expect(isSecretLikeConfigKey(key)).toBe(false);
    }
    // A near-miss of an allow-listed key is not allowed.
    for (const key of ["tokenUrlSecret", "TokenUrl", "tokenExchangeAccountLinkingEnabledValue"]) {
      expect(isSecretLikeConfigKey(key)).toBe(true);
    }
    for (const key of ["clientId", "useJwksUrl", "issuer", "keyId", "teamId", "publicKeySignatureVerifier", "signingCertificate", "defaultScope"]) {
      expect(isSecretLikeConfigKey(key)).toBe(false);
    }
  });

  it.each(["clientSecretValue", "passwordCredential", "accessTokenValue"])(
    "refuses %s in config in production even though it is not a plain suffix match",
    (key) => {
      process.env.KC_TEST_GW_SECRET = "gw";
      const err = () =>
        realmOf(prodIdpConfig([{ alias: "g", providerId: "google", config: { clientId: "id", [key]: "literal-credential" } }]), "production");
      expect(err).toThrow(new RegExp(`config\.${key} looks like a credential`));
      try {
        err();
      } catch (e) {
        expect(String((e as Error).message)).not.toContain("literal-credential");
      }
      delete process.env.KC_TEST_GW_SECRET;
    },
  );

  it("refuses a secret-like key in config and points at secrets", () => {
    const err = () =>
      realmOf(idpConfig([{ alias: "g", providerId: "google", config: { clientId: "id", clientSecret: "oops-literal" } }]));
    expect(err).toThrow(/config\.clientSecret looks like a credential/);
    expect(err).toThrow(/Move it to `secrets`/);
    try {
      err();
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("oops-literal");
    }
  });
});

describe("identity providers — secrets and modes", () => {
  const ENV = "KC_TEST_IDP_SECRET";
  afterEach(() => {
    delete process.env[ENV];
    delete process.env.KC_TEST_GW_SECRET;
  });

  it("development prefers devSecrets over secrets and never needs the production variable", () => {
    const realm = realmOf(
      idpConfig([
        {
          alias: "g",
          providerId: "google",
          secrets: { clientSecret: `\${env:${ENV}}` },
          devSecrets: { clientSecret: "dev-value" },
        },
      ]),
    );
    expect((realm.identityProviders![0] as { config: Record<string, string> }).config.clientSecret).toBe("dev-value");
  });

  it("development accepts a literal in secrets", () => {
    const realm = realmOf(idpConfig([{ alias: "g", providerId: "google", secrets: { clientSecret: "literal-dev" } }]));
    expect((realm.identityProviders![0] as { config: Record<string, string> }).config.clientSecret).toBe("literal-dev");
  });

  it("production resolves secrets from the environment", () => {
    process.env[ENV] = "from-env";
    process.env.KC_TEST_GW_SECRET = "gw";
    const realm = realmOf(
      prodIdpConfig([
        {
          alias: "g",
          providerId: "google",
          config: { clientId: "id" },
          secrets: { clientSecret: `\${env:${ENV}}` },
        },
      ]),
      "production",
    );
    expect((realm.identityProviders![0] as { config: Record<string, string> }).config.clientSecret).toBe("from-env");
  });

  it("production fails on a missing env variable, naming the variable but never a value", () => {
    process.env.KC_TEST_GW_SECRET = "gw";
    const err = () =>
      realmOf(
        prodIdpConfig([{ alias: "g", providerId: "google", secrets: { clientSecret: `\${env:${ENV}}` } }]),
        "production",
      );
    expect(err).toThrow(new RegExp(`secrets\\.clientSecret: references env var ${ENV}, but it is not set`));
  });

  it("production refuses a ${env:VAR:-fallback} default for a secret", () => {
    process.env.KC_TEST_GW_SECRET = "gw";
    const err = () =>
      realmOf(
        prodIdpConfig([{ alias: "g", providerId: "google", secrets: { clientSecret: `\${env:${ENV}:-committed}` } }]),
        "production",
      );
    expect(err).toThrow(/development-only and will not be used for a production realm/);
    try {
      err();
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("committed");
    }
  });

  it("production refuses a literal secret", () => {
    process.env.KC_TEST_GW_SECRET = "gw";
    const err = () =>
      realmOf(prodIdpConfig([{ alias: "g", providerId: "google", secrets: { clientSecret: "hunter2-literal" } }]), "production");
    expect(err).toThrow(/secrets\.clientSecret: a literal secret is committed for a non-dev realm/);
    try {
      err();
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("hunter2");
    }
  });

  it("production refuses devSecrets outright", () => {
    process.env.KC_TEST_GW_SECRET = "gw";
    process.env[ENV] = "x";
    const err = () =>
      realmOf(
        prodIdpConfig([
          {
            alias: "g",
            providerId: "google",
            secrets: { clientSecret: `\${env:${ENV}}` },
            devSecrets: { clientSecret: "dev-only-literal" },
          },
        ]),
        "production",
      );
    expect(err).toThrow(/devSecrets \(clientSecret\) are development-only/);
    try {
      err();
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("dev-only-literal");
    }
  });

  it("leaves no unresolved ${env:...} placeholder in the generated artifact", () => {
    process.env[ENV] = "from-env";
    process.env.KC_TEST_GW_SECRET = "gw";
    const artifact = generateKeycloakRealmArtifacts(
      [],
      prodIdpConfig([
        {
          alias: "g",
          providerId: "google",
          config: { clientId: `\${env:${ENV}}` },
          secrets: { clientSecret: `\${env:${ENV}}` },
        },
      ]),
      "production",
    )[0]!;
    expect(artifact.contents).not.toContain("${env:");
  });
});

describe("identity providers — production endpoint URLs", () => {
  afterEach(() => {
    delete process.env.KC_TEST_GW_SECRET;
    delete process.env.KC_TEST_IDP_CUSTOMER_WORKFORCE_CLIENT_SECRET;
  });

  function prod(config: Record<string, string | number | boolean>) {
    process.env.KC_TEST_GW_SECRET = "gw";
    process.env.KC_TEST_IDP_CUSTOMER_WORKFORCE_CLIENT_SECRET = "s";
    return () => realmOf(prodIdpConfig([{ ...DEDICATED_OIDC, mappers: [], config }]), "production");
  }

  it("rejects an http endpoint", () => {
    expect(prod({ ...DEDICATED_OIDC.config, tokenUrl: "http://identity.customer.example/oauth2/token" })).toThrow(
      /config\.tokenUrl uses http, not https/,
    );
  });

  it("rejects an http issuer", () => {
    expect(prod({ ...DEDICATED_OIDC.config, issuer: "http://identity.customer.example" })).toThrow(/config\.issuer uses http/);
  });

  it("rejects embedded credentials", () => {
    expect(prod({ ...DEDICATED_OIDC.config, jwksUrl: "https://user:pw@identity.customer.example/jwks" })).toThrow(
      /config\.jwksUrl embeds credentials/,
    );
  });

  it("rejects a fragment", () => {
    expect(prod({ ...DEDICATED_OIDC.config, authorizationUrl: "https://identity.customer.example/authorize#frag" })).toThrow(
      /config\.authorizationUrl carries a fragment/,
    );
  });

  it("rejects a relative URL", () => {
    expect(prod({ ...DEDICATED_OIDC.config, userInfoUrl: "/userinfo" })).toThrow(/config\.userInfoUrl is not an absolute URL/);
  });

  it("does not apply the URL rule in development, so a local mock issuer works", () => {
    const realm = realmOf(
      idpConfig([
        {
          ...withoutSecrets(DEDICATED_OIDC),
          devSecrets: { clientSecret: "d" },
          config: { ...DEDICATED_OIDC.config, tokenUrl: "http://localhost:9999/token" },
        },
      ]),
    );
    expect((realm.identityProviders![0] as { config: Record<string, string> }).config.tokenUrl).toBe("http://localhost:9999/token");
  });
});

describe("identity providers — the documented examples in authorization.yaml", () => {
  it("validate against the authoring schema and generate, once uncommented", () => {
    const { parse } = require("yaml") as { parse: (s: string) => unknown };
    const { authoringValidator } = require("../schema-validation.js") as {
      authoringValidator: () => { validate(document: unknown, origin: string): string | null };
    };
    const yamlPath = join(import.meta.dir, "../../../config/authoring/authorization.yaml");
    const lines = readFileSync(yamlPath, "utf8").split("\n");
    const start = lines.findIndex((l) => l === "  # identityProviders:");
    const end = lines.findIndex((l, i) => i > start && /^realmRoles:/.test(l));
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const example = lines
      .slice(start, end)
      .map((l) => l.replace(/^  # ?/, ""))
      .join("\n");
    const parsedExample = parse(example) as { identityProviders: AuthorizationIdentityProvider[] };
    expect(parsedExample.identityProviders.map((p) => [p.alias, p.providerId])).toEqual([
      ["google", "google"],
      ["customer-workforce", "oidc"],
    ]);

    const authored = parse(readFileSync(yamlPath, "utf8")) as AuthorizationConfigFile;
    const withExamples: AuthorizationConfigFile = {
      ...authored,
      keycloak: { ...authored.keycloak, identityProviders: parsedExample.identityProviders },
    };
    expect(authoringValidator().validate(withExamples, "authorization.yaml example")).toBe(
      "authorization-config.schema.json",
    );

    const realm = realmOf(withExamples);
    expect(realm.identityProviders!.map((p) => p.alias)).toEqual(["google", "customer-workforce"]);
    expect(realm.identityProviderMappers).toEqual([
      {
        name: "department",
        identityProviderAlias: "customer-workforce",
        identityProviderMapper: "oidc-user-attribute-idp-mapper",
        config: { claim: "dept", "user.attribute": "department", syncMode: "FORCE" },
      },
    ]);
    const workforce = realm.identityProviders![1] as { config: Record<string, string> };
    expect(workforce.config.tokenUrl).toBe("https://identity.customer.example/oauth2/token");
    expect(workforce.config.useJwksUrl).toBe("true");
  });
});
