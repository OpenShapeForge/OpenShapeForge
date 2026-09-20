// SPDX-License-Identifier: BUSL-1.1
/**
 * How one session's entity tools and entity resources are described: the
 * dedicated tool with its withheld fields and localized text, the generic
 * `osf_*` tools in their two-step projection, the resolution of a call to
 * the catalogue entry it means, and the entity schema resources.
 *
 * Split out of generated-mcp-server.ts.
 */
import { collectionManagedFields, withoutCollectionInputs } from "../operations/entity/collection-policy.js";
import {
  GENERIC_DESCRIBE_TOOL_NAME,
  GENERIC_TOOL_OPERATIONS,
  compactGenericInputSchema,
  describeToolDefinition,
  genericToolText,
  type GenericToolBranch,
} from "@openshapeforge/operations";
import { type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { DbSessionInput } from "../db/session.js";
import { getEntityOperationContracts, getGeneratedCrudTables } from "../operations/entity/index.js";
import type { EntityOperationContract } from "../operations/entity/types.js";
import { canReadClassifiedColumns } from "../graphql/generated-authz.js";
import { HttpError } from "../rest/http-error.js";
import { DATA_ACQUISITION_TOOL_FOOTER, ENTITY_CATALOG_URI } from "./server-instructions.js";
import { localizedText, type ResolvedLocale } from "./locale.js";
import {
  catalog,
  crudToolsNamed,
  sessionMayInvoke,
  toolsForSession,
  withholdClassified,
  withholdClassifiedOutput,
  type CatalogEntity,
  type CatalogField,
  type CatalogTool,
  type GeneratedTable,
} from "./catalog.js";
import { ENTITY_CONFIGURATION_APP_URI, publicOriginIsHttps } from "./handoff-config.js";

/**
 * Cap on rows a catalogue resource read returns. A resource has no cursor
 * protocol, so the cap keeps one read bounded; a catalogue larger than this
 * needs the list tool, which pages.
 */
export const RESOURCE_READ_LIMIT = 200;

/** The entity's authored label in the session's language, when it has one. */
export function entityTitle(
  entity: CatalogEntity | undefined,
  locale: ResolvedLocale | undefined,
): string | undefined {
  if (!entity) return undefined;
  return (locale && localizedText(entity.labels, locale)) || entity.title;
}

export let canonicalOperationsById: Map<string, EntityOperationContract> | undefined;

/**
 * The title and description of an entity CRUD tool in the session's language.
 *
 * The compiler collapses the canonical operation's `{ en, nl, … }` name and
 * description into English at build time and appends its own advice ("use get
 * for one known id", the edit-lease reminder). The canonical operation still
 * carries every language, so the localized sentence replaces the English one
 * it was composed from and the advice is kept; a tool without a canonical
 * operation (legacy v1) or a text the catalogue did not compose that way is
 * described as compiled.
 */
export function localizedToolText(
  tool: CatalogTool,
  locale: ResolvedLocale | undefined,
): { title: string | undefined; description: string } {
  const compiled = { title: tool.title, description: tool.description };
  if (!locale || !tool.operationId) return compiled;
  canonicalOperationsById ??= new Map(
    getEntityOperationContracts().map((operation) => [operation.id, operation]),
  );
  const canonical = canonicalOperationsById.get(tool.operationId);
  if (!canonical) return compiled;
  const english = localizedText(canonical.description, "en");
  const localized = localizedText(canonical.description, locale);
  return {
    title: localizedText(canonical.name, locale) ?? tool.title,
    description:
      english && localized && tool.description.startsWith(english)
        ? `${localized}${tool.description.slice(english.length)}`
        : tool.description,
  };
}

export function describeTool(
  tool: CatalogTool,
  entity: CatalogEntity | undefined,
  table: GeneratedTable | undefined,
  session: DbSessionInput,
  locale?: ResolvedLocale,
) {
  const classified =
    entity && !canReadClassifiedColumns(table?.source?.authorization, session)
      ? entity.classifiedFields
      : [];
  const text = localizedToolText(tool, locale);
  // Every generated create/update tool carries the same short reminder — see
  // DATA_ACQUISITION_TOOL_FOOTER and DATA_ACQUISITION_GUIDANCE in
  // mcp/server-instructions.ts. Read
  // and delete stay untouched: there is nothing to fill in.
  const description =
    tool.operation === "create" || tool.operation === "update"
      ? `${text.description}${DATA_ACQUISITION_TOOL_FOOTER}`
      : text.description;
  return {
    name: tool.name,
    title: text.title,
    description,
    inputSchema: withholdClassified(
      table && (tool.operation === "create" || tool.operation === "update")
        ? withoutCollectionInputs(tool.inputSchema as Record<string, unknown>, collectionManagedFields(table, getGeneratedCrudTables()))
        : tool.inputSchema as Record<string, unknown>,
      classified,
    ),
    ...(tool.outputSchema
      ? {
          outputSchema: withholdClassifiedOutput(
            tool.outputSchema,
            tool.operation,
            classified,
          ) as Tool["outputSchema"],
        }
      : {}),
    annotations: {
      title: text.title,
      ...tool.annotations,
    },
    // The MCP App is only advertised where it can render (https origin —
    // see publicOriginIsHttps); elsewhere the create tool answers with a
    // plain configuration URL instead.
    ...(tool.operation === "create" && entity?.elicitOnCreate && publicOriginIsHttps()
      ? { _meta: { ui: { resourceUri: ENTITY_CONFIGURATION_APP_URI } } }
      : {}),
  };
}

/**
 * Entities that share the `osf_*` tools rather than owning a prefixed set.
 * The compiler stamps this on the entity, not on the tool: a tool entry is
 * per-entity either way, and only the entity knows which style it opted into.
 */
export function entityIsGeneric(entity: CatalogEntity | undefined): boolean {
  return entity?.tools === "generic";
}

/**
 * Project the per-entity catalog entries that share one `osf_*` name into the
 * single tool a session actually sees.
 *
 * The merge happens AFTER the session filter on purpose: `entity` is the
 * parameter that picks the table, so its enum is the authorization boundary
 * the model is shown. Deduplicating on name instead would keep whichever
 * entry came first and either narrow the surface arbitrarily or advertise an
 * entity this session may not touch.
 *
 * The advertised schema is the compact two-step projection
 * (@openshapeforge/operations, mcp-generic-projection.ts): the properties
 * every entity shares verbatim, a stub for the ones that differ, and the
 * exact per-entity schema one `osf_describe` call away. The call path still
 * validates against the per-entity schema.
 */
export function describeGenericTool(
  entries: { tool: CatalogTool; entity: CatalogEntity | undefined }[],
  tables: Map<string, GeneratedTable>,
  session: DbSessionInput,
  locale: ResolvedLocale,
): Tool {
  const first = entries[0]!.tool;
  const operation = first.operation;
  const branches: GenericToolBranch[] = entries.map(({ tool, entity }) => ({
    entity: tool.entity,
    title: entityTitle(entity, locale) ?? tool.entity,
    inputSchema: describeTool(tool, entity, tables.get(tool.table), session, locale)
      .inputSchema as Record<string, unknown>,
  }));
  const text = genericToolText(operation, branches, ENTITY_CATALOG_URI, locale.tag);
  const elicits = entries.find(
    ({ entity }) => entity?.elicitOnCreate !== undefined,
  );
  return {
    name: first.name,
    title: text.title,
    description: text.description,
    inputSchema: compactGenericInputSchema(operation, branches, locale.tag) as Tool["inputSchema"],
    // A shared generic tool may still contain legacy v1 entities. Do not add a
    // response contract to that legacy surface; only an all-v2 group can
    // advertise the common field-agnostic canonical envelope.
    ...(entries.every(({ tool }) => tool.outputSchema !== undefined)
      ? { outputSchema: first.outputSchema as Tool["outputSchema"] }
      : {}),
    annotations: {
      title: text.title,
      ...first.annotations,
    },
    ...(operation === "create" && elicits && publicOriginIsHttps()
      ? { _meta: { ui: { resourceUri: ENTITY_CONFIGURATION_APP_URI } } }
      : {}),
  } as Tool;
}

/**
 * The second step of the generic projection: the exact per-entity schemas of
 * the operations this session may perform on one entity, described the same
 * way (withholding, collection policy, locale) the listing would describe a
 * dedicated tool.
 */
export function describeGenericEntity(
  wanted: unknown,
  operation: unknown,
  session: DbSessionInput,
  tables: Map<string, GeneratedTable>,
  locale: ResolvedLocale,
): Record<string, unknown> {
  const entries = toolsForSession(session, tables).filter(({ entity }) =>
    entityIsGeneric(entity),
  );
  const addressable = [...new Set(entries.map(({ tool }) => tool.entity))];
  if (typeof wanted !== "string" || !addressable.includes(wanted)) {
    throw new HttpError(
      400,
      "BAD_USER_INPUT",
      typeof wanted === "string" && wanted.length > 0
        ? `"${wanted}" is not one of the entities the osf_* tools can address ` +
            `in this session: ${addressable.join(", ")}.`
        : `${GENERIC_DESCRIBE_TOOL_NAME} needs an "entity" argument naming the ` +
            `record type. Available here: ${addressable.join(", ")}.`,
    );
  }
  if (
    operation !== undefined &&
    !(GENERIC_TOOL_OPERATIONS as readonly unknown[]).includes(operation)
  ) {
    throw new HttpError(
      400,
      "BAD_USER_INPUT",
      `"operation" must be one of ${GENERIC_TOOL_OPERATIONS.join(", ")}.`,
    );
  }
  const own = entries.filter(
    ({ tool }) => tool.entity === wanted && (operation === undefined || tool.operation === operation),
  );
  const entity = own[0]?.entity;
  return {
    entity: wanted,
    ...(entity ? { title: entityTitle(entity, locale) ?? entity.title } : {}),
    ...(entity ? { description: entity.description } : {}),
    ...(entity ? { resource: entityResourceUri(entity) } : {}),
    operations: Object.fromEntries(
      own.map(({ tool, entity }) => {
        const described = describeTool(tool, entity, tables.get(tool.table), session, locale);
        return [
          tool.operation,
          {
            tool: tool.name,
            description: described.description,
            inputSchema: described.inputSchema,
            ...(described.outputSchema ? { outputSchema: described.outputSchema } : {}),
          },
        ];
      }),
    ),
  };
}

/**
 * The describe tool is listed exactly when the session can address an entity
 * through the generic tools, with that set as its `entity` enum.
 */
export function describeToolForSession(
  session: DbSessionInput,
  tables: Map<string, GeneratedTable>,
  locale: ResolvedLocale,
): Tool[] {
  const addressable = [
    ...new Set(
      toolsForSession(session, tables)
        .filter(({ entity }) => entityIsGeneric(entity))
        .map(({ tool }) => tool.entity),
    ),
  ];
  return addressable.length > 0
    ? [describeToolDefinition(addressable, locale.tag) as Tool]
    : [];
}

/**
 * The CRUD half of a session's tool list: dedicated entities keep one tool per
 * entity per operation, generic entities collapse into one tool per operation.
 */
export function crudToolsForSession(
  session: DbSessionInput,
  tables: Map<string, GeneratedTable>,
  locale: ResolvedLocale,
): Tool[] {
  const entries = toolsForSession(session, tables);
  const generic = new Map<
    string,
    { tool: CatalogTool; entity: CatalogEntity | undefined }[]
  >();
  const listed: (Tool | { generic: string })[] = [];
  for (const entry of entries) {
    if (!entityIsGeneric(entry.entity)) {
      listed.push(
        describeTool(
          entry.tool,
          entry.entity,
          tables.get(entry.tool.table),
          session,
          locale,
        ) as unknown as Tool,
      );
      continue;
    }
    const current = generic.get(entry.tool.name);
    if (current) {
      current.push(entry);
      continue;
    }
    // The merged tool takes the position of its first contributing entry, so
    // an existing listing order does not shuffle when an entity is added.
    generic.set(entry.tool.name, [entry]);
    listed.push({ generic: entry.tool.name });
  }
  return [
    ...listed.map((item) =>
      "generic" in item
        ? describeGenericTool(generic.get(item.generic)!, tables, session, locale)
        : item,
    ),
    ...describeToolForSession(session, tables, locale),
  ];
}

/**
 * Resolve which catalog entry a call means. A dedicated name identifies one
 * entry outright; a generic name needs the `entity` argument, which is checked
 * against the entities THIS session may invoke the operation on — the same set
 * the listing advertised.
 */
export function resolveCrudTool(
  name: string,
  args: Record<string, unknown>,
  session: DbSessionInput,
  tables: Map<string, GeneratedTable>,
): CatalogTool | undefined {
  const candidates = crudToolsNamed(name);
  if (candidates.length === 0) return undefined;
  const generic = candidates.filter((tool) =>
    entityIsGeneric(catalog.entities.find((item) => item.entity === tool.entity)),
  );
  if (generic.length === 0) return candidates[0];
  const allowed = generic.filter((tool) =>
    sessionMayInvoke(tables.get(tool.table), tool.operation, session),
  );
  // Nothing allowed reads as an unknown tool, exactly like an unauthorized
  // dedicated tool: the listing omitted it, so saying more would leak which
  // entities exist.
  if (allowed.length === 0) return undefined;
  const wanted = args.entity;
  const match = allowed.find((tool) => tool.entity === wanted);
  if (match) return match;
  throw new HttpError(
    400,
    "BAD_USER_INPUT",
    typeof wanted === "string" && wanted.length > 0
      ? `"${wanted}" is not one of the entities "${name}" can address in this ` +
          `session: ${allowed.map((tool) => tool.entity).join(", ")}.`
      : `"${name}" needs an "entity" argument naming the record type. ` +
          `Available here: ${allowed.map((tool) => tool.entity).join(", ")}.`,
  );
}

/**
 * `entity` selects the catalog entry; it is not a column, so it is dropped
 * before the per-entity schema validates the call and before the executor
 * sees it. A dedicated tool keeps whatever it was sent — a stray `entity`
 * there is an invalid argument and its own schema says so.
 */
export function withoutEntitySelector(
  tool: CatalogTool,
  args: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!args || !("entity" in args)) return args;
  const entity = catalog.entities.find((item) => item.entity === tool.entity);
  if (!entityIsGeneric(entity)) return args;
  const { entity: _selector, ...rest } = args;
  return rest;
}

