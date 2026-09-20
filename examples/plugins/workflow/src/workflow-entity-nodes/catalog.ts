// @ts-nocheck
// SPDX-License-Identifier: BUSL-1.1
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { buildCrud } from "../../../../../packages/compiler/src/authoring/compiler/crud.js";
import { applyBaseEntityToCore, loadBaseEntity } from "../../../../../packages/compiler/src/authoring/base-entity.js";
import { inverseCollectionsFor, resolveBaseType, osfTypeDefinitionOf } from "../../../../../packages/compiler/src/authoring/entity-fields.js";
import { withInverseCollections } from "../../../../../packages/compiler/src/authoring/inverse-collections.js";
import { listEntityFiles, loadOsfTypes } from "../../../../../packages/compiler/src/authoring/loader.js";
import type { ComponentCatalog, CoreEntity, EntityProfile, Field, OsfTypeDefinition } from "../../../../../packages/compiler/src/authoring/types.js";
import { pluralize, uncapitalize } from "../../../../../packages/compiler/src/authoring/compiler/helpers.js";
import type { WorkflowEntityGenerationOptions } from "./types.js";
import { cloneField, isCollectionCardinality, normalizeOsfTypeKey, toKebabCase } from "./utils.js";
function loadYamlFile<T>(filePath: string): T {
  return parseYaml(readFileSync(filePath, "utf-8")) as T;
}

function loadWorkflowNodeComponentCatalog(authoringDir: string): ComponentCatalog {
  const componentCatalogPath = join(authoringDir, "catalogs", "components.yaml");
  return loadYamlFile<ComponentCatalog>(componentCatalogPath);
}

/**
 * The compiler's derived catalog: the authored catalogs plus one entry per
 * loaded entity, so an `osfType` naming an entity resolves like any other.
 */
export function loadWorkflowNodeOsfTypes(authoringDir: string): Record<string, OsfTypeDefinition> {
  return loadOsfTypes(authoringDir);
}

/** The one place a loaded field learns its base type; unresolvable types fail generation. */
function withBaseType(field: Field, osfTypes: Record<string, OsfTypeDefinition>): Field {
  const baseType = resolveBaseType(field.osfType, osfTypes);
  if (!baseType) throw new Error(`Workflow field '${field.key}': unknown osfType ${field.osfType}.`);
  return { ...field, baseType };
}

/**
 * Workflow-only field expansion. Sets `render` from the osf-type catalog,
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
  osfTypes: Record<string, OsfTypeDefinition>,
  componentCatalog: ComponentCatalog,
): Field {
  const osfType = osfTypeDefinitionOf(field.osfType, osfTypes);
  const children = field.children ?? osfType?.children;
  const item = field.item ?? osfType?.item;
  const hasStructuredShape = Boolean(children || item);
  const expanded = withBaseType(cloneField(field), osfTypes);
  const isEntityId = osfType?.kind === "entityId";

  if (isEntityId) {
    if (!expanded.options && osfType.listUrl) {
      expanded.options = {
        type: "remote" as const,
        remoteUrl: osfType.listUrl,
      };
    }
    expanded.render = {
      component: "OptionVariablePicker",
      props: {
        valueMode: "insertText",
      },
    };
  } else if (!expanded.render && !(osfType?.kind === "entity" && isCollectionCardinality(expanded.cardinality))) {
    // A single entity reference is a plain identifier input in a workflow
    // form and a collection of them has no input at all; the derived entity
    // catalog entry's render is for record screens.
    if (osfType?.render && osfType.kind !== "entity") {
      expanded.render = {
        component: expanded.readOnly ? osfType.render.display : osfType.render.input,
        ...(osfType.props ? { props: osfType.props } : {}),
      };
    } else if (!hasStructuredShape) {
      const defaultComponent = componentCatalog.defaults[expanded.baseType];
      if (defaultComponent?.component) {
        expanded.render = {
          component: defaultComponent.component,
        };
      }
    }
  }

  if (children) {
    expanded.children = children.map((child) =>
      expandSemanticFieldShape(child, osfTypes, componentCatalog),
    );
  }

  if (item) {
    expanded.item = expandSemanticFieldShape(item, osfTypes, componentCatalog);
  }

  return expanded;
}

function expandEntityFieldShapes(
  fields: Field[],
  osfTypes: Record<string, OsfTypeDefinition>,
  componentCatalog: ComponentCatalog,
) {
  return fields.map((field) =>
    expandSemanticFieldShape(field, osfTypes, componentCatalog),
  );
}

/**
 * Returns the identity type declared on the entity's `id` field. Throws if
 * missing — every entity's id field carries `osfType: <entity>Id` (the base
 * entity supplies it), enforced by the validator. There is no name-based
 * fallback by design (see plan v3, blocker #1).
 */
