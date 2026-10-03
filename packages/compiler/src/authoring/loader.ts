// @ts-nocheck
// SPDX-License-Identifier: BUSL-1.1
/**
 * Loads YAML authoring files from disk into a LoadedArtifacts bundle.
 *
 * For each entity under entities/ it loads the core definition, context
 * partials (field extensions), mappings, transform and component catalogs,
 * semantic type definitions, the app shell, and an optional view definition.
 *
 * Returns LoadedArtifacts, consumed by the validator (JSON Schema), semantic
 * checks, and compiler stages.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { BASE_ENTITY_FILENAME, applyBaseEntityToCore, loadBaseEntity } from "./base-entity.js";
import { assertEntityAuthoring } from "./entity-authoring.js";
import { deriveEntityOsfTypes, deriveProviderOsfTypes, normalizeEntityFields } from "./entity-fields.js";
import { loadOperationCatalogs } from "./operation-catalog.js";
import type {
  CoreEntity,
  EntityProfile,
  EntityMapping,
  TransformCatalog,
  ComponentCatalog,
  AppShell,
  ViewDefinition,
  OsfTypeCatalog,
  OsfTypeDefinition,
  RetentionPolicyCatalog,
  RetentionPolicy,
  AuthorizationConfig,
} from "./types.js";

export interface LoadedArtifacts {
  coreEntity: CoreEntity;
  profiles: EntityProfile[];
  mappings: EntityMapping[];
  transformCatalog: TransformCatalog;
  componentCatalog: ComponentCatalog;
  osfTypes: Record<string, OsfTypeDefinition>;
  retentionPolicies: Record<string, RetentionPolicy>;
  appShell: AppShell | null;
  viewDefinition: ViewDefinition | null;
}

export type FieldAuthoringProfile = Record<string, unknown> & {
  label?: Record<string, string>;
  description?: Record<string, string>;
  keyBehavior?: string;
  excludedFieldTypes?: string[];
  typePickerUsage?: string;
  controls?: Record<string, unknown>;
  lockedVisibleProperties?: string[];
};

type FieldAuthoringProfileCatalog = {
  schemaVersion: number;
  kind: "fieldAuthoringProfileCatalog";
  profiles: Record<string, FieldAuthoringProfile>;
};

/** Load the resolved, unnormalized field-authoring presets for build-time UI consumers. */
export function loadFieldAuthoringProfiles(
  authoringDir: string,
): Record<string, FieldAuthoringProfile> {
  const path = join(authoringDir, "catalogs", "field-authoring-profiles.yaml");
  const catalog = loadYaml<FieldAuthoringProfileCatalog>(path);
  if (
    catalog.schemaVersion !== 1 ||
    catalog.kind !== "fieldAuthoringProfileCatalog" ||
    !catalog.profiles ||
    typeof catalog.profiles !== "object" ||
    Array.isArray(catalog.profiles)
  ) {
    throw new Error(
      `${path} must be a schemaVersion 1 fieldAuthoringProfileCatalog with a profiles object.`,
    );
  }
  for (const [key, profile] of Object.entries(catalog.profiles)) {
    validateContentIdentifier(key, FIELD_KEY_PATTERN, "field authoring profile key", path);
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
      throw new Error(`Field authoring profile "${key}" in ${path} must be an object.`);
    }
  }
  return catalog.profiles;
}

/** Catalogs that bind the public build-time FieldDefinition schema compiler. */
export function loadFieldCompilationCatalogs(authoringDir: string): {
  componentCatalog: ComponentCatalog;
  osfTypes: Record<string, OsfTypeDefinition>;
} {
  return {
    componentCatalog: loadYaml<ComponentCatalog>(
      join(authoringDir, "catalogs", "components.yaml"),
    ),
    osfTypes: loadOsfTypes(authoringDir),
  };
}

const SAFE_IDENTIFIER = /^[a-z][a-z0-9-]*$/i;

function validateIdentifier(name: string, context: string): void {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(`Unsafe identifier '${name}' in ${context} — must match ${SAFE_IDENTIFIER}`);
  }
}

