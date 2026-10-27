// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { SQL } from "bun";
import { sql } from "kysely";
import { createDatabaseRuntime, type DatabaseRuntime } from "../connection.js";
import { withDbSession } from "../session.js";
import { withAuditContext } from "../../platform/audit-context.js";

const owner = process.env.SCRATCH_ADMIN_DATABASE_URL ?? "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";

test("tenant sessions batch setup without retaining pooled tenant, role, relation or audit authority", async () => {
  const name = `session_batch_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new SQL(owner, { max: 1 });
  await admin.unsafe(`create database "${name}"`);
  const url = new URL(owner); url.pathname = `/${name}`;
  const statements: string[] = [];
  let runtime: DatabaseRuntime | undefined;
  try {
    runtime = createDatabaseRuntime({ databaseUrl: url.toString(), maxConnections: 1,
      log: event => { if (event.level === "query") statements.push(event.query.sql); },
    });
    const db = runtime.db;
    // Deliberately poison this disposable pool connection. Tenant setup must
    // clear break-glass authority before the callback can access any rows.
    await sql`select set_config('app.bypass_rls', 'true', false),
      set_config('app.user_groups', 'poison', false),
      set_config('app.user_groups_exact', 'poison', false),
      set_config('app.user_groups_ancestors', 'poison', false)`.execute(db);
    const first = { tenantId: crypto.randomUUID(), userId: crypto.randomUUID(),
      relationId: crypto.randomUUID(), relationGroupIds: [crypto.randomUUID()],
      roles: ["Example.Read"], groups: [], scope: "self" as const };
    statements.length = 0;
    await withAuditContext("example.read", "bearer", () => withDbSession(db, first, async trx => {
      const result = (await sql<{ tenant: string; user: string; relation: string; roles: string; memberships: string; bypass: string; audit: string; groups: string; exact: string; ancestors: string }>`
        select current_setting('app.tenant_id') as tenant, current_setting('app.user_id') as "user",
          current_setting('app.relation_id') as relation, current_setting('app.roles') as roles,
          current_setting('app.relation_group_ids') as memberships, current_setting('app.bypass_rls') as bypass,
          current_setting('app.audit_operation') as audit, current_setting('app.user_groups') as groups,
          current_setting('app.user_groups_exact') as exact, current_setting('app.user_groups_ancestors') as ancestors
      `.execute(trx)).rows[0];
      expect(result).toEqual({ tenant: first.tenantId, user: first.userId, relation: first.relationId,
        roles: "Example.Read", memberships: first.relationGroupIds[0]!, bypass: "false", audit: "example.read", groups: "", exact: "", ancestors: "" });
    }));
    // Empty direct groups require no closure reads: clear every group GUC
    // in the initial authority batch instead of another round trip.
    expect(statements.filter(statement => statement.includes("set_config"))).toHaveLength(1);

    const second = { tenantId: crypto.randomUUID(), userId: crypto.randomUUID(), roles: [], groups: [] };
    await withDbSession(db, second, async trx => {
      const result = (await sql<{ tenant: string; roles: string; relation: string; memberships: string; bypass: string; audit: string }>`
        select current_setting('app.tenant_id') as tenant, current_setting('app.roles') as roles,
          current_setting('app.relation_id') as relation, current_setting('app.relation_group_ids') as memberships,
          current_setting('app.bypass_rls') as bypass, current_setting('app.audit_operation') as audit
      `.execute(trx)).rows[0];
      expect(result).toEqual({ tenant: second.tenantId, roles: "", relation: "", memberships: "", bypass: "false", audit: "" });
    });
    // The non-empty path must clear inherited group authority BEFORE closure
    // reads too. This fixture view exposes rows only with all three GUCs clear.
    const parent = crypto.randomUUID(), child = crypto.randomUUID();
    await sql`create schema platform`.execute(db);
    await sql`create table platform.fixture_closure (tenant_id uuid, ancestor_id uuid, descendant_id uuid)`.execute(db);
    await sql`insert into platform.fixture_closure values
      (${second.tenantId}::uuid, ${parent}::uuid, ${parent}::uuid),
      (${second.tenantId}::uuid, ${parent}::uuid, ${child}::uuid),
      (${second.tenantId}::uuid, ${child}::uuid, ${child}::uuid)`.execute(db);
    await sql`create view platform.org_unit_closure as select * from platform.fixture_closure
      where current_setting('app.user_groups', true) = ''
        and current_setting('app.user_groups_exact', true) = ''
        and current_setting('app.user_groups_ancestors', true) = ''`.execute(db);
    statements.length = 0;
    await withDbSession(db, { ...second, groups: [child] }, async trx => {
      const result = (await sql<{ groups: string; exact: string; ancestors: string }>`
        select current_setting('app.user_groups') as groups,
          current_setting('app.user_groups_exact') as exact,
          current_setting('app.user_groups_ancestors') as ancestors`.execute(trx)).rows[0]!;
      expect(result.groups).toBe(child);
      expect(result.exact).toBe(child);
      expect(result.ancestors.split(',').sort()).toEqual([parent, child].sort());
    });
    expect(statements.filter(statement => statement.includes("set_config"))).toHaveLength(2);
    expect((await sql<{ tenant: string }>`select current_setting('app.tenant_id', true) as tenant`.execute(db)).rows[0]!.tenant).toBe("");
  } finally {
    await runtime?.close();
    await admin.unsafe(`drop database "${name}" with (force)`);
    await admin.close();
  }
});
