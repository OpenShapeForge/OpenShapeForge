// SPDX-License-Identifier: BUSL-1.1
/**
 * Current tenant field definitions of an extensible entity, read from
 * `platform.extension_field_definitions` inside the caller's RLS session.
 *
 * A set is only ever used inside the transaction that proved it: every
 * request that reads or writes an extensible record proves the hash of the
 * current versions first (one indexed aggregate) and binds the set to its
 * own transaction. The synchronous projection and the query builder read the
 * set bound to the ACTIVE transaction, so a definition change by another
 * replica is seen by the next transaction, and a path that never proved one
 * gets none — it withholds `extensions` rather than serve a set this process
 * happened to remember. The process cache below only saves re-reading rows:
 * it is addressed by the hash itself, so it can return a set only for the
 * exact versions a transaction just proved, and an older set can never take
 * the place of a newer one.
 *
 * Writers and designers of one (tenant, entity) are ordered by one advisory
 * lock: a designer holds it exclusively, a writer or a backfill batch shared
 * from before it locks any record until it commits. A writer that read the
 * old definitions therefore commits before a definition change can, and a
 * write after the change reads the new one — there is no window in which a
 * late writer follows a version that is no longer current.
 */
import { randomUUID } from "node:crypto";
import { sql, type Transaction } from "kysely";
import type { RuntimeExtensibleEntity } from "@openshapeforge/plugin-runtime";
import type { DB } from "../../../generated/db/types.js";
import { currentDbSessionTransaction, type DbSessionInput } from "../../../db/session.js";
import { jsonbLiteral } from "../../../db/sql-helpers.js";
import { appendEntityEventInTransaction } from "../../../platform/entity-events.js";
import type { GeneratedCrudTable } from "../types.js";
import { extensionRegistry } from "./registry.js";
import {
  EXTENSION_VALUES_COLUMN,
  extensionError,
  type ExtensionDefinition,
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
/** Sets by the hash that proved them: `<tenant>:<entity>:<hash>`. */
const cache = new Map<string, ExtensionFieldSet>();
/** The sets each transaction proved, by `<tenant>:<entity>`. */
const proven = new WeakMap<object, Map<string, ExtensionFieldSet>>();
const scopeKey = (tenantId: string, entity: string) => `${tenantId}:${entity}`;

function remember(tenantId: string, set: ExtensionFieldSet): ExtensionFieldSet {
  const key = `${scopeKey(tenantId, set.entity)}:${set.hash}`;
  cache.delete(key);
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(key, set);
  return set;
}

/** The transaction a proof belongs to: the active session's, else the one handed in. */
function proofScope(trx: Transaction<DB>): object {
  return currentDbSessionTransaction() ?? trx;
}

function bind(trx: Transaction<DB>, tenantId: string, set: ExtensionFieldSet): ExtensionFieldSet {
  const scope = proofScope(trx);
  const sets = proven.get(scope) ?? new Map<string, ExtensionFieldSet>();
  proven.set(scope, sets);
  sets.set(scopeKey(tenantId, set.entity), set);
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

/**
 * Take the (tenant, entity) lock: `exclusive` for a definition change,
 * `shared` for a writer or a backfill batch, before it locks any record.
 */
export async function lockExtensionFields(
  trx: Transaction<DB>,
  tenantId: string,
  entity: string,
  mode: "exclusive" | "shared",
): Promise<void> {
  const key = `osf-extensions:${tenantId}:${entity}`;
  await (mode === "exclusive"
    ? sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`
    : sql`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`).execute(trx);
}

export async function loadExtensionFieldsFor(
  trx: Transaction<DB>,
  session: DbSessionInput,
  entity: string,
  entry: RuntimeExtensibleEntity,
  options: { lock?: boolean | "exclusive" | "shared" } = {},
): Promise<ExtensionFieldSet> {
  const tenantId = session.tenantId;
  if (!tenantId) extensionError("Tenant fields require a tenant session.", "UNAUTHENTICATED");
  // One designer at a time per (tenant, entity): versions, positions and the
  // field limit are decided under the exclusive lock; writers share it.
  if (options.lock) await lockExtensionFields(trx, tenantId!, entity, options.lock === "shared" ? "shared" : "exclusive");
  const hash = await currentHash(trx, tenantId!, entity);
  const cached = cache.get(`${scopeKey(tenantId!, entity)}:${hash}`);
  if (cached && cached.entry === entry) return bind(trx, tenantId!, cached);
  const rows = await sql<DefinitionRow>`
    select id, field_id, key, version, kind, definition, applies_when, state, position
    from platform.extension_field_definitions
    where tenant_id = ${tenantId}::uuid and entity = ${entity} and is_current
  `.execute(trx);
  return bind(trx, tenantId!, remember(tenantId!, toSet(entity, entry, hash, rows.rows)));
}

/** Load (and prove) the definitions of a table's entity; undefined when not extensible. */
export async function loadExtensionFields(
  trx: Transaction<DB>,
  session: DbSessionInput,
  table: GeneratedCrudTable,
  options: { lock?: "shared" } = {},
): Promise<ExtensionFieldSet | undefined> {
  const extensible = extensibleEntityOf(table);
  if (!extensible) return undefined;
  return loadExtensionFieldsFor(trx, session, extensible.entity, extensible.entry, options);
}

/**
 * The definitions the ACTIVE transaction proved for the session's tenant.
 * Absent means "not proven in this transaction": the projection then
 * withholds `extensions` rather than guess at classification or keys.
 */
export function provenExtensionFields(session: DbSessionInput | undefined | null, table: GeneratedCrudTable): ExtensionFieldSet | undefined {
  const extensible = extensibleEntityOf(table);
  const scope = currentDbSessionTransaction();
  if (!extensible || !session?.tenantId || !scope) return undefined;
  const set = proven.get(scope)?.get(scopeKey(session.tenantId, extensible.entity));
  return set?.entry === extensible.entry ? set : undefined;
}

/** Drop what this transaction proved for (tenant, entity) after it changed the definitions. */
export function forgetExtensionFields(trx: Transaction<DB>, tenantId: string, entity: string): void {
  proven.get(proofScope(trx))?.delete(scopeKey(tenantId, entity));
}

/**
 * The realtime resource of an entity's field definitions: the web
 * designer and form refresh on `<Entity>FieldDefinition`. One event per
 * definition change and per backfill step, id = the field id, no payload;
 * the change stream lets it through only to sessions that may list the
 * entity's field definitions (platform/entity-change-stream.ts).
 */
export const FIELD_DEFINITION_RESOURCE_SUFFIX = "FieldDefinition";

export async function announceFieldDefinitionChange(
  trx: Transaction<DB>,
  tenantId: string,
  entity: string,
  fieldId: string,
  change: "created" | "updated" | "deleted",
): Promise<void> {
  await appendEntityEventInTransaction(trx, {
    tenantId, aggregateType: `${entity}${FIELD_DEFINITION_RESOURCE_SUFFIX}`, aggregateId: fieldId, eventType: change,
  });
}

/** Append one definition version and make it the current one (append-only). */
export async function insertFieldVersion(
  trx: Transaction<DB>,
  session: DbSessionInput,
  entity: string,
  field: { fieldId: string; key: string; version: number; kind: ExtensionKind; definition: ExtensionDefinition; appliesWhen: unknown; state: ExtensionState; position: number },
): Promise<ExtensionField> {
  await sql`update platform.extension_field_definitions set is_current = false
    where tenant_id = ${session.tenantId}::uuid and field_id = ${field.fieldId}::uuid and is_current`.execute(trx);
  const id = randomUUID();
  await sql`insert into platform.extension_field_definitions
      (tenant_id, id, field_id, entity, key, version, kind, definition, applies_when, state, position, is_current, created_at, created_by)
    values (${session.tenantId}::uuid, ${id}::uuid, ${field.fieldId}::uuid, ${entity}, ${field.key}, ${field.version}, ${field.kind},
      ${jsonbLiteral(field.definition)}, ${field.appliesWhen === null ? null : jsonbLiteral(field.appliesWhen)}, ${field.state}, ${field.position}, true,
      now(), ${session.userId ?? null}::uuid)`.execute(trx);
  forgetExtensionFields(trx, session.tenantId!, entity);
  await announceFieldDefinitionChange(trx, session.tenantId!, entity, field.fieldId,
    field.version === 1 ? "created" : field.state === "deleted" ? "deleted" : "updated");
  return { rowId: id, ...field };
}