/**
 * The generated entity tool a native Service binding means, resolved first by
 * its exact canonical Operation id and then by its legacy MCP tool name. An
 * unknown key falls through to the deployment's plugin operations by key.
 *
 * A dedicated name identifies one entry. A generic `osf_*` name is emitted per
 * entity, so the binding has to carry an `entity` input the same way an
 * `osf_*` tool call carries the `entity` argument. Taking the first entry
 * instead ran the binding against whichever generic entity sorts first —
 * which is why plugins/cpq-catalog documents entity CRUD as unbindable and
 * why a pentest Service cannot maintain its VulnerabilityType catalogue.
 * Ambiguity is refused, loudly and at the binding, rather than guessed.
 */
export function resolveNativeCrudTool(
  operationKey: string,
  inputs: Record<string, unknown>,
): CatalogTool | undefined {
  const canonical = catalog.tools.filter(
    (tool) => tool.operationId === operationKey,
  );
  if (canonical.length > 1) {
    throw new HttpError(
      400,
      "OPERATION_MISCONFIGURED",
      `Canonical native operation "${operationKey}" resolves to more than one generated operation.`,
    );
  }
  if (canonical.length === 1) return canonical[0];
  const candidates = crudToolsNamed(operationKey);
  if (candidates.length <= 1) return candidates[0];
  const wanted = inputs.entity;
  const match = candidates.find((tool) => tool.entity === wanted);
  if (match) return match;
  throw new HttpError(
    400,
    "OPERATION_MISCONFIGURED",
    `Native operation "${operationKey}" is shared by the entities ` +
      `${candidates.map((tool) => tool.entity).join(", ")}. The binding must ` +
      `supply an "entity" input naming the one it means, exactly as a direct ` +
      `"${operationKey}" call does.`,
  );
}

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
