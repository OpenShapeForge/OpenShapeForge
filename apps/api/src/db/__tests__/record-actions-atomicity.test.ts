// SPDX-License-Identifier: BUSL-1.1
/**
 * The record-action privilege step as a CONCURRENT deployment sees it.
 *
 * The migration lock (bootstrap.ts) is a SESSION advisory lock: it serializes
 * writers of the schema, and it does nothing at all for a session that is not
 * one — an app or worker connection, or a definer-role statement, carries on
 * through the whole chain. So "the grants and the policies are replaced" is
 * only safe if no other session can observe the table between the two states,
 * and if a refusal part-way through leaves nothing behind.
 *
 * This runs on its own scratch database because it rewrites the two lookup
 * functions with its own entity list, which would otherwise erase the branches
 * another suite's fixtures depend on.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import { createDatabaseRuntime, type DatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import { APP_ROLE } from "../migrations/app-role.js";
import {
  applyRecordActionsMigration,
  type RecordActionEntity,
} from "../migrations/record-actions.js";
import { databaseRole } from "../database-roles.js";

const ADMIN_URL = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const RESOLVER_ROLE = databaseRole("recordActionResolver").name;
const TEST_TIMEOUT = 180_000;
const scratch = `record_actions_atomic_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const TABLE = "action_swaps";

let server: SQL;
let admin: DatabaseRuntime;

/**
 * The declared entity. `reads` is what the second pass narrows, so a stale
 * column grant from the first pass is visible as a leftover rather than
 * inferred.
 */
function entity(reads: RecordActionEntity["reads"] = {
  start: [{ field: "definition", column: "definition" }],
}): RecordActionEntity {
  return {
    entity: "ActionSwap", schema: "erp", table: TABLE,
    keyColumn: "id", keyIsUuid: true, aclColumn: "acl", actions: ["start"], reads,
  };
}

