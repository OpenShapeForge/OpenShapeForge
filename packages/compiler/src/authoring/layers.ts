// SPDX-License-Identifier: BUSL-1.1
/**
 * Layered authoring resolution — Kustomize-style bases and overlays.
 *
 * A repo declares its authoring sources in `authoring.config.yaml` at the
 * repo root:
 *
 *   layers:
 *     - packages/compiler/config/authoring        # base
 *     - authoring/overlays/my-overlay             # overlay (optional, many)
 *
 * A deployment appends its own in `authoring.config.local.yaml`, git-ignored
 * and append-only, so an extension that lives in another repository can be
 * mounted without this one declaring it. See
 * AUTHORING_LOCAL_CONFIG_FILENAME below.
 *
 * Layers are applied in order. An overlay may:
 *   - add new files anywhere (entities, contexts, mappings, views, catalogs)
 *   - patch an entity from an earlier layer by shipping a file with the SAME
 *     slug and `kind: entityPatch` — a strategic merge (objects deep-merge,
 *     keyed arrays merge by `key`/`id`, `$delete: true` removes a keyed item,
 *     explicit `null` removes an object property)
 *   - patch the app shell with `kind: appShellPatch`, the same strategic merge
 *     against `menu.yaml`. This is how a PLUGIN contributes a sidebar
 *     entry: `sidebarItems` is a keyed array, so a patch appends its own entry
 *     without restating anyone else's. Without it a plugin could emit a route
 *     file and have nothing in the app link to it, because shipping
 *     `menu.yaml` outright collides.
 *   - patch a realm file with `kind: authorizationPatch` at the SAME path as
 *     the `authorization*.yaml` it targets: rename a client (`renameClient`),
 *     add or amend clients, widen realm-role composites — without forking the
 *     base realm. See ./authorization-patch.ts for the exact rules.
 *
 * Catalog files (`catalogs/*.yaml`) merge across layers automatically: a
 * later layer's file with the same path strategically merges into the earlier
 * one, so an overlay can add referentiedata groups or transforms without
 * copying the base catalog. For every other path, shipping a plain file that
 * already exists in an earlier layer is an error — replacing wholesale is
 * almost always a mistake; patch instead.
 *
 * With a single layer and no patches the layer directory is used directly
 * (fast path, byte-identical to the pre-layer behavior). Otherwise the merged
 * tree is materialized deterministically under `.authoring-build/` at the
 * repo root so the resolved input is inspectable, exactly like running
 * `kustomize build`.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import YAML from "yaml";
import { packagedConfigFallback } from "../packaged-config.js";
import {
  AUTHORIZATION_PATCH_KIND,
  applyAuthorizationPatch,
  isAuthorizationFilePath,
} from "./authorization-patch.js";

export type AuthoringConfig = {
  layers: string[];
  /** Compiler plugin module specifiers (see ../plugins.ts). */
  plugins?: string[];
  /** Host-owned developer onboarding rendered in the generated REST OpenAPI document. */
  restApi?: RestApiDocumentation;
  /** Committed host selections for settings defined by their owning source. */
  settings?: Record<string, AuthoringSettingValue>;
};

export type AuthoringSettingValue = boolean | number | string | string[];

type ParsedAuthoringConfig = AuthoringConfig & {
  plugins: string[];
};

export type RestApiDocumentation = {
  title: string;
  version?: string;
  description: string;
  /** Optional guidance shown beside manual bearer entry in Swagger UI. */
  bearerDescription?: string;
  /** Public Authorization Code client metadata used by OpenAPI and Swagger UI. */
  oauth2?: RestApiOAuth2Documentation;
  externalDocs?: {
    description?: string;
    url: string;
  };
};

export type RestApiOAuth2Documentation = {
  description: string;
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes: Record<string, string>;
  /** Absolute public callback URL when origin inference is not suitable. */
  redirectUrl?: string;
};

export const AUTHORING_CONFIG_FILENAME = "authoring.config.yaml";
/**
 * Deployment-local addendum to the committed config, git-ignored.
 *
 * It exists so a deployment can mount an authoring extension that this
 * repository must never name. Sector standards are the case in point: they
 * ship as their own repository or package, contribute their own reference
 * data and entity patches, and are added HERE rather than to the committed
 * layer list — which would put the extension back into core by reference.
 *
 * It can only APPEND. Nothing in it can remove, reorder or replace a
 * committed layer or plugin: a local file that could drop the base layer
 * would turn "my machine builds something different" into a silent state
 * rather than an additive one. Extensions belong last regardless, since a
 * later layer is the one that gets to patch earlier ones.
 */
export const AUTHORING_LOCAL_CONFIG_FILENAME = "authoring.config.local.yaml";
const DEFAULT_LAYER = "packages/compiler/config/authoring";
const BUILD_DIR = ".authoring-build";

