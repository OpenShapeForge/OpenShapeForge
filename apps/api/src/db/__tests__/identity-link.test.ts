// SPDX-License-Identifier: BUSL-1.1
/**
 * The identity ↔ Relation link, end to end against a migrated scratch
 * database and the restricted app role (so RLS is what it is in production):
 * just-in-time creation, reuse, the pending candidate, confirmation, the
 * administrator's explicit link, and tenant isolation.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Kysely } from "kysely";
import type { DB } from "../../generated/db/types.js";
import { createDatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import { APP_ROLE } from "../migrations/app-role.js";
import { withDbSession } from "../session.js";
import { updateGeneratedEntity } from "../../operations/entity/mutations.js";
import { personSessionRoles } from "../../auth/person-roles.js";
import {
  __resetIdentityLinkForTests,
  confirmPendingLink,
  identityIdForRelation,
  linkIdentityToRelation,
  listPendingRoleAssignments,
  setMembershipRoles,
  resolveIdentityLink,
  sessionRelation,
  type IdentityClaims,
  type IdentityLinkState,
} from "../../auth/identity-link.js";
import type { TrustedSessionContext } from "../../auth/trusted-context.js";
import {
  callIdentityLinkTool,
  identityLinkToolsForSession,
} from "../../mcp/identity-link-tools.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const APP_ROLE_PASSWORD = "openshapeforge_app";
const TEST_TIMEOUT = 120_000;
const ISSUER = "http://localhost:8181/realms/openshapeforge";
const ADMIN_ROLES = ["Organization.All.ReadWrite", "Relations.All.ReadWrite"];

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
  const name = `identity_link_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
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
    insert into platform.tenants (id, slug, name, status, keycloak_realm)
    values (${tenantA}, 'tenant-a', 'Tenant A', 'active', 'openshapeforge'),
           (${tenantB}, 'tenant-b', 'Tenant B', 'active', 'openshapeforge')
  `.execute(adminDb);
}

type Person = { claims: IdentityClaims; roles: string[] };

function person(username: string, roles: string[] = []): Person {
  return {
    claims: {
      issuer: ISSUER,
      subject: randomUUID(),
      email: `${username}@example.com`,
      name: `${username[0]!.toUpperCase()}${username.slice(1)} Tester`,
      givenName: `${username[0]!.toUpperCase()}${username.slice(1)}`,
      familyName: "Tester",
      preferredUsername: username,
    },
    roles,
  };
}

function sessionFor(who: Person, tenantId: string, relation?: IdentityLinkState | null) {
  const session: TrustedSessionContext & { tenantId: string; userId: string } = {
    tenantId,
    userId: who.claims.subject,
    roles: who.roles,
    groups: [],
    oauthScopes: [],
    scope: "self",
    credential: "bearer",
    relation: relation ?? null,
  };
  return session;
}

/** Resolve like identity.ts does on a bearer session, bypassing the cache. */
async function signIn(db: Kysely<DB>, who: Person, tenantId: string) {
  __resetIdentityLinkForTests();
  const session = sessionFor(who, tenantId);
  const state = await resolveIdentityLink(db, session, who.claims);
  session.relation = state;
  return { session, state };
}

