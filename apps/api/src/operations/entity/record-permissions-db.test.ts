// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import {
  createDatabaseRuntime,
  type DatabaseRuntime,
} from "../../db/connection.js";
import { runMigrationChain } from "../../db/migration-chain.js";
import { APP_ROLE } from "../../db/migrations/app-role.js";
import { withDbSession, type DbSessionInput } from "../../db/session.js";

const ADMIN_URL = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const TEST_TIMEOUT = 90_000;
const scratchName = `record_permissions_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

function scratchUrl(role?: { username: string; password: string }): string {
  const url = new URL(ADMIN_URL);
  if (url.pathname === "/openshapeforge_dev") {
    throw new Error("admin URL must not point at openshapeforge_dev");
  }
  if (role) {
    url.username = role.username;
    url.password = role.password;
  }
  url.pathname = `/${scratchName}`;
  return url.toString();
}

const tenantId = randomUUID();
const userA = randomUUID();
const userB = randomUUID();
const groupA = randomUUID();
const roleA = "Records.All.Manage";

function session(userId: string, roles: string[] = [], groups: string[] = []): DbSessionInput {
  return { tenantId, userId, roles, groups, scope: "self" };
}

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
      create table erp.record_permission_fixture (
        id uuid primary key,
        tenant_id uuid not null,
        marker text not null,
        "authorization" jsonb not null
      )
    `.execute(conn);
    await sql`alter table erp.record_permission_fixture enable row level security`.execute(conn);
    await sql`alter table erp.record_permission_fixture force row level security`.execute(conn);
    await sql`
      create policy record_permission_fixture_row_scope
      on erp.record_permission_fixture
      using (
        app.bypass_rls() or (
          tenant_id = app.current_tenant()
          and app.record_permission_allows("authorization", 'view', true)
        )
      )
      with check (app.bypass_rls() or tenant_id = app.current_tenant())
    `.execute(conn);
    await sql.raw(
      `grant select, insert, update, delete on erp.record_permission_fixture to ${APP_ROLE}`,
    ).execute(conn);

    const rows = [
      { marker: "public-empty", authorization: {} },
      { marker: "user-a", authorization: { view: { users: [userA] } } },
      { marker: "role-a", authorization: { view: { roles: [roleA] } } },
      { marker: "group-a", authorization: { view: { groups: [groupA] } } },
      { marker: "malformed-action", authorization: { view: [] } },
      { marker: "malformed-subject", authorization: { view: { users: "everyone" } } },
    ];
    for (const row of rows) {
      await sql`
        insert into erp.record_permission_fixture (id, tenant_id, marker, "authorization")
        values (
          ${randomUUID()}::uuid,
          ${tenantId}::uuid,
          ${row.marker},
          ${row.authorization}::jsonb
        )
      `.execute(conn);
    }
  });
}, TEST_TIMEOUT);

afterAll(async () => {
  await restricted?.close();
  await privileged?.close();
  await admin?.unsafe(`drop database if exists "${scratchName}" with (force)`);
  await admin?.close();
});

async function visibleMarkers(input: DbSessionInput): Promise<string[]> {
  return withDbSession(restricted.db, input, async (trx) => {
    const result = await sql<{ marker: string }>`
      select marker from erp.record_permission_fixture order by marker
    `.execute(trx);
    return result.rows.map((row) => row.marker);
  });
}

describe("record-permission RLS", () => {
  test("valid empty is public while malformed ACL rows fail closed", async () => {
    expect(await visibleMarkers(session(userB))).toEqual(["public-empty"]);
  }, TEST_TIMEOUT);

  test("user, role and exact group subjects grant view independently", async () => {
    expect(await visibleMarkers(session(userA))).toEqual(["public-empty", "user-a"]);
    expect(await visibleMarkers(session(userB, [roleA]))).toEqual(["public-empty", "role-a"]);
    expect(await visibleMarkers(session(userB, [], [groupA]))).toEqual([
      "group-a",
      "public-empty",
    ]);
  }, TEST_TIMEOUT);

  test("edit and delete require view as well as their own action", async () => {
    await withDbSession(restricted.db, session(userA), async (trx) => {
      const result = await sql<{
        edit_only: boolean;
        view_edit: boolean;
        delete_only: boolean;
        view_delete: boolean;
        unknown_action: boolean;
      }>`
        select
          app.record_permission_allows(
            ${{ edit: { users: [userA] } }}::jsonb, 'edit', false
          ) as edit_only,
          app.record_permission_allows(
            ${{ view: { users: [userA] }, edit: { users: [userA] } }}::jsonb,
            'edit', false
          ) as view_edit,
          app.record_permission_allows(
            ${{ delete: { users: [userA] } }}::jsonb, 'delete', false
          ) as delete_only,
          app.record_permission_allows(
            ${{ view: { users: [userA] }, delete: { users: [userA] } }}::jsonb,
            'delete', false
          ) as view_delete,
          app.record_permission_allows('{}'::jsonb, null, true) as unknown_action
      `.execute(trx);
      expect(result.rows[0]).toEqual({
        edit_only: false,
        view_edit: true,
        delete_only: false,
        view_delete: true,
        unknown_action: false,
      });
    });
  }, TEST_TIMEOUT);
});
