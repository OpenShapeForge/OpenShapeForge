// SPDX-License-Identifier: BUSL-1.1
import { operationFailure } from "@openshapeforge/operations";
import { sql } from "kysely";
import { jsonbLiteral } from "../../db/sql-helpers.js";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import { entityColumnName, entityTableName } from "../../db/manifest-lookup.js";
import { withDbSession, type DbSessionInput } from "../../db/session.js";
import type { ModuleOperationHandler } from "../../modules/contract.js";
import { getGeneratedCrudTables, generatedCrudError, requireEntityOperation } from "./catalog.js";
import { fieldNameForColumn } from "./columns.js";
import { createGeneratedEntity, updateGeneratedEntity } from "./mutations.js";
import { copyBlueprintGraph, type BlueprintGraphRecord, type BlueprintBindings } from "./blueprint-graph.js";
import { getGeneratedEntity, listGeneratedEntities } from "./queries.js";
import { serializeEntityRow } from "./serialize-result.js";
import type { GeneratedCrudTable } from "./types.js";

type Binding = { entity: string; scope: Record<string,string>; match: string[] };
type ReferenceKey = { entity: string; sourceId: string; values: Record<string,unknown> };
type Include = { entity: string; via: string; fields: string[]; references?: string[]; include?: Include[] };
type BlueprintPolicy = { fields: string[]; labelField: string; mode?: "copy"; include?: Include[]; bindings?: Binding[] };
type Published = { tenant_id: string; blueprint_id: string; version: number; label: string; values_json: Record<string, unknown> };
function policy(table: GeneratedCrudTable): BlueprintPolicy {
  const value = (table.source as (GeneratedCrudTable["source"] & { blueprint?: BlueprintPolicy }))?.blueprint;
  if (!value || !table.tenantScoped) throw generatedCrudError("Blueprints are not enabled for this entity.", "BAD_USER_INPUT");
  return value;
}
function nameOf(table: GeneratedCrudTable) { return table.source!.authoringEntityName!; }
function requireWriter(table: GeneratedCrudTable, session: DbSessionInput) {
  const roles = session.roles ?? [];
  const permitted = [...(table.source?.authorization?.roles.create ?? []), ...(table.source?.authorization?.roles.update ?? [])];
  if (!permitted.some(role => roles.includes(role))) throw generatedCrudError("Blueprint access requires permission to edit this entity.", "FORBIDDEN");
}
function text(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw generatedCrudError(`${key} is required.`, "BAD_USER_INPUT");
  return value;
}
function allowedValues(table: GeneratedCrudTable, values: Record<string, unknown>) {
  return Object.fromEntries(policy(table).fields.map(field => [field, values[field] ?? null]));
}
async function readPublished(db: OpenShapeForgeDatabase, session: DbSessionInput, table: GeneratedCrudTable, blueprintId: string | null, search = "", limit = 51, offset = 0): Promise<Published[]> {
  policy(table);
  requireWriter(table, session);
  return withDbSession(db, session, async trx => (await sql<Published>`
    select * from app.read_blueprints(${nameOf(table)}, ${blueprintId}, ${search}, ${limit}, ${offset})
  `.execute(trx)).rows);
}
function graphTable(entity: string): GeneratedCrudTable {
  const table = getGeneratedCrudTables().find(table => table.source?.authoringEntityName === entity);
  if (!table?.tenantScoped) throw generatedCrudError("Blueprint child must be a tenant-scoped entity.", "BAD_USER_INPUT");
  return table;
}
function graphFields(table: GeneratedCrudTable, row: Record<string, unknown>) {
  return Object.fromEntries(table.columns.map(column => [fieldNameForColumn(column), row[column.name]]));
}
function graphReference(table: GeneratedCrudTable, field: string, id: unknown) {
  if (id == null) return null;
  const relationship = table.source?.graphql?.relationships?.find(relation => relation.resolve === "belongsTo" && (relation.fieldKey === field || relation.foreignKey === table.columns.find(column => fieldNameForColumn(column) === field)?.name));
  const target = getGeneratedCrudTables().find(candidate => candidate.name === relationship?.target || candidate.source?.graphql?.typeName === relationship?.target || candidate.source?.authoringEntityName === relationship?.target);
  if (!target || typeof id !== "string") throw generatedCrudError(`Invalid blueprint reference ${field}.`, "BAD_USER_INPUT");
  return { entity: nameOf(target), sourceId: id };
}
function graphValues(table: GeneratedCrudTable, fields: string[], values: Record<string, unknown>) {
  const selected: Record<string, unknown> = {};
  for (const field of fields) {
    const column = table.columns.find(column => fieldNameForColumn(column) === field);
    if (!column || column.primaryKey || column.generated || column.immutable || column.writtenBy?.length || column.classification || column.type === "uuid" || /^(tenantId|externalId|createdAt|updatedAt|deletedAt|permissions|recordPermissions|ownerId)$|password|secret|token|credential/i.test(field)) {
      throw generatedCrudError(`Unsafe blueprint scalar ${field}.`, "BAD_USER_INPUT");
    }
    if (!Object.hasOwn(values, field)) throw generatedCrudError(`Blueprint source field ${field} is unavailable.`, "FORBIDDEN");
    selected[field] = values[field];
  }
  return selected;
}
async function snapshotChildren(db: OpenShapeForgeDatabase, session: DbSessionInput, parent: GeneratedCrudTable, parentId: string, includes: Include[], records: BlueprintGraphRecord[], depth = 0): Promise<void> {
  if (depth > 8) throw generatedCrudError("Blueprint nesting exceeds eight levels.", "BAD_USER_INPUT");
  for (const include of includes) {
    const table = graphTable(include.entity);
    const reference = graphReference(table, include.via, parentId);
    if (reference?.entity !== nameOf(parent)) throw generatedCrudError("Blueprint child relationship does not point to its owner.", "BAD_USER_INPUT");
    let cursor: string | null = null;
    do {
      const page: import("./types.js").GeneratedEntityConnection = await listGeneratedEntities(db, session, { table: table.name, filter: { [include.via]: { eq: parentId } }, limit: 200, cursor });
      for (const row of page.rows) {
        if (records.length >= 1000) throw generatedCrudError("Blueprint graph exceeds 1000 records.", "BAD_USER_INPUT");
        const values = graphFields(table, row), sourceId = String(row[table.primaryKey!]);
        const references = Object.fromEntries([include.via, ...(include.references ?? [])].map(field => [field, graphReference(table, field, values[field])]));
        records.push({ entity: include.entity, sourceId, values: graphValues(table, include.fields, values), references });
        await snapshotChildren(db, session, table, sourceId, include.include ?? [], records, depth + 1);
      }
      cursor = page.nextCursor;
    } while (cursor);
  }
}
/**
 * `validate` sees the merged record (blueprint values under the caller's) as a
 * full create, so a stored value the contract no longer allows fails as
 * VALIDATION naming the field rather than at a database CHECK.
 */
