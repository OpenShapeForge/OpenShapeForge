// SPDX-License-Identifier: BUSL-1.1
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { loadAuthoringConfig } from "./authoring/layers.js";
import { collectAllArtifacts } from "./index.js";
import {
  compileSettingsPolicy,
  loadSettingsPolicy,
  SETTINGS_POLICY_PATH,
  type OwnedSettingsSource,
  type SettingsDefinitionSource,
  type SettingsOwner,
  type SettingsProviderSource,
} from "./settings.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const owner: SettingsOwner = { kind: "plugin", id: "artifact-storage" };

function definitionSource(
  settings: SettingsDefinitionSource["settings"],
  overrides: Partial<OwnedSettingsSource<SettingsDefinitionSource>> = {},
): OwnedSettingsSource<SettingsDefinitionSource> {
  return {
    document: {
      schemaVersion: 1,
      kind: "settingsDefinition",
      namespace: "storage.artifacts",
      settings,
    },
    owner,
    source: "plugin:artifact-storage/authoring/settings/artifacts.yaml",
    ...overrides,
  };
}

function providerSource(
  provider = "filesystem",
  capabilities = ["artifact-storage"],
): OwnedSettingsSource<SettingsProviderSource> {
  return {
    document: {
      schemaVersion: 1,
      kind: "settingsProvider",
      provider,
      capabilities,
    },
    owner: { kind: "plugin", id: `${provider}-adapter` },
    source: `plugin:${provider}-adapter/authoring/settings/provider.yaml`,
  };
}

function allDefinitions(enabled = true) {
  return definitionSource([
    {
      key: "enabled",
      type: "boolean",
      default: enabled,
    },
    {
      key: "maximumBytes",
      type: "integer",
      default: 10_000_000,
      minimum: 1,
      maximum: 25_000_000,
    },
    {
      key: "allowedMediaTypes",
      type: "stringSet",
      default: ["application/pdf"],
      allowed: ["application/pdf", "image/png"],
    },
    {
      key: "retentionMode",
      type: "choice",
      default: "standard",
      choices: ["standard", "short"],
    },
    {
      key: "provider",
      type: "provider",
      capability: "artifact-storage",
      allowedProviders: ["filesystem"],
      default: "filesystem",
      enabledBy: "enabled",
    },
  ]);
}

describe("owner-defined settings", () => {
  test("applies every host value only within the owner's typed ceiling", () => {
    const policy = compileSettingsPolicy(
      [allDefinitions()],
      [providerSource()],
      {
        "storage.artifacts.maximumBytes": 5_000_000,
        "storage.artifacts.allowedMediaTypes": ["image/png", "application/pdf"],
        "storage.artifacts.retentionMode": "short",
        "storage.artifacts.provider": "filesystem",
      },
    );

    expect(policy).toEqual({
      version: 1,
      settings: {
        "storage.artifacts.allowedMediaTypes": {
          type: "stringSet",
          value: ["application/pdf", "image/png"],
          owner,
          source: "plugin:artifact-storage/authoring/settings/artifacts.yaml",
        },
        "storage.artifacts.enabled": {
          type: "boolean",
          value: true,
          owner,
          source: "plugin:artifact-storage/authoring/settings/artifacts.yaml",
        },
        "storage.artifacts.maximumBytes": {
          type: "integer",
          value: 5_000_000,
          owner,
          source: "plugin:artifact-storage/authoring/settings/artifacts.yaml",
        },
        "storage.artifacts.provider": {
          type: "provider",
          value: "filesystem",
          capability: "artifact-storage",
          owner,
          source: "plugin:artifact-storage/authoring/settings/artifacts.yaml",
        },
        "storage.artifacts.retentionMode": {
          type: "choice",
          value: "short",
          owner,
          source: "plugin:artifact-storage/authoring/settings/artifacts.yaml",
        },
      },
      providers: {
        filesystem: {
          capabilities: ["artifact-storage"],
          owner: { kind: "plugin", id: "filesystem-adapter" },
          source: "plugin:filesystem-adapter/authoring/settings/provider.yaml",
        },
      },
    });
  });

  test("refuses unknown settings and every widening or type mismatch", () => {
    const definitions = [allDefinitions()];
    const providers = [providerSource()];
    const refused = [
      { "storage.artifacts.unknown": true },
      { "storage.artifacts.maximumBytes": 25_000_001 },
      { "storage.artifacts.maximumBytes": 1.5 },
      { "storage.artifacts.allowedMediaTypes": ["text/html"] },
      { "storage.artifacts.allowedMediaTypes": ["application/pdf", "application/pdf"] },
      { "storage.artifacts.retentionMode": "unbounded" },
      { "storage.artifacts.enabled": "true" },
    ];
    for (const hostSettings of refused) {
      expect(() => compileSettingsPolicy(definitions, providers, hostSettings)).toThrow();
    }
  });

  test("a disabled owner capability cannot be revived by provider installation or host selection", () => {
    const disabled = [allDefinitions(false)];

    const policy = compileSettingsPolicy(disabled, []);
    expect(policy.settings["storage.artifacts.enabled"]).toMatchObject({ value: false });
    expect(policy.settings["storage.artifacts.provider"]).toMatchObject({ value: null });

    expect(() => compileSettingsPolicy(disabled, [providerSource()], {
      "storage.artifacts.enabled": true,
    })).toThrow(/cannot enable/);
    expect(() => compileSettingsPolicy(disabled, [providerSource()], {
      "storage.artifacts.provider": "filesystem",
    })).toThrow(/gate is disabled/);
  });

  test("provider selection requires both the owner allowlist and the declared capability", () => {
    expect(() => compileSettingsPolicy([allDefinitions()], [providerSource(), providerSource("archive")], {
      "storage.artifacts.provider": "archive",
    })).toThrow(/outside its owner allowlist/);

    expect(() => compileSettingsPolicy([allDefinitions()], [providerSource("filesystem", ["other"])])).toThrow(
      /does not declare capability "artifact-storage"/,
    );

    expect(() => compileSettingsPolicy([allDefinitions()], [providerSource(), providerSource()])).toThrow(
      /declared more than once/,
    );
  });

  test("invalid owner defaults and duplicate definitions fail before host constraints", () => {
    expect(() => compileSettingsPolicy([
      definitionSource([{
        key: "maximumBytes",
        type: "integer",
        default: 50,
        minimum: 1,
        maximum: 10,
      }]),
    ], [])).toThrow(/default.*within/);

    expect(() => compileSettingsPolicy([
      definitionSource([{
        key: "allowedMediaTypes",
        type: "stringSet",
        default: ["text/html"],
        allowed: ["application/pdf"],
      }]),
    ], [])).toThrow(/outside its owner allowed set/);

    const originalCeiling = definitionSource([{
      key: "maximumBytes",
      type: "integer",
      default: 10,
      minimum: 1,
      maximum: 10,
    }]);
    const attemptedReplacement = definitionSource([{
      key: "maximumBytes",
      type: "integer",
      default: 10_000,
      minimum: 1,
      maximum: 10_000,
    }], {
      source: "plugin:artifact-storage/authoring/settings/replacement.yaml",
    });
    expect(() => compileSettingsPolicy([
      originalCeiling,
      attemptedReplacement,
    ], [])).toThrow(/defined more than once.*later layer cannot replace/i);

    expect(() => compileSettingsPolicy([
      originalCeiling,
      definitionSource([{
        key: "enabled",
        type: "boolean",
        default: true,
      }], {
        owner: { kind: "layer", id: "host-overlay" },
        source: "authoring/settings/replacement.yaml",
      }),
    ], [])).toThrow(/namespace.*owned by both/);
  });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "osf-settings-"));
  roots.push(root);
  return root;
}

