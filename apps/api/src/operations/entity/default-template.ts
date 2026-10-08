// SPDX-License-Identifier: BUSL-1.1
import { defaultTemplatePaths, renderDefaultTemplate, operationFailure } from '@openshapeforge/operations';
import { sql, type Transaction } from 'kysely';
import type { DB } from '../../generated/db/types.js';
import type { DbSessionInput } from '../../db/session.js';
import { getGeneratedCrudTables, requireEntityOperation, projectGeneratedEntityRow } from './catalog.js';
import { recordPermissionsAllowRow } from './record-permissions.js';
import type { GeneratedCrudColumn, GeneratedCrudTable, GeneratedEntityRow } from './types.js';
/** Materialize omitted fields in the same tenant transaction as the canonical create. */
export async function applyDefaultTemplates(trx: Transaction<DB>, session: DbSessionInput, table: GeneratedCrudTable, input: Map<GeneratedCrudColumn, unknown>, tables = getGeneratedCrudTables()) {
  const values = new Map(input);
  const related = new Map<string, GeneratedEntityRow>();
  const refuse = (): never => { throw operationFailure({code:'VALIDATION', message:'A default source is unavailable or unreadable.', retryable:false}); };
  for (const column of table.columns) {
    if (!column.defaultTemplate || values.has(column)) continue;
    const sources = new Map<string, unknown>();
    for (const path of defaultTemplatePaths(column.defaultTemplate)) {
      const [key, field] = path.split('.');
      if (!field) {
        const source = table.columns.find(candidate => candidate.sourceField === key);
        sources.set(path, source ? input.get(source) : undefined);
        continue;
      }
      const relationship = table.source?.graphql?.relationships?.find(relation => relation.name === key || relation.fieldKey === key || relation.fieldKey === `${key}Id`);
      if (!relationship?.foreignKey || relationship.resolve !== 'belongsTo') refuse();
      const target = tables.find(candidate => candidate.source?.graphql?.typeName === relationship!.target);
      if (!target?.primaryKey) refuse();
      requireEntityOperation(target!, 'get', session);
      const foreignKey = table.columns.find(candidate => candidate.name === relationship!.foreignKey);
      const id = foreignKey ? input.get(foreignKey) : undefined;
      if (typeof id !== 'string') refuse();
      const cacheKey = `${target!.name}/${id}`;
      let projected = related.get(cacheKey);
      if (!projected) {
        const tenant = target!.tenantScoped ? sql`and tenant_id = ${session.tenantId}` : sql``;
        const reply = await sql<{row: GeneratedEntityRow}>`select to_jsonb(candidate.*) as row from ${sql.id(target!.schema,target!.table)} as candidate where ${sql.id(target!.primaryKey!)}::text = ${id} ${tenant} limit 1`.execute(trx);
        const row = reply.rows[0]?.row;
        if (!row || target!.source?.authorization?.recordPermissions && !recordPermissionsAllowRow(target!,row,['view'],session)) refuse();
        projected = projectGeneratedEntityRow(target!, session, row!);
        related.set(cacheKey, projected);
      }
      const source = target!.columns.find(candidate => candidate.sourceField === field);
      sources.set(path, source ? projected[source.name] : undefined);
    }
    try { values.set(column, renderDefaultTemplate(column.defaultTemplate, sources)); }
    catch { refuse(); }
  }
  return values;
}
