// @ts-nocheck
// SPDX-License-Identifier: BUSL-1.1
/**
 * Loads YAML authoring files from disk into a LoadedArtifacts bundle.
 *
 * Supports two directory layouts: the current entities/contexts/ structure and
 * a legacy core/profiles/ fallback. For each entity it loads the core definition,
 * context partials (field extensions), mappings, transform and component catalogs,
 * semantic type definitions, the app shell, and an optional view definition.
 *
 * Also discovers and loads standalone "full" context entities that exist only
 * within a single context (contexts/<ctx>/full/).
 *
 * Returns LoadedArtifacts, consumed by the validator (JSON Schema), semantic
 * checks, and compiler stages.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { BASE_ENTITY_FILENAME, applyBaseEntityToCore, loadBaseEntity } from "./base-entity.js";
import type {
  CoreEntity,
  EntityProfile,
  EntityMapping,
  TransformCatalog,
  ComponentCatalog,
  AppShell,
  ViewDefinition,
  SemanticTypeCatalog,
  SemanticTypeDefinition,
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
  semanticTypes: Record<string, SemanticTypeDefinition>;
  retentionPolicies: Record<string, RetentionPolicy>;
  appShell: AppShell | null;
  viewDefinition: ViewDefinition | null;
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
const MCP_TOOL_PREFIX_PATTERN = /^[a-z][a-z0-9_]*$/;

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
 * Validates the entity name, every field key, and relationship key/target of a
 * fully-merged core entity (after base-entity application) before it is returned
 * to the compilers. Fails closed on any identifier that could break out of a
 * generated code position. Exported for unit testing.
 */
export function validateEntityContentIdentifiers(coreEntity: CoreEntity, origin: string): void {
  validateContentIdentifier(coreEntity.entity, ENTITY_NAME_PATTERN, "entity name", origin);
  validateFieldKeys(coreEntity.fields, origin);
  for (const rel of coreEntity.relationships ?? []) {
    if (!rel || typeof rel !== "object") continue;
    validateContentIdentifier((rel as { key?: unknown }).key, FIELD_KEY_PATTERN, "relationship key", origin);
    validateContentIdentifier((rel as { target?: unknown }).target, ENTITY_NAME_PATTERN, "relationship target", origin);
  }
  if (
    typeof coreEntity.rest === "object" &&
    coreEntity.rest !== null &&
    coreEntity.rest.basePath !== undefined
  ) {
    validateContentIdentifier(coreEntity.rest.basePath, REST_BASE_PATH_PATTERN, "rest basePath", origin);
  }
  if (
    typeof coreEntity.mcp === "object" &&
    coreEntity.mcp !== null &&
    coreEntity.mcp.toolPrefix !== undefined
  ) {
    validateContentIdentifier(
      coreEntity.mcp.toolPrefix,
      MCP_TOOL_PREFIX_PATTERN,
      "mcp toolPrefix",
      origin,
    );
  }
}

function loadYaml<T>(filePath: string): T {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const raw = readFileSync(filePath, "utf-8");
  return parseYaml(raw) as T;
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
 *
 * Legacy fallback:
 *   authoring/core/<entity>.yaml
 *   authoring/profiles/<profile>/<entity>.profile.yaml
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
  if (match) {
    return match.path;
  }
  // Legacy fallback layout.
  return join(authoringDir, "core", `${entityFileName}.yaml`);
}