// Strict allowlists for authoring *content* identifiers (not filenames). These
// mirror the config/schemas/*.json patterns (core-entity.schema.json: `entity`
// and relationship `target` are `^[A-Z][A-Za-z0-9]*$`; `fieldKey` is
// `^[a-z][A-Za-z0-9]*$`). Since #182 the schemas ARE enforced — by the corpus
// gate (`check:authoring-schemas`) for authoring that lives here, and at load
// for authoring that can arrive from outside (connector-loader.ts) — but these
// patterns are deliberately independent of that and must stay: a shape schema
// is documentation of a shape, not injection defence, and this layer has to
// fail closed even if a schema is edited to agree with an attacker. Without it
// these YAML-derived names reach codegen unvalidated: the entity name becomes
// an import path / string-literal
// key in the entity manifest (entity-manifest.ts.ejs), and field keys are
// interpolated raw into generated GraphQL operation strings (actions.ts.ejs,
// pages.ts). Enforcing the patterns here — at load, before any generator runs —
// fails closed so a hostile identifier (quotes, braces, backticks, ${},
// whitespace, newlines) can never be spliced into generated TS/GraphQL/SQL.
const ENTITY_NAME_PATTERN = /^[A-Z][A-Za-z0-9]*$/;
const FIELD_KEY_PATTERN = /^[a-z][A-Za-z0-9]*$/;
// rest.basePath is emitted verbatim into Fastify route strings and OpenAPI
// paths, so it gets the same fail-closed treatment: lowercase kebab-case only.
const REST_BASE_PATH_PATTERN = /^[a-z][a-z0-9-]*$/;
// mcp.toolPrefix is emitted verbatim into MCP tool names, which the protocol
// constrains to `^[a-zA-Z0-9_-]{1,128}$` and which the runtime dispatches on.
// Underscore rather than kebab-case, because the generated names join prefix
// and operation with `_` (`contact_detail_list`).

function validateContentIdentifier(
  value: unknown,
  pattern: RegExp,
  what: string,
  origin: string,
): void {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(
      `Unsafe ${what} ${JSON.stringify(value)} in ${origin} — must match ${pattern}. ` +
        `Authoring identifiers are emitted verbatim into generated code (GraphQL ` +
        `queries, import paths, SQL) and cannot contain other characters.`,
    );
  }
}

/**
 * Recursively validates every field `key` (including nested children/item/shape)
 * against the strict field-key pattern.
 */
function validateFieldKeys(
  fields: readonly { key?: unknown; children?: unknown; item?: unknown; shape?: unknown }[] | undefined,
  origin: string,
): void {
  if (!Array.isArray(fields)) return;
  for (const field of fields) {
    if (!field || typeof field !== "object") continue;
    validateContentIdentifier(field.key, FIELD_KEY_PATTERN, "field key", origin);
    validateFieldKeys(field.children as never, origin);
    if (field.item) validateFieldKeys([field.item] as never, origin);
    validateFieldKeys(field.shape as never, origin);
  }
}

/**
 * Relationships live on fields: a single reference is `osfType: <Entity>` and
 * its inverse collection is derived. An entity-level `relationships:` block
 * is refused by name so the author knows which entries to move.
 */
export function assertNoRelationshipsBlock(entity: { entity: string; relationships?: unknown }, origin: string): void {
  if (entity.relationships === undefined) return;
  const keys = Array.isArray(entity.relationships)
    ? entity.relationships.map((entry) => (entry && typeof entry === "object" ? String((entry as { key?: unknown }).key ?? "?") : "?"))
    : [];
  throw new Error(
    `${origin}: ${entity.entity} declares relationships${keys.length ? ` (${keys.join(", ")})` : ""}; ` +
      `relationships are fields — set osfType: <Entity> on the referencing field and let the compiler derive the inverse collection.`,
  );
}

/**
 * Validates the entity name and every field key of a fully-merged core
 * entity (after base-entity application) before it is returned to the
 * compilers. Fails closed on any identifier that could break out of a
 * generated code position. Exported for unit testing.
 */
export function validateEntityContentIdentifiers(coreEntity: CoreEntity, origin: string): void {
  validateContentIdentifier(coreEntity.entity, ENTITY_NAME_PATTERN, "entity name", origin);
  validateFieldKeys(coreEntity.fields, origin);
  assertNoRelationshipsBlock(coreEntity, origin);
  if (coreEntity.interfaces?.rest?.basePath !== undefined) {
    validateContentIdentifier(coreEntity.interfaces.rest.basePath, REST_BASE_PATH_PATTERN, "rest basePath", origin);
  }
}

const parsedYaml = new Map<string, { source: string; value: unknown }>();

