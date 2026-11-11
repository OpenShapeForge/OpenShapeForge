// SPDX-License-Identifier: BUSL-1.1
import { sql, type Transaction } from 'kysely';
import { operationFailure, parseTenantColors, resolvePalette, COLOR_SETTINGS_KEY, COLOR_SETTINGS_NAMESPACE } from '@openshapeforge/operations';
import type { DB } from '../generated/db/types.js';
import { withDbSession, type DbSessionInput } from '../db/session.js';
import type { ModuleOperationHandler } from '../modules/contract.js';
import type { OperationContract } from './runtime.js';

/** Explicit tenant predicate as well as RLS; this projection exposes only the public palette. */
export async function readColorPalette(trx: Transaction<DB>, session: DbSessionInput) {
  if (!session.tenantId) throw operationFailure({code:'UNAUTHENTICATED',message:'A tenant session is required.'});
  const result = await sql<{value: unknown}>`select value from erp.tenant_settings where tenant_id = ${session.tenantId}::uuid and namespace = ${COLOR_SETTINGS_NAMESPACE} and key = ${COLOR_SETTINGS_KEY}`.execute(trx);
  if (result.rows.length > 1) throw operationFailure({code:'INVALID_STATE',message:'Duplicate color palette settings.'});
  try { return resolvePalette(result.rows.length ? parseTenantColors(result.rows[0]!.value) : []); }
  catch { throw operationFailure({code:'INVALID_STATE',message:'The stored color palette is invalid.'}); }
}
export function nativeColorPaletteHandler(operation: OperationContract): ModuleOperationHandler {
  if(operation.key !== 'colors.list' || operation.plugin !== 'core' || operation.handler !== 'listColors' || operation.implementation?.type !== 'color-palette' || operation.auth.mode !== 'session' || operation.tenancy.mode !== 'required' || operation.effects?.data !== 'read' || operation.effects.external !== 'none') throw Error('Invalid color palette binding.');
  return async (_input, context) => {
    if(!context.db || !context.session?.tenantId) throw operationFailure({code:'UNAUTHENTICATED',message:'A tenant session is required.'});
    return {value:{colors:await withDbSession(context.db,context.session,trx=>readColorPalette(trx,context.session!))}};
  };
}
