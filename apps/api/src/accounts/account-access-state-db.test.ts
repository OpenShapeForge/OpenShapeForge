import { IDENTITY_LINK_ADMIN_ROLE } from '../auth/organization-roles.js';
// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from 'bun:test';
import { SQL } from 'bun';
import { sql } from 'kysely';
import { createDatabaseRuntime } from '../db/connection.js';
import { withDbSession } from '../db/session.js';
import { blockOrganizationAccount, restoreOrganizationAccount } from './account-management.js';
import { assertMemberAccessActive } from '../auth/member-access-state.js';
import { readSessionLink, cachedLinkState, linkCacheKey } from '../auth/identity-link-session.js';

const url = process.env.HUBBLE_ACCESS_TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.startsWith('/hubble_sandbox_')) throw new Error('HUBBLE_ACCESS_TEST_DATABASE_URL must name an isolated hubble_sandbox_ database.');

test('blocking is tenant-only, preserves assignments, rejects cached sessions and protects administrators', async () => {
  const admin = new SQL(url!, { max: 1 });
  const appUrl = new URL(url!); appUrl.username = appUrl.password = 'openshapeforge_app';
  const runtime = createDatabaseRuntime({ databaseUrl: appUrl.toString(), maxConnections: 1 });
  const tenantId = crypto.randomUUID(), otherId = crypto.randomUUID();
  const actor = crypto.randomUUID(), target = crypto.randomUUID(), identityId = crypto.randomUUID(), actorIdentityId = crypto.randomUUID();
  const issuer = 'https://identity.example.test/realms/demo';
  const session: any = { tenantId, userId: actor, issuer, roles: [IDENTITY_LINK_ADMIN_ROLE, 'Organization.Access.Manage', 'Organization.Accounts.Manage'],
    issuerRoles: [IDENTITY_LINK_ADMIN_ROLE, 'Organization.Access.Manage', 'Organization.Accounts.Manage'], groups: [], scope: 'tenant', credential: 'bearer' };
  const context: any = { session, db: runtime.db };
  const member: any = { ...session, userId: target, roles: [], issuerRoles: [] };
  const revision = async (id: string) => (await admin`select md5(extract(epoch from updated_at)::text || ':' || status || ':' || access_blocked::text || ':' || array_to_string(roles, ',')) as revision
    from platform.identity_relations where tenant_id=${tenantId} and identity_id=${id}`)[0]?.revision ?? '00000000000000000000000000000000';
  try {
    await admin`select set_config('app.roles',${[IDENTITY_LINK_ADMIN_ROLE,'Organization.Access.Manage'].join(',')},false)`;
    for (const tenant of [tenantId, otherId]) {
      await admin`insert into platform.tenants(id,slug,name,status) values(${tenant},${'block-'+tenant},'Block proof','active')`;
      const relation = crypto.randomUUID();
      await admin`insert into erp.relations(id,tenant_id,display_name,relation_type,status) values(${relation},${tenant},'Synthetic member','person','active')`;
      await admin`insert into platform.identities(id,issuer,subject,display_name) values(${identityId},${issuer},${target},'Synthetic member') on conflict do nothing`;
      await admin`insert into platform.identity_relations(identity_id,tenant_id,relation_id,status,roles,linked_at,linked_by)
        values(${identityId},${tenant},${relation},'linked',ARRAY['org_employee'],now(),'test')`;
    }
    const actorRelation = crypto.randomUUID();
    await admin`insert into erp.relations(id,tenant_id,display_name,relation_type,status)
      values(${actorRelation},${tenantId},'Administrator','person','active')`;
    await admin`insert into platform.identities(id,issuer,subject,display_name)
      values(${actorIdentityId},${issuer},${actor},'Administrator')`;
    await admin`insert into platform.identity_relations(identity_id,tenant_id,relation_id,status,roles,linked_at,linked_by)
      values(${actorIdentityId},${tenantId},${actorRelation},'linked',ARRAY['org_employee'],now(),'test')`;
    await admin`update platform.identity_relations set needs_role_assignment=true where tenant_id=${tenantId} and identity_id=${identityId}`;
    const before = await admin`select relation_id,roles,needs_role_assignment from platform.identity_relations where tenant_id=${tenantId} and identity_id=${identityId}`;
    const foreignIdentity = crypto.randomUUID(), foreignRelation = crypto.randomUUID();
    await admin`insert into erp.relations(id,tenant_id,display_name,relation_type,status) values(${foreignRelation},${otherId},'Other member','person','active')`;
    await admin`insert into platform.identities(id,issuer,subject) values(${foreignIdentity},${issuer},${foreignIdentity})`;
    await admin`insert into platform.identity_relations(identity_id,tenant_id,relation_id,status,linked_at,linked_by)
      values(${foreignIdentity},${otherId},${foreignRelation},'linked',now(),'test')`;
    // Populate the ordinary link cache before the access state changes.
    expect(await readSessionLink(runtime.db, member, { issuer, subject: target })).toMatchObject({ status: 'linked' });
    const cacheKey = linkCacheKey(issuer, target, tenantId);
    expect(cachedLinkState(cacheKey)).toBeDefined();
    expect(await blockOrganizationAccount({ id: identityId, revision: await revision(identityId), confirmed: true }, { ...context, session: member })).toMatchObject({ status: 403 });
    expect(await blockOrganizationAccount({ id: crypto.randomUUID(), revision: await revision(identityId), confirmed: true }, context)).toMatchObject({ status: 404 });
    expect(await blockOrganizationAccount({ id: foreignIdentity, revision: await revision(identityId), confirmed: true }, context)).toMatchObject({ status: 404 });
    expect(await blockOrganizationAccount({ id: actorIdentityId, revision: await revision(actorIdentityId), confirmed: true }, context)).toMatchObject({ code: 'SELF_BLOCK' });
    expect(await blockOrganizationAccount({ id: identityId, revision: await revision(identityId) }, context)).toMatchObject({ value: { updated: true } });
    expect(cachedLinkState(cacheKey)).toBeUndefined();
    await expect(assertMemberAccessActive(runtime.db, member)).rejects.toMatchObject({ status: 403, code: 'MEMBER_ACCESS_BLOCKED' });
    await assertMemberAccessActive(runtime.db, { ...member, tenantId: otherId });
    expect(await admin`select relation_id,roles,needs_role_assignment from platform.identity_relations where tenant_id=${tenantId} and identity_id=${identityId}`).toEqual(before);
    await expect(withDbSession(runtime.db, member, tx => sql`update platform.identity_relations set access_blocked=false
      where tenant_id=${tenantId}::uuid and identity_id=${identityId}::uuid`.execute(tx))).rejects.toThrow();
    expect(await restoreOrganizationAccount({ id: identityId, revision: await revision(identityId) }, context)).toMatchObject({ value: { updated: true } });
    await assertMemberAccessActive(runtime.db, member);
    expect(await admin`select relation_id,roles,needs_role_assignment from platform.identity_relations where tenant_id=${tenantId} and identity_id=${identityId}`).toEqual(before);
    await admin`update platform.identity_relations set roles=ARRAY['org_admin'] where tenant_id=${tenantId} and identity_id=${identityId}`;
    expect(await blockOrganizationAccount({ id: identityId, revision: await revision(identityId), confirmed: true }, context)).toMatchObject({ code: 'LAST_ADMINISTRATOR' });
    const events = await admin`select payload from platform.entity_events where tenant_id=${tenantId} and aggregate_id=${identityId}`;
    expect(events.map((row: any) => row.payload.action).sort()).toEqual(['block', 'restore']);
  } finally {
    await runtime.close();
    await admin.close();
  }
}, 30_000);
