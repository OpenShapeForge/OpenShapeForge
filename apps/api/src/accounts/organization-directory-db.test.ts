import { accessPolicy } from './access-policy.js';
import { IDENTITY_LINK_ADMIN_ROLE } from '../auth/organization-roles.js';
// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { SQL } from "bun";
import { createDatabaseRuntime } from "../db/connection.js";
import { ACCOUNT_READ, ACCOUNT_MANAGE } from "./account-session.js";
import * as directory from "./organization-directory.js";
import { createApiApp } from "../roles/api.js";
import { loadRuntimeModules } from "../modules/registry.js";
import { generateKeyPairSync, sign } from "node:crypto";
import { __resetSessionResolverForTests } from "../auth/identity.js";
import { join } from 'node:path';
import { projectLinkedProviders } from "./linked-providers.js";
import { blockOrganizationAccount } from "./account-management.js";

const url = process.env.HUBBLE_ACCOUNT_SOURCE_TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.startsWith("/hubble_sandbox_account_")) throw new Error("An isolated account proof database is required.");
test("Account collections, seek paging, tenant-scoped point reads and shared Relation cardinality", async () => {
  const admin = new SQL(url!, { max: 1 });
  const appUrl = new URL(url!); appUrl.username = appUrl.password = "openshapeforge_app";
  const runtime = createDatabaseRuntime({ databaseUrl: appUrl.toString(), maxConnections: 2 });
  const own = crypto.randomUUID(), other = crypto.randomUUID(), relation = crypto.randomUUID();
  const ids = Array.from({ length: 4 }, () => crypto.randomUUID());
  const issuer = 'https://identity.example.test/realms/openshapeforge';
  const verifierKeys = ['OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI', 'OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER',
    'OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE', 'OPENSHAPEFORGE_API_VERIFY_BEARER_AUTHORIZED_PARTIES'];
  const savedVerifier = Object.fromEntries(verifierKeys.map(key => [key, process.env[key]]));
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwks = Bun.serve({ port: 0, fetch: () => Response.json({ keys: [
    { ...pair.publicKey.export({ format: 'jwk' }), kid: 'account-proof', alg: 'RS256', use: 'sig' },
  ] }) });
  const token = (index: number) => {
    const now = Math.floor(Date.now() / 1000);
    const body = [Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'account-proof' })).toString('base64url'),
      Buffer.from(JSON.stringify({ iss: issuer, aud: 'account-proof', azp: 'account-proof', sub: ids[index],
        tid: own, iat: now, exp: now + 120, email: `account${index}@example.test`, email_verified: true,
        name: index < 2 ? 'Same label' : 'Third label',
        // Deliberately present on BOTH tokens: a person's membership, not this
        // issuer-wide claim, determines organization permissions.
        resource_access: { 'account-proof': { roles: [ACCOUNT_READ] } },
      })).toString('base64url')].join('.');
    return `${body}.${sign('RSA-SHA256', Buffer.from(body), pair.privateKey).toString('base64url')}`;
  };
  // Compose a minimal non-product permission catalog for this database fixture.
  // Standalone OSF deliberately ships no host permission catalog.
  const authoredPermissions = [...accessPolicy.permissions];
  accessPolicy.permissions.splice(0, accessPolicy.permissions.length, ...authoredPermissions,
    'FixtureRecords.All.Read', 'FixtureRecords.All.Update');
  const invitation = crypto.randomUUID();
  const historicalAccount = crypto.randomUUID();
  const ownRole = crypto.randomUUID(), foreignRole = crypto.randomUUID();
  const context: any = { db: runtime.db, session: { tenantId: own, userId: ids[0], roles: [ACCOUNT_READ], groups: [], scope: "tenant", credential: "bearer" } };
  try {
    process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI = jwks.url.href;
    process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER = issuer;
    process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE = 'account-proof';
    process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_AUTHORIZED_PARTIES = 'account-proof';
    __resetSessionResolverForTests();
    await admin`select set_config('app.roles',${[IDENTITY_LINK_ADMIN_ROLE,'Organization.Access.Manage'].join(',')},false)`;
    await admin`insert into platform.tenants(id,slug,name,status) values(${own},${"account-" + own},'Account proof','active'),(${other},${"account-" + other},'Other proof','active')`;
    await admin`insert into erp.relations(id,tenant_id,display_name,relation_type,status) values(${relation},${own},'Shared relation','person','active')`;
    await admin`insert into erp.accounts(id,tenant_id,username,email,status,relation_id) values(${historicalAccount},${own},'historical-only','historical@example.test','active',${relation})`;
    await admin`insert into platform.organization_access_roles(id,tenant_id,label,permissions) values
      (${ownRole},${own},'Account proof finance reader',ARRAY['FixtureRecords.All.Read','Platform.All.ReadWrite']),
      (${foreignRole},${other},'Other organization role',ARRAY['FixtureRecords.All.Update'])`;
    for (const [index, id] of ids.entries()) {
      await admin`insert into platform.identities(id,issuer,subject,email,display_name) values(${id},'https://identity.example.test/realms/openshapeforge',${id},${"account" + index + "@example.test"},${index < 2 ? "Same label" : "Third label"})`;
      if (index < 2) await admin`insert into platform.identity_relations(identity_id,tenant_id,relation_id,status,roles,linked_at,linked_by) values(${id},${own},${relation},'linked',ARRAY[${index === 0 ? ACCOUNT_READ : 'org_employee'},${'custom:' + (index === 0 ? ownRole : foreignRole)}],now(),'account-proof')`;
      else await admin`insert into platform.identity_relations(identity_id,tenant_id,status,roles) values(${id},${index === 2 ? own : other},'pending_confirmation',ARRAY['org_employee'])`;
    }
    await admin`insert into platform.identity_relations(identity_id,tenant_id,status,roles) values(${ids[0]},${other},'pending_confirmation',ARRAY['other-role'])`;
    await admin`insert into platform.employee_invitations(id,tenant_id,email,status,invited_by,role) values(${invitation},${own},'invitation@example.test','pending','account-proof','org_employee')`;
    const first: any = await directory.listOrganizationAccounts({ first: 1 }, context);
    expect(first.value.totalCount).toBe(3);
    expect(first.value.items).toHaveLength(1);
    expect(first.value.nextCursor).toBeString();
    const second: any = await directory.listOrganizationAccounts({ first: 1, after: first.value.nextCursor }, context);
    expect(second.value.items[0].id).not.toBe(first.value.items[0].id);
    const third: any = await directory.listOrganizationAccounts({ first: 1, after: second.value.nextCursor }, context);
    expect(third.value.items[0].id).not.toBe(second.value.items[0].id);
    expect(third.value.nextCursor).toBeNull();
    expect((await directory.getOrganizationAccount({ id: ids[2] }, context) as any).value.relationId).toBeNull();
    expect((await directory.getOrganizationAccount({ id: ids[3] }, context) as any).status).toBe(404);
    expect((await directory.getOrganizationAccount({ id: invitation }, context) as any).status).toBe(404);
    expect((await directory.getOrganizationAccount({ id: historicalAccount }, context) as any).status).toBe(404);
    expect((await admin`select username,email,relation_id::text from erp.accounts where id=${historicalAccount}`)[0]).toEqual({username:'historical-only',email:'historical@example.test',relation_id:relation});
    const shared: any = await directory.listOrganizationAccounts({ relationId: relation }, context);
    expect(shared.value.items.map((item: any) => item.id).sort()).toEqual(ids.slice(0, 2).sort());
    const otherAccount: any = await directory.getOrganizationAccount({ id: ids[0] }, { ...context, session: { ...context.session, tenantId: other } });
    expect(otherAccount.value.directRoles).toEqual(["other-role"]);
    expect(otherAccount.value.relationId).toBeNull();
    expect((await directory.listOrganizationAccounts({ after: first.value.nextCursor }, { ...context, session: { ...context.session, tenantId: other } }) as any).status).toBe(400);
    expect((await directory.listOrganizationAccounts({}, { ...context, session: { ...context.session, roles: ["Relations.All.Read"] } }) as any).status).toBe(403);
    expect(context.session.roles).not.toContain("Relations.All.Read");
    const grants: any = await directory.listOrganizationAccounts({}, context);
    const ownGrants = grants.value.items.find((row: any) => row.id === ids[0]).effectiveRoles;
    expect(ownGrants).toContain('FixtureRecords.All.Read');
    expect(ownGrants).not.toContain('Platform.All.ReadWrite');
    expect(grants.value.items.find((row: any) => row.id === ids[1]).effectiveRoles).not.toContain('FixtureRecords.All.Update');
    expect(grants.value.items.find((row: any) => row.id === ids[2]).effectiveRoles).toEqual([]);
    expect(otherAccount.value.effectiveRoles).toEqual([]);
    const app = createApiApp({ cors: false, databaseUrl: appUrl.toString(), modules: await loadRuntimeModules() });
    try {
      const ownHeaders = { authorization: `Bearer ${token(0)}` };
      const list = await app.inject({ method: 'GET', url: '/api/accounts/account/list?first=1', headers: ownHeaders });
      expect(list.statusCode, list.body).toBe(200);
      expect(list.json().items).toHaveLength(1);
      const get = await app.inject({ method: 'GET', url: `/api/accounts/account/${ids[2]}/get`, headers: ownHeaders });
      expect(get.statusCode, get.body).toBe(200);
      expect(get.json().data.id).toBe(ids[2]);
      expect(get.json().data.providerState).toBe('unavailable');
      expect(get.json().operations.some((offer: any) => offer.operation.id === 'Account.block')).toBe(false);
      const foreign = await app.inject({ method: 'GET', url: `/api/accounts/account/${ids[3]}/get`, headers: ownHeaders });
      expect(foreign.statusCode).toBe(404);
      const gql = await app.inject({ method: 'POST', url: '/api/graphql', headers: { ...ownHeaders, 'content-type': 'application/json' },
        payload: { query: 'query { accountList(input: { first: 1 }) }' } });
      expect(gql.statusCode, gql.body).toBe(200);
      expect(gql.json().errors, gql.body).toBeUndefined();
      expect(gql.json().data.accountList.items).toHaveLength(1);
      const gqlGet = await app.inject({ method: 'POST', url: '/api/graphql', headers: { ...ownHeaders, 'content-type': 'application/json' },
        payload: { query: `query { accountGet(input: { id: "${ids[1]}" }) }` } });
      expect(gqlGet.statusCode, gqlGet.body).toBe(200);
      expect(gqlGet.json().errors, gqlGet.body).toBeUndefined();
      expect(gqlGet.json().data.accountGet).toHaveProperty('data.id', ids[1]);
      expect(gqlGet.json().data.accountGet.operations).toBeArray();
      const mcp = await app.inject({ method: 'POST', url: '/api/mcp',
        headers: { ...ownHeaders, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'account_list', arguments: { first: 1 } } } });
      expect(mcp.statusCode, mcp.body).toBe(200);
      const rpc = mcp.headers['content-type']?.includes('text/event-stream')
        ? JSON.parse(mcp.body.split('\n').find(line => line.startsWith('data: '))!.slice(6))
        : mcp.json();
      expect(rpc.error, mcp.body).toBeUndefined();
      expect(rpc.result.isError, mcp.body).toBeFalsy();
      expect(rpc.result.structuredContent, mcp.body).toHaveProperty('items');
      expect(rpc.result.structuredContent.items).toHaveLength(1);
      const mcpGet = await app.inject({ method: 'POST', url: '/api/mcp',
        headers: { ...ownHeaders, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        payload: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'account_get', arguments: { id: ids[1] } } } });
      expect(mcpGet.statusCode, mcpGet.body).toBe(200);
      const getRpc = mcpGet.headers['content-type']?.includes('text/event-stream')
        ? JSON.parse(mcpGet.body.split('\n').find(line => line.startsWith('data: '))!.slice(6)) : mcpGet.json();
      expect(getRpc.error, mcpGet.body).toBeUndefined();
      expect(getRpc.result.structuredContent).toHaveProperty('data.id', ids[1]);
      expect(getRpc.result.structuredContent.operations).toBeArray();
      const denied = await app.inject({ method: 'GET', url: '/api/accounts/account/list',
        headers: { authorization: `Bearer ${token(1)}` } });
      expect(denied.statusCode, denied.body).toBe(403);
      expect(denied.json(), denied.body).toHaveProperty('error.code', 'FORBIDDEN');
      // Another replica changes membership without touching this process's link cache.
      await admin`update platform.identity_relations set roles=ARRAY[${'custom:' + ownRole}],updated_at=clock_timestamp()
        where identity_id=${ids[0]} and tenant_id=${own}`;
      const revoked = await app.inject({ method: 'GET', url: '/api/accounts/account/list', headers: ownHeaders });
      expect(revoked.statusCode, revoked.body).toBe(403);
      await admin`update platform.identity_relations set roles=ARRAY[${ACCOUNT_READ},${ACCOUNT_MANAGE},${'custom:' + ownRole}],updated_at=clock_timestamp()
        where identity_id=${ids[0]} and tenant_id=${own}`;
      const pendingOffer = await app.inject({ method: 'GET', url: `/api/accounts/account/${ids[2]}/get`, headers: ownHeaders });
      expect(pendingOffer.statusCode, pendingOffer.body).toBe(200);
      expect(pendingOffer.json().operations.find((offer: any) => offer.operation.id === 'Account.block'))
        .toMatchObject({ available: false, error: { code: 'INVALID_STATE' } });
      const roleList = await app.inject({ method: 'POST', url: '/api/accounts/list-roles', headers: ownHeaders, payload: {} });
      expect(roleList.statusCode, roleList.body).toBe(200);
      expect(roleList.json().roles.some((role: any) => role.key === 'custom:' + ownRole)).toBe(true);
      expect(roleList.json().roles.some((role: any) => role.key === 'custom:' + foreignRole)).toBe(false);
      const roleEdit = await app.inject({ method: 'POST', url: '/api/accounts/create-role', headers: ownHeaders, payload: { label: 'Unauthorized role edit', confirmed: true } });
      expect(roleEdit.statusCode, roleEdit.body).toBe(403);
      await admin`update platform.identity_relations set roles=ARRAY[${ACCOUNT_READ},${ACCOUNT_MANAGE},${IDENTITY_LINK_ADMIN_ROLE},${'Organization.Access.Manage'},${'custom:' + ownRole}],updated_at=clock_timestamp()
        where identity_id=${ids[0]} and tenant_id=${own}`;
      const pendingAdminView = await app.inject({ method: 'GET', url: `/api/accounts/account/${ids[2]}/get`, headers: ownHeaders });
      expect(pendingAdminView.statusCode, pendingAdminView.body).toBe(200);
      for (const operationId of ['Account.block', 'Account.restore', 'Account.assignRole', 'Account.revokeRole']) {
        expect(pendingAdminView.json().operations.find((offer: any) => offer.operation.id === operationId))
          .toMatchObject({ available: false, error: { code: 'INVALID_STATE' } });
      }
      const readAccount = async (id: string) => {
        const result = await app.inject({ method: 'GET', url: `/api/accounts/account/${id}/get`, headers: ownHeaders });
        expect(result.statusCode, result.body).toBe(200);
        const body = result.json();
        const blockOffer = body.operations.find((candidate: any) => candidate.operation.id === 'Account.block');
        const restoreOffer = body.operations.find((candidate: any) => candidate.operation.id === 'Account.restore');
        if (body.data.status === 'blocked') {
          expect(blockOffer).toMatchObject({ available: false, error: { code: 'INVALID_STATE' } });
          expect(restoreOffer).toMatchObject({ available: true, binding: { input: { id, revision: body.data.revision } } });
        } else if (body.data.status === 'linked') {
          expect(blockOffer).toMatchObject({ available: true, binding: { input: { id, revision: body.data.revision } } });
          expect(restoreOffer).toMatchObject({ available: false, error: { code: 'INVALID_STATE' } });
        }
        return body.data;
      };
      // Deterministic in-flight revocation: this handler retains the old
      // request session, but its transaction must see the current grant.
      const beforeWithdrawnWrite = await readAccount(ids[1]!);
      const staleActorSession: any = { ...context.session, issuer, issuerRoles: [],
        credential: 'bearer', relation: { status: 'linked' }, roles: [ACCOUNT_READ, ACCOUNT_MANAGE] };
      await admin`update platform.identity_relations set roles=ARRAY[${ACCOUNT_READ}],updated_at=clock_timestamp()
        where identity_id=${ids[0]} and tenant_id=${own}`;
      const withdrawnWrite: any = await blockOrganizationAccount(
        { id: ids[1], revision: beforeWithdrawnWrite.revision }, { db: runtime.db, session: staleActorSession } as any);
      expect(withdrawnWrite.status).toBe(403);
      expect(withdrawnWrite.code).toBe('FORBIDDEN');
      const withdrawnTrusted: any = await blockOrganizationAccount(
        { id: ids[1], revision: beforeWithdrawnWrite.revision },
        { db: runtime.db, session: { ...staleActorSession, credential: 'trusted-context', issuerRoles: undefined } } as any);
      expect(withdrawnTrusted.status).toBe(403);
      expect(withdrawnTrusted.code).toBe('FORBIDDEN');
      const afterWithdrawnWrite = await admin`select access_blocked from platform.identity_relations
        where tenant_id=${own} and identity_id=${ids[1]}`;
      expect(afterWithdrawnWrite[0].access_blocked).toBe(false);
      await admin`update platform.identity_relations set roles=ARRAY[${ACCOUNT_READ},${ACCOUNT_MANAGE},${IDENTITY_LINK_ADMIN_ROLE},${'Organization.Access.Manage'},${'custom:' + ownRole}],updated_at=clock_timestamp()
        where identity_id=${ids[0]} and tenant_id=${own}`;
      const changeAccount = (id: string, action: string, payload: Record<string, unknown>) => app.inject({
        method: 'POST', url: `/api/accounts/account/${id}/${action}`, headers: ownHeaders, payload,
      });
      const beforeBlock = await readAccount(ids[1]!);
      const noConfirmation = await changeAccount(ids[1]!, 'block', { revision: beforeBlock.revision });
      expect(noConfirmation.json(), noConfirmation.body).toHaveProperty('error.code', 'CONFIRMATION_REQUIRED');
      const blocked = await changeAccount(ids[1]!, 'block', { revision: beforeBlock.revision, confirmed: true });
      expect(blocked.statusCode, blocked.body).toBe(200);
      expect(blocked.json(), blocked.body).toHaveProperty('updated', true);
      const stale = await changeAccount(ids[1]!, 'restore', { revision: beforeBlock.revision, confirmed: true });
      expect(stale.statusCode, stale.body).toBe(409);
      expect(stale.json()).toHaveProperty('error.code', 'VERSION_CONFLICT');
      const afterBlock = await readAccount(ids[1]!);
      expect(afterBlock.status).toBe('blocked'); expect(afterBlock.effectiveRoles).toEqual([]);
      const duplicateBlock = await changeAccount(ids[1]!, 'block', { revision: afterBlock.revision, confirmed: true });
      expect(duplicateBlock.statusCode, duplicateBlock.body).toBe(409);
      expect(duplicateBlock.json()).toHaveProperty('error.code', 'INVALID_STATE');
      const restored = await changeAccount(ids[1]!, 'restore', { revision: afterBlock.revision, confirmed: true });
      expect(restored.statusCode, restored.body).toBe(200);
      await admin`update platform.identity_relations set needs_role_assignment=true where identity_id=${ids[1]} and tenant_id=${own}`;
      const beforeRole = await readAccount(ids[1]!);
      const foreignGrant = await changeAccount(ids[1]!, 'assign-role', { revision: beforeRole.revision, roleKey: 'custom:' + foreignRole, confirmed: true });
      expect(foreignGrant.statusCode, foreignGrant.body).toBe(400);
      const assigned = await changeAccount(ids[1]!, 'assign-role', { revision: beforeRole.revision, roleKey: 'custom:' + ownRole, confirmed: true });
      expect(assigned.statusCode, assigned.body).toBe(200);
      expect((await admin`select needs_role_assignment from platform.identity_relations where identity_id=${ids[1]} and tenant_id=${own}`)[0].needs_role_assignment).toBe(false);
      const afterRole = await readAccount(ids[1]!);
      expect(afterRole.effectiveRoles).toContain('FixtureRecords.All.Read');
      await admin`update platform.identity_relations set needs_role_assignment=true where identity_id=${ids[1]} and tenant_id=${own}`;
      const assignedAgain = await changeAccount(ids[1]!, 'assign-role', { revision: afterRole.revision, roleKey: 'custom:' + ownRole, confirmed: true });
      expect(assignedAgain.statusCode, assignedAgain.body).toBe(200);
      expect(assignedAgain.json()).toHaveProperty('updated', true);
      expect((await admin`select needs_role_assignment from platform.identity_relations where identity_id=${ids[1]} and tenant_id=${own}`)[0].needs_role_assignment).toBe(false);
      const afterNoopRole = await readAccount(ids[1]!);
      const removedRole = await changeAccount(ids[1]!, 'revoke-role', { revision: afterNoopRole.revision, roleKey: 'custom:' + ownRole, confirmed: true });
      expect(removedRole.statusCode, removedRole.body).toBe(200);
      const self = await readAccount(ids[0]!);
      const selfBlock = await changeAccount(ids[0]!, 'block', { revision: self.revision, confirmed: true });
      expect(selfBlock.statusCode, selfBlock.body).toBe(409);
      expect(selfBlock.json()).toHaveProperty('error.code', 'SELF_BLOCK');
      const otherMutation = await changeAccount(ids[3]!, 'block', { revision: self.revision, confirmed: true });
      expect(otherMutation.statusCode, otherMutation.body).toBe(404);
      const eventCount = async () => Number((await admin`select count(*) as count from platform.entity_events
        where tenant_id=${own} and aggregate_type='Account'`)[0].count);
      const beforeRace = await readAccount(ids[1]!);
      const eventsBeforeRace = await eventCount();
      const race = await Promise.all([0, 1].map(() => changeAccount(ids[1]!, 'block', {
        revision: beforeRace.revision, confirmed: true,
      })));
      expect(race.map(result => result.statusCode).sort()).toEqual([200, 409]);
      expect(await eventCount()).toBe(eventsBeforeRace + 1);
      const raced = await readAccount(ids[1]!);
      expect((await changeAccount(ids[1]!, 'restore', { revision: raced.revision, confirmed: true })).statusCode).toBe(200);
      // An unavailable audit append must roll back the state change too.
      const beforeAuditFailure = await readAccount(ids[1]!);
      const eventsBeforeFailure = await eventCount();
      await admin.unsafe(`create function platform.account_proof_audit_failure() returns trigger language plpgsql as $$
        begin if NEW.aggregate_type='Account' then raise exception 'proof audit unavailable' using errcode='58000'; end if; return NEW; end $$;
        create trigger account_proof_audit_failure before insert on platform.entity_events
        for each row execute function platform.account_proof_audit_failure()`);
      try {
        const failure = await changeAccount(ids[1]!, 'block', { revision: beforeAuditFailure.revision, confirmed: true });
        expect(failure.statusCode, failure.body).toBe(500);
        const unchanged = await readAccount(ids[1]!);
        expect(unchanged.revision).toBe(beforeAuditFailure.revision);
        expect(unchanged.status).toBe('linked');
        expect(await eventCount()).toBe(eventsBeforeFailure);
      } finally {
        await admin.unsafe('drop trigger account_proof_audit_failure on platform.entity_events; drop function platform.account_proof_audit_failure()');
      }
      await admin`update platform.identity_relations set roles=ARRAY['org_admin'],updated_at=clock_timestamp()
        where identity_id=${ids[0]} and tenant_id=${own}`;
      const onlyAdmin = await readAccount(ids[0]!);
      const lastAdmin = await changeAccount(ids[0]!, 'revoke-role', { revision: onlyAdmin.revision, roleKey: 'org_admin', confirmed: true });
      expect(lastAdmin.statusCode, lastAdmin.body).toBe(409);
      expect(lastAdmin.json()).toHaveProperty('error.code', 'LAST_ADMINISTRATOR');
      await admin`update platform.identity_relations set roles=ARRAY['org_admin'],updated_at=clock_timestamp()
        where identity_id=${ids[1]} and tenant_id=${own}`;
      const firstAdmin = await readAccount(ids[0]!), secondAdmin = await readAccount(ids[1]!);
      // Deterministically prove both serialized postconditions.
      const selfDemoted = await changeAccount(ids[0]!, 'revoke-role',
        { revision: firstAdmin.revision, roleKey: 'org_admin', confirmed: true });
      expect(selfDemoted.statusCode, selfDemoted.body).toBe(200);
      const staleActorBlock = await changeAccount(ids[1]!, 'block',
        { revision: secondAdmin.revision, confirmed: true });
      expect(staleActorBlock.statusCode, staleActorBlock.body).toBe(403);
      expect(staleActorBlock.json()).toHaveProperty('error.code', 'FORBIDDEN');
      await admin`update platform.identity_relations set roles=ARRAY['org_admin'],updated_at=clock_timestamp()
        where identity_id=${ids[0]} and tenant_id=${own}`;
      const secondAdminAgain = await readAccount(ids[1]!);
      const otherBlocked = await changeAccount(ids[1]!, 'block',
        { revision: secondAdminAgain.revision, confirmed: true });
      expect(otherBlocked.statusCode, otherBlocked.body).toBe(200);
      const firstAdminAgain = await readAccount(ids[0]!);
      const noFinalDemotion = await changeAccount(ids[0]!, 'revoke-role',
        { revision: firstAdminAgain.revision, roleKey: 'org_admin', confirmed: true });
      expect(noFinalDemotion.statusCode, noFinalDemotion.body).toBe(409);
      expect(noFinalDemotion.json()).toHaveProperty('error.code', 'LAST_ADMINISTRATOR');
      await admin`update platform.identity_relations set roles=ARRAY['org_admin'],access_blocked=false,updated_at=clock_timestamp()
        where identity_id=${ids[1]} and tenant_id=${own}`;
      const concurrentFirst = await readAccount(ids[0]!), concurrentSecond = await readAccount(ids[1]!);
      const concurrentAdmin = await Promise.all([
        changeAccount(ids[0]!, 'revoke-role', { revision: concurrentFirst.revision, roleKey: 'org_admin', confirmed: true }),
        changeAccount(ids[1]!, 'block', { revision: concurrentSecond.revision, confirmed: true }),
      ]);
      const concurrentCodes = concurrentAdmin.map(result => result.statusCode).sort();
      expect([[200, 403], [200, 409]]).toContainEqual(concurrentCodes);
      await admin`update platform.identity_relations set roles=ARRAY['org_employee'],access_blocked=false,updated_at=clock_timestamp()
        where identity_id=${ids[1]} and tenant_id=${own}`;
      // Restore the browser persona to read-only: no broad business grants were required.
      await admin`update platform.identity_relations set roles=ARRAY[${ACCOUNT_READ},${'custom:' + ownRole}],updated_at=clock_timestamp()
        where identity_id=${ids[0]} and tenant_id=${own}`;
      const root = process.env.HUBBLE_ACCOUNT_WEB_PROOF_ROOT;
      if (root) {
        // A separate manager keeps the original read-only and denied journeys intact.
        const manager = crypto.randomUUID(); ids.push(manager);
        await admin`insert into platform.identities(id,issuer,subject,email,display_name)
          values(${manager},${issuer},${manager},'manager@example.test','Account manager')`;
        await admin`insert into platform.identity_relations(identity_id,tenant_id,relation_id,status,roles,linked_at,linked_by)
          values(${manager},${own},${relation},'linked',ARRAY[${ACCOUNT_READ},${ACCOUNT_MANAGE}],now(),'account-proof')`;
        const relationReader = crypto.randomUUID(); ids.push(relationReader);
        await admin`insert into platform.identities(id,issuer,subject,email,display_name)
          values(${relationReader},${issuer},${relationReader},'relation-reader@example.test','Relation reader')`;
        await admin`insert into platform.identity_relations(identity_id,tenant_id,relation_id,status,roles,linked_at,linked_by)
          values(${relationReader},${own},${relation},'linked',ARRAY[${ACCOUNT_READ},'Relations.All.Read'],now(),'account-proof')`;
        const relationOnly = crypto.randomUUID(); ids.push(relationOnly);
        await admin`insert into platform.identities(id,issuer,subject,email,display_name)
          values(${relationOnly},${issuer},${relationOnly},'relation-only@example.test','Relation only')`;
        await admin`insert into platform.identity_relations(identity_id,tenant_id,relation_id,status,roles,linked_at,linked_by)
          values(${relationOnly},${own},${relation},'linked',ARRAY['Relations.All.Read'],now(),'account-proof')`;
        const managerHeaders = { authorization: `Bearer ${token(4)}` };
        const ownAccount = await app.inject({ method: 'GET', url: `/api/accounts/account/${manager}/get`, headers: managerHeaders });
        expect(ownAccount.statusCode, ownAccount.body).toBe(200);
        const selfPromotion = await app.inject({ method: 'POST', url: `/api/accounts/account/${manager}/assign-role`,
          headers: managerHeaders, payload: { revision: ownAccount.json().data.revision, roleKey: 'org_admin', confirmed: true } });
        expect(selfPromotion.statusCode, selfPromotion.body).toBe(403);
        expect(selfPromotion.json()).toHaveProperty('error.code', 'FORBIDDEN');
        const address = await app.listen({ host: '127.0.0.1', port: 0 });
        const web = Bun.spawn([process.execPath, join(root, 'apps/product-web/src/server.ts')], {
          cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: '0', HUBBLE_API_URL: address,
            HUBBLE_LOCAL_PREVIEW: '0' }, stdout: 'pipe', stderr: 'pipe',
        });
        try {
          const reader = web.stdout.getReader();
          let timer: ReturnType<typeof setTimeout> | undefined;
          const socket = (async () => {
            const decoder = new TextDecoder();
            let logs = '';
            for (;;) {
              const chunk = await reader.read();
              logs += decoder.decode(chunk.value, { stream: !chunk.done });
              const port = logs.match(/listening on 127\.0\.0\.1:(\d+)/)?.[1];
              if (port) return port;
              if (chunk.done) throw new Error('Isolated web exited before reporting a loopback socket.');
            }
          })();
          let port: string;
          try {
            port = await Promise.race([socket, new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('Isolated web did not bind in time.')), 15_000);
            })]);
          } finally { clearTimeout(timer); await reader.cancel(); reader.releaseLock(); }
          const browser = Bun.spawn([process.execPath, 'x', 'playwright', 'test', '--config', 'scripts/account-source.playwright.config.ts'], {
            cwd: root, env: { ...process.env, HUBBLE_ACCOUNT_PROOF_WEB_URL: `http://127.0.0.1:${port}`,
              HUBBLE_ACCOUNT_PROOF_TOKEN: token(0), HUBBLE_ACCOUNT_PROOF_DENIED_TOKEN: token(1),
              HUBBLE_ACCOUNT_PROOF_MANAGER_TOKEN: token(4), HUBBLE_ACCOUNT_PROOF_MANAGED_ID: ids[1],
              HUBBLE_ACCOUNT_PROOF_RELATION_TOKEN: token(5), HUBBLE_ACCOUNT_PROOF_RELATION_ID: relation,
              HUBBLE_ACCOUNT_PROOF_RELATION_ONLY_TOKEN: token(6),
              HUBBLE_ACCOUNT_PROOF_RECORD_ID: ids[2] }, stdout: 'pipe', stderr: 'pipe',
          });
          const [code, out, err] = await Promise.all([browser.exited, new Response(browser.stdout).text(), new Response(browser.stderr).text()]);
          expect(code, out + err).toBe(0);
        } finally { web.kill(); await web.exited; }
      }
      expect((await admin`select username,email,relation_id::text from erp.accounts where id=${historicalAccount}`)[0]).toEqual({username:'historical-only',email:'historical@example.test',relation_id:relation});
    } finally { await app.close(); }
  } finally {
    accessPolicy.permissions.splice(0, accessPolicy.permissions.length, ...authoredPermissions);
    jwks.stop(true);
    for (const key of verifierKeys) { if (savedVerifier[key] === undefined) delete process.env[key]; else process.env[key] = savedVerifier[key]; }
    __resetSessionResolverForTests();
    await runtime.close(); await admin.close();
  }
}, 180_000);

