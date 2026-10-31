// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Kysely } from "kysely";
import { listPlatformAudit } from "../../control/platform-audit.js";
import type { PlatformAdministrator } from "../../control/platform-admin.js";
import type { DB } from "../../generated/db/types.js";
import { createDatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import { SYSTEM_BYPASS_ROLE, withSystemSession } from "../session.js";

const ADMIN_URL = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const administrator: PlatformAdministrator = {
  subject: "0b2a3f1e-8a6b-4f30-9d2f-5f1c7a8e9b10",
  issuer: "https://identity.example/realms/control",
  username: "platform-admin",
  name: "Platform admin",
  email: "admin@example.com",
  authorizedParty: "admin-gateway",
  expiresAtMs: null,
};

test("platform audit is filtered, paginated, secret-free and records its own read without returning it", async () => {
  const name = `platform_audit_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new SQL(ADMIN_URL, { max: 1 });
  await admin.unsafe(`create database "${name}"`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const runtime = createDatabaseRuntime({ databaseUrl: url.toString(), maxConnections: 2 });
  try {
    await runtime.db.connection().execute((connection) => runMigrationChain(connection));
    const input = {
      actorSubject: `${administrator.issuer}#${administrator.subject}`,
      roles: [SYSTEM_BYPASS_ROLE],
    };
    const tenantId = randomUUID();
    await withSystemSession(runtime.db, { ...input, tenantId, reason: "regression: tenant system identity" }, async (trx, audit) => {
      const context = await sql<{ user_id: string; subject: string; bypass: boolean; rules: string }>`select current_setting('app.user_id', true) as user_id, current_setting('app.audit_actor_subject', true) as subject, app.bypass_rls() as bypass, current_setting('app.authorization_rules', true) as rules`.execute(trx);
      expect(context.rows[0]).toMatchObject({ user_id: '', subject: input.actorSubject, bypass: true, rules: '' });
      const recorded = await sql<{ actor_subject: string }>`select actor_subject from platform.system_bypass_audit where id = ${audit.auditId}`.execute(trx);
      expect(recorded.rows[0]?.actor_subject).toBe(input.actorSubject);
      const eventId = randomUUID();
      const event = await sql<{ payload: { audit: { actorSubject: string; actorId: string } } }>`insert into platform.entity_events(id, tenant_id, aggregate_type, aggregate_id, event_type, payload) values (${eventId}::uuid, ${tenantId}::uuid, 'Example', 'record', 'changed', '{}'::jsonb) returning payload`.execute(trx);
      expect(event.rows[0]?.payload.audit).toMatchObject({ actorSubject: input.actorSubject, actorId: input.actorSubject });
    });
    await withSystemSession(runtime.db, { ...input, reason: "platform-mcp: publish_catalog_entry service/alpha" }, async () => undefined);
    await withSystemSession(runtime.db, { ...input, reason: "platform-mcp: publish_catalog_entry service/bravo" }, async () => undefined);
    await withSystemSession(runtime.db, { ...input, reason: "internal maintenance detail" }, async () => undefined);
    await withSystemSession(runtime.db, { ...input, reason: "platform-mcp: future_action token=must-not-leak" }, async () => undefined);
    await sql`
      insert into platform.system_bypass_audit
        (id, actor_subject, reason, started_at, ended_at, succeeded)
      values
        (${randomUUID()}, ${input.actorSubject}, 'platform-mcp: withdraw_update_notice failed-notice', now() - interval '2 seconds', now() - interval '1 second', false),
        (${randomUUID()}, ${input.actorSubject}, 'platform-mcp: withdraw_update_notice running-notice', now(), null, false)
    `.execute(runtime.db);

    const deps = { db: runtime.db, administrator, provider: undefined };
    const first = await listPlatformAudit(deps, { action: "publish_catalog_entry", limit: 1 });
    expect(first.entries).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();
    expect(first.entries[0]).toMatchObject({ action: "publish_catalog_entry", result: "succeeded" });
    expect(JSON.stringify(first)).not.toContain("admin@example.com");
    expect(JSON.stringify(first)).not.toContain("internal maintenance detail");
    expect(JSON.stringify(first)).not.toContain("must-not-leak");

    const second = await listPlatformAudit(deps, {
      action: "publish_catalog_entry",
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0]?.target).not.toBe(first.entries[0]?.target);
    expect(second.nextCursor).toBeNull();

    const redactedUnknown = await listPlatformAudit(deps, { action: "future_action" });
    expect(redactedUnknown.entries).toEqual([
      expect.objectContaining({ action: "other_platform_action", target: null, result: "succeeded" }),
    ]);

    const windowStart = new Date(Date.now() - 60_000).toISOString();
    const windowEnd = new Date(Date.now() + 60_000).toISOString();
    const actorAndResult = await listPlatformAudit(deps, {
      actor: input.actorSubject,
      result: "succeeded",
      since: windowStart,
      until: windowEnd,
    });
    expect(actorAndResult.entries.length).toBeGreaterThanOrEqual(3);
    expect(actorAndResult.entries.every((entry) => entry.actor === input.actorSubject && entry.result === "succeeded")).toBe(true);

    const failed = await listPlatformAudit(deps, { action: "withdraw_update_notice", result: "failed" });
    expect(failed.entries).toEqual([expect.objectContaining({ target: "failed-notice", result: "failed" })]);
    const inProgress = await listPlatformAudit(deps, { action: "withdraw_update_notice", result: "in_progress" });
    expect(inProgress.entries).toEqual([expect.objectContaining({ target: "running-notice", result: "in_progress" })]);

    const reads = await sql<{ reason: string; succeeded: boolean }>`
      select reason, succeeded from platform.system_bypass_audit
       where reason = 'platform-mcp: control.list-platform-audit'
    `.execute(runtime.db as Kysely<DB>);
    expect(reads.rows).toHaveLength(6);
    expect(reads.rows.every((row) => row.succeeded)).toBe(true);
  } finally {
    await runtime.close();
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
    await admin.close();
  }
}, 90_000);
