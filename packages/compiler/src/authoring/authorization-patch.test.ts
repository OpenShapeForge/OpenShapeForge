// SPDX-License-Identifier: BUSL-1.1
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { applyAuthorizationPatch, renameClientReferences } from "./authorization-patch.js";
import { generateAuthoringKeycloakArtifacts } from "./generate-keycloak-artifacts.js";
import { resolveAuthoringLayers, strategicMerge } from "./layers.js";

/**
 * A realm small enough to read, shaped like the base `authorization.yaml`:
 * one gateway, one bearer-only entity-role client referenced from every place
 * a client id can be referenced.
 */
function baseRealm() {
  return {
    schemaVersion: 2,
    kind: "authorizationConfig",
    realm: { name: "openshapeforge", displayName: "OpenShapeForge", sslRequired: "none" },
    keycloak: {
      entityRoleClient: "erp-provider",
      clients: [
        {
          id: "openshapeforge-gateway",
          kind: "gateway",
          devSecret: "dev-secret",
          secret: "${env:KEYCLOAK_CLIENT_SECRET_OPENSHAPEFORGE_GATEWAY}",
          redirectUris: ["http://localhost:3000/*"],
          webOrigins: ["http://localhost:3000"],
        },
        {
          id: "erp-provider",
          kind: "bearerOnly",
          name: "ERP Provider — entity scopes",
          devSecret: "erp-provider-secret",
          secret: "${env:KEYCLOAK_CLIENT_SECRET_ERP_PROVIDER}",
        },
        { id: "openshapeforge-support", kind: "bearerOnly" },
      ],
    },
    realmRoles: {
      directie: {
        description: "Directie",
        composites: {
          "erp-provider": ["General.All.ReadWrite", "Relations.All.ReadWrite"],
          "openshapeforge-support": ["Support.Issues.All"],
        },
      },
      controller: {
        description: "Controller",
        composites: { "erp-provider": ["Finance.All.ReadWrite"] },
      },
    },
    clientRoles: {
      "erp-provider": ["General.All.ReadWrite", "Relations.All.ReadWrite", "Finance.All.ReadWrite"],
      "openshapeforge-support": ["Support.Issues.All"],
    },
    users: [
      {
        username: "directeur",
        password: "test",
        realmRoles: ["directie"],
        clientRoles: { "erp-provider": ["Relations.All.ReadWrite"] },
      },
    ],
  };
}

const origin = "authorizationPatch test/authorization.yaml";

/** The merged shape, loosely typed: tests reach for keys the base never had. */
type Realm = {
  kind: string;
  schemaVersion: number;
  realm: Record<string, unknown>;
  keycloak: { entityRoleClient?: string; client?: string; clients: Record<string, unknown>[] };
  realmRoles: Record<string, { description?: string; composites: Record<string, string[]> }>;
  clientRoles: Record<string, string[]>;
  users: { clientRoles?: Record<string, string[]> }[];
};

function apply(patch: Record<string, unknown>, base: unknown = baseRealm()): Realm {
  return applyAuthorizationPatch(base as never, { kind: "authorizationPatch", ...patch } as never, {
    strategicMerge,
    origin,
  }) as unknown as Realm;
}

