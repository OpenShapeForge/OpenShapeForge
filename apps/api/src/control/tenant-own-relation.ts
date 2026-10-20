// SPDX-License-Identifier: BUSL-1.1
import { sql, type Transaction } from 'kysely';
import { createHash } from 'node:crypto';
import type { DB } from '../generated/db/types.js';
import { actingPartyColumns, actingPartyTable, IDENTITY_CONTRACT } from '../auth/identity-contract.js';
import { withSystemSession, SYSTEM_BYPASS_ROLE } from '../db/session.js';
import type { OpenShapeForgeDatabase } from '../db/connection.js';

/** Stable, namespaced UUID: display names never establish organization ownership. */
export function tenantOrganizationRelationId(tenantId: string): string {
  const namespace = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex'); // RFC UUID URL namespace.
  const bytes = createHash('sha1').update(namespace).update('urn:openshapeforge:tenant-organization:' + tenantId.toLowerCase()).digest().subarray(0,16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // RFC UUID v5, an identifier rather than a security digest.
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

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
  const relationId = tenantOrganizationRelationId(tenantId);
  await sql`
    insert into ${sql.table(actingPartyTable())}
      (${sql.id(columns.id)},${sql.id(columns.tenantId)},${sql.id(columns.name)},${sql.id(columns.type)},${sql.id(columns.status)})
    values (${relationId}::uuid,${tenantId}::uuid,${tenant.name},${party.organizationType},${party.activeStatus})
    on conflict (${sql.id(columns.id)}) do nothing
  `.execute(trx);
  // Never reuse a conflicting identifier belonging to another tenant or party type.
  const owned = await sql`
    select ${sql.id(columns.id)} from ${sql.table(actingPartyTable())}
    where ${sql.id(columns.id)}=${relationId}::uuid and ${sql.id(columns.tenantId)}=${tenantId}::uuid
      and ${sql.id(columns.type)}=${party.organizationType}
  `.execute(trx);
  if (owned.rows.length !== 1) throw new Error('The tenant organization identifier is already in use by another party.');
  await sql`update platform.tenants set relation_id=${relationId}::uuid where id=${tenantId}::uuid`.execute(trx);
  return relationId;
}

/** Every host runs the core seed chain, including hosts without demo data. */
export async function seedTenantOwnRelations(db: OpenShapeForgeDatabase) {
  return withSystemSession(db, { actorSubject:'tenant-organization-seed', roles:[SYSTEM_BYPASS_ROLE],
    reason:'Seed missing tenant organization relations' }, async trx => {
    const tenants=await sql<{id:string}>`select id from platform.tenants where relation_id is null order by id`.execute(trx);
    for(const tenant of tenants.rows) await ensureTenantOwnRelation(trx,tenant.id);
    return tenants.rows.length;
  });
}
