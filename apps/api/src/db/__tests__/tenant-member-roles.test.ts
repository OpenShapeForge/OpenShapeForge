import { IDENTITY_LINK_ADMIN_ROLE, NEEDS_ROLE_ASSIGNMENT_ROLES } from "../../auth/organization-roles.js";
// SPDX-License-Identifier: BUSL-1.1
/**
 * The platform operator's member-role administration writes the tenant's
 * membership row, never a Keycloak user role: against a migrated scratch
 * database with a stubbed Keycloak members client.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Kysely } from "kysely";
import type { DB } from "../../generated/db/types.js";
import { __resetIdentityLinkForTests, confirmPendingLink, resolveIdentityLink } from "../../auth/identity-link.js";
import type { KeycloakTenantMemberAdminClient } from "../../control/keycloak-organization-members.js";
import type { PlatformAdministrator } from "../../control/platform-admin.js";
import {
  changeTenantMemberRoles,
  confirmTenantMemberLink,
  getTenantMember,
  listTenantMembers,
  removeTenantMembership,
} from "../../control/tenant-member-admin.js";
import { createDatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import { APP_ROLE } from "../migrations/app-role.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const APP_ROLE_PASSWORD = "openshapeforge_app";
const TEST_TIMEOUT = 120_000;
const ISSUER = "http://localhost:8181/realms/openshapeforge";
const TENANT = randomUUID();
const OTHER_TENANT = randomUUID();

const administrator: PlatformAdministrator = {
  subject: "operator", issuer: "https://identity.example/realms/control", username: "platform-admin",
  name: null, email: null, authorizedParty: "platform-mcp", expiresAtMs: Date.now() + 60_000,
};

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

async function withScratchDb<T>(fn: (appDb: Kysely<DB>, adminDb: Kysely<DB>) => Promise<T>) {
  const name = `tenant_member_roles_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
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

/** A Keycloak that knows one member and has never heard of client roles for people. */
function membersClient(memberId: string, email: string): KeycloakTenantMemberAdminClient {
  const member = { memberId, username: "nora", email, firstName: "Nora", lastName: "Tester", enabled: true, emailVerified: true, roles: [] };
  return {
    hasMemberByEmail: async () => true,
    inviteUser: async () => undefined,
    findPendingInvitationByEmail: async () => null,
    deleteInvitation: async () => false,
    listMembers: async () => [member],
    getMember: async (_organizationId: string, userId: string) => (userId === memberId ? member : null),
    listCredentials: async () => [],
    deleteCredential: async () => true,
    removeMember: async () => true,
    sendPasskeyRecovery: async () => undefined,
  } as unknown as KeycloakTenantMemberAdminClient;
}