beforeAll(async () => {
  if (!/^[a-z0-9_]+$/.test(scratch)) throw new Error("unsafe scratch database name");
  server = new SQL(ADMIN_URL, { max: 1 });
  await server.unsafe(`create database "${scratch}"`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${scratch}`;
  admin = createDatabaseRuntime({ databaseUrl: url.toString(), maxConnections: 4 });
  await admin.db.connection().execute(async (conn) => {
    await runMigrationChain(conn);
    await sql.raw(`
      create table erp.${TABLE} (
        id uuid primary key, tenant_id uuid not null, secret text not null,
        definition text not null default 'graph', acl jsonb not null default '{}'::jsonb)
    `).execute(conn);
    await sql.raw(`alter table erp.${TABLE} enable row level security`).execute(conn);
    await sql.raw(`alter table erp.${TABLE} force row level security`).execute(conn);
    await sql.raw(`
      create policy ${TABLE}_tenant_isolation on erp.${TABLE}
      using (app.bypass_rls() or tenant_id = app.current_tenant())
      with check (app.bypass_rls() or tenant_id = app.current_tenant())
    `).execute(conn);
    await applyRecordActionsMigration(conn, [entity()]);
  });
}, TEST_TIMEOUT);

afterAll(async () => {
  await admin?.close();
  await server?.unsafe(`drop database if exists "${scratch}" with (force)`);
  await server?.close();
});

const declaredPrivileges = async () =>
  admin.db.connection().execute(async (conn) =>
    (await sql<{ column_name: string; privilege_type: string }>`
      select column_name, privilege_type from information_schema.column_privileges
       where grantee = ${RESOLVER_ROLE} and table_name = ${TABLE}
       order by privilege_type, column_name
    `.execute(conn)).rows.map((row) => `${row.privilege_type} ${row.column_name}`));

const FULL_GRANTS = [
  "SELECT acl", "SELECT definition", "SELECT id", "SELECT tenant_id", "UPDATE acl",
];
const NARROWED_GRANTS = ["SELECT acl", "SELECT id", "SELECT tenant_id", "UPDATE acl"];

/** The advisory key the mid-swap test pauses the step on. */
const MID_SWAP = "osf.record-actions:mid-swap";

describe("the record-action step replaces its grants and policies atomically", () => {
  test("the row-security assert runs before anything is granted", async () => {
    expect(await declaredPrivileges()).toEqual(FULL_GRANTS);
    await admin.db.connection().execute(async (conn) => {
      // A second entity whose table has no row security: the step refuses it,
      // AFTER it has already granted and re-policied the first one.
      await sql`create table erp.action_unbounded (
        id uuid primary key, tenant_id uuid not null, acl jsonb not null default '{}'::jsonb)
      `.execute(conn);
      await expect(applyRecordActionsMigration(conn, [
        entity(),
        {
          entity: "ActionUnbounded", schema: "erp", table: "action_unbounded",
          keyColumn: "id", keyIsUuid: true, aclColumn: "acl", actions: ["start"], reads: {},
        },
      ])).rejects.toThrow(/row level security is not enabled on it/);
      const unbounded = await sql<{ count: number }>`
        select count(*)::int as count from information_schema.column_privileges
         where grantee = ${RESOLVER_ROLE} and table_name = 'action_unbounded'
      `.execute(conn);
      expect(unbounded.rows[0]!.count).toBe(0);
      await sql`drop table erp.action_unbounded`.execute(conn);
    });
    expect(await declaredPrivileges()).toEqual(FULL_GRANTS);
  }, TEST_TIMEOUT);

  /**
   * TRUNCATE is the privilege no policy can bound — it ignores row security
   * entirely — and `revoke` is not a complete answer either: a grant made by a
   * SECOND grantor survives the owner's revoke. Verified on PostgreSQL 17.11:
   * with `grant truncate ... to <app role> with grant option` and the app role
   * passing it on, the owner's `revoke all ... from <resolver>` leaves
   * `<resolver>=D/<app role>` in `relacl`. So the step reads its own result
   * back out of the catalog and refuses.
   *
   * It refuses AFTER revoking and re-granting, which is what makes this the
   * rollback test as well: the entity passed in declares no read projection,
   * so a step that was not transactional would leave the `definition` column
   * SELECT revoked behind its own failure.
   */
  test("a privilege the revoke cannot reach fails the step, and rolls its revoke back", async () => {
    try {
      await admin.db.connection().execute(async (conn) => {
        await sql.raw(
          `grant truncate on erp.${TABLE} to ${APP_ROLE} with grant option`,
        ).execute(conn);
        await sql.raw(`set role ${APP_ROLE}`).execute(conn);
        await sql.raw(`grant truncate on erp.${TABLE} to ${RESOLVER_ROLE}`).execute(conn);
        await sql`reset role`.execute(conn);
        await expect(
          applyRecordActionsMigration(conn, [entity({})]),
        ).rejects.toThrow(/also holds table:-:TRUNCATE/);
      });
      // Not the narrowed set the refused pass asked for: the whole unit rolled
      // back, so the deployment is left on the grants it had.
      expect(await declaredPrivileges()).not.toEqual(NARROWED_GRANTS);
      expect(await declaredPrivileges()).toEqual(FULL_GRANTS);
    } finally {
      await admin.db.connection().execute(async (conn) => {
        await sql.raw(`set role ${APP_ROLE}`).execute(conn);
        await sql.raw(
          `revoke truncate on erp.${TABLE} from ${RESOLVER_ROLE}`,
        ).execute(conn);
        await sql`reset role`.execute(conn);
        await sql.raw(
          `revoke truncate on erp.${TABLE} from ${APP_ROLE}`,
        ).execute(conn);
      });
    }
    // And with the stray privilege gone the step runs to completion again.
    await admin.db.connection().execute((conn) =>
      applyRecordActionsMigration(conn, [entity()]));
    expect(await declaredPrivileges()).toEqual(FULL_GRANTS);
  }, TEST_TIMEOUT);

  /**
   * The re-run, stopped in the middle of its own swap and inspected from
   * another session.
   *
   * An event trigger on `ddl_command_end` takes a SHARED advisory lock that
   * this test holds EXCLUSIVELY, so the first `create policy` of the swap
   * blocks inside the step's transaction with the three `drop policy`
   * statements already issued. A third session then counts the table's
   * record-action policies. Because the swap is one transaction, it still sees
   * all four: the drops are invisible until commit. Without the transaction
   * the dropped policy is already gone and the count is three — which is the
   * window a session running AS the resolver would have found the table
   * unfenced in.
   *
   * No sleeps decide anything: the test waits for an ungranted advisory lock
   * to appear, and fails if it never does.
   */
  test("a concurrent session cannot see the table mid-swap", async () => {
    const policyNames = async () =>
      admin.db.connection().execute(async (conn) =>
        (await sql<{ policyname: string }>`
          select policyname from pg_policies
           where schemaname = 'erp' and tablename = ${TABLE}
             and policyname like '%record_action%'
           order by policyname
        `.execute(conn)).rows.map((row) => row.policyname));
    const expectedPolicies = await policyNames();
    expect(expectedPolicies).toEqual([
      `${TABLE}_record_action_delete_fence`,
      `${TABLE}_record_action_fence`,
      `${TABLE}_record_action_lock`,
      `${TABLE}_record_action_read`,
    ]);

    await admin.db.connection().execute(async (conn) => {
      // The body is one dollar-quoted literal, so the two names it needs are
      // rendered rather than bound.
      await sql.raw(`
        create or replace function public.pause_record_action_swap()
        returns event_trigger language plpgsql as $pause$
        declare command record;
        begin
          for command in select * from pg_event_trigger_ddl_commands() loop
            if position('${TABLE}' in command.object_identity) > 0 then
              perform pg_advisory_lock_shared(hashtextextended('${MID_SWAP}', 0));
              perform pg_advisory_unlock_shared(hashtextextended('${MID_SWAP}', 0));
            end if;
          end loop;
        end $pause$
      `).execute(conn);
      await sql`
        create event trigger pause_record_action_swap on ddl_command_end
        when tag in ('CREATE POLICY')
        execute function public.pause_record_action_swap()
      `.execute(conn);
    });

    try {
      // The holder keeps the exclusive advisory lock for its whole session.
      await admin.db.connection().execute(async (holder) => {
        await sql`select pg_advisory_lock(hashtextextended(${MID_SWAP}, 0))`.execute(holder);
        const rerun = admin.db.connection().execute((other) =>
          applyRecordActionsMigration(other, [entity()]));
        try {
          let paused = false;
          for (let attempt = 0; attempt < 400 && !paused; attempt += 1) {
            const waiting = await sql<{ count: number }>`
              select count(*)::int as count from pg_locks
               where locktype = 'advisory' and not granted
                 and database = (select oid from pg_database
                                  where datname = current_database())
            `.execute(holder);
            paused = waiting.rows[0]!.count > 0;
            if (!paused) await new Promise((resolve) => setTimeout(resolve, 25));
          }
          expect(paused).toBe(true);
          // The swap is in progress and has already dropped policies. Nothing
          // outside its transaction can tell.
          expect(await policyNames()).toEqual(expectedPolicies);
        } finally {
          await sql`select pg_advisory_unlock(hashtextextended(${MID_SWAP}, 0))`.execute(holder);
          await rerun;
        }
      });
      expect(await policyNames()).toEqual(expectedPolicies);
    } finally {
      await admin.db.connection().execute(async (conn) => {
        await sql`drop event trigger if exists pause_record_action_swap`.execute(conn);
        await sql`drop function if exists public.pause_record_action_swap()`.execute(conn);
      });
    }
  }, TEST_TIMEOUT);
});
