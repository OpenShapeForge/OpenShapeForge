// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Transaction } from "kysely";
import type { DB } from "../generated/db/types.js";
import {
  createDatabaseRuntime,
  type DatabaseRuntime,
} from "../db/connection.js";
import { runMigrationChain } from "../db/migration-chain.js";
import { APP_ROLE } from "../db/migrations/app-role.js";
import { withDbSession } from "../db/session.js";
import { assertCurrentAccountAuthority } from "../accounts/account-current-authority.js";
import type { TrustedSessionContext } from "./trusted-context.js";
import { resolveGroupRoles } from "./group-roles.js";
import { personOrganizationAuthority } from "./bearer-session.js";
import { resolveRelationGroupMembershipIds } from "./relation-group-memberships.js";

const ADMIN_URL = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
if (decodeURIComponent(new URL(ADMIN_URL).pathname).toLowerCase().endsWith("_dev")) {
  throw new Error("admin URL must not point at an application database");
}
const TEST_TIMEOUT = 90_000;
const scratchName = `relation_groups_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

function scratchUrl(role?: { username: string; password: string }): string {
  const url = new URL(ADMIN_URL);
  if (role) {
    url.username = role.username;
    url.password = role.password;
  }
  url.pathname = `/${scratchName}`;
  return url.toString();
}

const tenantId = randomUUID();
const otherTenantId = randomUUID();
const userId = randomUUID();
const relationId = randomUUID();
const replacementRelationId = randomUUID();
const otherRelationId = randomUUID();
const activeGroupId = randomUUID();
const inactiveGroupId = randomUUID();
const otherTenantGroupId = randomUUID();

const session = {
  tenantId,
  userId,
  roles: [],
  groups: [],
  scope: "self" as const,
};

const identityId = randomUUID();
const identity = {
  issuer: "https://identity.example/realms/test",
  subject: userId,
};

let admin: SQL;
let privileged: DatabaseRuntime;
let restricted: DatabaseRuntime;

beforeAll(async () => {
  if (!/^[a-z0-9_]+$/.test(scratchName)) throw new Error("unsafe scratch database name");
  admin = new SQL(ADMIN_URL, { max: 1 });
  await admin.unsafe(`create database "${scratchName}"`);
  privileged = createDatabaseRuntime({ databaseUrl: scratchUrl(), maxConnections: 2 });
  await privileged.db.connection().execute((conn) => runMigrationChain(conn));
  restricted = createDatabaseRuntime({
    databaseUrl: scratchUrl({ username: APP_ROLE, password: "openshapeforge_app" }),
    maxConnections: 2,
  });

  await privileged.db.connection().execute(async (conn) => {
    await sql`
      insert into platform.tenants (id, slug, name, status)
      values
        (${tenantId}, 'membership-test', 'Membership test', 'active'),
        (${otherTenantId}, 'membership-other', 'Membership other', 'active')
    `.execute(conn);
    await sql`
      create table if not exists erp.relation_group_memberships (
        id uuid primary key default gen_random_uuid(),
        tenant_id uuid not null,
        relation_id uuid not null,
        relation_group_id uuid not null,
        status text not null,
        unique (tenant_id, relation_id, relation_group_id)
      )
    `.execute(conn);
    await sql`alter table erp.relation_group_memberships enable row level security`.execute(conn);
    await sql`alter table erp.relation_group_memberships force row level security`.execute(conn);
    await sql`
      drop policy if exists relation_group_memberships_tenant_isolation
      on erp.relation_group_memberships
    `.execute(conn);
    await sql`
      create policy relation_group_memberships_tenant_isolation
      on erp.relation_group_memberships
      using (tenant_id = app.current_tenant())
      with check (tenant_id = app.current_tenant())
    `.execute(conn);
    await sql.raw(
      `grant select on erp.relation_group_memberships to ${APP_ROLE}`,
    ).execute(conn);

    await sql`
      insert into erp.relations (id, tenant_id, display_name, relation_type, status)
      values
        (${relationId}, ${tenantId}, 'Member', 'person', 'active'),
        (${replacementRelationId}, ${tenantId}, 'Replacement member', 'person', 'active'),
        (${otherRelationId}, ${otherTenantId}, 'Other member', 'person', 'active')
    `.execute(conn);
    await sql`
      insert into platform.identities (id, issuer, subject, display_name)
      values (${identityId}, ${identity.issuer}, ${identity.subject}, 'Membership test user')
    `.execute(conn);
    await sql`
      insert into platform.identity_relations
        (identity_id, tenant_id, relation_id, status, linked_at, linked_by)
      values (${identityId}, ${tenantId}, ${relationId}, 'linked', now(), 'test')
    `.execute(conn);
    await sql`
      insert into erp.relation_groups (id, tenant_id, name, group_type, status)
      values
        (${activeGroupId}, ${tenantId}, 'Active group', 'general', 'active'),
        (${inactiveGroupId}, ${tenantId}, 'Inactive group', 'general', 'inactive'),
        (${otherTenantGroupId}, ${otherTenantId}, 'Other tenant group', 'general', 'active')
    `.execute(conn);
    await sql`
      insert into erp.relation_group_memberships
        (tenant_id, relation_id, relation_group_id, status)
      values
        (${tenantId}, ${relationId}, ${activeGroupId}, 'active'),
        (${tenantId}, ${relationId}, ${inactiveGroupId}, 'active'),
        (${otherTenantId}, ${otherRelationId}, ${otherTenantGroupId}, 'active')
    `.execute(conn);
  });
}, TEST_TIMEOUT);

afterAll(async () => {
  await restricted?.close();
  await privileged?.close();
  await admin?.unsafe(`drop database if exists "${scratchName}" with (force)`);
  await admin?.close();
});

describe("RelationGroup membership resolution", () => {
  test("reads only active same-tenant memberships for the linked Relation and no cache", async () => {
    expect(
      await resolveRelationGroupMembershipIds(restricted.db, session, identity),
    ).toEqual([activeGroupId]);

    await privileged.db.connection().execute((conn) =>
      sql`
        update platform.identity_relations
        set relation_id = ${replacementRelationId}
        where identity_id = ${identityId} and tenant_id = ${tenantId}
      `.execute(conn)
    );
    expect(
      await resolveRelationGroupMembershipIds(restricted.db, session, identity),
    ).toEqual([]);

    await privileged.db.connection().execute(async (conn) => {
      await sql`
        update platform.identity_relations
        set relation_id = ${relationId}
        where identity_id = ${identityId} and tenant_id = ${tenantId}
      `.execute(conn);
      await sql`
        update erp.relation_group_memberships
        set status = 'inactive'
        where tenant_id = ${tenantId} and relation_group_id = ${activeGroupId}
      `.execute(conn);
    });

    expect(
      await resolveRelationGroupMembershipIds(restricted.db, session, identity),
    ).toEqual([]);
  }, TEST_TIMEOUT);
});


test("dated memberships, grant revocation and non-admin escalation guards", async () => {
  const administrator = { ...session, roles: ["Organization.All.ReadWrite"], scope: "tenant" as const };
  await withDbSession(restricted.db, administrator, async trx => {
    await sql`update erp.relation_group_memberships set status='active', start_date=current_date+1
      where tenant_id=${tenantId}::uuid and relation_group_id=${activeGroupId}::uuid`.execute(trx);
    await sql`insert into platform.relation_group_roles (tenant_id,relation_group_id,role)
      values (${tenantId}::uuid,${activeGroupId}::uuid,'Finance.Budget.ReadWrite')`.execute(trx);
  });
  expect(await resolveRelationGroupMembershipIds(restricted.db, session, identity)).toEqual([]);
  await withDbSession(restricted.db, administrator, async trx => {
    await sql`update erp.relation_group_memberships set start_date=current_date, end_date=current_date
      where tenant_id=${tenantId}::uuid and relation_group_id=${activeGroupId}::uuid`.execute(trx);
  });
  expect(await resolveRelationGroupMembershipIds(restricted.db, session, identity)).toEqual([activeGroupId]);
  expect(await resolveGroupRoles(restricted.db, session, [activeGroupId])).toEqual(['Finance.Budget.ReadWrite']);
  expect(await resolveGroupRoles(restricted.db, { ...session, tenantId: otherTenantId }, [activeGroupId])).toEqual([]);
  // A person's authority reads the memberships and their group roles in ONE transaction.
  let begins = 0;
  const counted = createDatabaseRuntime({
    databaseUrl: scratchUrl({ username: APP_ROLE, password: "openshapeforge_app" }),
    maxConnections: 1,
    log: event => { if (/^\s*begin/i.test(event.query.sql)) begins += 1; },
  });
  try {
    const authority = await personOrganizationAuthority(counted.db, {
      tenantId, userId, groups: [], issuerRoles: [], identity,
    }, { identityId, issuer: identity.issuer, subject: identity.subject, status: "linked", relationId, displayName: null, relationType: "person", roles: [] } as never, undefined);
    expect(authority.relationGroupIds).toEqual([activeGroupId]);
    expect(authority.roles).toContain('Finance.Budget.ReadWrite');
    expect(begins).toBe(1);
  } finally { await counted.close(); }
  await expect(withDbSession(restricted.db, session, async trx => {
    await sql`update erp.relation_group_memberships set end_date=null
      where tenant_id=${tenantId}::uuid and relation_group_id=${activeGroupId}::uuid`.execute(trx);
  })).rejects.toThrow();
  await expect(withDbSession(restricted.db, session, async trx => {
    await sql`delete from platform.relation_group_roles where tenant_id=${tenantId}::uuid`.execute(trx);
  })).resolves.toBeUndefined(); // RLS hides write targets; the grant remains.
  expect(await resolveGroupRoles(restricted.db, session, [activeGroupId])).toEqual(['Finance.Budget.ReadWrite']);
  await withDbSession(restricted.db, administrator, async trx => {
    await sql`delete from platform.relation_group_roles where tenant_id=${tenantId}::uuid`.execute(trx);
  });
  expect(await resolveGroupRoles(restricted.db, session, [activeGroupId])).toEqual([]);
}, TEST_TIMEOUT);

test("core group role operations enforce administrator and tenant boundaries", async () => {
  const {assignGroupRole, revokeGroupRole, roleCatalog}=await import('../accounts/roles.js');
  const role=roleCatalog().find(row=>row.key==='financien')?.key ?? roleCatalog()[0]?.key;
  expect(role).toBeTruthy();
  const administrator={...session,roles:['Organization.All.ReadWrite'],scope:'tenant' as const};
  const context={db:restricted.db,session:administrator} as any;
  const assigned=await assignGroupRole({relationGroupId:activeGroupId,roleKey:role},context) as any;
  expect(assigned.value.roleKey).toBe(role);
  expect(await resolveGroupRoles(restricted.db,session,[activeGroupId])).toEqual([role!]);
  const denied=await assignGroupRole({relationGroupId:activeGroupId,roleKey:role},{...context,session}) as any;
  expect(denied.status).toBe(403);
  const crossTenant=await assignGroupRole({relationGroupId:otherTenantGroupId,roleKey:role},context) as any;
  expect(crossTenant.status).toBe(404);
  const unknown=await assignGroupRole({relationGroupId:activeGroupId,roleKey:'invented-role'},context) as any;
  expect(unknown.status).toBe(400);
  await revokeGroupRole({id:assigned.value.id,relationGroupId:activeGroupId},context);
  expect(await resolveGroupRoles(restricted.db,session,[activeGroupId])).toEqual([]);
},TEST_TIMEOUT);

test("a live authority check waits for a group-derived grant to be withdrawn", async () => {
  const requiredRole = "Finance.Budget.ReadWrite";
  const administrator = { ...session, roles: ["Organization.All.ReadWrite"], scope: "tenant" as const };
  const actor = { ...session, issuer: identity.issuer, credential: "bearer", roles: [requiredRole] } satisfies TrustedSessionContext;
  await withDbSession(restricted.db, administrator, (tx) => sql`
    insert into platform.relation_group_roles (tenant_id, relation_group_id, role)
    values (${tenantId}::uuid, ${activeGroupId}::uuid, ${requiredRole})
  `.execute(tx));
  const check = () => withDbSession(restricted.db, actor, (tx) =>
    assertCurrentAccountAuthority(restricted.db, tx, actor, requiredRole));
  await expect(check()).resolves.toBeUndefined();
  const removed = Promise.withResolvers<void>();
  const commit = Promise.withResolvers<void>();
  const withdraw = withDbSession(restricted.db, administrator, async (tx) => {
    await sql`delete from platform.relation_group_roles where tenant_id=${tenantId}::uuid
      and relation_group_id=${activeGroupId}::uuid and role=${requiredRole}`.execute(tx);
    removed.resolve();
    await commit.promise;
  });
  await Promise.race([removed.promise, withdraw]);
  const result = check().then(() => null, (error: unknown) => error);
  try {
    const deadline = Date.now() + 2_000;
    let waiting = false;
    while (!waiting && Date.now() < deadline) {
      const locks = await sql<{ waiting: boolean }>`select exists (
        select 1 from pg_locks where locktype = 'advisory' and not granted
          and database = (select oid from pg_database where datname = current_database())
      ) as waiting`.execute(privileged.db);
      waiting = locks.rows[0]?.waiting === true;
      if (!waiting) await Bun.sleep(10);
    }
    expect(waiting).toBe(true);
  } finally {
    commit.resolve();
    await withdraw;
  }
  expect(await result).toMatchObject({ status: 403, code: "FORBIDDEN" });
}, TEST_TIMEOUT);

test("a group write reports a retryable conflict when the live authority transaction already holds the tenant lock", async () => {
  const requiredRole = "integration_admin";
  const administrator = { ...session, roles: ["Organization.All.ReadWrite"], scope: "tenant" as const };
  const actor = { ...session, issuer: identity.issuer, credential: "bearer", roles: [requiredRole] } satisfies TrustedSessionContext;
  const removeGrant = (tx: Transaction<DB>) => sql`
    delete from platform.relation_group_roles where tenant_id=${tenantId}::uuid
      and relation_group_id=${activeGroupId}::uuid and role=${requiredRole}
  `.execute(tx);
  await withDbSession(restricted.db, administrator, (tx) => sql`
    insert into platform.relation_group_roles (tenant_id, relation_group_id, role)
    values (${tenantId}::uuid, ${activeGroupId}::uuid, ${requiredRole})
  `.execute(tx));
  await withDbSession(restricted.db, actor, async (tx) => {
    await assertCurrentAccountAuthority(restricted.db, tx, actor, requiredRole);
    await expect(restricted.db.transaction().execute(async (other) => {
      await sql`select set_config('app.tenant_id', ${tenantId}, true),
        set_config('app.roles', 'Organization.All.ReadWrite', true)`.execute(other);
      await removeGrant(other);
    })).rejects.toMatchObject({ errno: "40001" });
  });
  expect(await resolveGroupRoles(restricted.db, actor, [activeGroupId])).toEqual([requiredRole]);
  await withDbSession(restricted.db, administrator, removeGrant);
  expect(await resolveGroupRoles(restricted.db, actor, [activeGroupId])).toEqual([]);
}, TEST_TIMEOUT);

test("direct exceptions preserve other roles and cannot remove the last direct administrator", async () => {
  const {setMembershipRoles,mutateMembershipRole}=await import('./identity-link-admin.js');
  const administrator={...session,roles:['Organization.All.ReadWrite'],scope:'tenant' as const};
  await setMembershipRoles(restricted.db,administrator,identityId,['org_admin']);
  const state=await mutateMembershipRole(restricted.db,administrator,identityId,'Finance.Budget.ReadWrite',true);
  expect(state.roles).toContain('org_admin');
  expect(state.roles).toContain('Finance.Budget.ReadWrite');
  await expect(mutateMembershipRole(restricted.db,administrator,identityId,'org_admin',false)).rejects.toThrow('Keep at least one');
  await expect(setMembershipRoles(restricted.db,administrator,identityId,[])).rejects.toThrow('Keep at least one');
  const removed=await mutateMembershipRole(restricted.db,administrator,identityId,'Finance.Budget.ReadWrite',false);
  expect(removed.roles).toEqual(['org_admin']);
},TEST_TIMEOUT);