/** A Relation with an e-mail contact detail, as an administrator would have entered it. */
async function existingRelation(
  adminDb: Kysely<DB>,
  tenantId: string,
  displayName: string,
  email: string,
): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into erp.relations (id, tenant_id, display_name, relation_type, status)
    values (${id}, ${tenantId}, ${displayName}, 'person', 'active')
  `.execute(adminDb);
  await sql`
    insert into erp.contact_details (tenant_id, relation_id, type, value, is_primary)
    values (${tenantId}, ${id}, 'email', ${email}, true)
  `.execute(adminDb);
  return id;
}

/**
 * A pending invitation, as `invite_employee` would have left it. Written
 * without RLS (the owner connection) for the same reason `existingRelation`
 * is: this is the state an administrator's earlier call produced, not the
 * thing under test.
 */
async function invite(
  adminDb: Kysely<DB>,
  tenantId: string,
  email: string,
  role: "org_admin" | "org_employee" = "org_employee",
) {
  await sql`
    insert into platform.employee_invitations (tenant_id, email, role, invited_by)
    values (${tenantId}, ${email}, ${role}, 'test-admin')
    on conflict do nothing
  `.execute(adminDb);
}

/**
 * Sign in somebody the organization has invited. Admission is a precondition
 * for every test below that is about something else — the confirmation step,
 * role assignment, tenant isolation — so it is said once, here, instead of
 * being repeated in each of them.
 */
async function invitedSignIn(
  appDb: Kysely<DB>,
  adminDb: Kysely<DB>,
  who: Person,
  tenantId: string,
) {
  await invite(adminDb, tenantId, who.claims.email!);
  return signIn(appDb, who, tenantId);
}

async function invitationRows(adminDb: Kysely<DB>, tenantId: string) {
  return (
    await sql<{ email: string; role: string; status: string; accepted_at: Date | null }>`
      select email, role, status, accepted_at from platform.employee_invitations
       where tenant_id = ${tenantId} order by invited_at
    `.execute(adminDb)
  ).rows;
}

async function linkRows(adminDb: Kysely<DB>, tenantId: string) {
  return (
    await sql<{
      identity_id: string;
      status: string;
      relation_id: string | null;
      candidate_relation_id: string | null;
      linked_by: string | null;
    }>`
      select identity_id, status, relation_id, candidate_relation_id, linked_by
        from platform.identity_relations where tenant_id = ${tenantId}
       order by created_at
    `.execute(adminDb)
  ).rows;
}

describe("identity ↔ Relation link", () => {
  beforeEach(() => __resetIdentityLinkForTests());

  test(
    "an invited first session creates a person Relation just in time; later sessions reuse it",
    async () => {
      await withScratchDb(async (appDb, adminDb) => {
        await seedTenants(adminDb);
        const alice = person("alice");
        await invite(adminDb, tenantA, "alice@example.com");

        const first = await signIn(appDb, alice, tenantA);
        expect(first.state).toMatchObject({
          status: "linked",
          displayName: "Alice Tester",
          linkedBy: "jit",
          issuer: ISSUER,
          subject: alice.claims.subject,
        });
        const relationId = first.state!.relationId!;
        expect(sessionRelation(first.session)).toEqual({
          relationId,
          displayName: "Alice Tester",
        });

        // The rows behind it, seen without RLS: a Relation of type person, a
        // NaturalPerson with the token's names, an e-mail contact detail.
        const relation = (
          await sql<{ display_name: string; relation_type: string; tenant_id: string }>`
            select display_name, relation_type, tenant_id from erp.relations where id = ${relationId}
          `.execute(adminDb)
        ).rows[0];
        expect(relation).toEqual({
          display_name: "Alice Tester",
          relation_type: "person",
          tenant_id: tenantA,
        });
        const natural = (
          await sql<{ first_name: string; last_name: string }>`
            select first_name, last_name from erp.natural_persons where relation_id = ${relationId}
          `.execute(adminDb)
        ).rows;
        expect(natural).toEqual([{ first_name: "Alice", last_name: "Tester" }]);
        const contact = (
          await sql<{ type: string; value: string; is_primary: boolean }>`
            select type, value, is_primary from erp.contact_details where relation_id = ${relationId}
          `.execute(adminDb)
        ).rows;
        expect(contact).toEqual([{ type: "email", value: "alice@example.com", is_primary: true }]);
        const identity = (
          await sql<{ issuer: string; subject: string; email: string; display_name: string }>`
            select issuer, subject, email, display_name from platform.identities
          `.execute(adminDb)
        ).rows;
        expect(identity).toEqual([
          {
            issuer: ISSUER,
            subject: alice.claims.subject,
            email: "alice@example.com",
            display_name: "Alice Tester",
          },
        ]);

        // Second session: same Relation, nothing new created.
        const second = await signIn(appDb, alice, tenantA);
        expect(second.state!.relationId).toBe(relationId);
        const relationCount = (
          await sql<{ n: string }>`select count(*)::text as n from erp.relations`.execute(adminDb)
        ).rows[0]!.n;
        expect(relationCount).toBe("1");

        // Concurrent first sessions of ONE person share one resolution.
        const bob = person("bob");
        await invite(adminDb, tenantA, "bob@example.com");
        const session = sessionFor(bob, tenantA);
        const [x, y] = await Promise.all([
          resolveIdentityLink(appDb, session, bob.claims),
          resolveIdentityLink(appDb, session, bob.claims),
        ]);
        expect(x!.relationId).toBe(y!.relationId);
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "without an invitation nobody gets in, and nothing is created for them",
    async () => {
      await withScratchDb(async (appDb, adminDb) => {
        await seedTenants(adminDb);
        const stranger = person("stranger");

        // A perfectly valid token for the realm, for somebody this
        // organization has never been told about.
        await expect(signIn(appDb, stranger, tenantA)).rejects.toMatchObject({
          status: 403,
          code: "NOT_INVITED",
        });

        // The refusal says what has to happen, not just "no".
        await expect(signIn(appDb, stranger, tenantA)).rejects.toThrow(
          /invite_employee|administrator/i,
        );

        // Nothing was created on their way past: no Relation, no link row.
        const relations = (
          await sql<{ n: string }>`select count(*)::text as n from erp.relations`.execute(adminDb)
        ).rows[0]!.n;
        expect(relations).toBe("0");
        expect(await linkRows(adminDb, tenantA)).toEqual([]);

        // Being invited SOMEWHERE ELSE is not being invited here.
        await invite(adminDb, tenantB, "stranger@example.com");
        await expect(signIn(appDb, stranger, tenantA)).rejects.toMatchObject({
          code: "NOT_INVITED",
        });

        // Neither is a revoked invitation.
        await invite(adminDb, tenantA, "stranger@example.com");
        await sql`
          update platform.employee_invitations
             set status = 'revoked', revoked_at = now()
           where tenant_id = ${tenantA}
        `.execute(adminDb);
        await expect(signIn(appDb, stranger, tenantA)).rejects.toMatchObject({
          code: "NOT_INVITED",
        });
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "an invited person is admitted with the invited role recorded for THIS tenant, without an administrator",
    async () => {
      await withScratchDb(async (appDb, adminDb) => {
        await seedTenants(adminDb);
        const dave = person("dave");
        await invite(adminDb, tenantA, "Dave@Example.com", "org_admin");

        const { state } = await signIn(appDb, dave, tenantA);

        expect(state).toMatchObject({ status: "linked", linkedBy: "jit" });
        // The address matched case-insensitively, and the invited role is on
        // the membership row — nothing was asked of Keycloak, and nothing on
        // the session comes from the token's client roles.
        expect(state!.needsRoleAssignment).toBe(false);
        expect(state!.roles).toEqual(["Organization.All.ReadWrite", "org_admin"]);
        const row = (
          await sql<{ roles: string[]; needs_role_assignment: boolean }>`
            select roles, needs_role_assignment from platform.identity_relations
             where identity_id = ${state!.identityId} and tenant_id = ${tenantA}
          `.execute(adminDb)
        ).rows[0]!;
        expect(row).toEqual({ roles: ["Organization.All.ReadWrite", "org_admin"], needs_role_assignment: false });
        expect(
          await listPendingRoleAssignments(
            appDb,
            sessionFor(person("admin-y", ADMIN_ROLES), tenantA),
          ),
        ).toEqual([]);

        // And the invitation is spent, so it cannot admit a second person.
        expect(await invitationRows(adminDb, tenantA)).toMatchObject([
          { email: "Dave@Example.com", role: "org_admin", status: "accepted" },
        ]);

        // A later session reads the same roles back from the row.
        const again = await signIn(appDb, dave, tenantA);
        expect(again.state!.roles).toEqual(["Organization.All.ReadWrite", "org_admin"]);
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "a linked member without roles and a still-pending invitation is accepted on the next sign-in",
    async () => {
      await withScratchDb(async (appDb, adminDb) => {
        await seedTenants(adminDb);
        const fay = person("fay");
        await invite(adminDb, tenantA, "fay@example.com", "org_admin");
        // The state a 503 between the link and the acceptance would have left
        // behind (they are one transaction now, so it is written by hand):
        // linked, no roles, invitation still pending.
        const relationId = await existingRelation(adminDb, tenantA, "Fay Tester", "fay-other@example.com");
        await sql`
          insert into platform.identities (issuer, subject, email, display_name)
          values (${ISSUER}, ${fay.claims.subject}, 'fay@example.com', 'Fay Tester')
        `.execute(adminDb);
        await sql`
          insert into platform.identity_relations
            (identity_id, tenant_id, status, relation_id, linked_at, linked_by)
          select id, ${tenantA}, 'linked', ${relationId}, now(), 'jit'
            from platform.identities where subject = ${fay.claims.subject}
        `.execute(adminDb);

        const { state } = await signIn(appDb, fay, tenantA);
        expect(state).toMatchObject({
          status: "linked",
          relationId,
          needsRoleAssignment: false,
          roles: ["Organization.All.ReadWrite", "org_admin"],
        });
        expect(await invitationRows(adminDb, tenantA)).toMatchObject([{ status: "accepted" }]);
        // And it sticks: the next session reads it from the row.
        expect((await signIn(appDb, fay, tenantA)).state!.roles).toEqual([
          "Organization.All.ReadWrite",
          "org_admin",
        ]);
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "an invited org_admin holds what the realm's composite says, and can update a Relation with it",
    async () => {
      // The generated realm composites of the shipped base authorization —
      // the same artifact production runs on, no injected table.
      await withScratchDb(async (appDb, adminDb) => {
        await seedTenants(adminDb);
        const gina = person("gina");
        const hal = person("hal");
        await invite(adminDb, tenantA, "gina@example.com", "org_admin");
        await invite(adminDb, tenantA, "hal@example.com", "org_employee");
        const relationId = await existingRelation(adminDb, tenantA, "Some Client", "client@example.com");

        const admin = await signIn(appDb, gina, tenantA);
        const adminRoles = personSessionRoles({ roles: [] }, admin.state!, "openshapeforge");
        expect(adminRoles).toContain("Relations.All.ReadWrite");
        expect(adminRoles).toContain("Organization.All.ReadWrite");
        expect(adminRoles).toContain("org_admin");
        const updated = await updateGeneratedEntity(
          appDb,
          { tenantId: tenantA, userId: gina.claims.subject, roles: adminRoles, groups: [], scope: "tenant" },
          { table: "erp.relations", id: relationId, values: { displayName: "Renamed Client" } },
        );
        expect(updated).toMatchObject({ display_name: "Renamed Client" });

        const employee = await signIn(appDb, hal, tenantA);
        const employeeRoles = personSessionRoles({ roles: [] }, employee.state!, "openshapeforge");
        expect(employeeRoles).toEqual(["General.All.Read", "Relations.All.Read", "org_employee"]);
        await expect(
          updateGeneratedEntity(
            appDb,
            { tenantId: tenantA, userId: hal.claims.subject, roles: employeeRoles, groups: [], scope: "tenant" },
            { table: "erp.relations", id: relationId, values: { displayName: "Nope" } },
          ),
        ).rejects.toThrow(/Not authorized to update Relation/);
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "the invitation is claimed at admission: a revoke in between refuses, a role change in between wins",
    async () => {
      await withScratchDb(async (appDb, adminDb) => {
        await seedTenants(adminDb);
        // Revoked after the lookup but before the claim: simulated by revoking
        // right away — the claim (UPDATE ... RETURNING) is what decides, and
        // it finds nothing pending. Nothing is created.
        const ian = person("ian");
        await invite(adminDb, tenantA, "ian@example.com", "org_admin");
        await sql`
          update platform.employee_invitations set status = 'revoked', revoked_at = now()
           where tenant_id = ${tenantA} and lower(email) = 'ian@example.com'
        `.execute(adminDb);
        await expect(signIn(appDb, ian, tenantA)).rejects.toMatchObject({ code: "NOT_INVITED" });
        expect(await linkRows(adminDb, tenantA)).toEqual([]);
        expect(
          (await sql<{ n: string }>`select count(*)::text as n from erp.relations where tenant_id = ${tenantA}`.execute(adminDb)).rows[0]!.n,
        ).toBe("0");

        // The role recorded is the role the row holds when it is claimed.
        const jo = person("jo");
        await invite(adminDb, tenantA, "jo@example.com", "org_admin");
        await sql`
          update platform.employee_invitations set role = 'org_employee'
           where tenant_id = ${tenantA} and lower(email) = 'jo@example.com' and status = 'pending'
        `.execute(adminDb);
        const { state } = await signIn(appDb, jo, tenantA);
        expect(state!.roles).toEqual(["General.All.Read", "org_employee"]);
        expect(await invitationRows(adminDb, tenantA)).toMatchObject([
          { email: "ian@example.com", status: "revoked" },
          { email: "jo@example.com", role: "org_employee", status: "accepted" },
        ]);
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "roles are per organization: an org_admin of A is what B invited them as, and nothing in a third",
    async () => {
      await withScratchDb(async (appDb, adminDb) => {
        await seedTenants(adminDb);
        const erin = person("erin");
        await invite(adminDb, tenantA, "erin@example.com", "org_admin");
        await invite(adminDb, tenantB, "erin@example.com", "org_employee");

        const inA = await signIn(appDb, erin, tenantA);
        const inB = await signIn(appDb, erin, tenantB);
        expect(inA.state!.identityId).toBe(inB.state!.identityId);
        expect(inA.state!.roles).toEqual(["Organization.All.ReadWrite", "org_admin"]);
        expect(inB.state!.roles).toEqual(["General.All.Read", "org_employee"]);

        // The grant in A is not visible from B's row, through RLS as the app
        // role and through the resolver alike.
        const rolesSeenFrom = (tenantId: string) =>
          withDbSession(appDb, sessionFor(erin, tenantId), async (trx) =>
            (
              await sql<{ tenant_id: string; roles: string[] }>`
                select tenant_id, roles from platform.identity_relations
                 where identity_id = ${inA.state!.identityId}
              `.execute(trx)
            ).rows,
          );
        expect(await rolesSeenFrom(tenantB)).toEqual([
          { tenant_id: tenantB, roles: ["General.All.Read", "org_employee"] },
        ]);
        expect(await rolesSeenFrom(tenantA)).toEqual([
          { tenant_id: tenantA, roles: ["Organization.All.ReadWrite", "org_admin"] },
        ]);

        // The person cannot raise their own roles: the row is theirs to
        // confirm and to carry onboarding state on, never to grant with.
        await expect(
          withDbSession(appDb, sessionFor(erin, tenantB), (trx) =>
            sql`
              update platform.identity_relations
                 set roles = array['Organization.All.ReadWrite']::text[]
               where identity_id = ${inB.state!.identityId} and tenant_id = ${tenantB}
            `.execute(trx),
          ),
        ).rejects.toMatchObject({ errno: "42501" });
        __resetIdentityLinkForTests();
        expect((await signIn(appDb, erin, tenantB)).state!.roles).toEqual(["General.All.Read", "org_employee"]);
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "an existing Relation with the e-mail is not linked silently; the person confirms it",
    async () => {
      await withScratchDb(async (appDb, adminDb) => {
        await seedTenants(adminDb);
        const carol = person("carol");
        const carolsRelation = await existingRelation(
          adminDb,
          tenantA,
          "C. Tester (entered by hand)",
          "Carol@Example.com",
        );

        const first = await signIn(appDb, carol, tenantA);
        expect(first.state).toMatchObject({
          status: "pending_confirmation",
          relationId: null,
          candidateRelationId: carolsRelation,
          displayName: "C. Tester (entered by hand)",
        });
        expect(sessionRelation(first.session)).toBeNull();
        expect(
          (await sql<{ n: string }>`select count(*)::text as n from erp.relations`.execute(adminDb))
            .rows[0]!.n,
        ).toBe("1");

        // The person is offered confirm_my_link and nothing else.
        expect(identityLinkToolsForSession(first.session).map((tool) => tool.name)).toEqual([
          "confirm_my_link",
        ]);
        const outcome = await callIdentityLinkTool("confirm_my_link", {}, appDb, first.session);
        expect(outcome?.isError).not.toBe(true);
        expect(outcome?.structuredContent).toMatchObject({
          linked: true,
          status: "linked",
          relationId: carolsRelation,
        });
        // The session the server holds is updated in place.
        expect(sessionRelation(first.session)).toEqual({
          relationId: carolsRelation,
          displayName: "C. Tester (entered by hand)",
        });
        expect(await linkRows(adminDb, tenantA)).toEqual([
          {
            identity_id: first.state!.identityId,
            status: "linked",
            relation_id: carolsRelation,
            candidate_relation_id: null,
            linked_by: first.state!.identityId,
          },
        ]);

        // Next session reads the confirmed link; confirming again is refused.
        const second = await signIn(appDb, carol, tenantA);
        expect(second.state!.relationId).toBe(carolsRelation);
        expect(identityLinkToolsForSession(second.session)).toEqual([]);
        const again = await callIdentityLinkTool("confirm_my_link", {}, appDb, second.session);
        expect(again?.isError).toBe(true);
        expect(again?.structuredContent).toMatchObject({ error: { code: "NOT_FOUND" } });

        // Two Relations with the e-mail: pending without a candidate, so the
        // administrator has to decide.
        const dave = person("dave");
        await existingRelation(adminDb, tenantA, "Dave One", "dave@example.com");
        await existingRelation(adminDb, tenantA, "Dave Two", "dave@example.com");
        const daves = await invitedSignIn(appDb, adminDb, dave, tenantA);
        expect(daves.state).toMatchObject({
          status: "pending_confirmation",
          candidateRelationId: null,
        });
        expect(identityLinkToolsForSession(daves.session)).toEqual([]);
        await expect(confirmPendingLink(appDb, daves.session)).rejects.toMatchObject({
          code: "NO_CANDIDATE",
        });
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "an organization administrator links explicitly; anyone else is refused",
    async () => {
      await withScratchDb(async (appDb, adminDb) => {
        await seedTenants(adminDb);
        const admin = person("admin", ADMIN_ROLES);
        const erin = person("erin");
        const employee = person("frank", ["Relations.All.ReadWrite"]);
        const erinsRelation = await existingRelation(adminDb, tenantA, "Erin Tester", "erin@example.com");
        const adminSignIn = await invitedSignIn(appDb, adminDb, admin, tenantA);
        const erinSignIn = await invitedSignIn(appDb, adminDb, erin, tenantA);
        expect(erinSignIn.state!.status).toBe("pending_confirmation");
        const employeeSignIn = await invitedSignIn(appDb, adminDb, employee, tenantA);

        expect(identityLinkToolsForSession(adminSignIn.session).map((tool) => tool.name)).toEqual([
          "link_identity",
          "list_pending_members",
          "set_member_role",
        ]);
        expect(identityLinkToolsForSession(employeeSignIn.session)).toEqual([]);

        // Not an administrator: the tool does not exist for them, and the
        // function behind it refuses, and so does the database.
        const refused = await callIdentityLinkTool(
          "link_identity",
          { identityEmail: "erin@example.com", relationId: erinsRelation },
          appDb,
          employeeSignIn.session,
        );
        expect(refused?.isError).toBe(true);
        expect(refused?.structuredContent).toMatchObject({ error: { code: "NOT_FOUND" } });
        await expect(
          linkIdentityToRelation(appDb, employeeSignIn.session, {
            identityEmail: "erin@example.com",
            relationId: erinsRelation,
          }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
        await withDbSession(appDb, employeeSignIn.session, (trx) =>
            sql`
              update platform.identity_relations
                 set status = 'linked', relation_id = ${erinsRelation}, linked_at = now(), linked_by = 'x'
               where identity_id = ${erinSignIn.state!.identityId} and tenant_id = ${tenantA}
            `.execute(trx),
          );
        // UPDATE's USING policy hides rows the caller cannot mutate; PostgreSQL
        // reports zero affected rows rather than raising a WITH CHECK error.
        const unchanged = await sql<{ status: string; relation_id: string | null }>`
          select status, relation_id
            from platform.identity_relations
           where identity_id = ${erinSignIn.state!.identityId} and tenant_id = ${tenantA}
        `.execute(adminDb);
        expect(unchanged.rows[0]).toEqual({ status: "pending_confirmation", relation_id: null });

        // The administrator links Erin to her Relation.
        const linked = await callIdentityLinkTool(
          "link_identity",
          { identityEmail: "ERIN@example.com", relationId: erinsRelation },
          appDb,
          adminSignIn.session,
        );
        expect(linked?.isError).not.toBe(true);
        expect(linked?.structuredContent).toMatchObject({
          linked: true,
          status: "linked",
          relationId: erinsRelation,
          linkedBy: adminSignIn.state!.identityId,
        });
        const erinAgain = await signIn(appDb, erin, tenantA);
        expect(sessionRelation(erinAgain.session)).toEqual({
          relationId: erinsRelation,
          displayName: "Erin Tester",
        });

        // Validation: unknown e-mail, foreign Relation, missing argument.
        const unknown = await callIdentityLinkTool(
          "link_identity",
          { identityEmail: "nobody@example.com", relationId: erinsRelation },
          appDb,
          adminSignIn.session,
        );
        expect(unknown?.structuredContent).toMatchObject({ error: { code: "IDENTITY_NOT_FOUND" } });
        const foreignRelation = await existingRelation(adminDb, tenantB, "Elsewhere", "x@example.com");
        const elsewhere = await callIdentityLinkTool(
          "link_identity",
          { identityEmail: "erin@example.com", relationId: foreignRelation },
          appDb,
          adminSignIn.session,
        );
        expect(elsewhere?.structuredContent).toMatchObject({ error: { code: "RELATION_NOT_FOUND" } });
        const missing = await callIdentityLinkTool(
          "link_identity",
          { relationId: erinsRelation },
          appDb,
          adminSignIn.session,
        );
        expect(missing?.structuredContent).toMatchObject({ error: { code: "VALIDATION" } });
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "a link in tenant A is invisible in tenant B, where the person gets their own",
    async () => {
      await withScratchDb(async (appDb, adminDb) => {
        await seedTenants(adminDb);
        const grace = person("grace");
        const admin = person("admin", ADMIN_ROLES);

        const inA = await invitedSignIn(appDb, adminDb, grace, tenantA);
        const inB = await invitedSignIn(appDb, adminDb, grace, tenantB);
        expect(inA.state!.status).toBe("linked");
        expect(inB.state!.status).toBe("linked");
        expect(inA.state!.identityId).toBe(inB.state!.identityId);
        expect(inA.state!.relationId).not.toBe(inB.state!.relationId);

        // Through RLS as the app role: each tenant session sees its own row only.
        const seenFrom = (tenantId: string) =>
          withDbSession(appDb, sessionFor(admin, tenantId), async (trx) =>
            (
              await sql<{ tenant_id: string; relation_id: string }>`
                select tenant_id, relation_id from platform.identity_relations
                 where identity_id = ${inA.state!.identityId}
              `.execute(trx)
            ).rows,
          );
        expect(await seenFrom(tenantA)).toEqual([{ tenant_id: tenantA, relation_id: inA.state!.relationId! }]);
        expect(await seenFrom(tenantB)).toEqual([{ tenant_id: tenantB, relation_id: inB.state!.relationId! }]);

        // And the Relation created in A is not reachable from B.
        const relationFromB = await withDbSession(appDb, sessionFor(admin, tenantB), async (trx) =>
          (
            await sql<{ id: string }>`
              select id from erp.relations where id = ${inA.state!.relationId}
            `.execute(trx)
          ).rows,
        );
        expect(relationFromB).toEqual([]);

        // An administrator of B cannot link an identity that only ever signed
        // in to A: it is not visible there.
        const heidi = person("heidi");
        await invitedSignIn(appDb, adminDb, heidi, tenantA);
        const adminInB = await invitedSignIn(appDb, adminDb, admin, tenantB);
        const target = await existingRelation(adminDb, tenantB, "Heidi in B", "other@example.com");
        await expect(
          linkIdentityToRelation(appDb, adminInB.session, {
            identityEmail: "heidi@example.com",
            relationId: target,
          }),
        ).rejects.toMatchObject({ code: "IDENTITY_NOT_FOUND" });
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "a member with no roles here is listed for admins and set_member_role records them, for this tenant only",
    async () => {
      await withScratchDb(async (appDb, adminDb) => {
        await seedTenants(adminDb);
        const admin = person("admin", ADMIN_ROLES);
        const adminInA = await invitedSignIn(appDb, adminDb, admin, tenantA);

        // 1. An invited person arrives with roles, so nothing is pending.
        const ivy = person("ivy");
        const first = await invitedSignIn(appDb, adminDb, ivy, tenantA);
        expect(first.state!.needsRoleAssignment).toBe(false);
        expect(first.state!.roles).toEqual(["General.All.Read", "org_employee"]);

        // 2. A person whose Relation already existed is linked by confirming
        //    the candidate. That link carries NO roles yet — nobody invited
        //    them as anything — so they run on the just-in-time minimum and
        //    show up for the administrator.
        await existingRelation(adminDb, tenantA, "Jack Existing", "jack@example.com");
        const jack = person("jack");
        const jackFirst = await signIn(appDb, jack, tenantA);
        expect(jackFirst.state!.status).toBe("pending_confirmation");
        expect(jackFirst.state!.needsRoleAssignment).toBe(false);
        // Roles cannot be recorded on an unconfirmed link: nobody verified
        // that Relation is theirs yet.
        await expect(
          setMembershipRoles(appDb, adminInA.session, jackFirst.state!.identityId, ["org_admin"]),
        ).rejects.toMatchObject({ code: "IDENTITY_NOT_LINKED" });
        const confirmed = await confirmPendingLink(appDb, jackFirst.session);
        expect(confirmed).toMatchObject({ status: "linked", roles: [], needsRoleAssignment: true });

        const pending = await listPendingRoleAssignments(appDb, adminInA.session);
        expect(pending.map((row) => row.identityId)).toEqual([jackFirst.state!.identityId]);
        expect(pending[0]).toMatchObject({ email: "jack@example.com" });

        // Gated the same way link_identity is: a non-admin session is refused.
        const plainSession = sessionFor(person("plain"), tenantA);
        await expect(listPendingRoleAssignments(appDb, plainSession)).rejects.toMatchObject({
          code: "FORBIDDEN",
        });

        // 3. set_member_role, by relationId: writes the roles on THIS tenant's
        //    row and clears the flag. No Keycloak call is made — there is no
        //    control plane configured in this test, and none is needed.
        expect(
          await identityIdForRelation(appDb, adminInA.session, confirmed.relationId!),
        ).toBe(jackFirst.state!.identityId);
        const result = await callIdentityLinkTool(
          "set_member_role",
          { relationId: confirmed.relationId, role: "org_admin" },
          appDb,
          adminInA.session,
        );
        expect(result?.isError).not.toBe(true);
        expect(result?.structuredContent).toMatchObject({
          granted: true,
          role: "org_admin",
          roles: ["Organization.All.ReadWrite", "org_admin"],
        });
        const row = (
          await sql<{ needs_role_assignment: boolean; roles: string[] }>`
            select needs_role_assignment, roles from platform.identity_relations
             where identity_id = ${jackFirst.state!.identityId} and tenant_id = ${tenantA}
          `.execute(adminDb)
        ).rows[0]!;
        expect(row).toEqual({ needs_role_assignment: false, roles: ["Organization.All.ReadWrite", "org_admin"] });

        // The next session carries them, and the person is no longer pending.
        __resetIdentityLinkForTests();
        const third = await signIn(appDb, jack, tenantA);
        expect(third.state).toMatchObject({ needsRoleAssignment: false, roles: ["Organization.All.ReadWrite", "org_admin"] });
        expect(
          (await listPendingRoleAssignments(appDb, adminInA.session)).map((row) => row.identityId),
        ).toEqual([]);

        // 4. Demotion is the same call, and it replaces rather than adds.
        const demoted = await callIdentityLinkTool(
          "set_member_role",
          { identityId: jackFirst.state!.identityId, role: "org_employee" },
          appDb,
          adminInA.session,
        );
        expect(demoted?.structuredContent).toMatchObject({ roles: ["General.All.Read", "org_employee"] });

        // 5. Tenant B is untouched. Jack's row in B (once he is invited there)
        //    carries B's grant, and B's administrator cannot reach his row in
        //    A: it is invisible from B, so the update finds nothing.
        const adminInB = await invitedSignIn(appDb, adminDb, person("admin2", ADMIN_ROLES), tenantB);
        expect(await listPendingRoleAssignments(appDb, adminInB.session)).toEqual([]);
        const jackInB = await invitedSignIn(appDb, adminDb, jack, tenantB);
        expect(jackInB.state!.roles).toEqual(["General.All.Read", "org_employee"]);
        await expect(
          setMembershipRoles(appDb, adminInB.session, jackFirst.state!.identityId, ["Organization.All.ReadWrite", "org_admin"]),
        ).resolves.toMatchObject({ roles: ["Organization.All.ReadWrite", "org_admin"] });
        __resetIdentityLinkForTests();
        expect((await signIn(appDb, jack, tenantA)).state!.roles).toEqual(["General.All.Read", "org_employee"]);
        expect((await signIn(appDb, jack, tenantB)).state!.roles).toEqual(["Organization.All.ReadWrite", "org_admin"]);
      });
    },
    TEST_TIMEOUT,
  );
});