export function loadEntity(
  authoringDir: string,
  entityFileName: string
): LoadedArtifacts {
  validateIdentifier(entityFileName, "entity name");

  // Core entity — resolved anywhere under entities/ (subfolders allowed),
  // with a legacy fallback to authoring/core/.
  const corePath = resolveEntityFilePath(authoringDir, entityFileName);
  const rawCoreEntity = loadYaml<CoreEntity>(corePath);
  const baseEntity = loadBaseEntity(authoringDir);
  const coreEntity = applyBaseEntityToCore(rawCoreEntity, baseEntity, {
    kind: "core",
    path: corePath,
  });
  validateEntityContentIdentifiers(coreEntity, corePath);

  // Scan for context partials (field extensions)
  const profiles: EntityProfile[] = [];
  const mappings: EntityMapping[] = [];

  // New structure: contexts/<context>/partial/
  const contextsDir = join(authoringDir, "contexts");
  for (const contextName of listDirs(contextsDir)) {
    const partialPath = join(contextsDir, contextName, "partial", `${entityFileName}.yaml`);
    if (existsSync(partialPath)) {
      const profile = loadYaml<EntityProfile>(partialPath);
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
  const shellPath = join(authoringDir, "appShell.yaml");
  const appShell = existsSync(shellPath) ? loadYaml<AppShell>(shellPath) : null;

  // Semantic types (core + context catalogs merged)
  const semanticTypes = loadSemanticTypes(authoringDir);
  const retentionPolicies = loadRetentionPolicies(authoringDir);

  // View definition (optional)
  const viewPath = join(authoringDir, "views", `${entityFileName}.view.yaml`);
  const viewDefinition = existsSync(viewPath) ? loadYaml<ViewDefinition>(viewPath) : null;

  return { coreEntity, profiles, mappings, transformCatalog, componentCatalog, semanticTypes, retentionPolicies, appShell, viewDefinition };
}

/**
 * Load a full context entity (standalone entity that only exists in a context).
 * Creates a synthetic CoreEntity from the context YAML.
 */
export function loadContextEntity(
  authoringDir: string,
  contextName: string,
  entityFileName: string
): LoadedArtifacts {
  validateIdentifier(entityFileName, "context entity name");
  validateIdentifier(contextName, "context name");

  const fullPath = join(authoringDir, "contexts", contextName, "full", `${entityFileName}.yaml`);
  const contextEntity = loadYaml<EntityProfile>(fullPath);

  // Build a synthetic core entity from the context entity
  const rawCoreEntity: CoreEntity = {
    schemaVersion: contextEntity.schemaVersion,
    kind: "coreEntity",
    module: contextName,
    entity: contextEntity.entity,
    title: contextEntity.title ?? contextEntity.entity,
    description: contextEntity.description,
    language: contextEntity.language,
    domains: [...(contextEntity.domains ?? [])],
    retention: contextEntity.retention,
    baseEntity: (contextEntity as { baseEntity?: boolean }).baseEntity,
    displayTemplate: contextEntity.displayTemplate,
    filterField: contextEntity.filterField,
    indexes: (contextEntity as { indexes?: CoreEntity["indexes"] }).indexes,
    fields: contextEntity.fields ?? [],
    relationships: contextEntity.relationships,
    workflow: contextEntity.workflow,
    rest: (contextEntity as { rest?: CoreEntity["rest"] }).rest,
    // EntityProfile.authorization is typed for partial-profile field-level
    // extensions (ProfileAuthorizationConfig). A `full/` profile entity is a
    // standalone entity, so its YAML carries the wider AuthorizationConfig
    // shape (CRUD roles + rowAccess) — cast to match the synthetic CoreEntity.
    authorization: contextEntity.authorization as AuthorizationConfig | undefined,
    // No ui: — views handle that
  };
  const baseEntity = loadBaseEntity(authoringDir);
  const coreEntity = applyBaseEntityToCore(rawCoreEntity, baseEntity, {
    kind: "contextFull",
    path: fullPath,
  });
  validateEntityContentIdentifiers(coreEntity, fullPath);

  // Transform catalog
  const catalogPath = join(authoringDir, "catalogs", "transforms.yaml");
  const transformCatalog = loadYaml<TransformCatalog>(catalogPath);

  // Component catalog
  const componentPath = join(authoringDir, "catalogs", "components.yaml");
  const componentCatalog = loadYaml<ComponentCatalog>(componentPath);

  // App shell (optional)
  const shellPath = join(authoringDir, "appShell.yaml");
  const appShell = existsSync(shellPath) ? loadYaml<AppShell>(shellPath) : null;

  // Semantic types
  const semanticTypes = loadSemanticTypes(authoringDir);
  const retentionPolicies = loadRetentionPolicies(authoringDir);

  // View definition
  const viewPath = join(authoringDir, "views", `${entityFileName}.view.yaml`);
  const viewDefinition = existsSync(viewPath) ? loadYaml<ViewDefinition>(viewPath) : null;

  return {
    coreEntity,
    profiles: [],  // Full context entity — no partials
    mappings: [],
    transformCatalog,
    componentCatalog,
    semanticTypes,
    retentionPolicies,
    appShell,
    viewDefinition,
  };
}

/**
 * Discover all full context entities across all contexts.
 * Returns [contextName, entityFileName][] tuples.
 */
export function discoverContextEntities(authoringDir: string): { context: string; name: string }[] {
  const result: { context: string; name: string }[] = [];
  const contextsDir = join(authoringDir, "contexts");

  for (const contextName of listDirs(contextsDir)) {
    const fullDir = join(contextsDir, contextName, "full");
    if (!existsSync(fullDir)) continue;

    const files = readdirSync(fullDir).filter(f => f.endsWith(".yaml"));
    for (const f of files) {
      result.push({ context: contextName, name: f.replace(".yaml", "") });
    }
  }

  return result;
}

/**
 * Load and merge all semantic type catalogs (core + context-specific). Returns
 * the same merged object as before. Collision detection between core and
 * context catalogs is performed at the orchestrator level via
 * `loadSemanticTypeCatalogSources` + `checkSemanticTypeCatalogCollisions`.
 */
export function loadSemanticTypes(authoringDir: string): Record<string, SemanticTypeDefinition> {
  const merged: Record<string, SemanticTypeDefinition> = {};
  for (const { types } of loadSemanticTypeCatalogSources(authoringDir)) {
    Object.assign(merged, types);
  }
  return merged;
}

export interface SemanticTypeCatalogSource {
  /** Human-readable origin label, e.g. `core` or `contexts/<profile>`. */
  source: string;
  types: Record<string, SemanticTypeDefinition>;
}

/**
 * Returns each semantic-type catalog file as its own entry, in load order
 * (core first, then each context). Used by the orchestrator to detect when a
 * context catalog silently overwrites a core key.
 */
export function loadSemanticTypeCatalogSources(
  authoringDir: string,
): SemanticTypeCatalogSource[] {
  const sources: SemanticTypeCatalogSource[] = [];

  const corePath = join(authoringDir, "catalogs", "semantic-types.yaml");
  if (existsSync(corePath)) {
    const catalog = loadYaml<SemanticTypeCatalog>(corePath);
    sources.push({ source: "core", types: catalog.types ?? {} });
  }

  const contextsDir = join(authoringDir, "contexts");
  for (const contextName of listDirs(contextsDir)) {
    const contextPath = join(contextsDir, contextName, "semantic-types.yaml");
    if (existsSync(contextPath)) {
      const catalog = loadYaml<SemanticTypeCatalog>(contextPath);
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
  // loadSemanticTypes / loadSemanticTypeCatalogSources) is deterministic
  // regardless of filesystem readdir order across machines or rebuilt trees.
  return readdirSync(dirPath, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));
}