describe("applyAuthorizationPatch — renameClient", () => {
  test("rewrites every reference to the client id and nothing else", () => {
    const merged = apply({ renameClient: { from: "erp-provider", to: "hubble-api" } });

    expect(merged.keycloak.entityRoleClient).toBe("hubble-api");
    expect(merged.keycloak.clients.map((c) => c.id)).toEqual([
      "openshapeforge-gateway",
      "hubble-api",
      "openshapeforge-support",
    ]);
    // Identity moved; the client's own fields are untouched by the rename.
    const renamed = merged.keycloak.clients[1]!;
    expect(renamed.name).toBe("ERP Provider — entity scopes");
    expect(renamed.secret).toBe("${env:KEYCLOAK_CLIENT_SECRET_ERP_PROVIDER}");
    expect(Object.keys(merged.realmRoles.directie!.composites)).toEqual([
      "hubble-api",
      "openshapeforge-support",
    ]);
    expect(merged.realmRoles.controller!.composites).toEqual({
      "hubble-api": ["Finance.All.ReadWrite"],
    });
    expect(Object.keys(merged.clientRoles)).toEqual(["hubble-api", "openshapeforge-support"]);
    expect(merged.users[0]!.clientRoles).toEqual({ "hubble-api": ["Relations.All.ReadWrite"] });
    expect(JSON.stringify(merged)).not.toContain('"erp-provider"');
  });

  test("the patch body addresses the client under its NEW id", () => {
    const merged = apply({
      renameClient: { from: "erp-provider", to: "hubble-api" },
      keycloak: {
        clients: [
          {
            id: "hubble-api",
            name: "Hubble API",
            devSecret: "hubble-api-secret",
            secret: "${env:KEYCLOAK_CLIENT_SECRET_HUBBLE_API}",
          },
        ],
      },
    });
    const client = merged.keycloak.clients.find((c) => c.id === "hubble-api")!;
    expect(client).toEqual({
      id: "hubble-api",
      kind: "bearerOnly",
      name: "Hubble API",
      devSecret: "hubble-api-secret",
      secret: "${env:KEYCLOAK_CLIENT_SECRET_HUBBLE_API}",
    });
    expect(merged.keycloak.clients).toHaveLength(3);
  });

  test("renames serviceAccountClientRoles keys and the v1 keycloak.client / keycloak.realmRoles shape", () => {
    const base = {
      ...baseRealm(),
      keycloak: {
        client: "erp-provider",
        realmRoles: { legacy: { composites: { "erp-provider": ["X"] } } },
        clients: [
          { id: "erp-provider", kind: "bearerOnly" },
          {
            id: "provisioner",
            kind: "serviceAccount",
            serviceAccountClientRoles: { "erp-provider": ["General.All.Read"] },
          },
        ],
      },
    };
    const renamed = renameClientReferences(
      base as never,
      { from: "erp-provider", to: "hubble-api" },
      origin,
    ) as unknown as {
      keycloak: {
        client: string;
        realmRoles: Record<string, { composites: Record<string, string[]> }>;
        clients: Record<string, unknown>[];
      };
    };
    expect(renamed.keycloak.client).toBe("hubble-api");
    expect(renamed.keycloak.realmRoles.legacy!.composites).toEqual({ "hubble-api": ["X"] });
    expect(renamed.keycloak.clients[1]!.serviceAccountClientRoles).toEqual({
      "hubble-api": ["General.All.Read"],
    });
  });

  test("a rename of a client the base does not have is refused", () => {
    expect(() => apply({ renameClient: { from: "nope", to: "hubble-api" } })).toThrow(
      /renameClient\.from "nope" is not a client of the realm being patched \(clients: "openshapeforge-gateway", "erp-provider", "openshapeforge-support"\)/,
    );
  });

  test("a rename onto an id the base already has is refused", () => {
    expect(() =>
      apply({ renameClient: { from: "erp-provider", to: "openshapeforge-support" } }),
    ).toThrow(/renameClient\.to "openshapeforge-support" already exists/);
  });

  test("renameClient only knows from and to", () => {
    expect(() =>
      apply({ renameClient: { from: "erp-provider", to: "hubble-api", name: "Hubble API" } }),
    ).toThrow(/renameClient has unknown field\(s\): name/);
    expect(() => apply({ renameClient: { from: "erp-provider", to: "erp-provider" } })).toThrow(
      /both "erp-provider"/,
    );
    expect(() => apply({ renameClient: "erp-provider" })).toThrow(/must be an object/);
  });
});

