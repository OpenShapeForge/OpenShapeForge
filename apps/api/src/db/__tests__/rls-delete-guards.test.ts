// SPDX-License-Identifier: BUSL-1.1
/**
 * The bespoke platform-table read policies must never double as DELETE
 * authorization. These tests run the real migration chain in a scratch
 * database and connect through the restricted application role, because a
 * privileged test connection would bypass the exact PostgreSQL policy
 * semantics this suite protects.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Kysely } from "kysely";
import { IDENTITY_LINK_ADMIN_ROLE } from "../../auth/organization-roles.js";
import type { DB } from "../../generated/db/types.js";
import { createDatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import { APP_ROLE } from "../migrations/app-role.js";
import { SYSTEM_BYPASS_ROLE, withDbSession, withSystemSession } from "../session.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const APP_ROLE_PASSWORD = "openshapeforge_app";
const TEST_TIMEOUT = 120_000;

function databaseUrl(name: string, app = false): string {
  const url = new URL(ADMIN_URL);
  if (url.pathname === "/openshapeforge_dev") {
    throw new Error("admin URL must not point at openshapeforge_dev");
  }
  url.pathname = `/${name}`;
  if (app) {
    url.username = APP_ROLE;
    url.password = APP_ROLE_PASSWORD;
  }
  return url.toString();
}

async function withDb<T>(url: string, fn: (db: Kysely<DB>) => Promise<T>): Promise<T> {
  const runtime = createDatabaseRuntime({ databaseUrl: url, maxConnections: 4 });
  try {
    return await fn(runtime.db);
  } finally {
    await runtime.close();
  }
}

async function withScratchDb<T>(
  fn: (appDb: Kysely<DB>, adminDb: Kysely<DB>) => Promise<T>,
): Promise<T> {
  const name = `rls_delete_guards_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`unsafe scratch database name: ${name}`);

  const server = new SQL(ADMIN_URL, { max: 1 });
  try {
    await server.unsafe(`create database "${name}"`);
    try {
      return await withDb(databaseUrl(name), async (adminDb) => {
        await adminDb.connection().execute((conn) => runMigrationChain(conn));
        return withDb(databaseUrl(name, true), (appDb) => fn(appDb, adminDb));
      });
    } finally {
      await server.unsafe(`drop database if exists "${name}" with (force)`);
    }
  } finally {
    await server.close();
  }
}

describe("platform read policies do not authorize DELETE", () => {
  test(
    "readers cannot delete protected rows while self, organization-admin, and bypass paths still can",
    async () => {
      await withScratchDb(async (appDb, adminDb) => {
        const tenantA = randomUUID();
        const tenantB = randomUUID();
        const reader = randomUUID();
        const otherUser = randomUUID();
        const targetIdentity = randomUUID();
        const invitation = randomUUID();
        const notice = `notice-${randomUUID()}`;

        await withSystemSession(
          appDb,
          {
            actorSubject: "rls-delete-guard-fixture",
            roles: [SYSTEM_BYPASS_ROLE],
            reason: "test: seed RLS DELETE guard fixture",
          },
          async (trx) => {
            await sql`
              insert into platform.tenants (id, slug, name, status, keycloak_realm)
              values
                (${tenantA}::uuid, ${`tenant-${tenantA}`}, 'Tenant A', 'active', 'openshapeforge'),
                (${tenantB}::uuid, ${`tenant-${tenantB}`}, 'Tenant B', 'active', 'openshapeforge')
            `.execute(trx);
            await sql`
              insert into platform.update_notices
                (key, title, changed, published_by_subject, published_by_issuer)
              values (${notice}, 'RLS fixture', 'RLS fixture', 'test', 'test')
            `.execute(trx);
            await sql`
              insert into platform.user_update_notices (tenant_id, user_id, notice_key)
              values
                (${tenantA}::uuid, ${reader}::uuid, ${notice}),
                (${tenantA}::uuid, ${otherUser}::uuid, ${notice})
            `.execute(trx);
            await sql`
              insert into platform.identities (id, issuer, subject)
              values (${targetIdentity}::uuid, 'test', ${otherUser})
            `.execute(trx);
            await sql`
              insert into platform.identity_relations (identity_id, tenant_id, status)
              values
                (${targetIdentity}::uuid, ${tenantA}::uuid, 'pending_confirmation'),
                (${targetIdentity}::uuid, ${tenantB}::uuid, 'pending_confirmation')
            `.execute(trx);
            await sql`
              insert into platform.employee_invitations
                (id, tenant_id, email, role, invited_by)
              values
                (${invitation}::uuid, ${tenantA}::uuid, 'colleague@example.test',
                 'org_employee', 'test')
            `.execute(trx);
          },
        );

        await withDbSession(
          appDb,
          { tenantId: tenantA, userId: reader, roles: [] },
          async (trx) => {
            // Every target is readable in this tenant. Before the fix, that
            // same visibility predicate authorized each DELETE below.
            expect((await sql`select key from platform.update_notices where key = ${notice}`.execute(trx)).rows).toHaveLength(1);
            expect((await sql`select id from platform.identities where id = ${targetIdentity}::uuid`.execute(trx)).rows).toHaveLength(1);
            expect((await sql`select identity_id from platform.identity_relations where identity_id = ${targetIdentity}::uuid`.execute(trx)).rows).toHaveLength(1);
            expect((await sql`select id from platform.employee_invitations where id = ${invitation}::uuid`.execute(trx)).rows).toHaveLength(1);
            expect((await sql`select user_id from platform.user_update_notices where notice_key = ${notice}`.execute(trx)).rows).toHaveLength(2);

            expect(Number((await sql`delete from platform.update_notices where key = ${notice}`.execute(trx)).numAffectedRows)).toBe(0);
            expect(Number((await sql`delete from platform.identities where id = ${targetIdentity}::uuid`.execute(trx)).numAffectedRows)).toBe(0);
            expect(Number((await sql`delete from platform.identity_relations where identity_id = ${targetIdentity}::uuid`.execute(trx)).numAffectedRows)).toBe(0);
            expect(Number((await sql`delete from platform.employee_invitations where id = ${invitation}::uuid`.execute(trx)).numAffectedRows)).toBe(0);
            expect(Number((await sql`delete from platform.user_update_notices where user_id = ${otherUser}::uuid and notice_key = ${notice}`.execute(trx)).numAffectedRows)).toBe(0);

            // The acknowledgement belongs to this session, so its explicit
            // self-write policy still permits the intended DELETE.
            expect(Number((await sql`delete from platform.user_update_notices where user_id = ${reader}::uuid and notice_key = ${notice}`.execute(trx)).numAffectedRows)).toBe(1);
          },
        );

        await withDbSession(
          appDb,
          { tenantId: tenantA, userId: reader, roles: [IDENTITY_LINK_ADMIN_ROLE] },
          async (trx) => {
            expect(Number((await sql`delete from platform.identity_relations where identity_id = ${targetIdentity}::uuid`.execute(trx)).numAffectedRows)).toBe(1);
            expect(Number((await sql`delete from platform.employee_invitations where id = ${invitation}::uuid`.execute(trx)).numAffectedRows)).toBe(1);
          },
        );

        await withSystemSession(
          appDb,
          {
            actorSubject: "rls-delete-guard-maintenance",
            roles: [SYSTEM_BYPASS_ROLE],
            reason: "test: remove platform rows through audited maintenance",
          },
          async (trx) => {
            expect(Number((await sql`delete from platform.update_notices where key = ${notice}`.execute(trx)).numAffectedRows)).toBe(1);
            expect(Number((await sql`delete from platform.identities where id = ${targetIdentity}::uuid`.execute(trx)).numAffectedRows)).toBe(1);
          },
        );

        const remaining = await sql<{ identities: number; links: number; notices: number; acknowledgements: number }>`
          select
            (select count(*)::int from platform.identities where id = ${targetIdentity}::uuid) as identities,
            (select count(*)::int from platform.identity_relations where identity_id = ${targetIdentity}::uuid) as links,
            (select count(*)::int from platform.update_notices where key = ${notice}) as notices,
            (select count(*)::int from platform.user_update_notices where notice_key = ${notice}) as acknowledgements
        `.execute(adminDb);
        expect(remaining.rows[0]).toEqual({ identities: 0, links: 0, notices: 0, acknowledgements: 0 });
      });
    },
    TEST_TIMEOUT,
  );
});
