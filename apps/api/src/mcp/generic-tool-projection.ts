// SPDX-License-Identifier: BUSL-1.1
/**
 * The shared `osf_*` tools of one session: the compact two-step projection
 * of every generic entity the session may address, the describe tool that
 * serves the exact per-entity schemas, and the resolution of a generic call
 * to the catalogue entry it means. Split out of entity-tool-projection.ts.
 */

/**
 * Entities that share the `osf_*` tools rather than owning a prefixed set.
 * The compiler stamps this on the entity, not on the tool: a tool entry is
 * per-entity either way, and only the entity knows which style it opted into.
 */
import { crudToolAvailable } from "./session-projection.js";
import { entityResourceUri } from "./entity-resources.js";
import {
  GENERIC_DESCRIBE_TOOL_NAME,
  GENERIC_TOOL_OPERATIONS,
  advertisedGenericTool,
  describeToolDefinition,
  type GenericToolBranch,
} from "@openshapeforge/operations";
import { type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { DbSessionInput } from "../db/session.js";
import { HttpError } from "../rest/http-error.js";
import { ENTITY_CATALOG_URI } from "./server-instructions.js";
import { type ResolvedLocale } from "./locale.js";
import {
  type CatalogEntity,
  type CatalogTool,
  type GeneratedTable,
  catalog,
  crudToolsNamed,
} from "./catalog.js";
import { describeTool, entityTitle } from "./entity-tool-projection.js";
import { publicOriginIsHttps } from "./handoff-config.js";
import { toolsForSession } from "./session-projection.js";
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
  // The advertised shape is the package's, shared with the compiler's byte
  // budget. Every entity answers the same canonical envelope, so the group
  // advertises the first entry's output schema. The MCP App is only linked
  // where it can render (https origin — see publicOriginIsHttps).
  return advertisedGenericTool({
    name: first.name,
    operation,
    branches,
    entityCatalogUri: ENTITY_CATALOG_URI,
    outputSchema: first.outputSchema,
    annotations: first.annotations,
    linksConfigurationApp:
      entries.some(({ entity }) => entity?.elicitOnCreate !== undefined) && publicOriginIsHttps(),
    locale: locale.tag,
  }) as Tool;
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
  return describeGenericEntries(
    toolsForSession(session, tables).filter(({ entity }) => entityIsGeneric(entity)),
    wanted,
    operation,
    session,
    tables,
    locale,
  );
}

/** The describe answer over the generic entries a session may address (its own set, or a test's copy). */
export function describeGenericEntries(
  entries: { tool: CatalogTool; entity: CatalogEntity | undefined }[],
  wanted: unknown,
  operation: unknown,
  session: DbSessionInput,
  tables: Map<string, GeneratedTable>,
  locale: ResolvedLocale,
): Record<string, unknown> {
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
  // Bounded to what the session may perform on this entity, in the order
  // the operations are always listed: a read-only session is not told what
  // a delete would take, and an operation it cannot perform reads as absent.
  const performable = GENERIC_TOOL_OPERATIONS.filter((candidate) =>
    entries.some(({ tool }) => tool.entity === wanted && tool.operation === candidate),
  );
  if (operation !== undefined && !(performable as readonly unknown[]).includes(operation)) {
    throw new HttpError(
      400,
      "BAD_USER_INPUT",
      `"operation" must be one of the operations this session may perform on ` +
        `${wanted}: ${performable.join(", ")}.`,
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
            outputSchema: described.outputSchema,
            // The declared refusals, which the listing leaves out for its byte budget.
            errors: tool.errors.map(({ status, code, description }) => ({ status, code, description })),
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
  const generic = toolsForSession(session, tables).filter(({ entity }) => entityIsGeneric(entity));
  const addressable = [...new Set(generic.map(({ tool }) => tool.entity))];
  // The operation enum is what the session may perform on at least one of
  // them; the answer narrows it further to the entity asked about.
  const performable = GENERIC_TOOL_OPERATIONS.filter((candidate) =>
    generic.some(({ tool }) => tool.operation === candidate),
  );
  return addressable.length > 0
    ? [describeToolDefinition(addressable, locale.tag, performable) as Tool]
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
  const allowed = generic.filter((tool) => crudToolAvailable(tool, session, tables));
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
 * its exact canonical Operation id and then by its dedicated MCP tool name. An
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