export async function createFromBlueprint(db: OpenShapeForgeDatabase, session: DbSessionInput, table: GeneratedCrudTable, blueprintId: string, values: Record<string, unknown>, validate: (merged: Record<string, unknown>) => void = () => {}, trusted?: { operation: string; values: Record<string, unknown> }, bindings: BlueprintBindings = {}) {
  requireEntityOperation(table, "create", session);
  return withDbSession(db, session, async trx => {
    const source = (await readPublished(db, session, table, blueprintId))[0];
    if (!source) throw generatedCrudError("Blueprint is unavailable.", "NOT_FOUND");
    const merged = { ...allowedValues(table, source.values_json), ...values };
    validate(merged);
    const resolvedBindings: BlueprintBindings = structuredClone(bindings);
    const referenceKeys = source.values_json.$referenceKeys as ReferenceKey[] | undefined;
    for (const reference of referenceKeys ?? []) {
      if (resolvedBindings[reference.entity]?.[reference.sourceId]) continue;
      const rule = policy(table).bindings?.find(rule => rule.entity === reference.entity);
      if (!rule) continue;
      const filter: Record<string,unknown> = {};
      for (const [field, contextField] of Object.entries(rule.scope)) {
        if (merged[contextField] == null) throw generatedCrudError(`Blueprint reference needs ${contextField}.`, "BAD_USER_INPUT");
        filter[field] = {eq:merged[contextField]};
      }
      for (const field of rule.match) {
        if (reference.values[field] == null) throw generatedCrudError("Blueprint reference key is missing.", "BAD_USER_INPUT");
        filter[field] = {eq:reference.values[field]};
      }
      const destination = graphTable(reference.entity);
      const matches = await listGeneratedEntities(db, session, { table: destination.name, filter, limit: 2 });
      if (matches.rows.length !== 1 || matches.nextCursor) throw generatedCrudError("Blueprint reference has no unique destination. Check its context before copying.", "BAD_USER_INPUT");
      (resolvedBindings[reference.entity] ??= {})[reference.sourceId] = String(matches.rows[0]![destination.primaryKey!]);
    }
    const row = await createGeneratedEntity(db, session, { table: table.name, values: merged, ...(trusted ? { trusted } : {}) });
    const snapshot = source.values_json.$graph as BlueprintGraphRecord[] | undefined;
    if (policy(table).include?.length && !snapshot) throw generatedCrudError("Blueprint connected content is unavailable. Publish a complete version first.", "BAD_USER_INPUT");
    if (snapshot?.length) {
      const rootId = source.values_json.$rootId;
      if (typeof rootId !== "string") throw generatedCrudError("Blueprint root identity is missing.", "BAD_USER_INPUT");
      await copyBlueprintGraph(snapshot, { ...resolvedBindings, [nameOf(table)]: { ...resolvedBindings[nameOf(table)], [rootId]: String(row[table.primaryKey!]) } }, {
        create: async (entity, childValues) => {
          graphTable(entity);
          const { getEntityOperationContracts, executeEntityOperation } = await import("./runtime.js");
          const operation = getEntityOperationContracts().find(operation => operation.entityName === entity && operation.intent === "create" && operation.implementation?.type !== "plugin");
          if (!operation) throw generatedCrudError("Canonical child create is unavailable.", "FORBIDDEN");
          const result = await executeEntityOperation(db, session, { operation: { id: operation.id, intent: "create" }, input: { values: childValues } });
          if ("error" in result && result.error) throw operationFailure(result.error);
          if (!("data" in result) || !result.data || typeof result.data !== "object" || !("id" in result.data)) throw generatedCrudError("Child create returned no identity.", "INTERNAL_SERVER_ERROR");
          return String(result.data.id);
        },
      });
    }
    await sql`insert into platform.blueprint_copies (tenant_id, entity_name, record_id, blueprint_tenant_id, blueprint_id, source_version)
      values (${session.tenantId}::uuid, ${nameOf(table)}, ${String(row[table.primaryKey!])}::uuid, ${source.tenant_id}::uuid, ${source.blueprint_id}, ${source.version})`.execute(trx);
    return row;
  });
}
async function status(db: OpenShapeForgeDatabase, session: DbSessionInput, table: GeneratedCrudTable, id: string) {
  requireWriter(table, session);
  const record = await getGeneratedEntity(db, session, { table: table.name, id });
  if (!record) throw generatedCrudError("Record not found.", "NOT_FOUND");
  return withDbSession(db, session, async trx => {
    const copy = (await sql<{ blueprint_tenant_id: string; blueprint_id: string; source_version: number }>`select blueprint_tenant_id, blueprint_id, source_version from platform.blueprint_copies where tenant_id = ${session.tenantId}::uuid and entity_name = ${nameOf(table)} and record_id = ${id}::uuid`.execute(trx)).rows[0];
    if (!copy) return { source: null, updateAvailable: false };
    const source = (await readPublished(db, session, table, copy.blueprint_id))[0];
    if (!source || source.tenant_id !== copy.blueprint_tenant_id) return { source: null, updateAvailable: false };
    return { source: { blueprintId: copy.blueprint_id, version: copy.source_version, latestVersion: source.version, label: source.label }, updateAvailable: policy(table).mode !== "copy" && source.version > copy.source_version };
  });
}
async function reset(db: OpenShapeForgeDatabase, session: DbSessionInput, table: GeneratedCrudTable, input: Record<string, unknown>) {
  if (policy(table).mode === "copy") throw generatedCrudError("Independent blueprint copies cannot be reset.", "BAD_USER_INPUT");
  requireEntityOperation(table, "update", session);
  const id = text(input, "id");
  return withDbSession(db, session, async trx => {
    const copy = (await sql<{ blueprint_tenant_id: string; blueprint_id: string }>`select blueprint_tenant_id, blueprint_id from platform.blueprint_copies where tenant_id = ${session.tenantId}::uuid and entity_name = ${nameOf(table)} and record_id = ${id}::uuid for update`.execute(trx)).rows[0];
    if (!copy) throw generatedCrudError("Record has no blueprint source.", "NOT_FOUND");
    const source = (await readPublished(db, session, table, copy.blueprint_id))[0];
    if (!source || source.tenant_id !== copy.blueprint_tenant_id) throw generatedCrudError("Blueprint is unavailable.", "NOT_FOUND");
    if (source.version !== input.blueprintVersion) throw generatedCrudError("The blueprint has changed. Review its newest version first.", "VERSION_CONFLICT");
    // The canonical static executor checks the record version, edit lease and
    // confirmation in this same transaction before entering the handler.
    const row = await updateGeneratedEntity(db, session, { table: table.name, id, values: allowedValues(table, source.values_json) });
    if (!row) throw generatedCrudError("Record not found.", "NOT_FOUND");
    await sql`update platform.blueprint_copies set source_version = ${source.version} where tenant_id = ${session.tenantId}::uuid and entity_name = ${nameOf(table)} and record_id = ${id}::uuid`.execute(trx);
    return serializeEntityRow(table, row);
  });
}
/**
 * The operator role is the publish Operation's `auth.roles` (compiler,
 * blueprint-operations.ts) and the runtime refuses the session before this
 * handler runs (runtime.ts, sessionOperationRolesAllow); the insert policy
 * blueprint_versions_publish checks it a third time inside Postgres.
 */