function loadYaml<T>(filePath: string): T {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const raw = readFileSync(filePath, "utf-8");
  let cached = parsedYaml.get(filePath);
  if (!cached || cached.source !== raw) {
    cached = { source: raw, value: parseYaml(raw) };
    parsedYaml.set(filePath, cached);
  }
  // The corpus is loaded for multiple projections. Cache parsing by actual
  // source bytes, not timestamps, and isolate callers from shared mutation.
  return structuredClone(cached.value) as T;
}

/**
 * Load all authoring artifacts for a core entity.
 *
 * Expected layout:
 *   authoring/entities/<entity>.yaml                        (core entity)
 *   authoring/contexts/<context>/partial/<entity>.yaml       (field extensions)
 *   authoring/mappings/<context>/<entity>.mapping.yaml       (mappings)
 *   authoring/views/<entity>.view.yaml                       (standalone view)
 *   authoring/catalogs/transforms.yaml
 */
/**
 * Recursively lists entity YAML files under `entities/`. Subfolders (e.g.
 * `entities/core/`) are organizational only: the entity slug is the file stem
 * and must be unique across the whole tree. `_`-prefixed files such as
 * `_base.yaml` are shared meta definitions, not entities.
 */
export function listEntityFiles(
  authoringDir: string,
): { slug: string; path: string }[] {
  const root = join(authoringDir, "entities");
  const results: { slug: string; path: string }[] = [];

  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".yaml") &&
        !entry.name.startsWith("_")
      ) {
        results.push({ slug: entry.name.slice(0, -".yaml".length), path: fullPath });
      }
    }
  };
  walk(root);

  results.sort((a, b) => a.slug.localeCompare(b.slug));
  const seen = new Map<string, string>();
  for (const file of results) {
    const existing = seen.get(file.slug);
    if (existing) {
      throw new Error(
        `Duplicate entity slug "${file.slug}": ${existing} and ${file.path}. ` +
          "Entity folders are organizational only; slugs must be unique.",
      );
    }
    seen.set(file.slug, file.path);
  }
  return results;
}

/** Resolves an entity slug to its YAML path anywhere under `entities/`. */
export function resolveEntityFilePath(
  authoringDir: string,
  entityFileName: string,
): string {
  const match = listEntityFiles(authoringDir).find(
    (file) => file.slug === entityFileName,
  );
  if (!match) throw new Error(`Entity ${entityFileName} is not authored under ${join(authoringDir, "entities")}.`);
  return match.path;
}

export function loadEntity(
  authoringDir: string,
  entityFileName: string
): LoadedArtifacts {
  validateIdentifier(entityFileName, "entity name");

  // Core entity — resolved anywhere under entities/ (subfolders allowed).
  const corePath = resolveEntityFilePath(authoringDir, entityFileName);
  const rawCoreEntity = loadYaml<CoreEntity>(corePath);
  const baseEntity = loadBaseEntity(authoringDir);
  let coreEntity = applyBaseEntityToCore(rawCoreEntity, baseEntity, {
    kind: "core",
    path: corePath,
  });
  validateEntityContentIdentifiers(coreEntity, corePath);

  // Semantic types (core + context catalogs merged). Normalization resolves
  // every field's base type and derives the inverse collections, which the
  // v2 authoring checks below read.
  const osfTypes = loadOsfTypes(authoringDir);
  coreEntity = normalizeEntityFields(coreEntity, osfTypes);
  assertEntityAuthoring(coreEntity, corePath);

  // Scan for context partials (field extensions)
  const profiles: EntityProfile[] = [];
  const mappings: EntityMapping[] = [];

  // New structure: contexts/<context>/partial/
  const contextsDir = join(authoringDir, "contexts");
  for (const contextName of listDirs(contextsDir)) {
    const partialPath = join(contextsDir, contextName, "partial", `${entityFileName}.yaml`);
    if (existsSync(partialPath)) {
      const profile = loadYaml<EntityProfile>(partialPath);
      assertPartialProfileHasNoCrud(profile, partialPath);
      // Profile field keys also flow into codegen (GraphQL profile sub-types,
      // storage columns); validate them at load with the same strict pattern.
      validateFieldKeys(profile.fields, partialPath);
      profiles.push(profile);
    }

    const mappingPath = join(authoringDir, "mappings", contextName, `${entityFileName}.mapping.yaml`);
    if (existsSync(mappingPath)) {
      mappings.push(loadYaml<EntityMapping>(mappingPath));
    }
  }

  // Transform catalog
  const catalogPath = join(authoringDir, "catalogs", "transforms.yaml");
  const transformCatalog = loadYaml<TransformCatalog>(catalogPath);

  // Component catalog
  const componentPath = join(authoringDir, "catalogs", "components.yaml");
  const componentCatalog = loadYaml<ComponentCatalog>(componentPath);

  // App shell (optional)
  const shellPath = join(authoringDir, "menu.yaml");
  const appShell = existsSync(shellPath) ? loadYaml<AppShell>(shellPath) : null;

  const retentionPolicies = loadRetentionPolicies(authoringDir);

  // View definition (optional)
  const viewPath = join(authoringDir, "views", `${entityFileName}.view.yaml`);
  const viewDefinition = existsSync(viewPath) ? loadYaml<ViewDefinition>(viewPath) : null;

  return { coreEntity, profiles, mappings, transformCatalog, componentCatalog, osfTypes, retentionPolicies, appShell, viewDefinition };
}

