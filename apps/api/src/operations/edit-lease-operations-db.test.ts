// SPDX-License-Identifier: BUSL-1.1
/**
 * The canonical edit-lease Operations against PostgreSQL, on a scratch
 * database built from the bundled manifest and driven through the restricted
 * app role: a caller takes the lease its Operation requires and learns the
 * record version it was taken at, keeps it alive, and gives it back. The
 * lease belongs to the tenant AND the subject that took it, so a second
 * subject is refused the record, cannot renew the token it did not mint and
 * cannot release it — and neither can another tenant. The Operation named is
 * authorized on its own terms; it never widens what the caller may do.
 *
 * And what the token is for: the ordinary protected entity update takes it with
 * the record version the lease was taken at, consumes it, and refuses a token
 * that a second acquire replaced or that a write already spent.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import { operationErrorOf } from "@openshapeforge/operations";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import { createDatabaseRuntime, type DatabaseRuntime } from "../db/connection.js";
import { runMigrationChain } from "../db/migration-chain.js";
import { APP_ROLE, DEV_APP_ROLE_PASSWORD_DEFAULT } from "../db/migrations/app-role.js";
import { normalizeTimestampToken } from "../db/timestamps.js";
import type { ModuleOperationContext } from "../modules/contract.js";
import { editLeaseOperationHandler } from "./edit-lease-operations.js";
import { executeEntityOperation, getEntityOperationContracts } from "./entity/index.js";

const ADMIN_URL = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const scratchName = `edit_leases_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const update = getEntityOperationContracts().find(({ id }) => id === "Relation.update")!;
const EDITOR = [update.authorization.roles[0]!];
let admin: SQL, privileged: DatabaseRuntime, restricted: DatabaseRuntime;

function scratchUrl(role?: { username: string; password: string }): string {
  const url = new URL(ADMIN_URL);
  if (url.pathname === "/openshapeforge_dev" || url.pathname === "/hubble_dev") throw new Error("admin URL must not point at an application database");
  if (role) { url.username = role.username; url.password = role.password; }
  url.pathname = `/${scratchName}`;
  return url.toString();
}

const sessionFor = (tenantId: string, roles = EDITOR, userId = randomUUID()) =>
  ({
    tenantId, userId, roles, groups: [], scope: "tenant", credential: "bearer",
    userDisplayName: "Lease holder",
  }) as unknown as TrustedSessionContext;

async function run(handler: string, input: Record<string, unknown>, session: TrustedSessionContext): Promise<any> {
  const context = { db: restricted.db, session, transport: "operation" } as unknown as ModuleOperationContext;
  const result = await editLeaseOperationHandler({ key: handler, handler })(input, context);
  return (result as { value: unknown }).value;
}

async function refusalOf(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (error) {
    const failure = operationErrorOf(error);
    if (failure) return failure.code;
    throw error;
  }
  throw new Error("Expected the Operation to refuse.");
}

async function tenant(): Promise<string> {
  const id = randomUUID();
  await sql`insert into platform.tenants (id, slug, name, status) values (${id}::uuid, ${`lease-${id.slice(0, 8)}`}, 'Lease tenant', 'active')`.execute(privileged.db);
  return id;
}

async function relation(tenantId: string, displayName = "Lease target"): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into erp.relations (id, tenant_id, display_name, relation_type, status)
    values (${id}::uuid, ${tenantId}::uuid, ${displayName}, 'person', 'active')
  `.execute(privileged.db);
  return id;
}

async function leaseCount(tenantId: string): Promise<number> {
  const result = await sql<{ count: number }>`
    select count(*)::int as count from platform.entity_edit_leases where tenant_id = ${tenantId}::uuid
  `.execute(privileged.db);
  return result.rows[0]!.count;
}

/**
 * The protected write itself, exactly as an interface adapter sends it: the
 * record's own version and the lease token the acquire returned, through the
 * same generic entity path REST, MCP and Web use.
 */
async function updateDisplayName(
  session: TrustedSessionContext,
  targetId: string,
  lease: { leaseToken: string; targetVersion: string },
  displayName: string,
): Promise<any> {
  return executeEntityOperation(restricted.db, session, {
    operation: { id: update.id, intent: update.intent },
    input: {
      id: targetId,
      values: { displayName },
      expectedVersion: lease.targetVersion,
      leaseToken: lease.leaseToken,
    },
  });
}

async function storedVersion(targetId: string): Promise<string> {
  const result = await sql<{ version: string }>`
    select updated_at::text as version from erp.relations where id = ${targetId}::uuid
  `.execute(privileged.db);
  return normalizeTimestampToken(result.rows[0]!.version);
}

