// SPDX-License-Identifier: BUSL-1.1
/**
 * Tenant fields in the MCP tool schemas (§5.7, contract decision 16). The
 * static catalogue cannot know a tenant's fields, so every `tools/list` and
 * every `tools/call` first proves this session's definitions
 * (`primeSessionExtensions`), and the per-entity input schema — the one the
 * listing advertises, `osf_describe` returns and the dispatch validates — is
 * enriched with `extensions` typed per key. Listing and dispatch derive from
 * the same function, so the list never advertises what the call refuses.
 */
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withDbSession, type DbSessionInput } from "../db/session.js";
import { getGeneratedCrudTables, isGeneratedCrudOperationEnabled, requireEntityOperation } from "../operations/entity/catalog.js";
import { extensionPropertySchema, extensionShape } from "../operations/entity/extensions/model.js";
import { extensionRegistry } from "../operations/entity/extensions/registry.js";
import { extensibleEntityOf, loadExtensionFields, provenExtensionFields } from "../operations/entity/extensions/store.js";
import type { GeneratedCrudTable } from "../operations/entity/types.js";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function readable(table: GeneratedCrudTable, session: DbSessionInput): boolean {
  try {
    requireEntityOperation(table, isGeneratedCrudOperationEnabled(table, "list") ? "list" : "get", session);
    return true;
  } catch {
    return false;
  }
}

/** Prove the definitions of every extensible entity this session may read. */
export async function primeSessionExtensions(db: OpenShapeForgeDatabase, session: DbSessionInput): Promise<void> {
  if (!session.tenantId || !extensionRegistry.entityNames().length) return;
  const tables = getGeneratedCrudTables().filter((table) => extensibleEntityOf(table) && readable(table, session));
  if (!tables.length) return;
  await withDbSession(db, session, async (trx) => {
    for (const table of tables) await loadExtensionFields(trx, session, table);
  });
}

/** Whether this host can change a session's tool list by a tenant definition. */
export function hasExtensibleEntities(): boolean {
  return extensionRegistry.entityNames().length > 0;
}

/**
 * The input schema of one entity tool with this session's tenant fields:
 * `extensions` on create (flat) and update (`values`), and on list a filter
 * namespace and sort keys for the fields a query may use (never a
 * classified or collection sort key).
 */
export function withExtensionInputSchema(
  operation: string,
  schema: Record<string, unknown>,
  table: GeneratedCrudTable | undefined,
  session: DbSessionInput,
): Record<string, unknown> {
  if (!table || !extensibleEntityOf(table)) return schema;
  const set = provenExtensionFields(session, table);
  if (!set) return schema;
  const live = set.fields.filter((field) => field.state !== "deleted");
  if (operation === "create" || operation === "update") {
    const writable = live.filter((field) => field.kind === "stored" && field.state !== "deprecated");
    const properties = Object.fromEntries(writable.map((field) => {
      const property = extensionPropertySchema(set, field.key) ?? {};
      return [field.key, operation === "update" ? { anyOf: [property, { type: "null" }], description: property.description } : property];
    }));
    const extensions = {
      type: "object", additionalProperties: false, properties,
      description: "Tenant-defined fields of this record, by key. On update a missing key is unchanged and null clears it.",
    };
    const properties0 = object(schema.properties) ? schema.properties : {};
    if (operation === "create") return { ...schema, properties: { ...properties0, extensions } };
    const values = object(properties0.values) ? properties0.values : { type: "object", properties: {} };
    const valueProperties = object(values.properties) ? values.properties : {};
    return { ...schema, properties: { ...properties0, values: { ...values, properties: { ...valueProperties, extensions } } } };
  }
  if (operation === "list") {
    const queryable = live.filter((field) => !extensionShape(set.entry, field.definition).classified);
    const properties0 = object(schema.properties) ? schema.properties : {};
    const next: Record<string, unknown> = { ...properties0 };
    if (object(properties0.filter)) {
      const filter = properties0.filter;
      const filterProperties = object(filter.properties) ? filter.properties : {};
      next.filter = { ...filter, properties: { ...filterProperties, extensions: {
        type: "object", additionalProperties: false,
        description: `Tenant field predicates (at most ${set.entry.limits.filtersPerQuery} per query); a multi-valued field takes contains only.`,
        properties: Object.fromEntries(queryable.map((field) => [field.key, { type: "object" }])),
      } } };
    }
    if (object(properties0.sortField) && Array.isArray(properties0.sortField.enum)) {
      const sortable = queryable.filter((field) => !extensionShape(set.entry, field.definition).collection);
      next.sortField = { ...properties0.sortField, enum: [...properties0.sortField.enum as unknown[], ...sortable.map((field) => `extensions.${field.key}`)] };
    }
    return { ...schema, properties: next };
  }
  return schema;
}

/** A catalogue tool with its schema enriched for this session, for the dispatch checks. */
export function withExtensionTool<T extends { operation: string; inputSchema: unknown }>(
  tool: T,
  table: GeneratedCrudTable | undefined,
  session: DbSessionInput,
): T {
  const enriched = withExtensionInputSchema(tool.operation, tool.inputSchema as Record<string, unknown>, table, session);
  return enriched === tool.inputSchema ? tool : { ...tool, inputSchema: enriched };
}
