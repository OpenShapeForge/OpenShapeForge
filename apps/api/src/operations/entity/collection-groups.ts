// SPDX-License-Identifier: BUSL-1.1
import { sql } from 'kysely';
import type { OpenShapeForgeDatabase } from '../../db/connection.js';
import { withDbSession, type DbSessionInput } from '../../db/session.js';
import { authorizationProfilePredicate } from '../../auth/authorization-profile-sql.js';
import { bindAuthorizationProfileRules, resolveAuthorizationProfileAccess, type AuthorizationProfileRules } from '../../auth/authorization-profile-session.js';
import { auditContext, runWithAuditContext, withAuditContext } from '../../platform/audit-context.js';
import { assertBoundFieldQueryAllowed } from './field-bindings.js';
import { assertClassifiedQueryAllowed, assertElicitedQueryAllowed, generatedCrudError, getGeneratedCrudTables, readGeneratedCrudTable } from './catalog.js';
import { assertFieldReadable } from './field-read-access.js';
import { fieldColumnMap } from './columns.js';
import { buildFilterConditions, tenantFixedWhere } from './queries.js';
import { filterLeaves } from './filter-groups.js';
import { temporalReadOperations } from './temporal-threshold-resolver.js';
import { subtypeScopeWhere } from './subtype-scope.js';

export type CollectionGroup = { value: string | number | boolean | null; count: number };

/** Enumerate the groups of the complete authorized query, independently of its current record page. */
export async function readCollectionGroups(db: OpenShapeForgeDatabase, session: DbSessionInput, name: string, filter?: Record<string, unknown> | null, summary = false): Promise<CollectionGroup[]> {
  await resolveAuthorizationProfileAccess(session, db);
  const table = readGeneratedCrudTable(name, 'list', session);
  const key = summary ? table.source?.collectionSummaryBy : table.source?.collectionGroupBy;
  const column = key && fieldColumnMap(table).get(key);
  if (!key || !column) throw generatedCrudError('No collection grouping is configured.', 'BAD_USER_INPUT');
  assertFieldReadable(table, session, column);
  const operation = `${table.source?.authoringEntityName}.list`;
  const readOperations = [...new Set([...temporalReadOperations(table), ...filterLeaves(filter).flatMap(leaf => Object.keys(leaf)).flatMap(key => {
    const edge = table.source?.graphql?.relationships?.find(edge => edge.name === key);
    const related = edge && getGeneratedCrudTables().find(candidate => candidate.source?.graphql?.typeName === edge.target);
    return related?.source?.authoringEntityName ? [`${related.source.authoringEntityName}.list`] : [];
  })])];
  return withAuditContext(operation, undefined, () => runWithAuditContext({ ...auditContext()!, readOperations }, () => withDbSession(db, session, async trx => {
    const rules = (await sql<{ rules: AuthorizationProfileRules }>`select nullif(current_setting('app.authorization_rules',true),'')::jsonb as rules`.execute(trx)).rows[0]?.rules;
    bindAuthorizationProfileRules(session, rules);
    const input = { filter: { and: [filter ?? {}, { [key]: { isNull: true } }] } };
    assertClassifiedQueryAllowed(table, session, input);
    assertElicitedQueryAllowed(table, input);
    assertBoundFieldQueryAllowed(table, input);
    const where = sql`(${buildFilterConditions(table, session, filter, tenantFixedWhere(table, session), rules)})${subtypeScopeWhere(table, 'row_source')} and (${authorizationProfilePredicate(rules?.states[operation], rules?.actor ?? {}, 'row_source')})`;
    const result = await sql<{ value: CollectionGroup['value']; count: string }>`select ${sql.id('row_source', column.name)} as value, count(*)::text as count from ${sql.id(table.schema, table.table)} as row_source where ${where} group by ${sql.id('row_source', column.name)} order by ${sql.id('row_source', column.name)} asc nulls last limit 1001`.execute(trx);
    if (result.rows.length > 1000) throw generatedCrudError('This grouping has more than 1000 groups. Narrow the collection filter.', 'BAD_USER_INPUT');
    return result.rows.map(row => ({ value: row.value, count: Number(row.count) }));
  })));
}
