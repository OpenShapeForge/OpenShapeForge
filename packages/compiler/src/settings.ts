// SPDX-License-Identifier: BUSL-1.1
import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  AUTHORING_LOCAL_CONFIG_FILENAME,
  loadCommittedAuthoringConfig,
  pluginAuthoringDir,
  resolveLayerDir,
  type AuthoringConfig,
  type AuthoringSettingValue,
} from "./authoring/layers.js";
import { authoringValidator } from "./authoring/schema-validation.js";

export const SETTINGS_POLICY_PATH = "apps/api/src/generated/compiler/settings-policy.json";

export type SettingsOwner =
  | { kind: "plugin"; id: string }
  | { kind: "layer"; id: string };

type SettingBase = {
  key: string;
  description?: string;
};

export type IntegerSettingDefinition = SettingBase & {
  type: "integer";
  default: number;
  minimum: number;
  maximum: number;
};

export type StringSetSettingDefinition = SettingBase & {
  type: "stringSet";
  default: string[];
  allowed: string[];
};

export type ChoiceSettingDefinition = SettingBase & {
  type: "choice";
  default: string;
  choices: string[];
};

/** Host booleans are disable-only: false never becomes true downstream. */
export type BooleanSettingDefinition = SettingBase & {
  type: "boolean";
  default: boolean;
};

export type ProviderSettingDefinition = SettingBase & {
  type: "provider";
  capability: string;
  allowedProviders: string[];
  default?: string;
  /** Same-namespace boolean setting that must be effective before selection. */
  enabledBy?: string;
};

export type SettingDefinition =
  | IntegerSettingDefinition
  | StringSetSettingDefinition
  | ChoiceSettingDefinition
  | BooleanSettingDefinition
  | ProviderSettingDefinition;

export type SettingsDefinitionSource = {
  schemaVersion: 1;
  kind: "settingsDefinition";
  namespace: string;
  settings: SettingDefinition[];
};

export type SettingsProviderSource = {
  schemaVersion: 1;
  kind: "settingsProvider";
  provider: string;
  capabilities: string[];
};

export type OwnedSettingsSource<T> = {
  document: T;
  owner: SettingsOwner;
  /** Stable repo/plugin-relative provenance; never an absolute machine path. */
  source: string;
};

type EffectiveSettingBase = {
  owner: SettingsOwner;
  source: string;
};

export type EffectiveSetting =
  | (EffectiveSettingBase & { type: "integer"; value: number })
  | (EffectiveSettingBase & { type: "stringSet"; value: string[] })
  | (EffectiveSettingBase & { type: "choice"; value: string })
  | (EffectiveSettingBase & { type: "boolean"; value: boolean })
  | (EffectiveSettingBase & {
      type: "provider";
      value: string | null;
      capability: string;
    });

export type EffectiveSettingsPolicy = {
  version: 1;
  settings: Record<string, EffectiveSetting>;
  providers: Record<string, {
    capabilities: string[];
    owner: SettingsOwner;
    source: string;
  }>;
};

export type SettingsPluginEntry = {
  spec: string;
  plugin: { name: string };
};

const FQ_SETTING_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z][a-z0-9]*)*\.[A-Za-z][A-Za-z0-9_-]*$/;

function ownerKey(owner: SettingsOwner): string {
  return `${owner.kind}:${owner.id}`;
}

function assertUniqueStrings(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${path} must not contain duplicate values.`);
  }
}

function assertSafeInteger(value: number, path: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${path} must be a safe integer.`);
  }
}