export function assertPartialProfileHasNoCrud(
  profile: EntityProfile,
  profilePath: string,
): void {
  if ((profile as { crud?: unknown }).crud === undefined) return;
  throw new Error(
    `${profilePath} declares crud on a partial entity profile. ` +
      "CRUD exposure belongs to the owning entity or an entityPatch, " +
      "because partial field profiles do not own a generated resource.",
  );
}

/**
 * Load and merge all osf-type catalogs (core, then each context). Catalogs
 * are add-only: a context may add types but never redefine a key an earlier
 * catalog declared, because that key names the storage, GraphQL and JSON
 * Schema contract of every field that uses it.
 */
export function loadOsfTypes(authoringDir: string): Record<string, OsfTypeDefinition> {
  const merged: Record<string, OsfTypeDefinition> = {};
  const ownerByKey = new Map<string, string>();
  for (const { source, types } of loadOsfTypeCatalogSources(authoringDir)) {
    for (const [key, definition] of Object.entries(types)) {
      const owner = ownerByKey.get(key);
      if (owner !== undefined) {
        throw new Error(
          `Osf type ${key} in ${source}/osf-types.yaml redefines the entry from ${owner}; ` +
            "osf-type catalogs are add-only.",
        );
      }
      ownerByKey.set(key, source);
      merged[key] = definition;
    }
  }
  const entities = listEntityFiles(authoringDir).map(({ path }) => loadYaml<CoreEntity>(path));
  const withEntities = deriveEntityOsfTypes(entities.filter((entity) => entity.kind === "coreEntity"), merged);
  // Provider-backed entities (declared by Operation catalogs) are relationship
  // targets too: a field may name one as its osfType.
  return deriveProviderOsfTypes(loadOperationCatalogs(authoringDir).map(({ document }) => document), withEntities);
}

export interface OsfTypeCatalogSource {
  /** Human-readable origin label, e.g. `core` or `contexts/<profile>`. */
  source: string;
  types: Record<string, OsfTypeDefinition>;
}

/**
 * Returns each osf-type catalog file as its own entry, in load order
 * (core first, then each context).
 */
export function loadOsfTypeCatalogSources(
  authoringDir: string,
): OsfTypeCatalogSource[] {
  const sources: OsfTypeCatalogSource[] = [];

  const corePath = join(authoringDir, "catalogs", "osf-types.yaml");
  if (existsSync(corePath)) {
    const catalog = loadYaml<OsfTypeCatalog>(corePath);
    sources.push({ source: "core", types: catalog.types ?? {} });
  }

  const contextsDir = join(authoringDir, "contexts");
  for (const contextName of listDirs(contextsDir)) {
    const contextPath = join(contextsDir, contextName, "osf-types.yaml");
    if (existsSync(contextPath)) {
      const catalog = loadYaml<OsfTypeCatalog>(contextPath);
      sources.push({
        source: `contexts/${contextName}`,
        types: catalog.types ?? {},
      });
    }
  }

  return sources;
}

function loadRetentionPolicies(authoringDir: string): Record<string, RetentionPolicy> {
  const catalogPath = join(authoringDir, "catalogs", "retention-policies.yaml");
  if (!existsSync(catalogPath)) {
    return {};
  }

  const catalog = loadYaml<RetentionPolicyCatalog>(catalogPath);
  return catalog.policies ?? {};
}

function listDirs(dirPath: string): string[] {
  if (!existsSync(dirPath)) return [];
  // Sort so directory iteration (and thus catalog merge precedence in
  // loadOsfTypes / loadOsfTypeCatalogSources) is deterministic
  // regardless of filesystem readdir order across machines or rebuilt trees.
  return readdirSync(dirPath, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));
}