test('linked-provider projection is realm and organization scoped, never leaks unknown aliases', () => {
  const definitions = [
    { realm: 'realm', organizationAlias: 'own', alias: 'google', label: 'Google Workspace', type: 'google' },
    { realm: 'realm', organizationAlias: 'other', alias: 'microsoft', label: 'Microsoft 365', type: 'microsoft' },
  ];
  expect(projectLinkedProviders([{ alias: 'google' }, { alias: 'microsoft' }], definitions, 'realm', 'own')).toEqual({
    providers: [{ key: 'google', label: 'Google Workspace', type: 'google' }], state: 'unsupported',
  });
  expect(projectLinkedProviders([], definitions, 'realm', 'own')).toEqual({ providers: [], state: 'available' });
  expect(projectLinkedProviders([{ alias: 'google' }], definitions, 'different-realm', 'own')).toEqual({ providers: [], state: 'unsupported' });
  expect(projectLinkedProviders([{ alias: 'google' }], definitions, 'realm', 'unconfigured')).toEqual({ providers: [], state: 'not_configured' });
  expect(projectLinkedProviders([{ alias: 'microsoft' }], definitions, 'realm', 'other')).toEqual({
    providers: [{ key: 'microsoft', label: 'Microsoft 365', type: 'microsoft' }], state: 'available',
  });
});
