// SPDX-License-Identifier: BUSL-1.1
/**
 * Inviting an employee, end to end against a migrated scratch database and
 * the restricted app role (so RLS is what it is in production): the admin
 * gate, the Keycloak call shape (a fake client — no network in this test),
 * listing, revoking, re-inviting after revoke, and tenant isolation.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Kysely } from "kysely";
import type { DB } from "../../generated/db/types.js";
import { createDatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import { APP_ROLE } from "../migrations/app-role.js";
import {
  inviteEmployee,
  listInvitations,
  revokeInvitation,
} from "../../auth/employee-invitations.js";
import type { KeycloakOrganizationMembersClient } from "../../control/keycloak-organization-members.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const APP_ROLE_PASSWORD = "openshapeforge_app";
const TEST_TIMEOUT = 120_000;
const ADMIN_ROLES = ["Organization.All.ReadWrite"];

function databaseUrl(name: string, app = false): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  if (app) {
    url.username = APP_ROLE;
    url.password = APP_ROLE_PASSWORD;
  }
  return url.toString();
}

async function withDb<T>(url: string, fn: (db: Kysely<DB>) => Promise<T>) {
  const runtime = createDatabaseRuntime({ databaseUrl: url, maxConnections: 4 });
  try {
    return await fn(runtime.db);
  } finally {
    await runtime.close();
  }
}

async function withScratchDb<T>(
  fn: (appDb: Kysely<DB>, adminDb: Kysely<DB>) => Promise<T>,
) {
  const name = `employee_invitations_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const server = new SQL(ADMIN_URL, { max: 1 });
  try {
    await server.unsafe(`create database "${name}"`);
    try {
      return await withDb(databaseUrl(name), async (adminDb) => {
        await adminDb.connection().execute((trx) => runMigrationChain(trx));
        return withDb(databaseUrl(name, true), (appDb) => fn(appDb, adminDb));
      });
    } finally {
      await server.unsafe(`drop database if exists "${name}" with (force)`);
    }
  } finally {
    await server.close();
  }
}

const tenantA = randomUUID();
const tenantB = randomUUID();

async function seedTenants(adminDb: Kysely<DB>) {
  await sql`
    insert into platform.tenants (id, slug, name, status, keycloak_organization_id, keycloak_realm)
    values (${tenantA}, 'tenant-a', 'Tenant A', 'active', 'kc-org-a', 'openshapeforge'),
           (${tenantB}, 'tenant-b', 'Tenant B', 'active', 'kc-org-b', 'openshapeforge')
  `.execute(adminDb);
}

function sessionFor(tenantId: string, roles: string[]) {
  return { tenantId, userId: randomUUID(), roles, groups: [], scope: "self" as const };
}

/** A fake Keycloak client recording every invite call; never touches a network. */
function fakeKeycloak(): KeycloakOrganizationMembersClient & {
  calls: Array<{ organizationId: string; email: string }>;
} {
  const calls: Array<{ organizationId: string; email: string }> = [];
  return {
    calls,
    async inviteUser(organizationId, input) {
      calls.push({ organizationId, email: input.email });
    },
  };
}

describe("employee invitations", () => {
  test(
    "an administrator invites, lists, and revokes; a non-administrator is refused",
    async () => {
      await withScratchDb(async (appDb, adminDb) => {
        await seedTenants(adminDb);
        const admin = sessionFor(tenantA, ADMIN_ROLES);
        const employee = sessionFor(tenantA, ["org_employee"]);
        const keycloak = fakeKeycloak();

        await expect(
          inviteEmployee(appDb, employee, keycloak, {
            email: "colleague@example.com",
            role: "org_employee",
          }),
        ).rejects.toMatchObject({ status: 403 });
        expect(keycloak.calls).toEqual([]);

        const invitation = await inviteEmployee(appDb, admin, keycloak, {
          email: "Colleague@Example.com",
          firstName: "New",
          lastName: "Colleague",
          role: "org_employee",
        });
        expect(invitation).toMatchObject({
          email: "Colleague@Example.com",
          role: "org_employee",
          status: "pending",
        });
        // Keycloak was actually called, with this tenant's Organization id.
        expect(keycloak.calls).toEqual([
          { organizationId: "kc-org-a", email: "Colleague@Example.com" },
        ]);

        const listed = await listInvitations(appDb, admin);
        expect(listed).toHaveLength(1);
        expect(listed[0]!.email).toBe("Colleague@Example.com");

        await expect(listInvitations(appDb, employee)).rejects.toMatchObject({ status: 403 });

        const revoked = await revokeInvitation(appDb, admin, { email: "colleague@example.com" });
        expect(revoked.status).toBe("revoked");
        expect(await listInvitations(appDb, admin)).toEqual([]);

        // Revoking again finds nothing pending.
        await expect(
          revokeInvitation(appDb, admin, { email: "colleague@example.com" }),
        ).rejects.toMatchObject({ status: 404 });

        // Re-inviting the same address after a revoke is allowed (the partial
        // unique index only covers status = 'pending').
        const second = await inviteEmployee(appDb, admin, keycloak, {
          email: "colleague@example.com",
          role: "org_admin",
        });
        expect(second.role).toBe("org_admin");
        expect(await listInvitations(appDb, admin)).toHaveLength(1);
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "invitations are tenant-isolated",
    async () => {
      await withScratchDb(async (appDb, adminDb) => {
        await seedTenants(adminDb);
        const keycloak = fakeKeycloak();
        await inviteEmployee(appDb, sessionFor(tenantA, ADMIN_ROLES), keycloak, {
          email: "a-only@example.com",
          role: "org_employee",
        });

        const seenFromB = await listInvitations(appDb, sessionFor(tenantB, ADMIN_ROLES));
        expect(seenFromB).toEqual([]);

        await expect(
          revokeInvitation(appDb, sessionFor(tenantB, ADMIN_ROLES), { email: "a-only@example.com" }),
        ).rejects.toMatchObject({ status: 404 });
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "inviting fails cleanly when the tenant has no linked Keycloak Organization",
    async () => {
      await withScratchDb(async (appDb, adminDb) => {
        const unprovisioned = randomUUID();
        await sql`
          insert into platform.tenants (id, slug, name, status)
          values (${unprovisioned}, 'unprovisioned', 'Unprovisioned', 'active')
        `.execute(adminDb);
        const keycloak = fakeKeycloak();
        await expect(
          inviteEmployee(appDb, sessionFor(unprovisioned, ADMIN_ROLES), keycloak, {
            email: "x@example.com",
            role: "org_employee",
          }),
        ).rejects.toMatchObject({ status: 409 });
        expect(keycloak.calls).toEqual([]);
      });
    },
    TEST_TIMEOUT,
  );
});
