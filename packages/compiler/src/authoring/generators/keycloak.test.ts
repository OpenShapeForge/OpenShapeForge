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
