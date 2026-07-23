// @ts-nocheck
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { generatedCrudDeniedEntitySlugs } from "../../../../../packages/compiler/src/active-manifest.js";
import { applyBaseEntityToCore, loadBaseEntity } from "../../../../../packages/compiler/src/authoring/base-entity.js";
import { listEntityFiles } from "../../../../../packages/compiler/src/authoring/loader.js";
import type { ComponentCatalog, CoreEntity, EntityProfile, Field, SemanticTypeCatalog, SemanticTypeDefinition } from "../../../../../packages/compiler/src/authoring/types.js";
import { pluralize, uncapitalize } from "../../../../../packages/compiler/src/authoring/compiler/helpers.js";
import type { WorkflowEntityGenerationOptions } from "./types.js";
import { cloneField, normalizeSemanticTypeKey, toKebabCase } from "./utils.js";
function loadYamlFile<T>(filePath: string): T {
  return parseYaml(readFileSync(filePath, "utf-8")) as T;
}

function loadWorkflowNodeComponentCatalog(authoringDir: string): ComponentCatalog {
  const componentCatalogPath = join(authoringDir, "catalogs", "components.yaml");
  return loadYamlFile<ComponentCatalog>(componentCatalogPath);
}

export function loadWorkflowNodeSemanticTypes(authoringDir: string): Record<string, SemanticTypeDefinition> {
  const semanticTypes: Record<string, SemanticTypeDefinition> = {};
  const catalogsDir = join(authoringDir, "catalogs");
  const contextsDir = join(authoringDir, "contexts");
  const coreSemanticTypesPath = join(catalogsDir, "semantic-types.yaml");

  if (existsSync(coreSemanticTypesPath)) {
    Object.assign(
      semanticTypes,
      loadYamlFile<SemanticTypeCatalog>(coreSemanticTypesPath).types ?? {},
    );
  }

  if (existsSync(contextsDir)) {
    for (const contextName of readdirSync(contextsDir).sort()) {
      const contextSemanticTypesPath = join(
        contextsDir,
        contextName,
        "semantic-types.yaml",
      );
      if (!existsSync(contextSemanticTypesPath)) {
        continue;
      }

      Object.assign(
        semanticTypes,
        loadYamlFile<SemanticTypeCatalog>(contextSemanticTypesPath).types ?? {},
      );
    }
  }

  return semanticTypes;
}

/**
 * Workflow-only field expansion. Sets `render` from the semantic-type catalog,
 * recurses into nested shapes, and — for entity-ID semantic types — overrides
 * the render with the workflow-designer `OptionVariablePicker` and attaches
 * the catalog's `listUrl` as a remote-options source. This last branch is
 * what lets authored fields (e.g. `contact-detail.relationId`) become picker
 * fields inside the workflow inspector without authoring YAML restating it.
 *
 * Safe to special-case `kind: entityId` here because this function is called
 * only from `expandEntityFieldShapes`, which is only used by workflow node
 * generation. Regular ERP form fields never go through this path.
 */
function expandSemanticFieldShape(
  field: Field,
  semanticTypes: Record<string, SemanticTypeDefinition>,
  componentCatalog: ComponentCatalog,
): Field {
  const semanticType = field.semanticType ? semanticTypes[field.semanticType] : undefined;
  const children = field.children ?? semanticType?.children;
  const item = field.item ?? semanticType?.item;
  const hasStructuredShape = Boolean(children || item);
  const expanded = cloneField(field);
  const isEntityId = semanticType?.kind === "entityId";

  if (isEntityId) {
    if (!expanded.options && semanticType.listUrl) {
      expanded.options = {
        type: "remote" as const,
        remoteUrl: semanticType.listUrl,
      };
    }
    expanded.render = {
      component: "OptionVariablePicker",
      props: {
        valueMode: "insertText",
      },
    };
  } else if (!expanded.render) {
    if (semanticType?.render) {
      expanded.render = {
        component: expanded.readOnly ? semanticType.render.display : semanticType.render.input,
        ...(semanticType.props ? { props: semanticType.props } : {}),
      };
    } else if (!hasStructuredShape) {
      const defaultComponent = componentCatalog.defaults[expanded.valueType];
      if (defaultComponent?.component) {
        expanded.render = {
          component: defaultComponent.component,
        };
      }
    }
  }

  if (children) {
    expanded.children = children.map((child) =>
      expandSemanticFieldShape(child, semanticTypes, componentCatalog),
    );
  }

  if (item) {
    expanded.item = expandSemanticFieldShape(item, semanticTypes, componentCatalog);
  }

  return expanded;
}