describe("tenant member roles from the control plane", () => {
  test(
    "assign and remove write the membership row for this tenant only; a member who never signed in has no row",
    async () => {
      await withScratchDb(async (appDb, adminDb) => {
        await sql`
          insert into platform.tenants (id, slug, name, status, keycloak_realm, keycloak_organization_id)
          values (${TENANT}, 'acme', 'Acme', 'active', 'openshapeforge', 'org-acme'),
                 (${OTHER_TENANT}, 'other', 'Other', 'active', 'openshapeforge', 'org-other')
        `.execute(adminDb);
        const subject = randomUUID();
        const claims = { issuer: ISSUER, subject, email: "nora@example.com", givenName: "Nora", familyName: "Tester" };
        const deps = { db: appDb, administrator, members: membersClient(subject, "nora@example.com") };

        // Not signed in yet: nothing to write to.
        await expect(
          changeTenantMemberRoles(deps, "acme", subject, ["org_admin"], "assign"),
        ).rejects.toMatchObject({
          status: 409,
          code: "MEMBER_NOT_SIGNED_IN",
          detail: "MEMBER_NOT_SIGNED_IN",
          message: expect.stringContaining("has not signed in"),
        });

        // Invited as an employee in acme and in other, signed in to both.
        for (const tenant of [TENANT, OTHER_TENANT]) {
          await sql`
            insert into platform.employee_invitations (tenant_id, email, role, invited_by)
            values (${tenant}, 'nora@example.com', 'org_employee', 'test-admin')
          `.execute(adminDb);
          __resetIdentityLinkForTests();
          await resolveIdentityLink(appDb, { tenantId: tenant, userId: subject, roles: [], groups: [], scope: "self" }, claims);
        }

        // A member whose sign-in is still pending confirmation (their Relation
        // existed; nobody verified it is theirs) has a row but no link: no
        // roles can be assigned onto it.
        const pendingSubject = randomUUID();
        await sql`
          insert into erp.relations (id, tenant_id, display_name, relation_type, status)
          values (gen_random_uuid(), ${TENANT}, 'Pat Existing', 'person', 'active')
        `.execute(adminDb);
        await sql`
          insert into erp.contact_details (tenant_id, relation_id, type, value, is_primary)
          select tenant_id, id, 'email', 'pat@example.com', true from erp.relations
           where tenant_id = ${TENANT} and display_name = 'Pat Existing'
        `.execute(adminDb);
        __resetIdentityLinkForTests();
        const pat = await resolveIdentityLink(
          appDb,
          { tenantId: TENANT, userId: pendingSubject, roles: [], groups: [], scope: "self" },
          { issuer: ISSUER, subject: pendingSubject, email: "pat@example.com" },
        );
        expect(pat!.status).toBe("pending_confirmation");
        const patDeps = { db: appDb, administrator, members: membersClient(pendingSubject, "pat@example.com") };
        await expect(
          changeTenantMemberRoles(patDeps, "acme", pendingSubject, ["org_admin"], "assign"),
        ).rejects.toMatchObject({ status: 409, code: "MEMBER_LINK_PENDING", message: expect.stringContaining('candidate Relation "Pat Existing"') });
        const patRow = async () => (await sql<{ roles: string[]; status: string; linked_by: string | null }>`
            select ir.roles, ir.status, ir.linked_by from platform.identity_relations ir join platform.identities i on i.id = ir.identity_id
             where i.subject = ${pendingSubject} and ir.tenant_id = ${TENANT}
          `.execute(adminDb)).rows[0]!;
        expect((await patRow()).roles).toEqual([]);
        // The operator sees why, and whom the sign-in matched — by name.
        expect(await getTenantMember(patDeps, "acme", pendingSubject)).toMatchObject({
          linkStatus: "pending_confirmation", candidateRelationName: "Pat Existing", relationName: null, roles: [],
        });
        // A pending row holding roles (never written by the product) is not
        // confirmed: that would switch on grants nobody assigned while linked.
        const setPatRoles = (roles: string) => adminDb.transaction().execute(async (trx) => {
          await sql`select set_config('app.bypass_rls', 'true', true)`.execute(trx);
          await sql`
            update platform.identity_relations ir set roles = ${roles}::text[] from platform.identities i
             where i.id = ir.identity_id and i.subject = ${pendingSubject} and ir.tenant_id = ${TENANT}
          `.execute(trx);
        });
        await setPatRoles("{org_admin}");
        await expect(confirmTenantMemberLink(patDeps, "acme", pendingSubject))
          .rejects.toMatchObject({ status: 409, detail: "NO_PENDING_LINK" });
        expect(await patRow()).toMatchObject({ status: "pending_confirmation" });
        await setPatRoles("{}");
        // Confirming links exactly that candidate, as the operator; then roles can be written.
        const confirmed = await confirmTenantMemberLink(patDeps, "acme", pendingSubject);
        expect(confirmed).toMatchObject({ linkStatus: "linked", relationName: "Pat Existing", candidateRelationName: null });
        expect(await patRow()).toMatchObject({ status: "linked", linked_by: expect.stringContaining("#operator") });
        await expect(confirmTenantMemberLink(patDeps, "acme", pendingSubject))
          .rejects.toMatchObject({ status: 409, detail: "NO_PENDING_LINK" });
        expect(await changeTenantMemberRoles(patDeps, "acme", pendingSubject, ["org_admin"], "assign"))
          .toMatchObject({ roles: [IDENTITY_LINK_ADMIN_ROLE, "org_admin"] });

        // A pending sign-in whose candidate is gone (deleted Relation) has
        // nothing to confirm: a different refusal, and confirming refuses too.
        const quinnSubject = randomUUID();
        await sql`
          insert into erp.relations (id, tenant_id, display_name, relation_type, status)
          values (gen_random_uuid(), ${TENANT}, 'Quinn Gone', 'person', 'active')
        `.execute(adminDb);
        await sql`
          insert into erp.contact_details (tenant_id, relation_id, type, value, is_primary)
          select tenant_id, id, 'email', 'quinn@example.com', true from erp.relations
           where tenant_id = ${TENANT} and display_name = 'Quinn Gone'
        `.execute(adminDb);
        __resetIdentityLinkForTests();
        await resolveIdentityLink(appDb, { tenantId: TENANT, userId: quinnSubject, roles: [], groups: [], scope: "self" },
          { issuer: ISSUER, subject: quinnSubject, email: "quinn@example.com" });
        await sql`delete from erp.contact_details where tenant_id = ${TENANT} and value = 'quinn@example.com'`.execute(adminDb);
        await sql`delete from erp.relations where tenant_id = ${TENANT} and display_name = 'Quinn Gone'`.execute(adminDb);
        const quinnDeps = { db: appDb, administrator, members: membersClient(quinnSubject, "quinn@example.com") };
        expect(await getTenantMember(quinnDeps, "acme", quinnSubject))
          .toMatchObject({ linkStatus: "pending_confirmation", candidateRelationName: null });
        await expect(changeTenantMemberRoles(quinnDeps, "acme", quinnSubject, ["org_admin"], "assign"))
          .rejects.toMatchObject({ status: 409, code: "MEMBER_NOT_LINKED" });
        await expect(confirmTenantMemberLink(quinnDeps, "acme", quinnSubject))
          .rejects.toMatchObject({ status: 409, detail: "NO_PENDING_LINK" });

        // One member id, rows from two issuers: the operator is refused
        // rather than acting on whichever row happened to win.
        await sql`
          with other as (
            insert into platform.identities (issuer, subject, email)
            values ('https://elsewhere.example/realms/other', ${pendingSubject}, 'someone-else@example.com')
            returning id
          )
          insert into platform.identity_relations (identity_id, tenant_id, status)
          select id, ${TENANT}, 'pending_confirmation' from other
        `.execute(adminDb);
        await expect(changeTenantMemberRoles(patDeps, "acme", pendingSubject, ["org_admin"], "remove"))
          .rejects.toMatchObject({ status: 409, detail: "AMBIGUOUS_MEMBER_IDENTITY" });
        await expect(confirmTenantMemberLink(patDeps, "acme", pendingSubject))
          .rejects.toMatchObject({ status: 409, detail: "AMBIGUOUS_MEMBER_IDENTITY" });
        expect((await listTenantMembers(patDeps, "acme")).members[0]).toMatchObject({ linkStatus: null, roles: [] });
        expect(await patRow()).toMatchObject({ status: "linked" });
        await sql`delete from platform.identities where issuer = 'https://elsewhere.example/realms/other'`.execute(adminDb);

        const assigned = await changeTenantMemberRoles(deps, "acme", subject, ["org_admin"], "assign");
        expect(assigned).toMatchObject({
          action: "assigned",
          roles: [...NEEDS_ROLE_ASSIGNMENT_ROLES, IDENTITY_LINK_ADMIN_ROLE, "org_admin", "org_employee"].sort(),
        });
        const listed = await listTenantMembers(deps, "acme");
        expect(listed.members[0]).toMatchObject({ memberId: subject, roles: assigned.roles, linkStatus: "linked" });
        expect((await getTenantMember(deps, "acme", subject)).roles).toEqual(assigned.roles);

        // The other tenant's row is untouched, and so is the next session there.
        __resetIdentityLinkForTests();
        const inOther = await resolveIdentityLink(appDb, { tenantId: OTHER_TENANT, userId: subject, roles: [], groups: [], scope: "self" }, claims);
        expect(inOther!.roles).toEqual([...NEEDS_ROLE_ASSIGNMENT_ROLES, "org_employee"].sort());
        const inAcme = await resolveIdentityLink(appDb, { tenantId: TENANT, userId: subject, roles: [], groups: [], scope: "self" }, claims);
        expect(inAcme!.roles).toEqual(assigned.roles);

        const removed = await changeTenantMemberRoles(deps, "acme", subject, ["org_admin"], "remove");
        expect(removed.roles).toEqual([...NEEDS_ROLE_ASSIGNMENT_ROLES, "org_employee"].sort());
        // Nothing in Keycloak was asked to grant anything: the stub has no such method.
        expect("grantClientRoles" in deps.members).toBe(false);

        // Removing the membership removes the row and its roles in acme — and
        // only there — so a later invitation starts from nothing; a second
        // removal is a no-op, not an error.
        const gone = await removeTenantMembership(deps, "acme", subject);
        expect(gone).toMatchObject({ removed: true, membershipRowRemoved: true });
        expect(
          (await sql<{ tenant_id: string }>`
            select tenant_id from platform.identity_relations ir
              join platform.identities i on i.id = ir.identity_id
             where i.subject = ${subject} order by 1
          `.execute(adminDb)).rows.map((row) => row.tenant_id),
        ).toEqual([OTHER_TENANT]);
        expect(await removeTenantMembership(deps, "acme", subject)).toMatchObject({ membershipRowRemoved: false });
        // Her Relation stays in the tenant's records, so the next sign-in is
        // a pending confirmation with no roles — not the old persona. Once
        // re-invited and confirmed, the invitation is what she holds.
        const noraSession = { tenantId: TENANT, userId: subject, roles: [], groups: [], scope: "self" as const };
        __resetIdentityLinkForTests();
        const back = await resolveIdentityLink(appDb, noraSession, claims);
        expect(back).toMatchObject({ status: "pending_confirmation", roles: [] });
        await sql`
          insert into platform.employee_invitations (tenant_id, email, role, invited_by)
          values (${TENANT}, 'nora@example.com', 'org_admin', 'test-admin')
        `.execute(adminDb);
        await confirmPendingLink(appDb, { ...noraSession, relation: back });
        __resetIdentityLinkForTests();
        const again = await resolveIdentityLink(appDb, noraSession, claims);
        expect(again!.roles).toEqual([IDENTITY_LINK_ADMIN_ROLE, "org_admin"]);
      });
    },
    TEST_TIMEOUT,
  );
});