function readConfigFile(
  path: string,
  filename: string,
  {
    requireLayers,
    allowRestApi,
    allowSettings,
  }: { requireLayers: boolean; allowRestApi: boolean; allowSettings: boolean },
): ParsedAuthoringConfig {
  const parsed = YAML.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${filename} must be an object.`);
  }
  const candidate = parsed as Record<string, unknown>;
  const allowedKeys = ["layers", "plugins", "restApi", "settings"];
  const unknownKeys = Object.keys(candidate).filter((key) => !allowedKeys.includes(key));
  if (unknownKeys.length > 0) {
    throw new Error(`${filename} has unknown field(s): ${unknownKeys.sort().join(", ")}.`);
  }
  const layers = candidate.layers ?? (requireLayers ? undefined : []);
  const invalidLayers =
    !Array.isArray(layers) ||
    (requireLayers && layers.length === 0) ||
    layers.some((entry) => typeof entry !== "string");
  if (invalidLayers) {
    throw new Error(
      requireLayers
        ? `${filename} must declare a non-empty string array "layers".`
        : `${filename} "layers" must be a string array.`,
    );
  }
  const plugins = candidate.plugins ?? [];
  if (!Array.isArray(plugins) || plugins.some((entry) => typeof entry !== "string")) {
    throw new Error(`${filename} "plugins" must be a string array.`);
  }
  if (!allowRestApi && candidate.restApi !== undefined) {
    throw new Error(
      `${filename} cannot declare "restApi"; developer onboarding belongs in the committed config.`,
    );
  }
  if (!allowSettings && candidate.settings !== undefined) {
    throw new Error(
      `${filename} cannot declare "settings"; effective settings must be selected in the committed config.`,
    );
  }
  const restApi = candidate.restApi === undefined
    ? undefined
    : validateRestApiDocumentation(candidate.restApi, filename);
  const settings = candidate.settings === undefined
    ? undefined
    : validateAuthoringSettings(candidate.settings, filename);
  return {
    layers: layers as string[],
    plugins: plugins as string[],
    ...(restApi ? { restApi } : {}),
    ...(settings ? { settings } : {}),
  };
}

function validateAuthoringSettings(
  value: unknown,
  filename: string,
): Record<string, AuthoringSettingValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${filename} "settings" must be an object.`);
  }
  const settings: Record<string, AuthoringSettingValue> = {};
  for (const [key, setting] of Object.entries(value as Record<string, unknown>)) {
    const valid =
      typeof setting === "boolean" ||
      typeof setting === "number" ||
      typeof setting === "string" ||
      (Array.isArray(setting) && setting.every((item) => typeof item === "string"));
    if (!valid) {
      throw new Error(
        `${filename} setting "${key}" must be a boolean, number, string, or string array.`,
      );
    }
    settings[key] = Array.isArray(setting) ? [...setting] : setting;
  }
  return settings;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string.`);
  }
  return value.trim();
}

function validateRestApiDocumentation(
  value: unknown,
  filename: string,
): RestApiDocumentation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${filename} "restApi" must be an object.`);
  }
  const candidate = value as Record<string, unknown>;
  const unknownKeys = Object.keys(candidate).filter(
    (key) => ![
      "title",
      "version",
      "description",
      "bearerDescription",
      "oauth2",
      "externalDocs",
    ].includes(key),
  );
  if (unknownKeys.length > 0) {
    throw new Error(`${filename} "restApi" has unknown field(s): ${unknownKeys.sort().join(", ")}.`);
  }

  let externalDocs: RestApiDocumentation["externalDocs"];
  if (candidate.externalDocs !== undefined) {
    if (
      !candidate.externalDocs ||
      typeof candidate.externalDocs !== "object" ||
      Array.isArray(candidate.externalDocs)
    ) {
      throw new Error(`${filename} "restApi.externalDocs" must be an object.`);
    }
    const docs = candidate.externalDocs as Record<string, unknown>;
    const unknownDocKeys = Object.keys(docs).filter(
      (key) => !["description", "url"].includes(key),
    );
    if (unknownDocKeys.length > 0) {
      throw new Error(
        `${filename} "restApi.externalDocs" has unknown field(s): ${unknownDocKeys.sort().join(", ")}.`,
      );
    }
    const url = absoluteHttpUrl(docs.url, `${filename} "restApi.externalDocs.url"`);
    externalDocs = {
      url,
      ...(docs.description === undefined
        ? {}
        : {
            description: nonEmptyString(
              docs.description,
              `${filename} "restApi.externalDocs.description"`,
            ),
          }),
    };
  }

  let oauth2: RestApiOAuth2Documentation | undefined;
  if (candidate.oauth2 !== undefined) {
    if (!candidate.oauth2 || typeof candidate.oauth2 !== "object" || Array.isArray(candidate.oauth2)) {
      throw new Error(`${filename} "restApi.oauth2" must be an object.`);
    }
    const oauth = candidate.oauth2 as Record<string, unknown>;
    const unknownOAuthKeys = Object.keys(oauth).filter(
      (key) => ![
        "description",
        "authorizationUrl",
        "tokenUrl",
        "clientId",
        "scopes",
        "redirectUrl",
      ].includes(key),
    );
    if (unknownOAuthKeys.length > 0) {
      throw new Error(
        `${filename} "restApi.oauth2" has unknown field(s): ${unknownOAuthKeys.sort().join(", ")}.`,
      );
    }
    if (!oauth.scopes || typeof oauth.scopes !== "object" || Array.isArray(oauth.scopes)) {
      throw new Error(`${filename} "restApi.oauth2.scopes" must be an object.`);
    }
    const scopes = Object.fromEntries(
      Object.entries(oauth.scopes as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([scope, description]) => {
          if (!/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(scope)) {
            throw new Error(
              `${filename} "restApi.oauth2.scopes" contains invalid OAuth scope "${scope}".`,
            );
          }
          return [
            scope,
            nonEmptyString(
              description,
              `${filename} "restApi.oauth2.scopes.${scope}"`,
            ),
          ];
        }),
    );
    if (Object.keys(scopes).length === 0) {
      throw new Error(`${filename} "restApi.oauth2.scopes" must declare at least one scope.`);
    }
    oauth2 = {
      description: nonEmptyString(oauth.description, `${filename} "restApi.oauth2.description"`),
      authorizationUrl: absoluteHttpUrl(
        oauth.authorizationUrl,
        `${filename} "restApi.oauth2.authorizationUrl"`,
      ),
      tokenUrl: absoluteHttpUrl(oauth.tokenUrl, `${filename} "restApi.oauth2.tokenUrl"`),
      clientId: nonEmptyString(oauth.clientId, `${filename} "restApi.oauth2.clientId"`),
      scopes,
      ...(oauth.redirectUrl === undefined
        ? {}
        : {
            redirectUrl: absoluteHttpUrl(
              oauth.redirectUrl,
              `${filename} "restApi.oauth2.redirectUrl"`,
            ),
          }),
    };
  }

  return {
    title: nonEmptyString(candidate.title, `${filename} "restApi.title"`),
    description: nonEmptyString(candidate.description, `${filename} "restApi.description"`),
    ...(candidate.version === undefined
      ? {}
      : { version: nonEmptyString(candidate.version, `${filename} "restApi.version"`) }),
    ...(candidate.bearerDescription === undefined
      ? {}
      : {
          bearerDescription: nonEmptyString(
            candidate.bearerDescription,
            `${filename} "restApi.bearerDescription"`,
          ),
        }),
    ...(oauth2 ? { oauth2 } : {}),
    ...(externalDocs ? { externalDocs } : {}),
  };
}

