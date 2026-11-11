// SPDX-License-Identifier: BUSL-1.1
import { sql, type Transaction } from 'kysely';
import { operationFailure, parseTenantColors, COLOR_SETTINGS_KEY, COLOR_SETTINGS_NAMESPACE } from '@openshapeforge/operations';
import type { DB } from '../../generated/db/types.js';
import type { DbSessionInput } from '../../db/session.js';
import { readColorPalette } from '../color-palette.js';
import type { GeneratedCrudColumn, GeneratedCrudTable, GeneratedEntityRow } from './types.js';
import manifest from '../../generated/db/manifest.json' with {type:'json'};
export const colorReferenceTables = (manifest.tables as GeneratedCrudTable[]).filter(table=>table.tenantScoped && table.columns.some(column=>column.colorReference));

function refuse(message: string): never { throw operationFailure({code:'INVALID_INPUT',message}); }
function checkedPalette(value: unknown) { try { return parseTenantColors(value); } catch { return refuse('Use unique stable keys, names, six-digit hex values and active flags for the palette.'); } }
function isPalette(row: Record<string,unknown>) { return row.namespace===COLOR_SETTINGS_NAMESPACE && row.key===COLOR_SETTINGS_KEY; }
/** A shared tenant lock serializes palette removal with new references. */
export async function guardColorWrite(trx: Transaction<DB>, session: DbSessionInput, table: GeneratedCrudTable, input: ReadonlyMap<GeneratedCrudColumn,unknown>, current?: GeneratedEntityRow, deleting=false) {
  const settings = table.source?.authoringEntityName === 'TenantSetting';
  const row = {...current,...Object.fromEntries([...input].map(([column,value])=>[column.name,value]))};
  const references = [...input].filter(([column,value])=>column.colorReference && value!=null && value!==current?.[column.name]);
  if(!references.length && !(settings && (isPalette(row) || current && isPalette(current))))return;
  if(!session.tenantId)refuse('A tenant session is required.');
  await sql`select pg_advisory_xact_lock(hashtextextended(${`colors:${session.tenantId}`},0))`.execute(trx);
  if(settings && (isPalette(row) || current && isPalette(current))) {
    if(current && isPalette(current) && !isPalette(row))refuse('The color palette setting cannot be renamed.');
    const existing = await sql<{id:string}>`select id from erp.tenant_settings where tenant_id=${session.tenantId}::uuid and namespace=${COLOR_SETTINGS_NAMESPACE} and key=${COLOR_SETTINGS_KEY}`.execute(trx);
    if(existing.rows.some(item=>item.id!==current?.id))refuse('This tenant already has a color palette.');
    const before=current && isPalette(current)?checkedPalette(current.value):[];
    const after=deleting?[]:checkedPalette(row.value);
    if(!deleting && (!row.definition || typeof row.definition!=='object' || (row.definition as {osfType?:unknown}).osfType!=='colorPalette'))refuse('The color palette requires its canonical definition.');
    const removed=before.filter(color=>!after.some(next=>next.key===color.key)).map(color=>`tenant:${color.key}`);
    for(const target of colorReferenceTables)for(const column of target.columns.filter(c=>c.colorReference)) {
      if(!removed.length)break;
      const found=await sql`select 1 from ${sql.id(target.schema,target.table)} where tenant_id=${session.tenantId}::uuid and ${sql.id(column.name)} in (${sql.join(removed.map(value=>sql`${value}`))}) limit 1`.execute(trx);
      if(found.rows.length)refuse('A color is still in use. Archive it or replace its references before removing it.');
    }
  }
  if(references.length) {
    const palette=await readColorPalette(trx,session);
    for(const [,value] of references)if(!palette.some(color=>color.reference===value&&color.active))refuse('Choose an active color from this tenant’s palette.');
  }
}
