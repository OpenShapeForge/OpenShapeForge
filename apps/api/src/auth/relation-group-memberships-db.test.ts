// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import {
  createDatabaseRuntime,
  type DatabaseRuntime,
} from "../db/connection.js";
import { runMigrationChain } from "../db/migration-chain.js";
import { APP_ROLE } from "../db/migrations/app-role.js";
import { resolveRelationGroupMembershipIds } from "./relation-group-memberships.js";

const ADMIN_URL = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const TEST_TIMEOUT = 90_000;
const scratchName = `relation_groups_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

function scratchUrl(role?: { username: string; password: string }): string {
  const url = new URL(ADMIN_URL);
  if (url.pathname === "/openshapeforge_dev" || url.pathname === "/hubble_dev") {
    throw new Error("admin URL must not point at a live application database");
  }
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
        (${otherTenantId}, ${otherRelationId}, ${otherTenantGroupId}, 'active'),
        (${otherTenantId}, ${relationId}, ${otherTenantGroupId}, 'active')
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
