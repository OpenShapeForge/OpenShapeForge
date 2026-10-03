// SPDX-License-Identifier: BUSL-1.1
/**
 * The entity schema resources of one session: which entities it sees, which
 * fields of them, and the authored catalogue resources. Split out of
 * entity-tool-projection.ts.
 */

/**
 * Cap on rows a catalogue resource read returns. A resource has no cursor
 * protocol, so the cap keeps one read bounded; a catalogue larger than this
 * needs the list tool, which pages.
 */
import type { DbSessionInput } from "../db/session.js";
import { canReadClassifiedColumns } from "../graphql/generated-authz.js";
import { ENTITY_CATALOG_URI } from "./server-instructions.js";
import { localizedText, type ResolvedLocale } from "./locale.js";
import {
  type CatalogEntity,
  type CatalogField,
  type CatalogTool,
  type GeneratedTable,
  catalog,
} from "./catalog.js";
import { toolsForSession } from "./session-projection.js";
export const RESOURCE_READ_LIMIT = 200;

export type SessionEntity = {
  entity: CatalogEntity;
  tools: CatalogTool[];
};

export function entityResourceUri(entity: CatalogEntity): string {
  return `${ENTITY_CATALOG_URI}/${encodeURIComponent(entity.slug)}`;
}

export function entitiesForSession(
  session: DbSessionInput,
  tables: Map<string, GeneratedTable>,
): SessionEntity[] {
  const toolsByEntity = new Map<string, CatalogTool[]>();
  for (const { tool } of toolsForSession(session, tables)) {
    const current = toolsByEntity.get(tool.entity) ?? [];
    current.push(tool);
    toolsByEntity.set(tool.entity, current);
  }
  return catalog.entities.flatMap((entity) => {
    const tools = toolsByEntity.get(entity.entity);
    return tools ? [{ entity, tools }] : [];
  });
}

export function visibleFields(
  entity: CatalogEntity,
  table: GeneratedTable | undefined,
  session: DbSessionInput,
): CatalogField[] {
  if (canReadClassifiedColumns(table?.source?.authorization, session))
    return entity.fields;
  const classified = new Set(entity.classifiedFields);
  return entity.fields.filter((field) => !classified.has(field.key));
}

export function describeEntityResource(
  entry: SessionEntity,
  sessionEntities: SessionEntity[],
  tables: Map<string, GeneratedTable>,
  session: DbSessionInput,
  locale?: ResolvedLocale,
) {
  const { entity, tools } = entry;
  const resourceByEntity = new Map(
    sessionEntities.map((candidate) => [
      candidate.entity.entity,
      entityResourceUri(candidate.entity),
    ]),
  );
  const fields = visibleFields(entity, tables.get(entity.table), session);
  const storageRelationships = tables.get(entity.table)?.source?.graphql?.relationships ?? [];
  const relationships = entity.relationships.filter((relationship) =>
    resourceByEntity.has(relationship.target),
  );
  // displayTemplate and filterField reference fields by name; publishing either
  // to a session whose visibleFields hides that name would hand the caller the
  // classified field's name and point it at a filter/sort its own tools refuse.
  const visible = new Set(fields.map((field) => field.key));
  const templateVisible =
    !entity.displayTemplate ||
    [...entity.displayTemplate.matchAll(/{{\s*([\w.]+)\s*}}/g)].every(
      ([, key]) => visible.has(key!.split(".")[0]!),
    );

  return {
    entity: entity.entity,
    slug: entity.slug,
    title: localizedText(entity.labels, locale) ?? entity.title,
    language: locale?.tag,
    description: entity.description,
    domains: entity.domains,
    ...(entity.displayTemplate && templateVisible
      ? { displayTemplate: entity.displayTemplate }
      : {}),
    ...(entity.filterField && visible.has(entity.filterField)
      ? { filterField: entity.filterField }
      : {}),
    // A relationship-bearing field stays readable as a scalar (the row contains
    // it and the write tools require it); only the relationship edge is gated
    // on target visibility — the same split GraphQL settled in
    // generated-entity-schema.ts.
    fields: fields.map((field) => {
      const { relationship, ...rest } = field;
      const canonical = storageRelationships.find((entry) => entry.fieldKey === field.key);
      const target = canonical?.target ?? entity.relationships.find((entry) => entry.key === field.key)?.target ?? relationship?.entity;
      return {
        ...rest,
        ...(relationship && target && resourceByEntity.has(target)
          ? {
              relationship: {
                ...relationship,
                entity: target,
                resourceUri: resourceByEntity.get(target),
              },
            }
          : {}),
      };
    }),
    relationships: relationships.map((relationship) => ({
      ...relationship,
      ...storageRelationships.find((entry) => entry.fieldKey && entry.name === relationship.key),
      resourceUri: resourceByEntity.get(relationship.target),
    })),
    operations: tools.map((tool) => ({
      name: tool.name,
      operation: tool.operation,
      title: tool.title,
      description: tool.description,
      annotations: tool.annotations,
    })),
  };
}

/**
 * `locale` picks which authored label each entity is named by. It changes only
 * the reading — `entity`, `slug` and every field key are identifiers and are
 * the same in every language, which is what keeps this safe to vary per
 * session: two people looking at the same deployment see the same catalog,
 * spelled in their own language.
 */
export function describeCatalogResource(
  entries: SessionEntity[],
  locale?: ResolvedLocale,
) {
  return {
    catalogId: "openshapeforge.entity-schemas",
    generatedBy: catalog.generatedBy,
    source: catalog.source,
    language: locale?.tag,
    entities: entries.map(({ entity, tools }) => ({
      entity: entity.entity,
      slug: entity.slug,
      title: localizedText(entity.labels, locale) ?? entity.title,
      description: entity.description,
      domains: entity.domains,
      resourceUri: entityResourceUri(entity),
      operations: tools.map((tool) => tool.name),
    })),
  };
}

export const __describeEntityResourceForTests = describeEntityResource;
