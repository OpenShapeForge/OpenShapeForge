// SPDX-License-Identifier: BUSL-1.1
import { sql, type Transaction } from "kysely";
import type { DB } from "../../generated/db/types.js";
import type { DbSessionContext } from "../../db/session.js";
import { authorizationListFields } from "../../auth/authorization-profile-decision.js";
import { authorizationProfilePredicate } from "../../auth/authorization-profile-sql.js";
import type { AuthorizationProfileRules } from "../../auth/authorization-profile-session.js";
import { auditContext } from "../../platform/audit-context.js";
import { operationErrorOf } from "@openshapeforge/operations";
import { assertFieldReadable } from "./board-aggregate.js";
import { fieldColumnMap } from "./columns.js";
import { getGeneratedCrudTables, requireEntityOperation } from "./catalog.js";
import { subtypeScopeWhere } from "./subtype-scope.js";
import { evaluateTemporalThreshold } from "./temporal-threshold.js";
import type { GeneratedCrudTable, GeneratedEntityRow } from "./types.js";

/** Include dependent entity operations in the database session's policy snapshot. */
export function temporalReadOperations(table: GeneratedCrudTable): string[] {
  const tables = getGeneratedCrudTables();
  return [...new Set((table.source?.computedFields ?? []).flatMap(field => {
    if (field.resolver !== "temporalThreshold") return [];
    const edge = table.source?.graphql?.relationships?.find(item => item.name === field.trackedField);
    const target = edge && tables.find(item => item.source?.graphql?.typeName === edge.target);
    return target?.source?.authoringEntityName ? [`${target.source.authoringEntityName}.list`] : [];
  }))];
}

export async function resolveTemporalThresholdRows(trx: Transaction<DB>, session: DbSessionContext,
  table: GeneratedCrudTable, rows: GeneratedEntityRow[]): Promise<GeneratedEntityRow[]> {
  const definitions = (table.source?.computedFields ?? []).filter(field => field.resolver === "temporalThreshold");
  if (!definitions.length || !rows.length) return rows;
  const result = rows.map(row => ({ ...row }));
  const rules = (await sql<{ rules: AuthorizationProfileRules | null }>`select nullif(current_setting('app.authorization_rules',true),'')::jsonb as rules`.execute(trx)).rows[0]?.rules ?? undefined;
  const now = new Date((await sql<{ now: Date }>`select statement_timestamp() as now`.execute(trx)).rows[0]!.now);
  for (const definition of definitions) {
    const unknown = () => evaluateTemporalThreshold({ readable: false, applicable: false, since: null, thresholdDays: null, now });
    const tracked = fieldColumnMap(table).get(definition.trackedField);
    const edge = table.source?.graphql?.relationships?.find(item => item.name === definition.trackedField);
    const target = edge && getGeneratedCrudTables().find(item => item.source?.graphql?.typeName === edge.target);
    const threshold = target && fieldColumnMap(target).get(definition.thresholdDays.split(".")[1]!);
    const rootFields = authorizationListFields(session, table.source?.authoringEntityName);
    const targetFields = target && authorizationListFields(session, target.source?.authoringEntityName);
    let readable = !!tracked && !!target && !!threshold && edge?.resolve === "belongsTo" && edge.kind === "belongsTo" &&
      edge.fieldKey === definition.trackedField && edge.foreignKey === tracked?.name && !edge.via && !edge.through &&
      (!edge.constraints || !Object.keys(edge.constraints).length) && !!target.primaryKey &&
      (!rootFields || auditContext()?.operationId !== `${table.source?.authoringEntityName}.list` || rootFields.includes(definition.trackedField)) &&
      (!targetFields || targetFields.includes(definition.thresholdDays.split(".")[1]!));
    if (readable) {
      try {
        requireEntityOperation(target!, "list", session);
        assertFieldReadable(table, session, tracked!);
        assertFieldReadable(target!, session, threshold!);
      } catch (error) {
        const failure = operationErrorOf(error);
        if (!failure || failure.code !== "FORBIDDEN") throw error;
        readable = false;
      }
    }
    if (!readable || !tracked || !target || !threshold || !target.primaryKey || !table.primaryKey) {
      for (const row of result) row[definition.field] = unknown();
      continue;
    }
    const ids = [...new Set(result.flatMap(row => row[tracked.name] == null ? [] : [String(row[tracked.name])]))];
    const records = [...new Set(result.flatMap(row => row[table.primaryKey!] == null ? [] : [String(row[table.primaryKey!])]))];
    const targetOperation = `${target.source?.authoringEntityName}.list`;
    const targetRows = ids.length ? (await sql<{ id: string; threshold: number | string | null }>`select ${sql.id("row_source", target.primaryKey)}::text as id, ${sql.id("row_source", threshold.name)} as threshold
      from ${sql.id(target.schema, target.table)} as row_source where ${sql.id("row_source", target.primaryKey)}::text in (${sql.join(ids.map(id => sql`${id}`))})
      ${target.tenantScoped ? sql`and ${sql.id("row_source", "tenant_id")}=${session.tenantId}::uuid` : sql``}
      ${subtypeScopeWhere(target, "row_source")} and (${authorizationProfilePredicate(rules?.states[targetOperation], rules?.actor ?? {}, "row_source")})`.execute(trx)).rows : [];
    const times = records.length ? (await sql<{ record_id: string; since_at: Date }>`select record_id,since_at from platform.field_value_since
      where tenant_id=${session.tenantId}::uuid and entity_type=${table.source?.authoringEntityName} and field_key=${definition.trackedField}
      and record_id in (${sql.join(records.map(id => sql`${id}`))})`.execute(trx)).rows : [];
    const targetMap = new Map(targetRows.map(row => [row.id, row.threshold]));
    const sinceMap = new Map(times.map(row => [row.record_id, new Date(row.since_at)]));
    for (const row of result) {
      const id = row[tracked.name];
      if (id != null && !targetMap.has(String(id))) { row[definition.field] = unknown(); continue; }
      const value = id == null ? null : targetMap.get(String(id));
      row[definition.field] = evaluateTemporalThreshold({ readable: true, applicable: id != null,
        thresholdDays: value == null ? null : Number(value), since: sinceMap.get(String(row[table.primaryKey])) ?? null, now });
    }
  }
  return result;
}
