// SPDX-License-Identifier: BUSL-1.1
import { sql } from 'kysely';
import { withDbSession } from '../db/session.js';
import { actingPartyColumns, actingPartyTable, IDENTITY_CONTRACT } from '../auth/identity-contract.js';
import { accessSession, guarded } from './custom-roles.js';

/** Read-only account-administration projection; does not grant CRM edit access. */
export const listInvitationRelations=guarded(async(_input,c)=>{
  const session=accessSession(c),columns=actingPartyColumns(),party=IDENTITY_CONTRACT.actingParty;
  const relations=await withDbSession(c.db!,session,async tx=>(await sql<{id:string;label:string}>`
    select ${sql.ref(columns.id)} as id, ${sql.ref(columns.name)} as label
    from ${sql.table(actingPartyTable())}
    where ${sql.ref(columns.tenantId)}=${session.tenantId}::uuid
      and ${sql.ref(columns.type)}=${party.personType}
      and coalesce(${sql.ref(columns.status)},${party.activeStatus})=${party.activeStatus}
    order by ${sql.ref(columns.name)},${sql.ref(columns.id)}`.execute(tx)).rows);
  return {value:{relations}};
});