async function publish(db: OpenShapeForgeDatabase, session: DbSessionInput, table: GeneratedCrudTable, input: Record<string, unknown>) {
  const blueprint = policy(table);
  return withDbSession(db, session, async trx => {
    const tenant = (await sql<{ kind: string }>`select ${sql.ref(entityColumnName("Tenant", "tenantKind"))} as kind from ${sql.table(entityTableName("Tenant"))} where tenant_id = ${session.tenantId}::uuid`.execute(trx)).rows[0];
    // "blueprint" is the Tenant.tenantKind value of a blueprint tenant.
    if (tenant?.kind !== "blueprint") throw generatedCrudError("Only blueprint tenants can publish.", "FORBIDDEN");
    const row = await getGeneratedEntity(db, session, { table: table.name, id: text(input, "id") });
    if (!row) throw generatedCrudError("Record not found.", "NOT_FOUND");
    const fields = Object.fromEntries(table.columns.map(column => [fieldNameForColumn(column), row[column.name]]));
    const blueprintId = text(fields, "externalId");
    await sql`select pg_advisory_xact_lock(hashtextextended(${`${session.tenantId}:${nameOf(table)}:${blueprintId}`}, 0))`.execute(trx);
    const last = (await sql<{ version: number; values_json: Record<string, unknown>; source_record_id: string }>`select version, values_json, source_record_id from platform.blueprint_versions where tenant_id = ${session.tenantId}::uuid and entity_name = ${nameOf(table)} and blueprint_id = ${blueprintId} order by version desc limit 1`.execute(trx)).rows[0];
    if (last && last.source_record_id !== input.id) throw generatedCrudError("This blueprint identifier belongs to another record.", "BAD_USER_INPUT");
    const values = allowedValues(table, fields);
    if (blueprint.include?.length) {
      const records: BlueprintGraphRecord[] = [];
      await snapshotChildren(db, session, table, text(input, "id"), blueprint.include, records);
      values.$graph = records;
      values.$rootId = text(input, "id");
      const internal = new Set(records.map(record => JSON.stringify([record.entity,record.sourceId])));
      internal.add(JSON.stringify([nameOf(table),text(input,"id")]));
      const referenceKeys: ReferenceKey[] = [];
      const seen = new Set<string>();
      for (const record of records) for (const reference of Object.values(record.references)) {
        if (!reference) continue;
        const key=JSON.stringify([reference.entity,reference.sourceId]);
        if (internal.has(key) || seen.has(key)) continue;
        seen.add(key);
        const rule=blueprint.bindings?.find(rule=>rule.entity===reference.entity);
        if (!rule) continue;
        const target=graphTable(reference.entity);
        const row=await getGeneratedEntity(db,session,{table:target.name,id:reference.sourceId});
        if (!row) throw generatedCrudError("Blueprint reference is unavailable.","NOT_FOUND");
        referenceKeys.push({...reference,values:graphValues(target,rule.match,graphFields(target,row))});
      }
      values.$referenceKeys=referenceKeys;
    }
    const version = (last?.version ?? 0) + 1;
    const readerRoles = [...new Set([...(table.source?.authorization?.roles.create ?? []), ...(table.source?.authorization?.roles.update ?? [])])];
    await sql`insert into platform.blueprint_versions (tenant_id, entity_name, blueprint_id, version, source_record_id, label, values_json, reader_roles)
      values (${session.tenantId}::uuid, ${nameOf(table)}, ${blueprintId}, ${version}, ${text(input, "id")}::uuid, ${String(fields[blueprint.labelField] ?? blueprintId)}, ${jsonbLiteral(values)}, array(select jsonb_array_elements_text(${jsonbLiteral(readerRoles)})))`.execute(trx);
    return { blueprintId, version };
  });
}
export function blueprintOperationHandler(handler: string): ModuleOperationHandler {
  const split = handler.lastIndexOf(".");
  const entity = handler.slice(0, split);
  const action = handler.slice(split + 1);
  if (!["list", "status", "reset", "publish"].includes(action)) throw new Error("Unknown core blueprint handler.");
  return async (raw, context) => {
    if (!context.db || !context.session) throw generatedCrudError("Authenticated database session required.", "FORBIDDEN");
    const table = getGeneratedCrudTables().find(table => table.source?.authoringEntityName === entity);
    if (!table) throw generatedCrudError("Entity not found.", "NOT_FOUND");
    policy(table);
    const input = raw as Record<string, unknown>;
    let value: unknown;
    if (action === "list") {
      const limit = Math.max(1, Math.min(100, Number(input.limit ?? 25)));
      const offset = input.cursor ? Number(input.cursor) : 0;
      if (!Number.isInteger(offset) || offset < 0 || offset > 10000) throw generatedCrudError("Invalid blueprint cursor.", "BAD_USER_INPUT");
      const rows = await readPublished(context.db, context.session, table, null, typeof input.search === "string" ? input.search : "", limit + 1, offset);
      value = { items: rows.slice(0, limit).map(row => ({ blueprintId: row.blueprint_id, label: row.label, version: row.version, description: typeof row.values_json.description === "string" ? row.values_json.description : "", preview: (Array.isArray(row.values_json.$graph) ? row.values_json.$graph as BlueprintGraphRecord[] : []).filter(record => record.references[policy(table).include?.[0]?.via ?? ""]?.entity === nameOf(table)).slice(0, 20).map(record => record.values[policy(table).include?.find(include => include.entity === record.entity)?.fields[0] ?? ""] ?? "").filter((value): value is string => typeof value === "string") })), nextCursor: rows.length > limit ? String(offset + limit) : null };
    } else if (action === "status") value = await status(context.db, context.session, table, text(input, "id"));
    else if (action === "reset") value = await reset(context.db, context.session, table, input);
    else value = await publish(context.db, context.session, table, input);
    return { value, status: 200 };
  };
}
