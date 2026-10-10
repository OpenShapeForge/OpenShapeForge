// SPDX-License-Identifier: BUSL-1.1
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler,
  type CompiledQuery, type DatabaseConnection, type QueryResult } from "kysely";
import type { DB } from "../generated/db/types.js";
import { KeycloakAdminError } from "../control/keycloak-organization-admin.js";
import type { KeycloakOrganizationMembersClient } from "../control/keycloak-organization-members.js";
import {
  EMPLOYEE_INVITATION_ADMIN_ROLE, employeeInvitationRoleGrants, inviteEmployee, revokeInvitation,
} from "./employee-invitations.js";
import identity from '../generated/compiler/identity.json' with { type: 'json' };

describe("employeeInvitationRoleGrants", () => {
  test("records the persona name beside the OSF authorization baseline", () => {
    expect(employeeInvitationRoleGrants("org_admin", {})).toEqual([
      "org_admin",
      identity.administratorRole,
    ]);
    expect(employeeInvitationRoleGrants("org_employee", {})).toEqual([
      "org_employee",
      ...identity.memberRoles,
    ]);
  });

  test("a host persona under the canonical name adds nothing twice; another name is added", () => {
    expect(
      employeeInvitationRoleGrants("org_admin", { OPENSHAPEFORGE_ORG_ADMIN_CLIENT_ROLE: "org_admin" }),
    ).toEqual(["org_admin", identity.administratorRole]);
    expect(
      employeeInvitationRoleGrants("org_employee", {
        OPENSHAPEFORGE_ORG_EMPLOYEE_CLIENT_ROLE: "example_employee",
      }),
    ).toEqual(["org_employee", ...identity.memberRoles, "example_employee"]);
  });
});

 test("an invitation without a direct role grants no implicit employee role", () => {
  expect(employeeInvitationRoleGrants(null)).toEqual([]);
});

describe("invitation log lines", () => {
  const TENANT = "11111111-1111-4111-8111-111111111111";
  const ADDRESS = "invitee.private@example.test";
  const session = { tenantId: TENANT, userId: "22222222-2222-4222-8222-222222222222", roles: [EMPLOYEE_INVITATION_ADMIN_ROLE] };
  const row = {
    id: "33333333-3333-4333-8333-333333333333", email: ADDRESS, role: null, first_name: null, last_name: null,
    status: "pending", invited_by: session.userId, invited_at: new Date(0).toISOString(), revoked_at: null,
  };
  const jobs: (readonly unknown[])[] = [];
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      if (query.sql.includes("from platform.tenants")) return { rows: [{ keycloak_organization_id: "org-1", keycloak_realm: "realm", slug: "acme", name: "Acme" }] as R[] };
      if (query.sql.includes("\"platform\".\"jobs\"")) { jobs.push(query.parameters); return { rows: [{ id: "job-1", status: "pending" }] as R[] }; }
      if (query.sql.includes("platform.employee_invitations")) return { rows: [row] as R[] };
      return { rows: [] };
    },
    async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> { throw new Error("Unexpected stream"); },
  };
  const db = new Kysely<DB>({ dialect: {
    createAdapter: () => new PostgresAdapter(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
    createDriver: () => ({
      async init() {}, async acquireConnection() { return connection; },
      async beginTransaction() {}, async commitTransaction() {}, async rollbackTransaction() {},
      async releaseConnection() {}, async destroy() {},
    }),
  } });
  const keycloak = (fail: boolean) => ({
    async hasMemberByEmail() { if (fail) throw new KeycloakAdminError("KEYCLOAK_ADMIN_UNAVAILABLE", "down", 503); return true; },
    async findPendingInvitationByEmail() { return { id: "kc-invitation" }; },
    async deleteInvitation() { return true; },
  }) as unknown as KeycloakOrganizationMembersClient;

  let logged: string[] = [];
  const spies: { mockRestore(): void }[] = [];
  beforeEach(() => {
    logged = [];
    for (const level of ["info", "warn"] as const) {
      spies.push(spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(" ")); }));
    }
  });
  afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });

  test("an admission, a Keycloak failure and a revocation are logged by id, never by address", async () => {
    await expect(inviteEmployee(db, session, keycloak(false), { email: ADDRESS })).resolves.toMatchObject({ id: row.id, email: ADDRESS });
    await expect(inviteEmployee(db, session, keycloak(true), { email: ADDRESS })).rejects.toBeDefined();
    await expect(revokeInvitation(db, session, keycloak(false), { email: ADDRESS })).resolves.toMatchObject({ id: row.id });
    expect(logged.some((line) => line.includes('"admission_recorded"') && line.includes(row.id))).toBe(true);
    expect(logged.some((line) => line.includes('"keycloak_failed"'))).toBe(true);
    expect(logged.some((line) => line.includes(`revoked invitation ${row.id}`))).toBe(true);
    expect(logged.filter((line) => line.includes(ADDRESS))).toEqual([]);
  });

  test("an existing member is mailed an organization invitation; a failed mail keeps the admission", async () => {
    const calls: string[] = [];
    const notifying = (fail: boolean) => ({ ...keycloak(false),
      async inviteExistingMember(organizationId: string, email: string) { calls.push(`${organizationId} ${email}`); if (fail) throw new KeycloakAdminError("KEYCLOAK_ADMIN_UNAVAILABLE", "smtp", 500); return true; },
    }) as unknown as KeycloakOrganizationMembersClient;
    await expect(inviteEmployee(db, session, notifying(false), { email: ADDRESS, role: "org_employee" }))
      .resolves.toMatchObject({ delivery: "not_required", accessNotice: "sent" });
    expect(calls).toEqual([`org-1 ${ADDRESS}`]);
    await expect(inviteEmployee(db, session, notifying(true), { email: ADDRESS, role: "org_employee" }))
      .resolves.toMatchObject({ delivery: "not_required", accessNotice: "failed" });
    expect(logged.some((line) => line.includes('"access_notice_failed"'))).toBe(true);
    expect(logged.filter((line) => line.includes(ADDRESS))).toEqual([]);
  });
});