describe("applyAuthorizationPatch — merge", () => {
  test("scalars override, clients merge by id, new clients append, $delete removes", () => {
    const merged = apply({
      keycloak: {
        entityRoleClient: "openshapeforge-support",
        clients: [
          { id: "openshapeforge-support", name: "Support (renamed)" },
          { id: "openshapeforge-audit", kind: "bearerOnly" },
          { id: "openshapeforge-gateway", $delete: true },
        ],
      },
    });
    expect(merged.keycloak.entityRoleClient).toBe("openshapeforge-support");
    expect(merged.keycloak.clients).toEqual([
      { id: "erp-provider", kind: "bearerOnly", name: "ERP Provider — entity scopes", devSecret: "erp-provider-secret", secret: "${env:KEYCLOAK_CLIENT_SECRET_ERP_PROVIDER}" },
      { id: "openshapeforge-support", kind: "bearerOnly", name: "Support (renamed)" },
      { id: "openshapeforge-audit", kind: "bearerOnly" },
    ]);
  });

  test("role-name lists union: composites and clientRoles gain grants without restating the base", () => {
    const merged = apply({
      realmRoles: {
        directie: {
          composites: {
            "erp-provider": ["Pentest.All.ReadWrite", "General.All.ReadWrite"],
            "openshapeforge-audit": ["Audit.Logs.All"],
          },
        },
        pentester: {
          description: "Pentester",
          composites: { "erp-provider": ["Pentest.All.ReadWrite"] },
        },
      },
      clientRoles: { "erp-provider": ["Pentest.All.ReadWrite"], "openshapeforge-audit": ["Audit.Logs.All"] },
    });
    // Base order first, additions appended once — deterministic and duplicate-free.
    expect(merged.realmRoles.directie!.composites).toEqual({
      "erp-provider": ["General.All.ReadWrite", "Relations.All.ReadWrite", "Pentest.All.ReadWrite"],
      "openshapeforge-support": ["Support.Issues.All"],
      "openshapeforge-audit": ["Audit.Logs.All"],
    });
    expect(merged.realmRoles.directie!.description).toBe("Directie");
    expect(merged.realmRoles.pentester).toEqual({
      description: "Pentester",
      composites: { "erp-provider": ["Pentest.All.ReadWrite"] },
    });
    expect(merged.clientRoles["erp-provider"]).toEqual([
      "General.All.ReadWrite",
      "Relations.All.ReadWrite",
      "Finance.All.ReadWrite",
      "Pentest.All.ReadWrite",
    ]);
    expect(merged.clientRoles["openshapeforge-audit"]).toEqual(["Audit.Logs.All"]);
  });

  test("null removes a composite client, a realm role or a client role list", () => {
    const merged = apply({
      realmRoles: { controller: null, directie: { composites: { "openshapeforge-support": null } } },
      clientRoles: { "openshapeforge-support": null },
    });
    expect(Object.keys(merged.realmRoles)).toEqual(["directie"]);
    expect(Object.keys(merged.realmRoles.directie!.composites)).toEqual(["erp-provider"]);
    expect(Object.keys(merged.clientRoles)).toEqual(["erp-provider"]);
  });

  test("rename runs before the merge, so grants can be added to the renamed client in one patch", () => {
    const merged = apply({
      renameClient: { from: "erp-provider", to: "hubble-api" },
      realmRoles: { directie: { composites: { "hubble-api": ["Pentest.All.ReadWrite"] } } },
    });
    expect(merged.realmRoles.directie!.composites["hubble-api"]).toEqual([
      "General.All.ReadWrite",
      "Relations.All.ReadWrite",
      "Pentest.All.ReadWrite",
    ]);
  });

  test("unknown top-level keys and schemaVersion are refused", () => {
    expect(() => apply({ schemaVersion: 3 })).toThrow(
      /unknown field\(s\): schemaVersion.*schemaVersion is the base document's/,
    );
    expect(() => apply({ realmRole: {} })).toThrow(/unknown field\(s\): realmRole/);
  });

  test("the merged result is validated as an authorizationConfig, naming the patch", () => {
    expect(() =>
      apply({ keycloak: { clients: [{ id: "broken", kind: "bearer-only" }] } }),
    ).toThrow(/authorizationPatch test\/authorization\.yaml \(merged result\) does not match authorization-config\.schema\.json/);
  });

  test("a patch can only target an authorizationConfig", () => {
    expect(() => apply({}, { kind: "appShell" })).toThrow(
      /targets a document of kind "appShell"; an authorizationPatch can only patch an authorizationConfig/,
    );
  });

  test("inputs are not mutated", () => {
    const base = baseRealm();
    const snapshot = JSON.stringify(base);
    apply({ renameClient: { from: "erp-provider", to: "hubble-api" }, clientRoles: { "hubble-api": ["X"] } }, base);
    expect(JSON.stringify(base)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// Through the layer resolver and the realm generator
// ---------------------------------------------------------------------------

describe("resolveAuthoringLayers — authorizationPatch", () => {
  const roots: string[] = [];

  function makeRepo(): string {
    const root = mkdtempSync(join(tmpdir(), "openshapeforge-authz-patch-"));
    roots.push(root);
    return root;
  }

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function writeYaml(root: string, relativePath: string, doc: unknown) {
    const full = join(root, relativePath);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, YAML.stringify(doc), "utf8");
  }

  function configureLayers(root: string, layers: string[]) {
    writeFileSync(join(root, "authoring.config.yaml"), YAML.stringify({ layers }), "utf8");
  }

  const hubblePatch = {
    kind: "authorizationPatch",
    renameClient: { from: "erp-provider", to: "hubble-api" },
    keycloak: {
      clients: [
        {
          id: "hubble-api",
          name: "Hubble API",
          devSecret: "hubble-api-secret",
          secret: "${env:KEYCLOAK_CLIENT_SECRET_HUBBLE_API}",
        },
      ],
    },
  };

  test("a host layer renames the entity-role client through to the generated realm export", () => {
    const root = makeRepo();
    writeYaml(root, "base/authorization.yaml", baseRealm());
    writeYaml(root, "host/authorization.yaml", hubblePatch);
    configureLayers(root, ["base", "host"]);

    const resolved = resolveAuthoringLayers(root);
    const merged = YAML.parse(readFileSync(join(resolved, "authorization.yaml"), "utf8"));
    // The merged document is a realm file the generator reads by kind; a
    // surviving patch envelope would make the realm stop being generated.
    expect(merged.kind).toBe("authorizationConfig");
    expect(merged.schemaVersion).toBe(2);

    const [artifact] = generateAuthoringKeycloakArtifacts(resolved);
    expect(artifact?.path).toBe("keycloak/openshapeforge-realm.json");
    const realm = JSON.parse(artifact!.contents);
    expect(artifact!.contents).not.toContain("erp-provider");
    expect(realm.clients.map((c: { clientId: string }) => c.clientId)).toContain("hubble-api");
    const client = realm.clients.find((c: { clientId: string }) => c.clientId === "hubble-api");
    expect(client.name).toBe("Hubble API");
    expect(client.secret).toBe("hubble-api-secret");
    // Audience mappers on the gateway derive from bearer-only client ids.
    const gateway = realm.clients.find((c: { clientId: string }) => c.clientId === "openshapeforge-gateway");
    expect(gateway.protocolMappers.map((m: { name: string }) => m.name)).toContain("hubble-api-audience");
    expect(Object.keys(realm.roles.client)).toContain("hubble-api");
    const directie = realm.roles.realm.find((r: { name: string }) => r.name === "directie");
    expect(Object.keys(directie.composites.client)).toEqual(["hubble-api", "openshapeforge-support"]);
  });

  test("resolution is deterministic: two runs materialize byte-identical realm files", () => {
    const root = makeRepo();
    writeYaml(root, "base/authorization.yaml", baseRealm());
    writeYaml(root, "host/authorization.yaml", hubblePatch);
    configureLayers(root, ["base", "host"]);

    const first = readFileSync(join(resolveAuthoringLayers(root), "authorization.yaml"), "utf8");
    const second = readFileSync(join(resolveAuthoringLayers(root), "authorization.yaml"), "utf8");
    expect(second).toBe(first);
  });

  test("patches stack in layer order, each seeing the previous result", () => {
    const root = makeRepo();
    writeYaml(root, "base/authorization.yaml", baseRealm());
    writeYaml(root, "host/authorization.yaml", hubblePatch);
    writeYaml(root, "plugin/authorization.yaml", {
      kind: "authorizationPatch",
      realmRoles: { directie: { composites: { "hubble-api": ["Pentest.All.ReadWrite"] } } },
      clientRoles: { "hubble-api": ["Pentest.All.ReadWrite"] },
    });
    configureLayers(root, ["base", "host", "plugin"]);

    const merged = YAML.parse(readFileSync(join(resolveAuthoringLayers(root), "authorization.yaml"), "utf8"));
    expect(merged.realmRoles.directie!.composites["hubble-api"]).toEqual([
      "General.All.ReadWrite",
      "Relations.All.ReadWrite",
      "Pentest.All.ReadWrite",
    ]);
    expect(merged.clientRoles["hubble-api"]).toHaveLength(4);
  });

  test("a second realm file is patched under its own name and the first is left alone", () => {
    const root = makeRepo();
    writeYaml(root, "base/authorization.yaml", baseRealm());
    writeYaml(root, "base/authorization.control.yaml", {
      schemaVersion: 2,
      kind: "authorizationConfig",
      realm: { name: "openshapeforge-control" },
      keycloak: { clients: [{ id: "admin-gateway", kind: "gateway", devSecret: "s", redirectUris: ["http://localhost:4000/*"], webOrigins: ["http://localhost:4000"] }] },
      realmRoles: { "platform-operator": { description: "Operator" } },
    });
    writeYaml(root, "host/authorization.control.yaml", {
      kind: "authorizationPatch",
      realm: { displayName: "Hubble Control" },
    });
    configureLayers(root, ["base", "host"]);

    const resolved = resolveAuthoringLayers(root);
    const control = YAML.parse(readFileSync(join(resolved, "authorization.control.yaml"), "utf8"));
    expect(control.realm).toEqual({ name: "openshapeforge-control", displayName: "Hubble Control" });
    const tenant = YAML.parse(readFileSync(join(resolved, "authorization.yaml"), "utf8"));
    expect(tenant.realm.displayName).toBe("OpenShapeForge");
    expect(generateAuthoringKeycloakArtifacts(resolved).map((a) => a.path)).toEqual([
      "keycloak/openshapeforge-control-realm.json",
      "keycloak/openshapeforge-realm.json",
    ]);
  });

  test("a patch for a realm no earlier layer defines is rejected", () => {
    const root = makeRepo();
    writeYaml(root, "base/entities/core/widget.yaml", { schemaVersion: 1, kind: "coreEntity" });
    writeYaml(root, "host/authorization.yaml", hubblePatch);
    configureLayers(root, ["base", "host"]);

    expect(() => resolveAuthoringLayers(root)).toThrow(
      /authorizationPatch .*host\/authorization\.yaml cannot be applied: no earlier layer defines authorization\.yaml/,
    );
  });

  test("a patch filed away from the realm root is rejected rather than copied through", () => {
    const root = makeRepo();
    writeYaml(root, "base/authorization.yaml", baseRealm());
    writeYaml(root, "host/realms/authorization.yaml", hubblePatch);
    configureLayers(root, ["base", "host"]);

    expect(() => resolveAuthoringLayers(root)).toThrow(
      /authorizationPatch .*host\/realms\/authorization\.yaml must sit at the path of the realm file it patches/,
    );
  });

  test("a plain authorizationConfig replacement still collides, and the error now names the patch kind", () => {
    const root = makeRepo();
    writeYaml(root, "base/authorization.yaml", baseRealm());
    writeYaml(root, "host/authorization.yaml", baseRealm());
    configureLayers(root, ["base", "host"]);

    expect(() => resolveAuthoringLayers(root)).toThrow(
      /Layer collision on authorization\.yaml: .* ships a plain replacement\. .*kind: authorizationPatch/,
    );
  });

  test("a malformed patch fails at resolve time with the patch's own path", () => {
    const root = makeRepo();
    writeYaml(root, "base/authorization.yaml", baseRealm());
    writeYaml(root, "host/authorization.yaml", {
      kind: "authorizationPatch",
      renameClient: { from: "missing-client", to: "hubble-api" },
    });
    configureLayers(root, ["base", "host"]);

    expect(() => resolveAuthoringLayers(root)).toThrow(
      /authorizationPatch .*host\/authorization\.yaml: renameClient\.from "missing-client" is not a client/,
    );
  });
});
