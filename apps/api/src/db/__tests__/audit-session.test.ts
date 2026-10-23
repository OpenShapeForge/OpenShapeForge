// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { SQL } from "bun";
import { sql } from "kysely";
import { createDatabaseRuntime } from "../connection.js";
import { withDbSession, withInvocationSavepoint } from "../session.js";
import { auditContext, withAuditContext } from "../../platform/audit-context.js";

const owner = process.env.SCRATCH_ADMIN_DATABASE_URL ?? "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
test("a context-free outer transaction retains its actual correlation around nested Operations and explicit savepoints", async () => {
  const name = `audit_session_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new SQL(owner, { max: 1 });
  await admin.unsafe(`create database "${name}"`);
  const url = new URL(owner); url.pathname = `/${name}`;
  const runtime = createDatabaseRuntime({ databaseUrl: url.toString(), maxConnections: 1 });
  const session = { tenantId: crypto.randomUUID(), userId: crypto.randomUUID(), roles: [], groups: [] };
  try {
    expect(auditContext()).toBeUndefined();
    await withDbSession(runtime.db, session, async tx => {
      const current = async () => (await sql<{ correlation: string; operation: string }>`select current_setting('app.audit_correlation') as correlation,current_setting('app.audit_operation') as operation`.execute(tx)).rows[0]!;
      const outer = await current(); expect(outer.correlation).toMatch(/^[a-f0-9-]{36}$/); expect(outer.operation).toBe("");
      await withAuditContext("nested.operation", "bearer", () => withDbSession(runtime.db, session, async nested => {
        expect(nested).toBe(tx);
        expect(await current()).toEqual({ correlation: outer.correlation, operation: "nested.operation" });
      }), "person");
      expect(await current()).toEqual(outer);
      await expect(withInvocationSavepoint(tx, () => withAuditContext("nested.failure", "bearer", () =>
        withDbSession(runtime.db, session, nested => sql`select 1/0`.execute(nested))))).rejects.toThrow();
      expect(await current()).toEqual(outer);
      expect(auditContext()!.correlationId).toBe(outer.correlation);
    });
    expect(auditContext()).toBeUndefined();
    // Merely changing audit metadata must not introduce failure isolation.
    for (const changedMetadata of [false, true]) {
      await expect(withDbSession(runtime.db, session, async tx => {
        const fail = () => withDbSession(runtime.db, session, nested => sql`select 1/0`.execute(nested));
        await expect(changedMetadata ? withAuditContext("nested.failure", "bearer", fail) : fail()).rejects.toThrow();
        await sql`select 1`.execute(tx);
      })).rejects.toThrow(/transaction is aborted/);
    }
  } finally {
    await runtime.close();
    await admin.unsafe(`drop database "${name}" with (force)`); await admin.close();
  }
});
