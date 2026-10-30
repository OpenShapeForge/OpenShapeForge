// SPDX-License-Identifier: BUSL-1.1
import { sql, type RawBuilder } from "kysely";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import { withDbSession, type DbSessionInput } from "../../db/session.js";
import { authorizationProfilePredicate } from "../../auth/authorization-profile-sql.js";
import { bindAuthorizationProfileRules, resolveAuthorizationProfileAccess, type AuthorizationProfileRules } from "../../auth/authorization-profile-session.js";
import { auditContext, runWithAuditContext, withAuditContext } from "../../platform/audit-context.js";
import { assertBoundFieldQueryAllowed } from "./field-bindings.js";
import { assertClassifiedQueryAllowed, assertElicitedQueryAllowed, generatedCrudError, getGeneratedCrudTables, readGeneratedCrudTable, requireEntityOperation } from "./catalog.js";
import { fieldColumnMap, fieldNameForColumn } from "./columns.js";
import { filterLeaves } from "./filter-groups.js";
import { buildFilterConditions, tenantFixedWhere } from "./queries.js";
import { subtypeScopeWhere } from "./subtype-scope.js";
import type { GeneratedCrudColumn, GeneratedCrudTable, ListPageInput } from "./types.js";

type Hop = { parent: GeneratedCrudTable; target: GeneratedCrudTable; foreign: GeneratedCrudColumn };
type Plan = { root: GeneratedCrudTable; group: GeneratedCrudColumn; hops: Hop[]; amount: GeneratedCrudColumn; currency: GeneratedCrudColumn };
export type BoardGroupTotal = { group: string | null; available: boolean; totals: Array<{ currency: string; amount: string }> };

/** Resolve only the server-owned board definition against compiler-generated metadata. */
export function boardAggregatePlan(root: GeneratedCrudTable, tables: readonly GeneratedCrudTable[]): Plan {
  const config = root.source?.boardAggregate;
  if (!config) throw generatedCrudError("No board aggregate is configured.", "BAD_USER_INPUT");
  const group = fieldColumnMap(root).get(config.groupBy);
  const amountParts = config.sum.split(".");
  const currencyParts = config.currency.split(".");
  const amountKey = amountParts.pop();
  const currencyKey = currencyParts.pop();
  if (!group || !amountKey || !currencyKey || amountParts.length > 4 || amountParts.some((part, index) => !part || part !== currencyParts[index]) || amountParts.length !== currencyParts.length) {
    throw generatedCrudError("Invalid board aggregate definition.", "INTERNAL_SERVER_ERROR");
  }
  let current = root;
  const hops: Hop[] = [];
  for (const key of amountParts) {
    const relationship = current.source?.graphql?.relationships?.find(candidate => candidate.name === key);
    const target = relationship && tables.find(candidate => candidate.source?.graphql?.typeName === relationship.target);
    const foreign = relationship?.foreignKey && current.columns.find(column => column.name === relationship.foreignKey);
    if (!relationship || relationship.kind !== "belongsTo" || relationship.resolve !== "belongsTo" || relationship.fieldKey !== key || relationship.via || relationship.through || (relationship.constraints && Object.keys(relationship.constraints).length > 0) || !target?.primaryKey || !foreign || fieldColumnMap(current).get(fieldNameForColumn(foreign)) !== foreign) {
      throw generatedCrudError("Invalid board aggregate relationship.", "INTERNAL_SERVER_ERROR");
    }
    hops.push({ parent: current, target, foreign });
    current = target;
  }
  const amount = fieldColumnMap(current).get(amountKey);
  const currency = fieldColumnMap(current).get(currencyKey);
  if (!amount || !currency || !["numeric", "integer", "bigint"].includes(amount.type) || currency.type !== "text") {
    throw generatedCrudError("Board aggregate requires exact numeric and currency columns.", "INTERNAL_SERVER_ERROR");
  }
  return { root, group, hops, amount, currency };
}

function assertFieldReadable(table: GeneratedCrudTable, session: DbSessionInput, column: GeneratedCrudColumn) {
  const key = fieldNameForColumn(column);
  if (column.typedBy || table.source?.computedFields?.some(field => field.field === key)) {
    throw generatedCrudError("Board aggregation requires stored, non-computed fields.", "FORBIDDEN");
  }
  const input = { filter: { [key]: { eq: null } } };
  withAuditContext(`${table.source?.authoringEntityName}.list`, undefined, () => {
    assertClassifiedQueryAllowed(table, session, input, true);
    assertElicitedQueryAllowed(table, input, true);
    assertBoundFieldQueryAllowed(table, input, true);
  });
}

function assertPlanReadable(plan: Plan, session: DbSessionInput, input: Pick<ListPageInput, "filter">) {
  requireEntityOperation(plan.root, "list", session);
  assertFieldReadable(plan.root, session, plan.group);
  withAuditContext(`${plan.root.source?.authoringEntityName}.list`, undefined, () => {
    assertClassifiedQueryAllowed(plan.root, session, input);
    assertElicitedQueryAllowed(plan.root, input);
    assertBoundFieldQueryAllowed(plan.root, input);
  });
  for (const hop of plan.hops) {
    assertFieldReadable(hop.parent, session, hop.foreign);
    requireEntityOperation(hop.target, "list", session);
  }
  const target = plan.hops.at(-1)?.target ?? plan.root;
  assertFieldReadable(target, session, plan.amount);
  assertFieldReadable(target, session, plan.currency);
}

