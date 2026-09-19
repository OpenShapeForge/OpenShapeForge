// SPDX-License-Identifier: BUSL-1.1
/**
 * Capability grants against a migrated scratch database: issue, list,
 * supersede, resolve, lock, expire, consume, revoke, purge — and the tenant
 * fence, which the app role cannot cross.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Kysely } from "kysely";
import type { DB } from "../../generated/db/types.js";
import { createDatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import { withDbSession } from "../session.js";
import { HttpError } from "../../rest/http-error.js";
import {
  issueCapabilityGrantInTransaction,
  listCapabilityGrantsInTransaction,
  purgeCapabilityGrants,
  revokeCapabilityGrantInTransaction,
} from "../../operations/capability-grants.js";
import {
  CAPABILITY_GRANT_ATTEMPT_POLICY,
  consumeCapabilityGrantInTransaction,
  resolveCapabilityGrantSession,
} from "../../operations/capability-grant-resolution.js";
import { parseGrantToken, renderGrantToken } from "../../operations/capability-grant-token.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const APP_ROLE = "openshapeforge_app";
const APP_PASSWORD = "openshapeforge_app";
const TEST_TIMEOUT = 120_000;
const OPERATIONS = new Set(["demo.envelope.read", "demo.envelope.sign"]);
const SUBJECT_ENTITY = "Envelope";

function databaseUrl(name: string, appRole = false): string {
  const url = new URL(ADMIN_URL);
  if (url.pathname === "/openshapeforge_dev") throw new Error("admin URL must not point at openshapeforge_dev");
  if (appRole) {
    url.username = APP_ROLE;
    url.password = APP_PASSWORD;
  }
  url.pathname = `/${name}`;
  return url.toString();
}

async function withDb<T>(url: string, fn: (db: Kysely<DB>) => Promise<T>): Promise<T> {
  const runtime = createDatabaseRuntime({ databaseUrl: url, maxConnections: 2 });
  try {
    return await fn(runtime.db);
  } finally {
    await runtime.close();
  }
}

async function withScratchDb<T>(fn: (name: string) => Promise<T>): Promise<T> {
  const name = `capability_grants_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new SQL(ADMIN_URL, { max: 1 });
  try {
    await admin.unsafe(`create database "${name}"`);
    try {
      return await fn(name);
    } finally {
      await admin.unsafe(`drop database if exists "${name}" with (force)`);
    }
  } finally {
    await admin.close();
  }
}

async function createTenant(db: Kysely<DB>, slug: string): Promise<string> {
  const inserted = await sql<{ id: string }>`
    insert into platform.tenants (slug, name, status) values (${slug}, ${slug}, 'active') returning id::text
  `.execute(db);
  return inserted.rows[0]!.id;
}

function issuer(tenantId: string) {
  return { tenantId, userId: randomUUID(), roles: ["Organization.All.ReadWrite"], groups: [], scope: "tenant" as const };
}

async function refusal(work: Promise<unknown>): Promise<{ status: number; code: string }> {
  try {
    await work;
  } catch (error) {
    if (error instanceof HttpError) return { status: error.status, code: error.code };
    throw error;
  }
  throw new Error("expected a refusal");
}

async function events(db: Kysely<DB>, session: ReturnType<typeof issuer>, grantId: string): Promise<string[]> {
  return withDbSession(db, session, async (trx) => {
    const rows = await sql<{ event_type: string }>`
      select event_type from platform.entity_events
       where aggregate_type = 'capability_grant' and aggregate_id = ${grantId}
       order by sequence
    `.execute(trx);
    return rows.rows.map((row) => row.event_type);
  });
}

describe("capability grants", () => {
  test("issue, resolve, consume, lock, expire, supersede, revoke, purge and the tenant fence", async () => {
    await withScratchDb(async (name) => {
      let tenantA = "";
      let tenantB = "";
      await withDb(databaseUrl(name), async (db) => {
        await db.connection().execute((conn) => runMigrationChain(conn));
        tenantA = await createTenant(db, "grants-a");
        tenantB = await createTenant(db, "grants-b");
      });
      await withDb(databaseUrl(name, true), async (db) => {
        const session = issuer(tenantA);
        const subject = { entity: SUBJECT_ENTITY, id: randomUUID() };
        const recipient = { kind: "email", address: "recipient@example.test" };
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
        const issue = (input: Partial<Parameters<typeof issueCapabilityGrantInTransaction>[2]> = {}, now?: Date) =>
          withDbSession(db, session, (trx) =>
            issueCapabilityGrantInTransaction(trx, session, {
              operations: [...OPERATIONS],
              subject,
              recipient,
              expiresAt,
              ...input,
            }, { capabilityOperations: OPERATIONS, ...(now ? { now } : {}) }));

        // Validation happens before any row is written.
        await expect(issue({ operations: ["demo.other"] })).rejects.toThrow(/not an auth.mode: capability/);
        await expect(issue({ expiresAt: new Date(Date.now() - 1000) })).rejects.toThrow(/expire in the future/);
        await expect(issue({ recipient: { address: "x" } as never })).rejects.toThrow(/non-empty kind/);
        await expect(issue({ maxUses: 0 })).rejects.toThrow(/positive integer/);

        // A reusable grant resolves repeatedly and counts every use.
        const reusable = await issue();
        expect(parseGrantToken(reusable.token)?.id).toBe(reusable.id);
        const grantSession = await resolveCapabilityGrantSession(db, reusable.token, { key: "demo.envelope.read" });
        expect(grantSession.credential).toBe("grant");
        expect(grantSession.tenantId).toBe(tenantA);
        expect(grantSession.userId).toBe(reusable.id);
        expect(grantSession.roles).toEqual([]);
        expect(grantSession.grant).toMatchObject({ id: reusable.id, subject, recipient, operations: [...OPERATIONS] });
        for (const uses of [1, 2]) {
          const used = await withDbSession(db, grantSession, (trx) =>
            consumeCapabilityGrantInTransaction(trx, grantSession, "demo.envelope.read"));
          expect(used).toEqual({ uses, consumed: false });
        }
        await resolveCapabilityGrantSession(db, reusable.token, { key: "demo.envelope.sign" });

        // Scope: an Operation outside the list, or another entity than the subject's.
        expect(await refusal(resolveCapabilityGrantSession(db, reusable.token, { key: "demo.envelope.delete" })))
          .toEqual({ status: 403, code: "GRANT_SCOPE" });
        expect(await refusal(resolveCapabilityGrantSession(db, reusable.token, {
          key: "demo.envelope.read", target: { entityName: "Quote" },
        }))).toEqual({ status: 403, code: "GRANT_SCOPE" });

        // Unknown ids and malformed tokens are one indistinguishable refusal.
        expect(await refusal(resolveCapabilityGrantSession(db, undefined, { key: "demo.envelope.read" })))
          .toEqual({ status: 401, code: "GRANT_INVALID" });
        expect(await refusal(resolveCapabilityGrantSession(db, "garbage", { key: "demo.envelope.read" })))
          .toEqual({ status: 401, code: "GRANT_INVALID" });
        expect(await refusal(resolveCapabilityGrantSession(
          db, renderGrantToken(randomUUID(), parseGrantToken(reusable.token)!.secret), { key: "demo.envelope.read" },
        ))).toEqual({ status: 401, code: "GRANT_INVALID" });

        // Wrong secrets count; the limit locks; the lock refuses even the right secret.
        const wrong = renderGrantToken(reusable.id, parseGrantToken(reusable.token)!.secret.replace(/^./, (c) => c === "A" ? "B" : "A"));
        const policy = CAPABILITY_GRANT_ATTEMPT_POLICY;
        for (let attempt = 1; attempt < policy.maxFailedAttempts; attempt += 1) {
          expect(await refusal(resolveCapabilityGrantSession(db, wrong, { key: "demo.envelope.read" })))
            .toEqual({ status: 401, code: "GRANT_INVALID" });
        }
        expect(await refusal(resolveCapabilityGrantSession(db, wrong, { key: "demo.envelope.read" })))
          .toEqual({ status: 423, code: "GRANT_LOCKED" });
        expect(await refusal(resolveCapabilityGrantSession(db, reusable.token, { key: "demo.envelope.read" })))
          .toEqual({ status: 423, code: "GRANT_LOCKED" });
        const afterLock = new Date(Date.now() + policy.lockMs + 1000);
        expect(await refusal(resolveCapabilityGrantSession(db, wrong, { key: "demo.envelope.read" }, afterLock)))
          .toEqual({ status: 401, code: "GRANT_INVALID" });
        // The lock expired and the window with it: that failure started a new window.
        await resolveCapabilityGrantSession(db, reusable.token, { key: "demo.envelope.read" }, afterLock);
        const listed = await withDbSession(db, session, (trx) => listCapabilityGrantsInTransaction(trx, subject));
        expect(listed.find((grant) => grant.id === reusable.id)).toMatchObject({ status: "active", uses: 2, lockedUntil: null });
        expect(JSON.stringify(listed)).not.toContain("token");
        expect(await events(db, session, reusable.id)).toEqual([
          "capability_grant_issued", "capability_grant_used", "capability_grant_used", "capability_grant_locked",
        ]);

        // A single-use grant is consumed exactly once, inside the transaction:
        // a rolled-back handler leaves it usable.
        const single = await issue({ maxUses: 1 });
        const singleSession = await resolveCapabilityGrantSession(db, single.token, { key: "demo.envelope.sign" });
        await expect(withDbSession(db, singleSession, async (trx) => {
          await consumeCapabilityGrantInTransaction(trx, singleSession, "demo.envelope.sign");
          throw new Error("handler failed");
        })).rejects.toThrow("handler failed");
        expect(await withDbSession(db, singleSession, (trx) =>
          consumeCapabilityGrantInTransaction(trx, singleSession, "demo.envelope.sign"))).toEqual({ uses: 1, consumed: true });
        expect(await refusal(withDbSession(db, singleSession, (trx) =>
          consumeCapabilityGrantInTransaction(trx, singleSession, "demo.envelope.sign"))))
          .toEqual({ status: 409, code: "GRANT_CONSUMED" });
        expect(await refusal(resolveCapabilityGrantSession(db, single.token, { key: "demo.envelope.sign" })))
          .toEqual({ status: 409, code: "GRANT_CONSUMED" });

        // Expiry is checked against the clock, resolution and consumption alike.
        const shortLived = await issue({ expiresAt: new Date(Date.now() + 5 * 60 * 1000) });
        const later = new Date(Date.now() + 6 * 60 * 1000);
        expect(await refusal(resolveCapabilityGrantSession(db, shortLived.token, { key: "demo.envelope.read" }, later)))
          .toEqual({ status: 410, code: "GRANT_EXPIRED" });
        const shortSession = await resolveCapabilityGrantSession(db, shortLived.token, { key: "demo.envelope.read" });
        expect(await refusal(withDbSession(db, shortSession, (trx) =>
          consumeCapabilityGrantInTransaction(trx, shortSession, "demo.envelope.read", later))))
          .toEqual({ status: 410, code: "GRANT_EXPIRED" });

        // Superseding revokes the earlier active grant for the same subject and recipient only.
        const otherRecipient = await issue({ recipient: { kind: "email", address: "other@example.test" } });
        const replacement = await issue({ supersede: "same-subject-and-recipient" });
        const bySupersede = await withDbSession(db, session, (trx) => listCapabilityGrantsInTransaction(trx, subject));
        const summary = (id: string) => bySupersede.find((grant) => grant.id === id)!;
        expect(summary(reusable.id)).toMatchObject({ status: "revoked", revokedReason: "superseded", supersededBy: replacement.id });
        expect(summary(shortLived.id)).toMatchObject({ status: "revoked", supersededBy: replacement.id });
        expect(summary(single.id)).toMatchObject({ status: "consumed", revokedAt: null });
        expect(summary(otherRecipient.id)).toMatchObject({ status: "active" });
        expect(summary(replacement.id)).toMatchObject({ status: "active" });
        expect(await refusal(resolveCapabilityGrantSession(db, reusable.token, { key: "demo.envelope.read" })))
          .toEqual({ status: 410, code: "GRANT_REVOKED" });
        await resolveCapabilityGrantSession(db, replacement.token, { key: "demo.envelope.read" });

        // Explicit revocation is idempotent and audited once per real change.
        const revoked = await withDbSession(db, session, (trx) =>
          revokeCapabilityGrantInTransaction(trx, { id: replacement.id, reason: "Customer asked" }));
        expect(revoked).toMatchObject({ status: "revoked", revokedReason: "Customer asked" });
        const again = await withDbSession(db, session, (trx) =>
          revokeCapabilityGrantInTransaction(trx, { id: replacement.id, reason: "Twice" }));
        expect(again).toMatchObject({ status: "revoked", revokedReason: "Customer asked" });
        expect(await withDbSession(db, session, (trx) =>
          revokeCapabilityGrantInTransaction(trx, { id: randomUUID() }))).toBeUndefined();
        expect(await events(db, session, replacement.id)).toEqual(["capability_grant_issued", "capability_grant_revoked"]);

        // The tenant fence: another tenant sees nothing and revokes nothing.
        const strangerSession = issuer(tenantB);
        expect(await withDbSession(db, strangerSession, (trx) => listCapabilityGrantsInTransaction(trx, subject))).toEqual([]);
        expect(await withDbSession(db, strangerSession, (trx) =>
          revokeCapabilityGrantInTransaction(trx, { id: otherRecipient.id }))).toBeUndefined();
        // The token still resolves in its own tenant: the lookup function
        // answers the tenant, the session is fenced to it.
        expect((await resolveCapabilityGrantSession(db, otherRecipient.token, { key: "demo.envelope.read" })).tenantId).toBe(tenantA);

        // Purge removes only what has been dead for the retention window.
        const now = new Date();
        expect(await purgeCapabilityGrants(db, session, { retainDays: 30, now })).toBe(0);
        const farFuture = new Date(now.getTime() + 31 * 24 * 60 * 60 * 1000);
        const purged = await purgeCapabilityGrants(db, session, { retainDays: 30, now: farFuture });
        expect(purged).toBe(5);
        const remaining = await withDbSession(db, session, (trx) => listCapabilityGrantsInTransaction(trx, subject, farFuture));
        expect(remaining).toEqual([]);
      });
    });
  }, TEST_TIMEOUT);
});
