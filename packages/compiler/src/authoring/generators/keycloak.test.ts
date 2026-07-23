import { afterEach, describe, expect, it } from "bun:test";
import {
  generateKeycloakRealmArtifacts,
  isDevRealm,
  resolveClientSecret,
} from "./keycloak.js";
import type { AuthorizationConfigFile } from "../types/authoring.js";

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
    expect(() => generateKeycloakRealmArtifacts([], config)).toThrow(/devSecret is dev-only/);
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
    expect(() => generateKeycloakRealmArtifacts([], config)).toThrow(/literal client secret is committed for a non-dev realm/);
  });
});

describe("isDevRealm", () => {
  it("treats sslRequired:none and -dev names as dev", () => {
    expect(isDevRealm({ name: "openshapeforge-dev", sslRequired: "none" })).toBe(true);
    expect(isDevRealm({ name: "acme-dev" })).toBe(true);
    expect(isDevRealm(undefined)).toBe(true); // falls back to DEFAULT_REALM_NAME
  });

  it("treats a TLS-required non-dev-named realm as production", () => {
    expect(isDevRealm({ name: "openshapeforge", sslRequired: "all" })).toBe(false);
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

  it("uses the ${env:VAR:-fallback} default when unset", () => {
    expect(resolveClientSecret({ id: "c", kind: "serviceAccount", secret: `\${env:${KEY}:-fb}` }, false)).toBe("fb");
  });

  it("throws when an env ref is unset and has no fallback", () => {
    expect(() => resolveClientSecret({ id: "c", kind: "serviceAccount", secret: `\${env:${KEY}}` }, false)).toThrow(
      /is not set and no/,
    );
  });
});
