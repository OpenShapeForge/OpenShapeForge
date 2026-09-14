// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import { jsonbLiteral } from "../../db/sql-helpers.js";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import { withDbSession, type DbSessionInput } from "../../db/session.js";
import type { ModuleOperationHandler } from "../../modules/contract.js";
import { getGeneratedCrudTables, generatedCrudError, requireEntityOperation } from "./catalog.js";
import { fieldNameForColumn } from "./columns.js";
import { createGeneratedEntity, updateGeneratedEntity } from "./mutations.js";
import { getGeneratedEntity } from "./queries.js";
import { serializeEntityRow } from "./serialize-result.js";
import type { GeneratedCrudTable } from "./types.js";

type BlueprintPolicy = { fields: string[]; labelField: string };
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
export async function createFromBlueprint(db: OpenShapeForgeDatabase, session: DbSessionInput, table: GeneratedCrudTable, blueprintId: string, values: Record<string, unknown>) {
  requireEntityOperation(table, "create", session);
  return withDbSession(db, session, async trx => {
    const source = (await readPublished(db, session, table, blueprintId))[0];
    if (!source) throw generatedCrudError("Blueprint is unavailable.", "NOT_FOUND");
    const row = await createGeneratedEntity(db, session, { table: table.name, values: { ...allowedValues(table, source.values_json), ...values } });
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
    return { source: { blueprintId: copy.blueprint_id, version: copy.source_version, latestVersion: source.version, label: source.label }, updateAvailable: source.version > copy.source_version };
  });
}
async function reset(db: OpenShapeForgeDatabase, session: DbSessionInput, table: GeneratedCrudTable, input: Record<string, unknown>) {
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
async function publish(db: OpenShapeForgeDatabase, session: DbSessionInput, table: GeneratedCrudTable, input: Record<string, unknown>) {
  if (!session.roles?.includes("platform-operator")) throw generatedCrudError("Blueprint publication requires a platform administrator.", "FORBIDDEN");
  const blueprint = policy(table);
  return withDbSession(db, session, async trx => {
    const tenant = (await sql<{ tenant_kind: string }>`select tenant_kind from erp.tenants where tenant_id = ${session.tenantId}::uuid`.execute(trx)).rows[0];
    if (tenant?.tenant_kind !== "blueprint") throw generatedCrudError("Only blueprint tenants can publish.", "FORBIDDEN");
    const row = await getGeneratedEntity(db, session, { table: table.name, id: text(input, "id") });
    if (!row) throw generatedCrudError("Record not found.", "NOT_FOUND");
    const fields = Object.fromEntries(table.columns.map(column => [fieldNameForColumn(column), row[column.name]]));
    const blueprintId = text(fields, "externalId");
    await sql`select pg_advisory_xact_lock(hashtextextended(${`${session.tenantId}:${nameOf(table)}:${blueprintId}`}, 0))`.execute(trx);
    const last = (await sql<{ version: number; values_json: Record<string, unknown>; source_record_id: string }>`select version, values_json, source_record_id from platform.blueprint_versions where tenant_id = ${session.tenantId}::uuid and entity_name = ${nameOf(table)} and blueprint_id = ${blueprintId} order by version desc limit 1`.execute(trx)).rows[0];
    if (last && last.source_record_id !== input.id) throw generatedCrudError("This blueprint identifier belongs to another record.", "BAD_USER_INPUT");
    const values = allowedValues(table, fields);
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
      value = { items: rows.slice(0, limit).map(row => ({ blueprintId: row.blueprint_id, label: row.label, version: row.version })), nextCursor: rows.length > limit ? String(offset + limit) : null };
    } else if (action === "status") value = await status(context.db, context.session, table, text(input, "id"));
    else if (action === "reset") value = await reset(context.db, context.session, table, input);
    else value = await publish(context.db, context.session, table, input);
    return { value, status: 200 };
  };
}
