// SPDX-License-Identifier: BUSL-1.1
/**
 * Member and invitation administration must not hold `for update` on the
 * tenant row: that lock conflicts with the `for key share` every
 * tenant-scoped foreign-key insert takes, so the tenant's sign-ins, receipts
 * and jobs would wait for the Keycloak calls made under it. Real Kysely
 * compilation and transactions over a fake connection that records the SQL.
 */
import { describe, expect, test } from "bun:test";
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type QueryResult,
} from "kysely";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import type { KeycloakTenantMemberAdminClient } from "../keycloak-organization-members-types.js";
import type { PlatformAdministrator } from "../platform-admin.js";
import {
  changeTenantMemberRoles,
  getTenantCredential,
  getTenantMember,
  listTenantCredentials,
  listTenantMembers,
  removeTenantMembership,
} from "../tenant-member-admin.js";
import { manageTenantInvitations } from "../tenant-invitations.js";

const TENANT = { id: "11111111-1111-4111-8111-111111111111", slug: "acme", status: "active",
  keycloak_realm: "tenants", keycloak_organization_id: "org-1" };
const administrator: PlatformAdministrator = {
  subject: "operator", issuer: "https://identity.example.test/realms/control", username: "operator",
  name: null, email: null, authorizedParty: "platform-mcp", expiresAtMs: null,
};

function recordingDatabase() {
  const queries: string[] = [];
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      queries.push(query.sql);
      return { rows: (/from platform\.tenants/.test(query.sql) ? [TENANT] : []) as R[] };
    },
    async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> { throw new Error("Unexpected stream"); },
  };
  const db = new Kysely({ dialect: {
    createAdapter: () => new PostgresAdapter(),
    createIntrospector: (database) => new PostgresIntrospector(database),
    createQueryCompiler: () => new PostgresQueryCompiler(),
    createDriver: () => ({
      async init() {}, async acquireConnection() { return connection; },
      async beginTransaction() {}, async commitTransaction() {}, async rollbackTransaction() {},
      async releaseConnection() {}, async destroy() {},
    }),
  } }) as unknown as OpenShapeForgeDatabase;
  const tenantLock = () => {
    const select = queries.find((sql) => /from platform\.tenants/.test(sql));
    expect(select).toBeDefined();
    return /for (no key )?update/.exec(select!)?.[0] ?? null;
  };
  return { db, queries, tenantLock };
}

const member = (memberId: string) => ({ memberId, username: memberId, email: `${memberId}@example.test`,
  firstName: null, lastName: null, enabled: true, emailVerified: true });

function membersClient(count = 1) {
  const state = { inFlight: 0, maxInFlight: 0, calls: 0 };
  const client = {
    async listMembers() { return Array.from({ length: count }, (_, index) => member(`m${index}`)); },
    async getMember(_organizationId: string, userId: string) { return member(userId); },
    async listCredentials() {
      state.calls++;
      state.inFlight++;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      state.inFlight--;
      return [{ credentialId: "c1", type: "password", label: null, createdAt: null }];
    },
    async removeMember() { return true; },
  } as unknown as KeycloakTenantMemberAdminClient;
  return { client, state };
}

describe("tenant member administration", () => {
  test("reads take no row lock on the tenant", async () => {
    for (const read of [
      (deps: Parameters<typeof listTenantMembers>[0]) => listTenantMembers(deps, "acme"),
      (deps: Parameters<typeof listTenantMembers>[0]) => getTenantMember(deps, "acme", "m0"),
      (deps: Parameters<typeof listTenantMembers>[0]) => listTenantCredentials(deps, "acme", "m0"),
      (deps: Parameters<typeof listTenantMembers>[0]) => getTenantCredential(deps, "acme", "m0", "c1"),
    ]) {
      const { db, tenantLock } = recordingDatabase();
      await read({ db, administrator, members: membersClient().client });
      expect(tenantLock()).toBeNull();
    }
  });

  test("writes serialise with for no key update, never for update", async () => {
    const remove = recordingDatabase();
    await removeTenantMembership({ db: remove.db, administrator, members: membersClient().client }, "acme", "m0");
    expect(remove.tenantLock()).toBe("for no key update");

    const roles = recordingDatabase();
    await expect(changeTenantMemberRoles({ db: roles.db, administrator, members: membersClient().client },
      "acme", "m0", ["org_employee"], "assign")).rejects.toMatchObject({ code: "MEMBER_NOT_SIGNED_IN" });
    expect(roles.tenantLock()).toBe("for no key update");
  });

  test("listing a large tenant keeps at most 8 credential reads in flight and keeps member order", async () => {
    const { db } = recordingDatabase();
    const { client, state } = membersClient(50);
    const listed = await listTenantMembers({ db, administrator, members: client }, "acme");
    expect(state.calls).toBe(50);
    expect(state.maxInFlight).toBe(8);
    expect(listed.members.map((row) => row.memberId)).toEqual(Array.from({ length: 50 }, (_, index) => `m${index}`));
    expect(listed.members[0]).toMatchObject({ credentialCount: 1, credentialTypes: ["password"] });
  });
});

describe("tenant invitation administration", () => {
  const clients = () => ({
    tenantRealm: TENANT.keycloak_realm,
    organizations: { async getOrganization() { return { id: "org-1", alias: "acme", enabled: true }; } },
    members: {
      async listInvitations() { return [{ id: "inv-1", email: "a@example.test", firstName: null, lastName: null,
        status: "PENDING", sentDate: null, expiresAt: null }]; },
      async listMembers() { return []; },
      async hasMemberByEmail() { return true; },
    },
  }) as never;

  test("list and get take no lock; create serialises with for no key update", async () => {
    for (const [action, input] of [["list", {}], ["get", { invitationId: "inv-1" }]] as const) {
      const { db, tenantLock } = recordingDatabase();
      await manageTenantInvitations({ db, administrator, firstAdministrator: clients() }, action, { slug: "acme", ...input });
      expect(tenantLock()).toBeNull();
    }
    // The fake database returns no row for the invitation insert, which the create reports as a conflict.
    const create = recordingDatabase();
    await expect(manageTenantInvitations({ db: create.db, administrator, firstAdministrator: clients() }, "create",
      { slug: "acme", email: "b@example.test", role: "org_employee" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(create.tenantLock()).toBe("for no key update");
  });
});