/**
 * Execute a configured grouped money sum using the list filter and authorization
 * boundaries. A missing or unreadable value makes its whole group unavailable.
 * No client-supplied SQL identifiers or partial-page totals are accepted.
 */
export async function aggregateBoardGroups(db: OpenShapeForgeDatabase, session: DbSessionInput, input: { table: string; filter?: Record<string, unknown> | null }): Promise<BoardGroupTotal[]> {
  await resolveAuthorizationProfileAccess(session, db);
  const root = readGeneratedCrudTable(input.table, "list", session);
  return aggregateBoardGroupsForTable(db, session, root, getGeneratedCrudTables(), input);
}

/** Internal entry point with server-owned table definitions, also used by DB tests. */
export async function aggregateBoardGroupsForTable(db: OpenShapeForgeDatabase, session: DbSessionInput, root: GeneratedCrudTable, tables: readonly GeneratedCrudTable[], input: Pick<ListPageInput, "filter">): Promise<BoardGroupTotal[]> {
  await resolveAuthorizationProfileAccess(session, db);
  const plan = boardAggregatePlan(root, tables);
  assertPlanReadable(plan, session, input);
  const rootOperation = `${root.source?.authoringEntityName}.list`;
  const reads = new Set(plan.hops.map(hop => `${hop.target.source?.authoringEntityName}.list`));
  for (const leaf of filterLeaves(input.filter)) for (const key of Object.keys(leaf)) {
    const relationship = root.source?.graphql?.relationships?.find(edge => edge.name === key);
    const target = relationship && tables.find(table => table.source?.graphql?.typeName === relationship.target);
    if (target?.source?.authoringEntityName) reads.add(`${target.source.authoringEntityName}.list`);
  }
  return withAuditContext(rootOperation, undefined, () => runWithAuditContext({ ...auditContext()!, readOperations: [...reads] }, () => withDbSession(db, session, async (trx) => {
    const rules = (await sql<{ rules: AuthorizationProfileRules }>`select nullif(current_setting('app.authorization_rules',true),'')::jsonb as rules`.execute(trx)).rows[0]?.rules;
    bindAuthorizationProfileRules(session, rules);
    assertPlanReadable(plan, session, input);
    const where = sql`(${buildFilterConditions(root, session, input.filter, tenantFixedWhere(root, session), rules)})${subtypeScopeWhere(root, "row_source")} and (${authorizationProfilePredicate(rules?.states[rootOperation], rules?.actor ?? {}, "row_source")})`;
    const joins: RawBuilder<unknown>[] = [];
    const missing: RawBuilder<unknown>[] = [];
    let previous = "row_source";
    plan.hops.forEach((hop, index) => {
      const alias = `board_target_${index}`;
      const operation = `${hop.target.source?.authoringEntityName}.list`;
      const tenant = hop.target.tenantScoped ? sql`and ${sql.id(alias, "tenant_id")} = ${session.tenantId}` : sql``;
      joins.push(sql`left join ${sql.id(hop.target.schema, hop.target.table)} as ${sql.id(alias)} on ${sql.id(alias, hop.target.primaryKey!)} = ${sql.id(previous, hop.foreign.name)} ${tenant} ${subtypeScopeWhere(hop.target, alias)} and (${authorizationProfilePredicate(rules?.states[operation], rules?.actor ?? {}, alias)})`);
      missing.push(sql`${sql.id(alias, hop.target.primaryKey!)} is null`);
      previous = alias;
    });
    const value = sql.id(previous, plan.amount.name);
    const currency = sql.id(previous, plan.currency.name);
    const group = sql.id("row_source", plan.group.name);
    const incomplete = sql.join([...missing, sql`${value} is null`, sql`${currency} is null`, sql`${currency} !~ '^[A-Z]{3}$'`], sql` or `);
    const result = await sql<{ group_value: string | null; currency_value: string | null; total: string | null; incomplete: boolean }>`
      select ${group}::text as group_value, ${currency}::text as currency_value,
        sum(${value})::text as total, bool_or(${incomplete}) as incomplete
      from ${sql.id(root.schema, root.table)} as row_source ${sql.join(joins, sql` `)}
      where ${where}
      group by ${group}, ${currency}
      order by ${group} asc nulls first, ${currency} asc nulls first
      limit 1001
    `.execute(trx);
    if (result.rows.length > 1000) throw generatedCrudError("Board aggregate has too many groups or currencies.", "BAD_USER_INPUT");
    const groups = new Map<string | null, BoardGroupTotal>();
    for (const row of result.rows) {
      const current = groups.get(row.group_value) ?? { group: row.group_value, available: true, totals: [] };
      if (row.incomplete || row.currency_value === null || row.total === null) current.available = false;
      else current.totals.push({ currency: row.currency_value, amount: row.total });
      groups.set(row.group_value, current);
    }
    return [...groups.values()].map(item => item.available ? item : { ...item, totals: [] });
  })));
}