function validateDefinition(
  fqKey: string,
  definition: SettingDefinition,
): void {
  if (!FQ_SETTING_PATTERN.test(fqKey)) {
    throw new Error(`Setting key "${fqKey}" is not a valid namespace.key.`);
  }
  switch (definition.type) {
    case "integer": {
      assertSafeInteger(definition.minimum, `${fqKey}.minimum`);
      assertSafeInteger(definition.maximum, `${fqKey}.maximum`);
      assertSafeInteger(definition.default, `${fqKey}.default`);
      if (definition.minimum > definition.maximum) {
        throw new Error(`${fqKey}.minimum must not exceed its owner maximum.`);
      }
      if (definition.default < definition.minimum || definition.default > definition.maximum) {
        throw new Error(`${fqKey}.default must be within its owner minimum and maximum.`);
      }
      return;
    }
    case "stringSet": {
      assertUniqueStrings(definition.allowed, `${fqKey}.allowed`);
      assertUniqueStrings(definition.default, `${fqKey}.default`);
      const allowed = new Set(definition.allowed);
      const outside = definition.default.filter((value) => !allowed.has(value));
      if (outside.length > 0) {
        throw new Error(`${fqKey}.default contains value(s) outside its owner allowed set: ${outside.join(", ")}.`);
      }
      return;
    }
    case "choice":
      assertUniqueStrings(definition.choices, `${fqKey}.choices`);
      if (!definition.choices.includes(definition.default)) {
        throw new Error(`${fqKey}.default must be one of its owner choices.`);
      }
      return;
    case "boolean":
      return;
    case "provider":
      assertUniqueStrings(definition.allowedProviders, `${fqKey}.allowedProviders`);
      if (definition.default && !definition.allowedProviders.includes(definition.default)) {
        throw new Error(`${fqKey}.default must be in its owner allowedProviders.`);
      }
      return;
  }
}

function settingValue(
  fqKey: string,
  definition: Exclude<SettingDefinition, ProviderSettingDefinition>,
  selected: AuthoringSettingValue | undefined,
): number | string[] | string | boolean {
  switch (definition.type) {
    case "integer": {
      const value = selected ?? definition.default;
      if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw new Error(`Host setting "${fqKey}" must be a safe integer.`);
      }
      if (value < definition.minimum || value > definition.maximum) {
        throw new Error(
          `Host setting "${fqKey}" must remain within owner bounds ${definition.minimum}..${definition.maximum}.`,
        );
      }
      return value;
    }
    case "stringSet": {
      const value = selected ?? definition.default;
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        throw new Error(`Host setting "${fqKey}" must be a string array.`);
      }
      assertUniqueStrings(value, `Host setting "${fqKey}"`);
      const allowed = new Set(definition.allowed);
      const outside = value.filter((item) => !allowed.has(item));
      if (outside.length > 0) {
        throw new Error(
          `Host setting "${fqKey}" widens the owner allowed set with: ${outside.join(", ")}.`,
        );
      }
      return [...value].sort();
    }
    case "choice": {
      const value = selected ?? definition.default;
      if (typeof value !== "string" || !definition.choices.includes(value)) {
        throw new Error(`Host setting "${fqKey}" must be one of its owner choices.`);
      }
      return value;
    }
    case "boolean": {
      const value = selected ?? definition.default;
      if (typeof value !== "boolean") {
        throw new Error(`Host setting "${fqKey}" must be a boolean.`);
      }
      if (value && !definition.default) {
        throw new Error(`Host setting "${fqKey}" cannot enable a capability its owner disabled.`);
      }
      return value;
    }
  }
}

/**
 * Applies host selections only after all owner definitions and provider
 * capabilities have been collected and validated.
 */