describe("canonical edit-lease Operations", () => {
  beforeAll(async () => {
    admin = new SQL(ADMIN_URL, { max: 1 });
    await admin.unsafe(`create database "${scratchName}"`);
    privileged = createDatabaseRuntime({ databaseUrl: scratchUrl(), maxConnections: 2 });
    await privileged.db.connection().execute((conn) => runMigrationChain(conn));
    restricted = createDatabaseRuntime({
      databaseUrl: scratchUrl({ username: APP_ROLE, password: process.env.OPENSHAPEFORGE_APP_PASSWORD ?? DEV_APP_ROLE_PASSWORD_DEFAULT }),
      maxConnections: 4,
    });
  }, 120_000);

  afterAll(async () => {
    await restricted?.close();
    await privileged?.close();
    await admin?.unsafe(`drop database if exists "${scratchName}" with (force)`);
    await admin?.close();
  });

  test("takes a lease with the record's own version, keeps it alive and gives it back", async () => {
    const tenantId = await tenant(), session = sessionFor(tenantId);
    const targetId = await relation(tenantId);
    const lease = await run("acquireEditLease", { operationId: update.id, targetId }, session);
    expect(lease).toMatchObject({ operationId: update.id, entityId: update.entityId, targetId });
    expect(lease.targetVersion).toBe(await storedVersion(targetId));
    expect(lease.leaseToken).toMatch(/^[\w-]{20,}$/);
    expect(Date.parse(lease.expiresAt)).toBeGreaterThan(Date.now());

    const renewed = await run("renewEditLease", { leaseToken: lease.leaseToken }, session);
    expect(renewed).toMatchObject({
      operationId: update.id, entityId: update.entityId, targetId, targetVersion: lease.targetVersion,
    });
    expect("leaseToken" in renewed).toBe(false);
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThanOrEqual(Date.parse(lease.expiresAt));

    expect(await run("releaseEditLease", { leaseToken: lease.leaseToken }, session)).toEqual({ released: true });
    expect(await leaseCount(tenantId)).toBe(0);
    // Giving back a lease that is already gone is done, not an error.
    expect(await run("releaseEditLease", { leaseToken: lease.leaseToken }, session)).toEqual({ released: false });
    expect(await refusalOf(run("renewEditLease", { leaseToken: lease.leaseToken }, session))).toBe("LEASE_EXPIRED");
  });

  test("another subject of the same tenant controls neither the record nor the token", async () => {
    const tenantId = await tenant(), holder = sessionFor(tenantId), other = sessionFor(tenantId);
    const targetId = await relation(tenantId);
    const lease = await run("acquireEditLease", { operationId: update.id, targetId }, holder);

    expect(await refusalOf(run("acquireEditLease", { operationId: update.id, targetId }, other))).toBe("LOCKED");
    expect(await refusalOf(run("renewEditLease", { leaseToken: lease.leaseToken }, other))).toBe("LEASE_EXPIRED");
    expect(await run("releaseEditLease", { leaseToken: lease.leaseToken }, other)).toEqual({ released: false });
    // The holder still holds it, and still reads the version it took it at.
    expect(await run("renewEditLease", { leaseToken: lease.leaseToken }, holder))
      .toMatchObject({ targetId, targetVersion: lease.targetVersion });
    expect(await leaseCount(tenantId)).toBe(1);
  });

  test("another tenant reaches neither the token nor the record", async () => {
    const tenantId = await tenant(), holder = sessionFor(tenantId);
    const targetId = await relation(tenantId);
    const lease = await run("acquireEditLease", { operationId: update.id, targetId }, holder);

    const foreignTenantId = await tenant(), foreign = sessionFor(foreignTenantId);
    expect(await refusalOf(run("renewEditLease", { leaseToken: lease.leaseToken }, foreign))).toBe("LEASE_EXPIRED");
    expect(await run("releaseEditLease", { leaseToken: lease.leaseToken }, foreign)).toEqual({ released: false });
    expect(await refusalOf(run("acquireEditLease", { operationId: update.id, targetId }, foreign))).toBe("NOT_FOUND");
    expect(await leaseCount(foreignTenantId)).toBe(0);
    expect(await leaseCount(tenantId)).toBe(1);
  });

  test("the protected update spends the live token; a replaced or spent one is refused", async () => {
    const tenantId = await tenant(), session = sessionFor(tenantId);
    const targetId = await relation(tenantId);
    const first = await run("acquireEditLease", { operationId: update.id, targetId }, session);
    // Taking the same lease again is not the same call twice. The holder keeps
    // the record, but a fresh token replaces the stored hash, so the token the
    // first call returned is dead — which is why acquire claims no idempotency.
    const second = await run("acquireEditLease", { operationId: update.id, targetId }, session);
    expect(second.leaseToken).not.toBe(first.leaseToken);
    expect(second.targetVersion).toBe(first.targetVersion);
    expect(await leaseCount(tenantId)).toBe(1);
    expect(await refusalOf(run("renewEditLease", { leaseToken: first.leaseToken }, session)))
      .toBe("LEASE_EXPIRED");
    const retired = await updateDisplayName(session, targetId, first, "Written with a retired token");
    expect(retired.error?.code).toBe("LEASE_INVALID");
    expect(await storedVersion(targetId)).toBe(first.targetVersion);

    // The live token does protect the real write, and the write spends it.
    const written = await updateDisplayName(session, targetId, second, "Written by the lease holder");
    expect(written.error).toBeUndefined();
    expect(written.data).toMatchObject({ display_name: "Written by the lease holder" });
    expect(await leaseCount(tenantId)).toBe(0);
    // Replayed against the record as it now stands, so the refusal is the spent
    // lease and not the stale version.
    const replay = await updateDisplayName(
      session,
      targetId,
      { ...second, targetVersion: await storedVersion(targetId) },
      "Written twice",
    );
    expect(replay.error?.code).toBe("LEASE_INVALID");
    expect(await storedVersion(targetId)).not.toBe(first.targetVersion);
  });

  test("the Operation named decides, and an unknown record is not disclosed", async () => {
    const tenantId = await tenant();
    const targetId = await relation(tenantId);
    expect(await refusalOf(run(
      "acquireEditLease",
      { operationId: update.id, targetId },
      sessionFor(tenantId, ["Relations.All.Read"]),
    ))).toBe("FORBIDDEN");
    expect(await refusalOf(run(
      "acquireEditLease",
      { operationId: update.id, targetId: randomUUID() },
      sessionFor(tenantId),
    ))).toBe("NOT_FOUND");
    expect(await leaseCount(tenantId)).toBe(0);
  });
});