function absoluteHttpUrl(value: unknown, path: string): string {
  const url = nonEmptyString(value, path);
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`${path} must be an absolute HTTP(S) URL.`);
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error(`${path} must be an absolute HTTP(S) URL.`);
  }
  if (parsedUrl.username || parsedUrl.password) {
    throw new Error(`${path} must not contain credentials.`);
  }
  return url;
}

export function loadCommittedAuthoringConfig(repoRoot: string): ParsedAuthoringConfig {
  const configPath = join(repoRoot, AUTHORING_CONFIG_FILENAME);
  return existsSync(configPath)
    ? readConfigFile(configPath, AUTHORING_CONFIG_FILENAME, {
        requireLayers: true,
        allowRestApi: true,
        allowSettings: true,
      })
    : { layers: [DEFAULT_LAYER], plugins: [] };
}

export function loadAuthoringConfig(repoRoot: string): AuthoringConfig {
  const base = loadCommittedAuthoringConfig(repoRoot);

  const localPath = join(repoRoot, AUTHORING_LOCAL_CONFIG_FILENAME);
  if (!existsSync(localPath)) {
    return {
      layers: base.layers,
      plugins: base.plugins,
      ...(base.restApi ? { restApi: base.restApi } : {}),
      ...(base.settings ? { settings: base.settings } : {}),
    };
  }
  const local = readConfigFile(localPath, AUTHORING_LOCAL_CONFIG_FILENAME, {
    requireLayers: false,
    allowRestApi: false,
    allowSettings: false,
  });

  // A duplicate is refused rather than de-duplicated. Appending a layer that
  // is already committed would move it to the end of the order, silently
  // changing which layer patches which — the opposite of what someone adding
  // an extension is asking for.
  for (const [kind, committed, added] of [
    ["layer", base.layers, local.layers],
    ["plugin", base.plugins, local.plugins],
  ] as const) {
    const duplicate = added.find((entry) => committed.includes(entry));
    if (duplicate) {
      throw new Error(
        `${AUTHORING_LOCAL_CONFIG_FILENAME} re-declares the ${kind} "${duplicate}", which ` +
          `${AUTHORING_CONFIG_FILENAME} already declares. The local file only appends; ` +
          `remove the duplicate rather than restating it.`,
      );
    }
  }

  if (local.layers.length > 0 || local.plugins.length > 0) {
    // Generated artifacts are committed and gate-checked, so a build carrying
    // extra layers must not look like an ordinary one. CI never has this file;
    // a developer who does needs to know before `bun run generate` writes an
    // artifact set nobody else can reproduce.
    const added = [
      ...local.layers.map((entry) => `layer ${entry}`),
      ...local.plugins.map((entry) => `plugin ${entry}`),
    ].join(", ");
    console.warn(
      `[authoring] ${AUTHORING_LOCAL_CONFIG_FILENAME} is active: ${added}. ` +
        `Generated artifacts will include it — do not commit them.`,
    );
  }

  return {
    layers: [...base.layers, ...local.layers],
    plugins: [...base.plugins, ...local.plugins],
    ...(base.restApi ? { restApi: base.restApi } : {}),
    ...(base.settings ? { settings: base.settings } : {}),
  };
}

/**
 * A plugin may ship its own authoring layer: an `authoring/` directory next
 * to the plugin module (local specs) or at the package root (package specs).
 * Resolved synchronously — the plugin CODE is imported separately.
 */
export function pluginAuthoringDir(repoRoot: string, spec: string): string | null {
  let moduleDir: string | null = null;
  if (spec.startsWith(".") || isAbsolute(spec)) {
    const asPath = isAbsolute(spec) ? spec : resolve(repoRoot, spec);
    if (existsSync(asPath)) {
      moduleDir = asPath.endsWith(".ts") || asPath.endsWith(".js")
        ? resolve(asPath, "..")
        : asPath;
    }
  } else {
    try {
      moduleDir = resolve(Bun.resolveSync(`${spec}/package.json`, repoRoot), "..");
    } catch {
      moduleDir = null;
    }
  }
  if (!moduleDir) return null;
  const authoring = join(moduleDir, "authoring");
  return existsSync(authoring) ? authoring : null;
}

/**
 * Resolves a layer entry to an absolute directory: repo-relative or absolute
 * paths first; then, for a `packages/compiler/...` entry a host repo does not
 * mirror, the copy packaged with the compiler (which is how the implicit base
 * layer works outside this monorepo); then a bare package specifier whose
 * package root contains an `authoring/` directory (so contexts can ship as
 * workspace packages).
 */
export function resolveLayerDir(repoRoot: string, layer: string): string {
  const asPath = isAbsolute(layer) ? layer : resolve(repoRoot, layer);
  if (existsSync(asPath)) {
    return asPath;
  }
  // A host repo that consumes the compiler as a package rarely mirrors the
  // compiler's own config tree; a `packages/compiler/...` layer (notably the
  // implicit base layer) falls back to the copy packaged with the compiler.
  if (!isAbsolute(layer)) {
    const packaged = packagedConfigFallback(layer);
    if (packaged) {
      return packaged;
    }
  }
  try {
    const packageJson = Bun.resolveSync(`${layer}/package.json`, repoRoot);
    const packageAuthoring = join(packageJson, "..", "authoring");
    if (existsSync(packageAuthoring)) {
      return packageAuthoring;
    }
    throw new Error(`package "${layer}" has no authoring/ directory`);
  } catch (error) {
    throw new Error(
      `Authoring layer "${layer}" is neither a directory (relative to ${repoRoot}) ` +
        `nor a resolvable package with an authoring/ directory. ${String(error)}`,
    );
  }
}