export function compileSettingsPolicy(
  definitions: readonly OwnedSettingsSource<SettingsDefinitionSource>[],
  providerSources: readonly OwnedSettingsSource<SettingsProviderSource>[],
  selected: Readonly<Record<string, AuthoringSettingValue>> = {},
): EffectiveSettingsPolicy {
  const providers = new Map<string, OwnedSettingsSource<SettingsProviderSource>>();
  for (const source of providerSources) {
    const provider = source.document.provider;
    if (providers.has(provider)) {
      throw new Error(`Settings provider "${provider}" is declared more than once.`);
    }
    assertUniqueStrings(source.document.capabilities, `Settings provider "${provider}" capabilities`);
    providers.set(provider, source);
  }

  const settings = new Map<string, {
    definition: SettingDefinition;
    owner: SettingsOwner;
    source: string;
    namespace: string;
  }>();
  const namespaceOwners = new Map<string, SettingsOwner>();
  for (const source of definitions) {
    const namespace = source.document.namespace;
    const priorOwner = namespaceOwners.get(namespace);
    if (priorOwner && ownerKey(priorOwner) !== ownerKey(source.owner)) {
      throw new Error(
        `Settings namespace "${namespace}" is owned by both ${ownerKey(priorOwner)} and ${ownerKey(source.owner)}.`,
      );
    }
    namespaceOwners.set(namespace, source.owner);
    for (const definition of source.document.settings) {
      const fqKey = `${namespace}.${definition.key}`;
      validateDefinition(fqKey, definition);
      if (settings.has(fqKey)) {
        throw new Error(
          `Setting "${fqKey}" is defined more than once; a later layer cannot replace its owner ceiling.`,
        );
      }
      settings.set(fqKey, {
        definition,
        owner: source.owner,
        source: source.source,
        namespace,
      });
    }
  }

  const unknown = Object.keys(selected).filter((key) => !settings.has(key)).sort();
  if (unknown.length > 0) {
    throw new Error(`Committed host settings contain unknown key(s): ${unknown.join(", ")}.`);
  }

  const effective = new Map<string, EffectiveSetting>();
  for (const fqKey of [...settings.keys()].sort()) {
    const entry = settings.get(fqKey)!;
    if (entry.definition.type === "provider") continue;
    const value = settingValue(fqKey, entry.definition, selected[fqKey]);
    effective.set(fqKey, {
      type: entry.definition.type,
      value,
      owner: entry.owner,
      source: entry.source,
    } as EffectiveSetting);
  }

  for (const fqKey of [...settings.keys()].sort()) {
    const entry = settings.get(fqKey)!;
    const definition = entry.definition;
    if (definition.type !== "provider") continue;
    let enabled = true;
    if (definition.enabledBy) {
      const gateKey = `${entry.namespace}.${definition.enabledBy}`;
      const gateDefinition = settings.get(gateKey)?.definition;
      const gate = effective.get(gateKey);
      if (gateDefinition?.type !== "boolean" || gate?.type !== "boolean") {
        throw new Error(`Setting "${fqKey}" enabledBy must name a boolean in the same namespace.`);
      }
      enabled = gate.value;
    }
    const hostSelection = selected[fqKey];
    if (!enabled) {
      if (hostSelection !== undefined) {
        throw new Error(`Host setting "${fqKey}" cannot select a provider while its owner gate is disabled.`);
      }
      effective.set(fqKey, {
        type: "provider",
        value: null,
        capability: definition.capability,
        owner: entry.owner,
        source: entry.source,
      });
      continue;
    }
    const value = hostSelection ?? definition.default;
    if (typeof value !== "string") {
      throw new Error(`Host setting "${fqKey}" must select an owner-allowed provider.`);
    }
    if (!definition.allowedProviders.includes(value)) {
      throw new Error(`Host setting "${fqKey}" selects provider "${value}" outside its owner allowlist.`);
    }
    const registration = providers.get(value);
    if (!registration || !registration.document.capabilities.includes(definition.capability)) {
      throw new Error(
        `Host setting "${fqKey}" selects provider "${value}", but it does not declare capability "${definition.capability}".`,
      );
    }
    effective.set(fqKey, {
      type: "provider",
      value,
      capability: definition.capability,
      owner: entry.owner,
      source: entry.source,
    });
  }

  return {
    version: 1,
    settings: Object.fromEntries([...effective.entries()].sort(([left], [right]) => left.localeCompare(right))),
    providers: Object.fromEntries(
      [...providers.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([provider, source]) => [provider, {
          capabilities: [...source.document.capabilities].sort(),
          owner: source.owner,
          source: source.source,
        }]),
    ),
  };
}

function yamlFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      if (entry.isFile() && (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml"))) {
        files.push(path);
      }
    }
  };
  walk(root);
  return files.sort();
}