export function resolveEntityIdOsfTypeKey(entityName: string, idField?: Field): string {
  const declared = normalizeOsfTypeKey(idField?.osfType);
  if (!declared) {
    throw new Error(
      `Entity '${entityName}' is missing osfType on its id field. ` +
        `Declare 'osfType: <entity>Id' in the entity YAML.`,
    );
  }
  return declared;
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
  };
}

export function loadWorkflowNodeEntities(authoringDir: string): CoreEntity[] {
  const entities: CoreEntity[] = [];
  const osfTypes = loadWorkflowNodeOsfTypes(authoringDir);
  const componentCatalog = loadWorkflowNodeComponentCatalog(authoringDir);
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
    // The inverse collections the compiler derives for this entity are
    // readable fields for workflow nodes, exactly like the authored ones.
    const withCollections = withInverseCollections(
      contextCompleteEntity.entity,
      contextCompleteEntity.fields,
      inverseCollectionsFor(contextCompleteEntity.entity, osfTypes),
    );
    entities.push({
      ...contextCompleteEntity,
      fields: expandEntityFieldShapes(withCollections, osfTypes, componentCatalog),
    });
  }

  return entities;
}

export function getWorkflowCoreEntityGraphqlRegistry(
  authoringDir: string,
  options: WorkflowEntityGenerationOptions = {},
): Record<string, { plural: string; filterType: string; idField: string }> {
  const registry: Record<string, { plural: string; filterType: string; idField: string }> = {};
  for (const entity of loadWorkflowNodeEntities(authoringDir)) {
    const slug = toKebabCase(entity.entity);
    if (options.excludeEntitySlugs?.has(slug)) {
      continue;
    }
    if (!isWorkflowEntityListDiscoverable(entity)) {
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

export function isWorkflowEntityListDiscoverable(entity: CoreEntity): boolean {
  return buildCrud(entity).operations.list;
}

/**
 * Public helper for other generators (e.g. `workflow-node-config.ts`) that need
 * to enrich authored `Field`s with the same entity-ID picker metadata the
 * CoreEntity generator applies. Walks the field tree, derives every field's
 * `baseType` and, for any field whose `osfType` resolves to a `kind: entityId` catalog entry, attaches the
 * catalog's `listUrl` as a remote-options source and forces the render to
 * `OptionVariablePicker`. Authoring-supplied `options` win over the catalog.
 */
export function enrichFieldsWithEntityIdRemoteOptions(
  osfTypes: Record<string, OsfTypeDefinition>,
  fields: Field[],
): Field[] {
  return fields.map((field) => enrichFieldWithEntityIdRemoteOptions(field, osfTypes));
}

function enrichFieldWithEntityIdRemoteOptions(
  field: Field,
  osfTypes: Record<string, OsfTypeDefinition>,
): Field {
  const cloned = withBaseType(cloneField(field), osfTypes);
  const osfType = osfTypeDefinitionOf(cloned.osfType, osfTypes);

  if (osfType?.kind === "entityId" && osfType.listUrl) {
    if (!cloned.options) {
      cloned.options = {
        type: "remote" as const,
        remoteUrl: osfType.listUrl,
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
      enrichFieldWithEntityIdRemoteOptions(child, osfTypes),
    );
  }

  if (cloned.item) {
    cloned.item = enrichFieldWithEntityIdRemoteOptions(cloned.item, osfTypes);
  }

  return cloned;
}