function walkFiles(root: string, current = root): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(root, fullPath));
    } else if (entry.isFile()) {
      results.push(relative(root, fullPath));
    }
  }
  return results.sort();
}

// ---------------------------------------------------------------------------
// Strategic merge
// ---------------------------------------------------------------------------

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const CRUD_OPERATION_KEYS = ["list", "get", "create", "update", "delete"] as const;

function isPlainObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ARRAY_MERGE_KEYS = ["key", "id", "value", "title"] as const;
type ArrayMergeKey = (typeof ARRAY_MERGE_KEYS)[number];

/**
 * Locales localized text may carry, in the order one of them stands in for
 * the whole text. Every entity authors in English (`language: en`), so the
 * English text is the one a patch author can rely on restating.
 */
const LOCALIZED_TEXT_IDENTITY_ORDER = ["en", "nl", "fr"] as const;

/**
 * What identifies `item` in a keyed array under `mergeKey`, or null when the
 * item carries no usable key. `key`, `id` and `value` are plain strings.
 * `title` is what view groups (record tabs, create and update modes) are keyed
 * by, and a group title is localized text rather than a string: two groups are
 * the same group when their authoring-language text agrees. Matching on one
 * locale is deliberate — a patch that restates `title: { en: Membership }`
 * must find `{ en: Membership, nl: Lidmaatschap }` and refine it, not append a
 * look-alike twin beside it. Without this key every layout tweak had to
 * restate all of a tab's groups, which is exactly how a patch drifts from its
 * base.
 */
function mergeKeyIdentity(item: JsonValue, mergeKey: ArrayMergeKey): string | null {
  if (!isPlainObject(item)) return null;
  const value = item[mergeKey];
  if (typeof value === "string") return value;
  if (mergeKey === "title" && isPlainObject(value)) {
    for (const locale of LOCALIZED_TEXT_IDENTITY_ORDER) {
      const text = value[locale];
      if (typeof text === "string") return `${locale}:${text}`;
    }
  }
  return null;
}

function arrayMergeKey(items: JsonValue[]): ArrayMergeKey | null {
  for (const candidate of ARRAY_MERGE_KEYS) {
    if (
      items.length > 0 &&
      items.every((item) => mergeKeyIdentity(item, candidate) !== null)
    ) {
      return candidate;
    }
  }
  return null;
}

/**
 * Kustomize-style strategic merge:
 * - objects deep-merge; a patch property with value `null` deletes the key
 * - arrays whose items all carry a `key`, `id`, `value` or (localized)
 *   `title` merge by it, in that priority order; a patch item with
 *   `$delete: true` removes the base item; new keys append
 * - all other arrays are replaced wholesale
 */
export function strategicMerge(base: JsonValue, patch: JsonValue): JsonValue {
  if (isPlainObject(base) && isPlainObject(patch)) {
    const result: { [key: string]: JsonValue } = { ...base };
    for (const [key, patchValue] of Object.entries(patch)) {
      if (patchValue === null) {
        delete result[key];
      } else if (key in result) {
        result[key] = strategicMerge(result[key]!, patchValue);
      } else {
        result[key] = patchValue;
      }
    }
    return result;
  }

  if (Array.isArray(base) && Array.isArray(patch)) {
    const mergeKey = arrayMergeKey(base) ?? arrayMergeKey(patch);
    if (mergeKey) {
      const result: JsonValue[] = [...base];
      for (const patchItem of patch) {
        const identity = mergeKeyIdentity(patchItem, mergeKey);
        if (!isPlainObject(patchItem) || identity === null) {
          throw new Error(
            `Patch array items must carry a "${mergeKey}" to merge into a keyed array.`,
          );
        }
        const index = result.findIndex(
          (item) => mergeKeyIdentity(item, mergeKey) === identity,
        );
        if (patchItem.$delete === true) {
          if (index >= 0) result.splice(index, 1);
          continue;
        }
        if (index >= 0) {
          result[index] = strategicMerge(result[index]!, patchItem);
        } else {
          result.push(patchItem);
        }
      }
      return result;
    }
    return patch;
  }

  return patch;
}

type JsonObject = { [key: string]: JsonValue };

function stableJson(value: JsonValue | undefined): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameJson(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  return stableJson(left) === stableJson(right);
}

function objectProperty(value: JsonValue | undefined, key: string): JsonObject | undefined {
  if (!isPlainObject(value)) return undefined;
  const property = value[key];
  return isPlainObject(property) ? property : undefined;
}

function stringList(value: JsonValue | undefined): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function assertOrListOnlyNarrows(
  before: JsonValue | undefined,
  after: JsonValue | undefined,
  path: string,
  origin: string,
): void {
  const prior = stringList(before);
  if (!prior) return;
  const next = stringList(after);
  if (!next || next.some((item) => !prior.includes(item))) {
    throw new Error(
      `${origin} widens ${path}. OR-authorized values may only be removed by a later layer.`,
    );
  }
}

function assertAndListOnlyNarrows(
  before: JsonValue | undefined,
  after: JsonValue | undefined,
  path: string,
  origin: string,
): void {
  const prior = stringList(before);
  if (!prior) return;
  const next = stringList(after);
  if (!next || prior.some((item) => !next.includes(item))) {
    throw new Error(
      `${origin} widens ${path}. Every required value from an earlier layer must remain required.`,
    );
  }
}