function stableLayerId(spec: string, index: number): string {
  if (isAbsolute(spec)) return `committed-layer-${index + 1}`;
  return spec.replaceAll("\\", "/").replace(/^\.\//, "");
}

function stableSource(
  repoRoot: string,
  layerDir: string,
  file: string,
  owner: SettingsOwner,
): string {
  if (owner.kind === "plugin") {
    return `plugin:${owner.id}/authoring/${relative(layerDir, file).split(sep).join("/")}`;
  }
  const repoRelative = relative(repoRoot, file);
  if (repoRelative && !repoRelative.startsWith("..") && !isAbsolute(repoRelative)) {
    return repoRelative.split(sep).join("/");
  }
  return `layer:${owner.id}/${relative(layerDir, file).split(sep).join("/")}`;
}

function readSources(
  repoRoot: string,
  layerDir: string,
  owner: SettingsOwner,
): {
  definitions: OwnedSettingsSource<SettingsDefinitionSource>[];
  providers: OwnedSettingsSource<SettingsProviderSource>[];
} {
  const definitions: OwnedSettingsSource<SettingsDefinitionSource>[] = [];
  const providers: OwnedSettingsSource<SettingsProviderSource>[] = [];
  for (const file of yamlFiles(join(layerDir, "settings"))) {
    const source = stableSource(repoRoot, layerDir, file, owner);
    const { document } = authoringValidator().validateFile(file, source);
    const candidate = document as { kind?: string };
    if (candidate.kind === "settingsDefinition") {
      definitions.push({ document: document as SettingsDefinitionSource, owner, source });
    } else if (candidate.kind === "settingsProvider") {
      providers.push({ document: document as SettingsProviderSource, owner, source });
    } else {
      throw new Error(`${source} is inside settings/ but has kind "${candidate.kind ?? "missing"}".`);
    }
  }
  return { definitions, providers };
}

function localSettingsFiles(
  repoRoot: string,
  effectiveConfig: AuthoringConfig,
  committedConfig: AuthoringConfig,
): string[] {
  const files: string[] = [];
  for (const layer of effectiveConfig.layers.slice(committedConfig.layers.length)) {
    const layerDir = resolveLayerDir(repoRoot, layer);
    files.push(...yamlFiles(join(layerDir, "settings")).map((file) => relative(layerDir, file)));
  }
  for (const spec of (effectiveConfig.plugins ?? []).slice((committedConfig.plugins ?? []).length)) {
    const layerDir = pluginAuthoringDir(repoRoot, spec);
    if (layerDir) {
      files.push(...yamlFiles(join(layerDir, "settings")).map((file) => relative(layerDir, file)));
    }
  }
  return files.sort();
}

export function loadSettingsPolicy(
  repoRoot: string,
  effectiveConfig: AuthoringConfig,
  pluginEntries: readonly SettingsPluginEntry[],
): EffectiveSettingsPolicy {
  const committed = loadCommittedAuthoringConfig(repoRoot);
  const localFiles = localSettingsFiles(repoRoot, effectiveConfig, committed);
  if (localFiles.length > 0) {
    throw new Error(
      `${AUTHORING_LOCAL_CONFIG_FILENAME} may not add settings definitions or providers: ${localFiles.join(", ")}.`,
    );
  }

  const definitions: OwnedSettingsSource<SettingsDefinitionSource>[] = [];
  const providers: OwnedSettingsSource<SettingsProviderSource>[] = [];
  const collect = (sources: ReturnType<typeof readSources>) => {
    definitions.push(...sources.definitions);
    providers.push(...sources.providers);
  };

  committed.layers.forEach((spec, index) => {
    const owner: SettingsOwner = { kind: "layer", id: stableLayerId(spec, index) };
    collect(readSources(repoRoot, resolveLayerDir(repoRoot, spec), owner));
  });
  const entryBySpec = new Map(pluginEntries.map((entry) => [entry.spec, entry]));
  for (const spec of committed.plugins ?? []) {
    const entry = entryBySpec.get(spec);
    if (!entry) {
      throw new Error(`Committed settings plugin "${spec}" was not loaded.`);
    }
    const layerDir = pluginAuthoringDir(repoRoot, spec);
    if (layerDir) {
      collect(readSources(repoRoot, layerDir, { kind: "plugin", id: entry.plugin.name }));
    }
  }

  return compileSettingsPolicy(definitions, providers, committed.settings ?? {});
}

export function renderSettingsPolicy(policy: EffectiveSettingsPolicy): string {
  return `${JSON.stringify(policy, null, 2)}\n`;
}