function writeYaml(path: string, document: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, YAML.stringify(document));
}

describe("settings source ownership", () => {
  test("emits stable plugin provenance and passes the same effective policy to generators", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "base"), { recursive: true });
    mkdirSync(join(root, "documents-plugin"), { recursive: true });
    writeFileSync(
      join(root, "documents-plugin", "index.ts"),
      'export default { name: "documents" };\n',
    );
    writeFileSync(
      join(root, "documents-plugin", "runtime.ts"),
      'export default { name: "documents", operationHandlers: {} };\n',
    );
    const plugin = join(root, "adapter", "index.ts");
    writeYaml(join(root, "adapter", "authoring", "settings", "artifacts.yaml"), allDefinitions().document);
    writeYaml(join(root, "adapter", "authoring", "settings", "provider.yaml"), providerSource().document);
    writeFileSync(plugin, [
      "export default {",
      "  name: 'artifact-storage',",
      "  generate(context) {",
      "    return [{ path: 'settings-observed.json', contents: JSON.stringify(context.settingsPolicy) + '\\n' }];",
      "  },",
      "};",
      "",
    ].join("\n"));
    writeYaml(join(root, "authoring.config.yaml"), {
      layers: ["packages/compiler/config/authoring"],
      plugins: ["./documents-plugin/index.ts", "./adapter/index.ts"],
      settings: {
        "storage.artifacts.maximumBytes": 4_000_000,
      },
    });

    const { groups } = await collectAllArtifacts(root);
    const policyArtifact = groups.settings.find((artifact) => artifact.path === SETTINGS_POLICY_PATH);
    const pluginArtifact = groups.plugins[0]!.artifacts.find(
      (artifact) => artifact.path === "settings-observed.json",
    );
    expect(policyArtifact).toBeDefined();
    expect(JSON.parse(pluginArtifact!.contents)).toEqual(JSON.parse(policyArtifact!.contents));
    expect(policyArtifact?.contents).not.toContain(root);
    expect(JSON.parse(policyArtifact!.contents)).toMatchObject({
      settings: {
        "storage.artifacts.maximumBytes": {
          value: 4_000_000,
          owner: { kind: "plugin", id: "artifact-storage" },
          source: "plugin:artifact-storage/authoring/settings/artifacts.yaml",
        },
      },
    });
  }, 60_000);

  test("local layers and plugins cannot inject definitions or providers", () => {
    const root = tempRoot();
    mkdirSync(join(root, "base"), { recursive: true });
    writeYaml(join(root, "local-layer", "settings", "injected.yaml"), allDefinitions().document);
    writeYaml(join(root, "authoring.config.yaml"), { layers: ["base"] });
    writeYaml(join(root, "authoring.config.local.yaml"), { layers: ["local-layer"] });
    const effective = loadAuthoringConfig(root);
    expect(() => loadSettingsPolicy(root, effective, [])).toThrow(
      /authoring\.config\.local\.yaml may not add settings/,
    );

    rmSync(join(root, "authoring.config.local.yaml"));
    writeYaml(join(root, "local-plugin", "authoring", "settings", "injected.yaml"), providerSource().document);
    writeFileSync(join(root, "local-plugin", "index.ts"), "export default { name: 'local-plugin' };\n");
    writeYaml(join(root, "authoring.config.local.yaml"), { plugins: ["./local-plugin/index.ts"] });
    const withPlugin = loadAuthoringConfig(root);
    expect(() => loadSettingsPolicy(root, withPlugin, [{
      spec: "./local-plugin/index.ts",
      plugin: { name: "local-plugin" },
    }])).toThrow(/authoring\.config\.local\.yaml may not add settings/);
  });
});