function expandEntityFieldShapes(
  fields: Field[],
  semanticTypes: Record<string, SemanticTypeDefinition>,
  componentCatalog: ComponentCatalog,
) {
  return fields.map((field) =>
    expandSemanticFieldShape(field, semanticTypes, componentCatalog),
  );
}

/**
 * Returns the semantic-type key declared on the entity's `id` field. Throws
 * if missing — every entity is required to annotate its id field with
 * `semanticType: <entity>Id`, enforced by the validator. There is no
 * name-based fallback by design (see plan v3, blocker #1).
 */
export function resolveEntityIdSemanticTypeKey(entityName: string, idField?: Field): string {
  const declared = normalizeSemanticTypeKey(idField?.semanticType);
  if (!declared) {
    throw new Error(
      `Entity '${entityName}' is missing semanticType on its id field. ` +
        `Declare 'semanticType: <entity>Id' in the entity YAML.`,
    );
  }
  return declared;
}

function toSyntheticCoreEntity(
  contextName: string,
  entityProfile: EntityProfile,
): CoreEntity {
  return {
    schemaVersion: entityProfile.schemaVersion,
    kind: "coreEntity",
    module: contextName,
    entity: entityProfile.entity,
    title: entityProfile.title ?? entityProfile.entity,
    description: entityProfile.description,
    language: entityProfile.language,
    domains: [...(entityProfile.domains ?? [])],
    fields: entityProfile.fields ?? [],
    relationships: entityProfile.relationships,
    workflow: entityProfile.workflow,
  };
}

