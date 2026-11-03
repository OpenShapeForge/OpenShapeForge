// SPDX-License-Identifier: BUSL-1.1
/**
 * Current tenant field definitions of an extensible entity, read from
 * `platform.extension_field_definitions` inside the caller's RLS session and
 * cached per (tenant, entity) on a hash of the current versions. Every
 * request that reads or writes an extensible record proves the hash first
 * (one indexed aggregate), so a definition change by another process is seen
 * by the next request, never served stale from this cache.
 */
import { sql, type Transaction } from "kysely";
import type { RuntimeExtensibleEntity } from "@openshapeforge/plugin-runtime";
import type { DB } from "../../../generated/db/types.js";
import type { DbSessionInput } from "../../../db/session.js";
import type { GeneratedCrudTable } from "../types.js";
import { extensionRegistry } from "./registry.js";
import {
  EXTENSION_VALUES_COLUMN,
  extensionError,
  type ExtensionField,
  type ExtensionFieldSet,
  type ExtensionKind,
  type ExtensionState,
} from "./model.js";

/** The registry entry of a table that is the authored home of an extensible entity. */
export function extensibleEntityOf(table: GeneratedCrudTable): { entity: string; entry: RuntimeExtensibleEntity } | undefined {
  const entity = table.source?.authoringEntityName;
  if (!entity || table.subtype) return undefined;
  const entry = extensionRegistry.entity(entity);
  if (!entry) return undefined;
  if (entry.table !== `${table.schema}.${table.table}` || !table.tenantScoped || table.primaryKey !== "id" ||
      !table.columns.some((column) => column.name === EXTENSION_VALUES_COLUMN && column.type === "jsonb")) {
    throw extensionError("Extension registry metadata does not match its table.", "INVALID_DEFINITION");
  }
  return { entity, entry };
}

/**
 * Whether this physical table carries an `extension_values` source column, for
 * any entity sharing it (a subtype reads its base table): the raw column is
 * never a caller field on any of them.
 */
export function carriesExtensionValues(table: GeneratedCrudTable): boolean {
  const physical = `${table.schema}.${table.table}`;
  return extensionRegistry.entityNames().some((name) => extensionRegistry.entity(name)!.table === physical) &&
    table.columns.some((column) => column.name === EXTENSION_VALUES_COLUMN);
}

type DefinitionRow = {
  id: string; field_id: string; key: string; version: number; kind: ExtensionKind;
  definition: Record<string, unknown>; applies_when: unknown; state: ExtensionState; position: number;
};

const CACHE_LIMIT = 2048;
const cache = new Map<string, ExtensionFieldSet>();
const cacheKey = (tenantId: string, entity: string) => `${tenantId}:${entity}`;

function remember(tenantId: string, set: ExtensionFieldSet): ExtensionFieldSet {
  const key = cacheKey(tenantId, set.entity);
  cache.delete(key);
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(key, set);
  return set;
}

function toSet(entity: string, entry: RuntimeExtensibleEntity, hash: string, rows: DefinitionRow[]): ExtensionFieldSet {
  const fields: ExtensionField[] = rows
    .map((row) => Object.freeze({
      rowId: row.id, fieldId: row.field_id, key: row.key, version: Number(row.version), kind: row.kind,
      definition: row.definition, appliesWhen: row.applies_when ?? null, state: row.state, position: Number(row.position),
    }))
    .sort((left, right) => left.position - right.position || left.key.localeCompare(right.key));
  const live = fields.filter((field) => field.state !== "deleted");
  return Object.freeze({
    entity, entry, hash, fields: Object.freeze(fields),
    byKey: new Map(live.map((field) => [field.key, field])),
    byId: new Map(fields.map((field) => [field.fieldId, field])),
  });
}

/** The hash of the current versions; cheap enough to prove on every request. */
async function currentHash(trx: Transaction<DB>, tenantId: string, entity: string): Promise<string> {
  const result = await sql<{ hash: string | null }>`
    select md5(string_agg(id::text || ':' || state || ':' || position::text, ',' order by id)) as hash
    from platform.extension_field_definitions
    where tenant_id = ${tenantId}::uuid and entity = ${entity} and is_current
  `.execute(trx);
  return result.rows[0]?.hash ?? "empty";
}

export async function loadExtensionFieldsFor(
  trx: Transaction<DB>,
  session: DbSessionInput,
  entity: string,
  entry: RuntimeExtensibleEntity,
  options: { lock?: boolean } = {},
): Promise<ExtensionFieldSet> {
  const tenantId = session.tenantId;
  if (!tenantId) extensionError("Tenant fields require a tenant session.", "UNAUTHENTICATED");
  if (options.lock) {
    // One designer at a time per (tenant, entity): versions, positions and
    // the field limit are decided under this lock.
    await sql`select pg_advisory_xact_lock(hashtextextended(${`osf-extensions:${tenantId}:${entity}`}, 0))`.execute(trx);
  }
  const hash = await currentHash(trx, tenantId!, entity);
  const cached = cache.get(cacheKey(tenantId!, entity));
  if (cached && cached.hash === hash && cached.entry === entry) return cached;
  const rows = await sql<DefinitionRow>`
    select id, field_id, key, version, kind, definition, applies_when, state, position
    from platform.extension_field_definitions
    where tenant_id = ${tenantId}::uuid and entity = ${entity} and is_current
  `.execute(trx);
  return remember(tenantId!, toSet(entity, entry, hash, rows.rows));
}

/** Load (and prove) the definitions of a table's entity; undefined when not extensible. */
export async function loadExtensionFields(
  trx: Transaction<DB>,
  session: DbSessionInput,
  table: GeneratedCrudTable,
): Promise<ExtensionFieldSet | undefined> {
  const extensible = extensibleEntityOf(table);
  if (!extensible) return undefined;
  return loadExtensionFieldsFor(trx, session, extensible.entity, extensible.entry);
}

/**
 * The definitions this process last proved for the session's tenant. The
 * synchronous projection reads them; every entry point that reads or writes
 * an extensible record proves them first (`loadExtensionFields`). Absent
 * means "not proven in this process": the projection then withholds
 * `extensions` rather than guess at classification.
 */
export function provenExtensionFields(session: DbSessionInput | undefined | null, table: GeneratedCrudTable): ExtensionFieldSet | undefined {
  const extensible = extensibleEntityOf(table);
  if (!extensible || !session?.tenantId) return undefined;
  const cached = cache.get(cacheKey(session.tenantId, extensible.entity));
  return cached?.entry === extensible.entry ? cached : undefined;
}

/** Drop a tenant's proven definitions after this process changed them. */
export function forgetExtensionFields(tenantId: string, entity: string): void {
  cache.delete(cacheKey(tenantId, entity));
}
