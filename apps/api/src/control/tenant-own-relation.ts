// SPDX-License-Identifier: BUSL-1.1
import { sql, type Transaction } from 'kysely';
import type { DB } from '../generated/db/types.js';
import { actingPartyColumns, actingPartyTable, IDENTITY_CONTRACT } from '../auth/identity-contract.js';
import { withSystemSession, SYSTEM_BYPASS_ROLE } from '../db/session.js';
import type { OpenShapeForgeDatabase } from '../db/connection.js';

/** Provisioning and seed reconciliation share one transaction-owned implementation.
 * The existing tenant pointer is authoritative. Never relink or rename customer data.
 * Locking the registry row serializes provisioning, retries and seed reconciliation. */
export async function ensureTenantOwnRelation(trx: Transaction<DB>, tenantId: string): Promise<string> {
  const tenants = await sql<{id:string;name:string;relation_id:string|null}>`
    select id, name, relation_id from platform.tenants where id=${tenantId}::uuid for update
  `.execute(trx);
  const tenant = tenants.rows[0];
  if (!tenant) throw new Error('Tenant does not exist.');
  if (tenant.relation_id) return tenant.relation_id;
  const columns = actingPartyColumns();
  const party = IDENTITY_CONTRACT.actingParty;
  const matches = await sql<{id:string}>`
    select ${sql.id(columns.id)} as id from ${sql.table(actingPartyTable())}
    where ${sql.id(columns.tenantId)}=${tenantId}::uuid
      and ${sql.id(columns.type)}=${party.organizationType}
      and lower(${sql.id(columns.name)})=lower(${tenant.name})
    order by ${sql.id(columns.id)} limit 2
  `.execute(trx);
  // Ambiguous customer data needs an explicit link, not a guessed organization.
  if (matches.rows.length > 1) throw new Error('Multiple organizations match the tenant name; link the tenant organization explicitly.');
  let relationId = matches.rows[0]?.id;
  if (!relationId) {
    const inserted = await sql<{id:string}>`
      insert into ${sql.table(actingPartyTable())}
        (${sql.id(columns.tenantId)},${sql.id(columns.name)},${sql.id(columns.type)},${sql.id(columns.status)})
      values (${tenantId}::uuid,${tenant.name},${party.organizationType},${party.activeStatus})
      returning ${sql.id(columns.id)} as id
    `.execute(trx);
    relationId = inserted.rows[0]!.id;
  }
  await sql`update platform.tenants set relation_id=${relationId}::uuid where id=${tenantId}::uuid`.execute(trx);
  return relationId;
}

/** Every host runs the core seed chain, including hosts without demo data. */
export async function seedTenantOwnRelations(db: OpenShapeForgeDatabase) {
  return withSystemSession(db, { actorSubject:'tenant-organization-seed', roles:[SYSTEM_BYPASS_ROLE],
    reason:'Seed missing tenant organization relations' }, async trx => {
    const tenants=await sql<{id:string}>`select id from platform.tenants order by id`.execute(trx);
    for(const tenant of tenants.rows) await ensureTenantOwnRelation(trx,tenant.id);
    return tenants.rows.length;
  });
}