function assertExactWhenPresent(
  before: JsonValue | undefined,
  after: JsonValue | undefined,
  path: string,
  origin: string,
): void {
  if (before !== undefined && !sameJson(before, after)) {
    throw new Error(
      `${origin} changes ${path} declared by an earlier layer. This security contract is not ` +
        "orderable, so entity patches must preserve it exactly.",
    );
  }
}

function assertLegacyInterfaceOnlyNarrows(
  base: JsonObject,
  merged: JsonObject,
  interfaceKey: "rest" | "mcp",
  origin: string,
): void {
  const resolve = (document: JsonObject, operation: (typeof CRUD_OPERATION_KEYS)[number]): boolean => {
    const value = document[interfaceKey];
    if (value === true) return true;
    if (!isPlainObject(value) || value.enabled === false) return false;
    const configured = objectProperty(value, "operations");
    return configured?.[operation] !== false;
  };
  const widened = CRUD_OPERATION_KEYS.filter(
    (operation) => !resolve(base, operation) && resolve(merged, operation),
  );
  if (widened.length > 0) {
    throw new Error(
      `${origin} widens ${interfaceKey} exposure (${widened.join(", ")}) disabled by an earlier layer.`,
    );
  }
}

function assertRoleMapsOnlyNarrow(
  base: JsonObject | undefined,
  merged: JsonObject | undefined,
  keys: readonly string[],
  path: string,
  origin: string,
): void {
  if (!base) return;
  for (const key of keys) {
    assertOrListOnlyNarrows(base[key], merged?.[key], `${path}.${key}`, origin);
  }
}

function keyedObjects(value: JsonValue | undefined, key = "key"): Map<string, JsonObject> {
  const result = new Map<string, JsonObject>();
  if (!Array.isArray(value)) return result;
  for (const item of value) {
    if (isPlainObject(item) && typeof item[key] === "string") {
      result.set(item[key] as string, item);
    }
  }
  return result;
}

function assertFieldsOnlyNarrow(base: JsonObject, merged: JsonObject, origin: string): void {
  const beforeFields = keyedObjects(base.fields);
  const afterFields = keyedObjects(merged.fields);
  for (const [key, before] of beforeFields) {
    const after = afterFields.get(key);
    if (!after) continue;

    assertRoleMapsOnlyNarrow(
      objectProperty(before, "permissions"),
      objectProperty(after, "permissions"),
      ["read", "write"],
      `fields.${key}.permissions`,
      origin,
    );
    assertRoleMapsOnlyNarrow(
      objectProperty(objectProperty(before, "authorization"), "roles"),
      objectProperty(objectProperty(after, "authorization"), "roles"),
      ["read", "write"],
      `fields.${key}.authorization.roles`,
      origin,
    );

    if (before.immutable === true && after.immutable !== true) {
      throw new Error(`${origin} removes fields.${key}.immutable declared by an earlier layer.`);
    }
    assertOrListOnlyNarrows(before.writtenBy, after.writtenBy, `fields.${key}.writtenBy`, origin);
  }
}

function resolvedRowEmpty(rowAccess: JsonObject): "public" | "restricted" {
  return rowAccess.owner !== undefined || rowAccess.empty === "restricted"
    ? "restricted"
    : "public";
}

function assertRowAccessOnlyNarrows(base: JsonObject, merged: JsonObject, origin: string): void {
  const before = objectProperty(objectProperty(base, "authorization"), "rowAccess");
  if (!before || before.enabled !== true) return;
  const after = objectProperty(objectProperty(merged, "authorization"), "rowAccess");
  if (!after || after.enabled !== true) {
    throw new Error(`${origin} removes authorization.rowAccess enabled by an earlier layer.`);
  }
  if (resolvedRowEmpty(before) === "restricted" && resolvedRowEmpty(after) !== "restricted") {
    throw new Error(`${origin} widens authorization.rowAccess.empty from restricted to public.`);
  }

  const priorAxes = (["owner", "group"] as const).filter((axis) => before[axis] !== undefined);
  const nextAxes = (["owner", "group"] as const).filter((axis) => after[axis] !== undefined);
  if (
    priorAxes.length > 0 &&
    (nextAxes.length === 0 || nextAxes.some((axis) => !priorAxes.includes(axis)))
  ) {
    throw new Error(
      `${origin} widens authorization.rowAccess owner/group OR branches declared by an earlier layer.`,
    );
  }
  for (const axis of priorAxes) {
    if (after[axis] !== undefined) {
      assertExactWhenPresent(
        before[axis],
        after[axis],
        `authorization.rowAccess.${axis}`,
        origin,
      );
    }
  }

  const beforeAcl = objectProperty(before, "recordPermissions");
  if (!beforeAcl) return;
  const afterAcl = objectProperty(after, "recordPermissions");
  if (!afterAcl) {
    throw new Error(`${origin} removes authorization.rowAccess.recordPermissions.`);
  }
  assertExactWhenPresent(
    beforeAcl.field,
    afterAcl.field,
    "authorization.rowAccess.recordPermissions.field",
    origin,
  );
  if (beforeAcl.empty === "restricted" && afterAcl.empty !== "restricted") {
    throw new Error(
      `${origin} widens authorization.rowAccess.recordPermissions.empty from restricted to public.`,
    );
  }
  assertAndListOnlyNarrows(
    beforeAcl.createRequires,
    afterAcl.createRequires,
    "authorization.rowAccess.recordPermissions.createRequires",
    origin,
  );

  const beforeField = keyedObjects(base.fields).get(String(beforeAcl.field));
  const afterField = keyedObjects(merged.fields).get(String(afterAcl.field));
  if (!beforeField || !afterField) {
    throw new Error(
      `${origin} removes the authorization.rowAccess.recordPermissions field declared by an earlier layer.`,
    );
  }
  assertExactWhenPresent(
    beforeField.defaultValue,
    afterField.defaultValue,
    `fields.${String(beforeAcl.field)}.defaultValue`,
    origin,
  );
}