function listWorkflowNodeContextNames(contextsDir: string): string[] {
  if (!existsSync(contextsDir)) {
    return [];
  }

  return readdirSync(contextsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function loadWorkflowNodeContextPartials(
  authoringDir: string,
  entityFileName: string,
): EntityProfile[] {
  const contextsDir = join(authoringDir, "contexts");
  const profiles: EntityProfile[] = [];

  for (const contextName of listWorkflowNodeContextNames(contextsDir)) {
    const partialPath = join(
      contextsDir,
      contextName,
      "partial",
      `${entityFileName}.yaml`,
    );
    if (existsSync(partialPath)) {
      profiles.push(loadYamlFile<EntityProfile>(partialPath));
    }
  }

  return profiles;
}

function mergeWorkflowNodeFields(
  coreFields: Field[],
  profiles: EntityProfile[],
): Field[] {
  const fieldsByKey = new Map<string, Field>();

  for (const field of coreFields) {
    fieldsByKey.set(field.key, field);
  }

  for (const profile of profiles) {
    for (const field of profile.fields ?? []) {
      if (!fieldsByKey.has(field.key)) {
        fieldsByKey.set(field.key, field);
      }
    }
  }

  return Array.from(fieldsByKey.values());
}

function cloneWorkflowNodeRelationship<T>(relationship: T): T {
  return JSON.parse(JSON.stringify(relationship)) as T;
}

function mergeWorkflowNodeRelationships(
  coreRelationships: CoreEntity["relationships"],
  profiles: EntityProfile[],
): CoreEntity["relationships"] {
  const relationshipsByKey = new Map<string, NonNullable<CoreEntity["relationships"]>[number]>();

  for (const relationship of coreRelationships ?? []) {
    relationshipsByKey.set(relationship.key, relationship);
  }

  for (const profile of profiles) {
    for (const relationship of profile.relationships ?? []) {
      if (!relationshipsByKey.has(relationship.key)) {
        relationshipsByKey.set(relationship.key, relationship);
      }
    }
  }

  return Array.from(relationshipsByKey.values()).map(cloneWorkflowNodeRelationship);
}

function applyWorkflowNodeContextPartials(
  entity: CoreEntity,
  profiles: EntityProfile[],
): CoreEntity {
  if (profiles.length === 0) {
    return entity;
  }

  return {
    ...entity,
    fields: mergeWorkflowNodeFields(entity.fields, profiles),
    relationships: mergeWorkflowNodeRelationships(entity.relationships, profiles),
  };
}

export function loadWorkflowNodeEntities(authoringDir: string): CoreEntity[] {
  const entities: CoreEntity[] = [];
  const semanticTypes = loadWorkflowNodeSemanticTypes(authoringDir);
  const componentCatalog = loadWorkflowNodeComponentCatalog(authoringDir);
  const contextsDir = join(authoringDir, "contexts");
  const baseEntity = loadBaseEntity(authoringDir);

  // Plugin-extraction adaptation: discover entity YAMLs through the core
  // loader's recursive `listEntityFiles` (entities now live in organizational
  // subfolders like `entities/core/`); the original flat readdirSync predates
  // that layout and found nothing.
  for (const { slug, path } of listEntityFiles(authoringDir)) {
    const rawEntity = loadYamlFile<CoreEntity>(path);
    const entity = applyBaseEntityToCore(rawEntity, baseEntity, {
      kind: "core",
      path,
    });
    const profiles = loadWorkflowNodeContextPartials(authoringDir, slug);
    const contextCompleteEntity = applyWorkflowNodeContextPartials(
      entity,
      profiles,
    );
    entities.push({
      ...contextCompleteEntity,
      fields: expandEntityFieldShapes(
        contextCompleteEntity.fields,
        semanticTypes,
        componentCatalog,
      ),
    });
  }

  if (existsSync(contextsDir)) {
    for (const contextName of readdirSync(contextsDir).sort()) {
      const fullDir = join(contextsDir, contextName, "full");
      if (!existsSync(fullDir)) {
        continue;
      }

      for (const entry of readdirSync(fullDir).sort()) {
        if (!entry.endsWith(".yaml") || entry.startsWith("_")) {
          continue;
        }

        const entityProfile = loadYamlFile<EntityProfile>(join(fullDir, entry));
        const rawEntity = toSyntheticCoreEntity(contextName, entityProfile);
        const entity = applyBaseEntityToCore(rawEntity, baseEntity, {
          kind: "contextFull",
          path: join(fullDir, entry),
        });
        entities.push({
          ...entity,
          fields: expandEntityFieldShapes(entity.fields, semanticTypes, componentCatalog),
        });
      }
    }
  }

  return entities;
}

export function getWorkflowCoreEntityGraphqlRegistry(
  authoringDir: string,
  options: WorkflowEntityGenerationOptions = {
    excludeEntitySlugs: generatedCrudDeniedEntitySlugs,
  },
): Record<string, { plural: string; filterType: string; idField: string }> {
  const registry: Record<string, { plural: string; filterType: string; idField: string }> = {};
  for (const entity of loadWorkflowNodeEntities(authoringDir)) {
    const slug = toKebabCase(entity.entity);
    if (options.excludeEntitySlugs?.has(slug)) {
      continue;
    }
    if (registry[slug]) {
      continue;
    }
    registry[slug] = {
      plural: pluralize(uncapitalize(entity.entity)),
      filterType: `${entity.entity}Filter`,
      idField: "id",
    };
  }
  return registry;
}

/**
 * Public helper for other generators (e.g. `workflow-node-config.ts`) that need
 * to enrich authored `Field`s with the same entity-ID picker metadata the
 * CoreEntity generator applies. Walks the field tree and, for any field whose
 * `semanticType` resolves to a `kind: entityId` catalog entry, attaches the
 * catalog's `listUrl` as a remote-options source and forces the render to
 * `OptionVariablePicker`. Authoring-supplied `options` win over the catalog.
 */
export function enrichFieldsWithEntityIdRemoteOptions(
  semanticTypes: Record<string, SemanticTypeDefinition>,
  fields: Field[],
): Field[] {
  return fields.map((field) => enrichFieldWithEntityIdRemoteOptions(field, semanticTypes));
}

function enrichFieldWithEntityIdRemoteOptions(
  field: Field,
  semanticTypes: Record<string, SemanticTypeDefinition>,
): Field {
  const cloned = cloneField(field);
  const semanticType = cloned.semanticType ? semanticTypes[cloned.semanticType] : undefined;

  if (semanticType?.kind === "entityId" && semanticType.listUrl) {
    if (!cloned.options) {
      cloned.options = {
        type: "remote" as const,
        remoteUrl: semanticType.listUrl,
      };
    }
    cloned.render = {
      component: "OptionVariablePicker",
      props: {
        valueMode: "insertText",
      },
    };
  }

  if (Array.isArray(cloned.children)) {
    cloned.children = cloned.children.map((child) =>
      enrichFieldWithEntityIdRemoteOptions(child, semanticTypes),
    );
  }

  if (cloned.item) {
    cloned.item = enrichFieldWithEntityIdRemoteOptions(cloned.item, semanticTypes);
  }

  return cloned;
}
