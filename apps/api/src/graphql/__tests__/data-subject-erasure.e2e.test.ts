// SPDX-License-Identifier: BUSL-1.1
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { graphql, type ExecutionResult, type GraphQLSchema } from "graphql";
import { sql } from "kysely";
import { createDatabaseRuntime, type DatabaseRuntime } from "../../db/connection.js";
import { runMigrationChain } from "../../db/migration-chain.js";
import { withDbSession } from "../../db/session.js";
import { buildGraphqlSchema } from "../schema.js";

const ADMIN_URL = process.env.SCRATCH_ADMIN_DATABASE_URL ?? "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const PRIVACY_ROLE = "Privacy.DataErasure";

type Session = { tenantId: string; userId: string; roles: string[]; groups: string[]; scope: "tenant" };
type Harness = { runtime: DatabaseRuntime; schema: GraphQLSchema; databaseUrl: string };

let admin: SQL | null = null;
let scratchDatabase: string | null = null;
let runtime: DatabaseRuntime | null = null;
let booted: Promise<Harness> | null = null;

async function harness(): Promise<Harness> {
  if (booted) return booted;
  booted = (async () => {
    const name = `privacy_erase_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    admin = new SQL(ADMIN_URL, { max: 1 });
    await admin.unsafe(`create database "${name}"`);
    scratchDatabase = name;
    const migrateUrl = new URL(ADMIN_URL);
    migrateUrl.pathname = `/${name}`;
    const migrated = createDatabaseRuntime({ databaseUrl: migrateUrl.toString(), maxConnections: 1 });
    try {
      await migrated.db.connection().execute((connection) => runMigrationChain(connection));
    } finally {
      await migrated.close();
    }
    const appUrl = new URL(migrateUrl.toString());
    appUrl.username = "openshapeforge_app";
    appUrl.password = "openshapeforge_app";
    runtime = createDatabaseRuntime({ databaseUrl: appUrl.toString(), maxConnections: 4 });
    return { runtime, schema: buildGraphqlSchema([], { db: runtime.db }), databaseUrl: migrateUrl.toString() };
  })();
  return booted;
}

afterAll(async () => {
  await runtime?.close();
  if (admin && scratchDatabase) await admin.unsafe(`drop database if exists "${scratchDatabase}" with (force)`);
  await admin?.close();
});

function session(tenantId: string, roles: string[]): Session {
  return { tenantId, userId: randomUUID(), roles, groups: [], scope: "tenant" };
}

async function execute(sessionValue: Session, source: string, relationId: string): Promise<ExecutionResult> {
  const { schema, runtime: db } = await harness();
  return graphql({ schema, source, contextValue: { db: db.db, session: sessionValue }, variableValues: { relationId } });
}

async function seedSubject(sessionValue: Session, includeContact = true) {
  const { runtime: db } = await harness();
  return withDbSession(db.db, sessionValue, async (trx) => {
    const relation = await sql<{ id: string }>`
      insert into erp.relations (tenant_id, display_name, relation_type)
      values (${sessionValue.tenantId}::uuid, 'Subject', 'person') returning id
    `.execute(trx);
    const relationId = relation.rows[0]!.id;
    if (includeContact) {
      await sql`
        insert into erp.contact_details (tenant_id, relation_id, type, value)
        values (${sessionValue.tenantId}::uuid, ${relationId}::uuid, 'email', 'subject@example.test')
      `.execute(trx);
    }
    await sql`
      insert into erp.payment_details (tenant_id, relation_id, type, iban, bic, account_holder)
      values (${sessionValue.tenantId}::uuid, ${relationId}::uuid, 'bank', 'NL00TEST0123456789', 'TESTNL2A', 'Subject Name')
    `.execute(trx);
    return relationId;
  });
}

async function relationExists(sessionValue: Session, relationId: string) {
  const { runtime: db } = await harness();
  return withDbSession(db.db, sessionValue, async (trx) => {
    const result = await sql<{ count: string }>`select count(*)::text as count from erp.relations where id = ${relationId}::uuid`.execute(trx);
    return result.rows[0]!.count;
  });
}

const ERASE = "mutation($relationId: ID!) { eraseRelationDataSubject(relationId: $relationId) { contactDetailsDeleted paymentDetailsAnonymized relationsDeleted } }";

describe("data-subject erasure", () => {
  test("requires the dedicated privacy role, not generic write/delete", async () => {
    const tenantId = randomUUID();
    const writer = session(tenantId, ["Relations.All.ReadWrite"]);
    const relationId = await seedSubject(writer);
    const result = await execute(writer, ERASE, relationId);
    expect(result.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
    expect(await relationExists(writer, relationId)).toBe("1");
  });

  test("keeps erasure tenant-scoped", async () => {
    const tenantA = session(randomUUID(), [PRIVACY_ROLE]);
    const tenantB = session(randomUUID(), [PRIVACY_ROLE]);
    const relationId = await seedSubject(tenantB);
    const result = await execute(tenantA, ERASE, relationId);
    expect(result.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
    expect(await relationExists(tenantB, relationId)).toBe("1");
  });

  test("deletes direct PII, anonymizes statutory payment PII, and writes anonymous audit", async () => {
    const privacy = session(randomUUID(), [PRIVACY_ROLE]);
    const relationId = await seedSubject(privacy);
    const result = await execute(privacy, ERASE, relationId);
    expect(result.errors ?? []).toEqual([]);
    expect(result.data).toEqual({ eraseRelationDataSubject: { contactDetailsDeleted: 1, paymentDetailsAnonymized: 1, relationsDeleted: 1 } });
    const { runtime: db } = await harness();
    await withDbSession(db.db, privacy, async (trx) => {
      const contacts = await sql<{ count: string }>`select count(*)::text as count from erp.contact_details where relation_id = ${relationId}::uuid`.execute(trx);
      const payment = await sql<{ relation_id: string | null; iban: string | null; bic: string | null; account_holder: string | null }>`select relation_id, iban, bic, account_holder from erp.payment_details`.execute(trx);
      const audit = await sql<{ contact_details_deleted: number; payment_details_anonymized: number; relations_deleted: number }>`select contact_details_deleted, payment_details_anonymized, relations_deleted from platform.data_subject_erasure_audit`.execute(trx);
      const auditColumns = await sql<{ column_name: string }>`select column_name from information_schema.columns where table_schema = 'platform' and table_name = 'data_subject_erasure_audit'`.execute(trx);
      expect(contacts.rows[0]!.count).toBe("0");
      expect(payment.rows).toEqual([{ relation_id: null, iban: null, bic: null, account_holder: null }]);
      expect(audit.rows).toEqual([{ contact_details_deleted: 1, payment_details_anonymized: 1, relations_deleted: 1 }]);
      expect(auditColumns.rows.map((row) => row.column_name)).not.toEqual(expect.arrayContaining(["subject_id", "actor_id", "actor_subject", "payload"]));
    });
  });

  test("rolls back every mutation when the anonymous audit write fails", async () => {
    const privacy = session(randomUUID(), [PRIVACY_ROLE]);
    const relationId = await seedSubject(privacy);
    const { databaseUrl } = await harness();
    const privileged = new SQL(databaseUrl, { max: 1 });
    try {
      await privileged.unsafe("create function platform.fail_erasure_audit() returns trigger language plpgsql as $$ begin raise exception 'audit failed'; end $$");
      await privileged.unsafe("create trigger fail_erasure_audit before insert on platform.data_subject_erasure_audit for each row execute function platform.fail_erasure_audit()");
      const result = await execute(privacy, ERASE, relationId);
      expect(result.errors).toHaveLength(1);
      expect(await relationExists(privacy, relationId)).toBe("1");
    } finally {
      await privileged.unsafe("drop trigger if exists fail_erasure_audit on platform.data_subject_erasure_audit");
      await privileged.unsafe("drop function if exists platform.fail_erasure_audit()");
      await privileged.close();
    }
  });

  test("generic deleteRelation cannot remove a relation while payment PII remains", async () => {
    const writer = session(randomUUID(), ["Relations.All.ReadWrite"]);
    const relationId = await seedSubject(writer, false);
    const result = await execute(writer, "mutation($relationId: ID!) { deleteRelation(id: $relationId) }", relationId);
    expect(result.errors).toHaveLength(1);
    expect(await relationExists(writer, relationId)).toBe("1");
    const { runtime: db } = await harness();
    await withDbSession(db.db, writer, async (trx) => {
      const payment = await sql<{ iban: string | null; bic: string | null; account_holder: string | null }>`
        select iban, bic, account_holder from erp.payment_details where relation_id = ${relationId}::uuid
      `.execute(trx);
      expect(payment.rows).toEqual([{ iban: "NL00TEST0123456789", bic: "TESTNL2A", account_holder: "Subject Name" }]);
    });
  });
});