function assertConfirmationOnlyNarrows(
  before: JsonValue | undefined,
  after: JsonValue | undefined,
  path: string,
  origin: string,
): void {
  if (!isPlainObject(before)) return;
  if (!isPlainObject(after)) {
    throw new Error(`${origin} removes ${path} declared by an earlier layer.`);
  }
  const rank = { none: 0, acknowledgement: 1, challenge: 2 } as const;
  const beforeMode = typeof before.mode === "string" ? before.mode : "";
  const afterMode = typeof after.mode === "string" ? after.mode : "";
  const beforeRank = rank[beforeMode as keyof typeof rank];
  const afterRank = rank[afterMode as keyof typeof rank];
  if (beforeRank === undefined || afterRank === undefined || afterRank < beforeRank) {
    throw new Error(`${origin} weakens ${path} declared by an earlier layer.`);
  }
  if (beforeMode === "challenge" && !sameJson(before, after)) {
    throw new Error(`${origin} changes ${path}.challenge declared by an earlier layer.`);
  }
}

function assertSessionAuthOnlyNarrows(
  before: JsonObject,
  after: JsonObject | undefined,
  path: string,
  origin: string,
): void {
  if (!after || after.mode !== "session") {
    throw new Error(`${origin} widens ${path} away from authenticated session authorization.`);
  }
  if (before.roles !== undefined) {
    assertOrListOnlyNarrows(before.roles, after.roles, `${path}.roles`, origin);
  }
  assertExactWhenPresent(before.roleGroups, after.roleGroups, `${path}.roleGroups`, origin);
  assertAndListOnlyNarrows(before.scopes, after.scopes, `${path}.scopes`, origin);
  assertExactWhenPresent(
    before.recordPermission,
    after.recordPermission,
    `${path}.recordPermission`,
    origin,
  );
}

function assertOperationOnlyNarrows(
  before: JsonObject,
  after: JsonObject | undefined,
  path: string,
  origin: string,
): void {
  if (!after) {
    throw new Error(`${origin} removes ${path} declared by an earlier layer.`);
  }
  for (const key of ["implementation", "target", "input", "effects", "reliability", "tenancy"] as const) {
    assertExactWhenPresent(before[key], after[key], `${path}.${key}`, origin);
  }

  const beforeAuth = objectProperty(before, "auth");
  const afterAuth = objectProperty(after, "auth");
  if (beforeAuth?.mode === "session") {
    assertSessionAuthOnlyNarrows(beforeAuth, afterAuth, `${path}.auth`, origin);
  } else if (beforeAuth?.mode === "public") {
    if (afterAuth?.mode !== "public" && afterAuth?.mode !== "session") {
      throw new Error(`${origin} changes ${path}.auth to an incomparable authorization mode.`);
    }
  } else if (beforeAuth) {
    assertExactWhenPresent(beforeAuth, afterAuth, `${path}.auth`, origin);
  }

  const beforeConcurrency = objectProperty(before, "concurrency");
  const afterConcurrency = objectProperty(after, "concurrency");
  for (const control of ["version", "editLease"] as const) {
    if (beforeConcurrency?.[control] !== undefined) {
      assertExactWhenPresent(
        beforeConcurrency[control],
        afterConcurrency?.[control],
        `${path}.concurrency.${control}`,
        origin,
      );
    }
  }
  assertConfirmationOnlyNarrows(before.confirmation, after.confirmation, `${path}.confirmation`, origin);
  assertExactWhenPresent(before.interaction, after.interaction, `${path}.interaction`, origin);

  if (before.prerequisites !== undefined) {
    if (!Array.isArray(before.prerequisites) || !Array.isArray(after.prerequisites)) {
      throw new Error(`${origin} removes ${path}.prerequisites declared by an earlier layer.`);
    }
    const afterItems = new Set(after.prerequisites.map(stableJson));
    if (before.prerequisites.some((item) => !afterItems.has(stableJson(item)))) {
      throw new Error(`${origin} widens ${path}.prerequisites by removing a required receipt.`);
    }
  }
}

function assertOperationsOnlyNarrow(base: JsonObject, merged: JsonObject, origin: string): void {
  const beforeOperations = objectProperty(base, "operations");
  if (!beforeOperations) return;
  const afterOperations = objectProperty(merged, "operations");
  for (const [key, before] of Object.entries(beforeOperations)) {
    if (isPlainObject(before)) {
      assertOperationOnlyNarrows(
        before,
        isPlainObject(afterOperations?.[key]) ? afterOperations[key] as JsonObject : undefined,
        `operations.${key}`,
        origin,
      );
    }
  }

  const beforeInterfaces = objectProperty(base, "interfaces");
  const afterInterfaces = objectProperty(merged, "interfaces");
  for (const interfaceKey of ["rest", "graphql", "mcp", "web"] as const) {
    const beforeInterface = isPlainObject(beforeInterfaces?.[interfaceKey])
      ? beforeInterfaces[interfaceKey] as JsonObject
      : undefined;
    const afterInterface = isPlainObject(afterInterfaces?.[interfaceKey])
      ? afterInterfaces[interfaceKey] as JsonObject
      : undefined;
    const beforeProjected = objectProperty(beforeInterface, "operations");
    const afterProjected = objectProperty(afterInterface, "operations");
    for (const operationKey of Object.keys(beforeOperations)) {
      const beforeEnabled = Boolean(beforeInterface) && beforeProjected?.[operationKey] !== false;
      const afterEnabled = Boolean(afterInterface) && afterProjected?.[operationKey] !== false;
      if (!beforeEnabled && afterEnabled) {
        throw new Error(
          `${origin} re-enables interfaces.${interfaceKey}.operations.${operationKey} disabled by an earlier layer.`,
        );
      }
    }
  }
}

/**
 * Entity patches are deployment composition, not a second authority source.
 * Security policy is therefore monotone across layers: OR grants may shrink,
 * AND requirements may grow and controls that cannot be safely ordered must
 * stay structurally equal. New plugin operations remain valid extension
 * points; these checks protect only contracts an earlier owner already set.
 */
