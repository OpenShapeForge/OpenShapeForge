// SPDX-License-Identifier: BUSL-1.1
/**
 * Tenant fields in the MCP tool schemas. The
 * static catalogue cannot know a tenant's fields, so every `tools/list` and
 * every `tools/call` first proves this session's definitions
 * (`primeSessionExtensions`), and the per-entity input schema — the one the
 * listing advertises, `osf_describe` returns and the dispatch validates — is
 * enriched with `extensions` typed per key. Listing and dispatch derive from
 * the same function, so the list never advertises what the call refuses.
 * A computed field (a formula) is read-only: never a property of the create
 * or update input — which refuses any key it does not list — and marked
 * `readOnly` where a list may filter or sort on it.
 */
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withDbSession, type DbSessionInput } from "../db/session.js";
import { getGeneratedCrudTables, isGeneratedCrudOperationEnabled, requireEntityOperation } from "../operations/entity/catalog.js";
import { extensionPropertySchema, extensionShape } from "../operations/entity/extensions/model.js";
import { extensionRegistry } from "../operations/entity/extensions/registry.js";
import { extensibleEntityOf, loadExtensionFields } from "../operations/entity/extensions/store.js";
import type { ExtensionFieldSet } from "../operations/entity/extensions/model.js";
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

/**
 * The sets the last prime proved, per session object: a tool schema is built
 * after the prime's transaction closed, so it reads them from here — never
 * from a process-wide "latest" set another session or replica left behind.
 * The runtime validates every value again inside its own transaction.
 */
const primed = new WeakMap<object, Map<string, ExtensionFieldSet>>();

/** Prove the definitions of every extensible entity this session may read. */
export async function primeSessionExtensions(db: OpenShapeForgeDatabase, session: DbSessionInput): Promise<void> {
  if (!session.tenantId || !extensionRegistry.entityNames().length) return;
  const tables = getGeneratedCrudTables().filter((table) => extensibleEntityOf(table) && readable(table, session));
  if (!tables.length) return;
  const sets = new Map<string, ExtensionFieldSet>();
  await withDbSession(db, session, async (trx) => {
    for (const table of tables) {
      const set = await loadExtensionFields(trx, session, table);
      if (set) sets.set(table.name, set);
    }
  });
  primed.set(session, sets);
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
  const set = primed.get(session)?.get(table.name);
  if (!set || set.entry !== extensibleEntityOf(table)?.entry) return schema;
  const live = set.fields.filter((field) => field.state !== "deleted");
  if (operation === "create" || operation === "update") {
    const writable = live.filter((field) => field.kind === "stored" && field.state !== "deprecated");
    const computed = live.filter((field) => field.kind !== "stored" && field.state !== "deprecated").map((field) => field.key).sort();
    const properties = Object.fromEntries(writable.map((field) => {
      const property = extensionPropertySchema(set, field.key) ?? {};
      return [field.key, operation === "update" ? { anyOf: [property, { type: "null" }], description: property.description } : property];
    }));
    const extensions = {
      type: "object", additionalProperties: false, properties,
      description: "Tenant-defined fields of this record, by key. On update a missing key is unchanged and null clears it." +
        (computed.length ? ` Computed and read-only, so never accepted here: ${computed.join(", ")}.` : ""),
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
        properties: Object.fromEntries(queryable.map((field) => [field.key, field.kind === "stored" ? { type: "object" }
          : { type: "object", readOnly: true, description: `Computed by a ${field.kind}${typeof field.definition.osfType === "string" ? ` (${field.definition.osfType})` : ""}; read-only.` }])),
      } } };
    }
    if (object(properties0.sortField) && Array.isArray(properties0.sortField.enum)) {
      const sortable = queryable.filter((field) => {
        const shape = extensionShape(set.entry, field.definition);
        return !shape.collection && !shape.projection;
      });
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