function assertEntitySecurityOnlyNarrows(baseValue: JsonValue, mergedValue: JsonValue, origin: string): void {
  if (!isPlainObject(baseValue) || !isPlainObject(mergedValue)) return;
  const base = baseValue;
  const merged = mergedValue;

  assertLegacyInterfaceOnlyNarrows(base, merged, "rest", origin);
  assertLegacyInterfaceOnlyNarrows(base, merged, "mcp", origin);
  assertRoleMapsOnlyNarrow(
    objectProperty(base, "permissions"),
    objectProperty(merged, "permissions"),
    ["read", "create", "update", "delete"],
    "permissions",
    origin,
  );
  assertRoleMapsOnlyNarrow(
    objectProperty(objectProperty(base, "authorization"), "roles"),
    objectProperty(objectProperty(merged, "authorization"), "roles"),
    ["read", "create", "update", "delete"],
    "authorization.roles",
    origin,
  );
  assertFieldsOnlyNarrow(base, merged, origin);
  assertRowAccessOnlyNarrows(base, merged, origin);
  assertOperationsOnlyNarrow(base, merged, origin);

  if (base.workerAccess === undefined && merged.workerAccess !== undefined) {
    throw new Error(`${origin} enables workerAccess not granted by the owning layer.`);
  }
  if (
    base.workerAccess !== undefined &&
    merged.workerAccess !== undefined &&
    base.workerAccess !== merged.workerAccess
  ) {
    throw new Error(`${origin} changes workerAccess granted by an earlier layer.`);
  }
}

// ---------------------------------------------------------------------------
// Layer resolution
// ---------------------------------------------------------------------------

/**
 * The app shell's canonical path inside a resolved authoring tree. `loader.ts`
 * reads it from exactly here, so a patch has to merge into this path and no
 * other for the result to be the document the generator sees.
 */
const APP_SHELL_FILENAME = "menu.yaml";

function isEntityFile(relativePath: string): boolean {
  return (
    relativePath.startsWith("entities/") &&
    relativePath.endsWith(".yaml") &&
    !relativePath.split("/").pop()!.startsWith("_")
  );
}

function entitySlug(relativePath: string): string {
  return relativePath.split("/").pop()!.slice(0, -".yaml".length);
}

/**
 * The layer directories this repo authors, in application order: the configured
 * layers, then each plugin that ships an `authoring/` directory.
 *
 * Exported because a caller that needs the SOURCES rather than the merged tree
 * — `check:authoring-schemas` walks them to validate each file against its
 * schema — must agree with the compiler about which directories those are. The
 * gate used to name one path literally, so the plugin-shipped layers were
 * outside everything it could see (#237); deriving both from here means a
 * plugin that contributes authoring cannot contribute unvalidated authoring.
 */
export function authoringLayerDirs(repoRoot: string, config?: AuthoringConfig): string[] {
  const { layers, plugins = [] } = config ?? loadAuthoringConfig(repoRoot);
  const dirs = layers.map((layer) => resolveLayerDir(repoRoot, layer));
  for (const spec of plugins) {
    const authoring = pluginAuthoringDir(repoRoot, spec);
    if (authoring) {
      dirs.push(authoring);
    }
  }
  return dirs;
}

/**
 * Resolves the configured layers into a single authoring directory.
 * Single layer without patches -> that directory, untouched (fast path).
 */
export function resolveAuthoringLayers(repoRoot: string, config?: AuthoringConfig): string {
  const layerDirs = authoringLayerDirs(repoRoot, config);

  if (layerDirs.length === 1) {
    return layerDirs[0]!;
  }

  const buildDir = join(repoRoot, BUILD_DIR);
  rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });

  // relativePath -> { sourceLayer, contents } for plain files;
  // entity slugs are tracked separately so patches can target them by slug.
  const files = new Map<string, { layer: string; path: string }>();
  const entityPathBySlug = new Map<string, string>();
  // Entity names are tracked too: the same `entity:` under a second file stem
  // is the slug collision wearing a different name, and a slug-only check lets
  // it through to compile as two candidates for one GraphQL type and one
  // physical table.
  const entityPathByName = new Map<string, { layer: string; path: string }>();

  for (const layerDir of layerDirs) {
    for (const relativePath of walkFiles(layerDir)) {
      const sourcePath = join(layerDir, relativePath);
      const resolvedRelativePath = relativePath;

      const parsed = relativePath.endsWith(".yaml")
        ? (YAML.parse(readFileSync(sourcePath, "utf8")) as
            | { kind?: string; entity?: string }
            | null)
        : null;

      if (relativePath.endsWith(".yaml")) {
        if (parsed?.kind === "entityPatch") {
          const slug = entitySlug(relativePath);
          const targetRelative = entityPathBySlug.get(slug);
          if (!targetRelative) {
            throw new Error(
              `entityPatch ${layerDir}/${relativePath} targets slug "${slug}" ` +
                "but no earlier layer defines that entity.",
            );
          }
          const target = files.get(targetRelative)!;
          const baseDoc = YAML.parse(
            readFileSync(join(target.layer, target.path), "utf8"),
          ) as JsonValue;
          const { kind: _kind, ...patchBody } = parsed as { [key: string]: JsonValue };
          const merged = strategicMerge(baseDoc, patchBody as JsonValue);
          assertEntitySecurityOnlyNarrows(
            baseDoc,
            merged,
            `entityPatch ${layerDir}/${relativePath}`,
          );
          const mergedPath = join(buildDir, targetRelative);
          mkdirSync(join(mergedPath, ".."), { recursive: true });
          writeFileSync(mergedPath, YAML.stringify(merged), "utf8");
          // Later layers may patch again: repoint the base to the merged file.
          files.set(targetRelative, { layer: buildDir, path: targetRelative });
          continue;
        }

        if (parsed?.kind === "appShellPatch") {
          // Targeted by path, not by slug: there is exactly one app shell, so a
          // slug lookup would have one possible answer. The patch is merged
          // into the canonical path wherever the patch file itself sits, which
          // is what keeps a misfiled patch from being copied through as an
          // inert extra document nobody reads.
          const target = files.get(APP_SHELL_FILENAME);
          if (!target) {
            throw new Error(
              `appShellPatch ${layerDir}/${relativePath} cannot be applied: ` +
                "no earlier layer defines an app shell " +
                `(${APP_SHELL_FILENAME}).`,
            );
          }
          const baseDoc = YAML.parse(
            readFileSync(join(target.layer, target.path), "utf8"),
          ) as JsonValue;
          const { kind: _kind, ...patchBody } = parsed as { [key: string]: JsonValue };
          const merged = strategicMerge(baseDoc, patchBody as JsonValue);
          const mergedPath = join(buildDir, APP_SHELL_FILENAME);
          mkdirSync(join(mergedPath, ".."), { recursive: true });
          writeFileSync(mergedPath, YAML.stringify(merged), "utf8");
          files.set(APP_SHELL_FILENAME, { layer: buildDir, path: APP_SHELL_FILENAME });
          continue;
        }

        if (parsed?.kind === AUTHORIZATION_PATCH_KIND) {
          // Path-targeted like the app shell: realm files are found by their
          // filename at the tree root, so the patch names its target by
          // sitting at that same path. A patch filed elsewhere is refused
          // rather than copied through — the generator would then reject it
          // as a realm file of the wrong kind, one step removed from the
          // mistake.
          if (!isAuthorizationFilePath(relativePath)) {
            throw new Error(
              `${AUTHORIZATION_PATCH_KIND} ${layerDir}/${relativePath} must sit at the path of the ` +
                "realm file it patches (authorization.yaml or authorization.<realm>.yaml at the layer root).",
            );
          }
          const target = files.get(relativePath);
          if (!target) {
            throw new Error(
              `${AUTHORIZATION_PATCH_KIND} ${layerDir}/${relativePath} cannot be applied: ` +
                `no earlier layer defines ${relativePath}. A patch overlays a realm; ` +
                "to author a new realm, ship an authorizationConfig under its own filename.",
            );
          }
          const baseDoc = YAML.parse(
            readFileSync(join(target.layer, target.path), "utf8"),
          ) as JsonValue;
          const merged = applyAuthorizationPatch(baseDoc, parsed as JsonValue, {
            strategicMerge,
            origin: `${AUTHORIZATION_PATCH_KIND} ${layerDir}/${relativePath}`,
          });
          const mergedPath = join(buildDir, relativePath);
          mkdirSync(join(mergedPath, ".."), { recursive: true });
          writeFileSync(mergedPath, YAML.stringify(merged), "utf8");
          files.set(relativePath, { layer: buildDir, path: relativePath });
          continue;
        }
      }

      if (files.has(resolvedRelativePath)) {
        const isCatalog =
          resolvedRelativePath.startsWith("catalogs/") && resolvedRelativePath.endsWith(".yaml");
        if (isCatalog) {
          const target = files.get(resolvedRelativePath)!;
          const baseDoc = YAML.parse(
            readFileSync(join(target.layer, target.path), "utf8"),
          ) as JsonValue;
          const overlayDoc = YAML.parse(readFileSync(sourcePath, "utf8")) as JsonValue;
          const merged = strategicMerge(baseDoc, overlayDoc);
          const mergedPath = join(buildDir, resolvedRelativePath);
          mkdirSync(join(mergedPath, ".."), { recursive: true });
          writeFileSync(mergedPath, YAML.stringify(merged), "utf8");
          files.set(resolvedRelativePath, { layer: buildDir, path: resolvedRelativePath });
          continue;
        }
        throw new Error(
          `Layer collision on ${resolvedRelativePath}: ${files.get(resolvedRelativePath)!.layer} ` +
            `already provides it and ${layerDir} ships a plain replacement. ` +
            "Entities can be modified with kind: entityPatch; the app shell with " +
            "kind: appShellPatch; realm files (authorization*.yaml) with " +
            "kind: authorizationPatch; catalogs/*.yaml merge automatically.",
        );
      }
      if (isEntityFile(relativePath)) {
        const slug = entitySlug(relativePath);
        const existing = entityPathBySlug.get(slug);
        if (existing && existing !== relativePath) {
          throw new Error(
            `Duplicate entity slug "${slug}" across layers (${existing} vs ${relativePath}). ` +
              "Use kind: entityPatch to modify an entity from an earlier layer.",
          );
        }
        entityPathBySlug.set(slug, relativePath);

        // Same entity, different stem. The backend manifest's collision audit
        // would refuse this too, but three stages later and in terms of the
        // physical table it produces; here the two authoring files and the
        // stem a patch has to carry are both still in view.
        const entityName = parsed?.entity;
        if (typeof entityName === "string") {
          const owner = entityPathByName.get(entityName);
          if (owner && owner.path !== relativePath) {
            const remedy = owner.layer === layerDir
              ? "Entity names must be unique within a layer."
              : `Use kind: entityPatch (file stem "${entitySlug(owner.path)}") ` +
                "to modify an entity from an earlier layer.";
            throw new Error(
              `Duplicate entity "${entityName}" across layers (${owner.path} vs ${relativePath}). ${remedy}`,
            );
          }
          entityPathByName.set(entityName, { layer: layerDir, path: relativePath });
        }
      }
      files.set(resolvedRelativePath, { layer: layerDir, path: relativePath });
    }
  }

  for (const [relativePath, source] of files) {
    if (source.layer === buildDir) {
      continue; // already written by a patch merge
    }
    const target = join(buildDir, relativePath);
    mkdirSync(join(target, ".."), { recursive: true });
    cpSync(join(source.layer, source.path), target);
  }

  return buildDir;
}
