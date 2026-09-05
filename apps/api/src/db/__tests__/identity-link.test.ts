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
import {
  __resetIdentityLinkForTests,
  clearNeedsRoleAssignment,
  confirmPendingLink,
  identityIdForRelation,
  identityKeycloakSubject,
  linkIdentityToRelation,
  listPendingRoleAssignments,
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
    "first session creates a person Relation just in time; later sessions reuse it",
    async () => {
      await withScratchDb(async (appDb, adminDb) => {
        await seedTenants(adminDb);
        const alice = person("alice");

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
        const daves = await signIn(appDb, dave, tenantA);
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
        const adminSignIn = await signIn(appDb, admin, tenantA);
        const erinSignIn = await signIn(appDb, erin, tenantA);
        expect(erinSignIn.state!.status).toBe("pending_confirmation");
        const employeeSignIn = await signIn(appDb, employee, tenantA);

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
        await expect(
          withDbSession(appDb, employeeSignIn.session, (trx) =>
            sql`
              update platform.identity_relations
                 set status = 'linked', relation_id = ${erinsRelation}, linked_at = now(), linked_by = 'x'
               where identity_id = ${erinSignIn.state!.identityId} and tenant_id = ${tenantA}
            `.execute(trx),
          ),
        ).rejects.toThrow(/row-level security/);

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

        const inA = await signIn(appDb, grace, tenantA);
        const inB = await signIn(appDb, grace, tenantB);
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
        await signIn(appDb, heidi, tenantA);
        const adminInB = await signIn(appDb, admin, tenantB);
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
    "needs_role_assignment is set only on the JIT-create path, listed for admins, and cleared by set_member_role",
    async () => {
      await withScratchDb(async (appDb, adminDb) => {
        await seedTenants(adminDb);
        const admin = person("admin", ADMIN_ROLES);

        // 1. A brand-new identity: no existing Relation carries the e-mail, so
        //    ensureIdentityLink creates one. needs_role_assignment must be true.
        const ivy = person("ivy");
        const first = await signIn(appDb, ivy, tenantA);
        expect(first.state!.needsRoleAssignment).toBe(true);
        expect(
          (await linkRows(adminDb, tenantA)).find((row) => row.identity_id === first.state!.identityId),
        ).toMatchObject({ status: "linked" });
        const flagRow = (
          await sql<{ needs_role_assignment: boolean }>`
            select needs_role_assignment from platform.identity_relations
             where identity_id = ${first.state!.identityId} and tenant_id = ${tenantA}
          `.execute(adminDb)
        ).rows[0]!;
        expect(flagRow.needs_role_assignment).toBe(true);

        // 2. A later session for the SAME identity reads the flag back as
        //    still true (the cache was reset by signIn, so this is a fresh read).
        const second = await signIn(appDb, ivy, tenantA);
        expect(second.state!.needsRoleAssignment).toBe(true);

        // 3. The pending_confirmation path (an existing Relation, e-mail
        //    match, nobody confirmed) must NEVER set the flag — it attaches to
        //    a Relation someone already has, so there is nothing to grant.
        const existingEmail = "jack@example.com";
        await existingRelation(adminDb, tenantA, "Jack Existing", existingEmail);
        const jack = person("jack");
        const jackFirst = await signIn(appDb, jack, tenantA);
        expect(jackFirst.state!.status).toBe("pending_confirmation");
        expect(jackFirst.state!.needsRoleAssignment).toBe(false);

        // 4. link_identity (an administrator linking explicitly) must not set
        //    it either. Reuse jack's identity from step 3 (pending_confirmation,
        //    needs_role_assignment already false) so this exercises the
        //    administrator-link write itself, not a JIT create beforehand.
        const adminInA = await signIn(appDb, admin, tenantA);
        const jackTarget = await existingRelation(adminDb, tenantA, "Jack Target", "jack-target@example.com");
        const linked = await linkIdentityToRelation(appDb, adminInA.session, {
          identityEmail: "jack@example.com",
          relationId: jackTarget,
        });
        expect(linked.needsRoleAssignment).toBe(false);

        // 5. list_pending_members (listPendingRoleAssignments): ivy shows up
        //    (needs_role_assignment, linked) — note admin's OWN identity is
        //    also JIT-created here and therefore also pending, since the flag
        //    is about how the Relation came to exist, not about the JWT's
        //    roles. Jack does not show up (still pending_confirmation, never
        //    linked at all).
        const pending = await listPendingRoleAssignments(appDb, adminInA.session);
        expect(pending.map((row) => row.identityId)).not.toContain(jackFirst.state!.identityId);
        const ivyPending = pending.find((row) => row.identityId === first.state!.identityId);
        expect(ivyPending).toMatchObject({
          identityId: first.state!.identityId,
          relationId: first.state!.relationId,
          email: "ivy@example.com",
        });

        // Gated the same way link_identity is: a non-admin session is refused.
        const plainSession = sessionFor(person("plain"), tenantA);
        await expect(listPendingRoleAssignments(appDb, plainSession)).rejects.toMatchObject({
          code: "FORBIDDEN",
        });

        // 6. identityIdForRelation / identityKeycloakSubject: what
        //    set_member_role resolves before calling the Keycloak admin API.
        const resolvedIdentityId = await identityIdForRelation(
          appDb,
          adminInA.session,
          first.state!.relationId!,
        );
        expect(resolvedIdentityId).toBe(first.state!.identityId);
        const subject = await identityKeycloakSubject(appDb, adminInA.session, first.state!.identityId);
        expect(subject).toEqual({ issuer: ISSUER, subject: ivy.claims.subject });

        // 7. clearNeedsRoleAssignment: what set_member_role does after granting
        //    the real Keycloak role. Idempotent, tenant-scoped, and it
        //    invalidates the cache so the NEXT session re-reads the flag.
        await clearNeedsRoleAssignment(appDb, adminInA.session, first.state!.identityId);
        const clearedRow = (
          await sql<{ needs_role_assignment: boolean }>`
            select needs_role_assignment from platform.identity_relations
             where identity_id = ${first.state!.identityId} and tenant_id = ${tenantA}
          `.execute(adminDb)
        ).rows[0]!;
        expect(clearedRow.needs_role_assignment).toBe(false);

        __resetIdentityLinkForTests();
        const third = await signIn(appDb, ivy, tenantA);
        expect(third.state!.needsRoleAssignment).toBe(false);
        expect(
          (await listPendingRoleAssignments(appDb, adminInA.session)).map((row) => row.identityId),
        ).not.toContain(first.state!.identityId);

        // Clearing again is a no-op, not an error.
        await expect(
          clearNeedsRoleAssignment(appDb, adminInA.session, first.state!.identityId),
        ).resolves.toBeUndefined();

        // Cross-tenant: an administrator of B never sees A's pending members
        // (only their own tenant's — here, their own JIT-created identity).
        const adminInB = await signIn(appDb, person("admin2", ADMIN_ROLES), tenantB);
        const pendingInB = await listPendingRoleAssignments(appDb, adminInB.session);
        expect(pendingInB.map((row) => row.identityId)).not.toContain(first.state!.identityId);
        expect(pendingInB.every((row) => row.identityId !== jackFirst.state!.identityId)).toBe(true);
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "set_member_role grants the Keycloak role, then forces the person to sign in again",
    async () => {
      const previousEnv = {
        OPENSHAPEFORGE_CONTROL_KEYCLOAK_BASE_URL: process.env.OPENSHAPEFORGE_CONTROL_KEYCLOAK_BASE_URL,
        KEYCLOAK_CLIENT_SECRET_OPENSHAPEFORGE_AUTH_API:
          process.env.KEYCLOAK_CLIENT_SECRET_OPENSHAPEFORGE_AUTH_API,
        OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_ISSUER:
          process.env.OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_ISSUER,
        OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_JWKS_URI:
          process.env.OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_JWKS_URI,
        OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_CLIENT_ID:
          process.env.OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_CLIENT_ID,
        OPENSHAPEFORGE_PUBLIC_ORIGIN: process.env.OPENSHAPEFORGE_PUBLIC_ORIGIN,
      };
      const originalFetch = globalThis.fetch;
      process.env.OPENSHAPEFORGE_CONTROL_KEYCLOAK_BASE_URL = "http://keycloak.test:8080";
      process.env.KEYCLOAK_CLIENT_SECRET_OPENSHAPEFORGE_AUTH_API = "test-secret";
      process.env.OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_ISSUER = "http://keycloak.test:8080/realms/control";
      process.env.OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_JWKS_URI =
        "http://keycloak.test:8080/realms/control/protocol/openid-connect/certs";
      process.env.OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_CLIENT_ID = "operator-gateway";
      process.env.OPENSHAPEFORGE_PUBLIC_ORIGIN = "https://tenant.example.com";

      // Records every admin-API call so the test can assert BOTH that the
      // logout happens (not just that it doesn't blow up) AND that it happens
      // strictly after the role-mapping POST, not before or instead of it.
      const calls: Array<{ url: string; method: string }> = [];
      globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
        const url = String(input);
        const method = init.method ?? "GET";
        if (url.includes("/protocol/openid-connect/token")) {
          return Response.json({ access_token: "service-account-token", expires_in: 900 });
        }
        calls.push({ url, method });
        if (url.endsWith("/clients?clientId=erp-provider")) {
          return Response.json([{ id: "erp-provider-uuid", clientId: "erp-provider" }]);
        }
        if (url.endsWith("/clients/erp-provider-uuid/roles")) {
          return Response.json([{ id: "role-1", name: "General.All.Read" }]);
        }
        if (url.includes("/role-mappings/clients/erp-provider-uuid") && method === "POST") {
          return new Response(null, { status: 204 });
        }
        if (url.endsWith("/logout") && method === "POST") {
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected admin call in test: ${method} ${url}`);
      }) as unknown as typeof globalThis.fetch;

      try {
        await withScratchDb(async (appDb, adminDb) => {
          await seedTenants(adminDb);
          const admin = person("mallory-admin", ADMIN_ROLES);
          const nora = person("nora");

          const adminSignIn = await signIn(appDb, admin, tenantA);
          const noraSignIn = await signIn(appDb, nora, tenantA);
          expect(noraSignIn.state!.needsRoleAssignment).toBe(true);

          const result = await callIdentityLinkTool(
            "set_member_role",
            { identityId: noraSignIn.state!.identityId, role: "org_employee" },
            appDb,
            adminSignIn.session,
          );

          expect(result?.isError).not.toBe(true);
          expect(result?.structuredContent).toMatchObject({
            granted: true,
            role: "org_employee",
            forcedReauthentication: true,
          });

          // The role-mapping POST and the logout POST both happened, and the
          // logout came strictly after the grant — set_member_role must not
          // end the person's session before their new role is actually on it.
          const roleMappingIndex = calls.findIndex(
            (call) =>
              call.url.includes("/role-mappings/clients/erp-provider-uuid") &&
              call.method === "POST",
          );
          const logoutIndex = calls.findIndex(
            (call) => call.url.endsWith("/logout") && call.method === "POST",
          );
          expect(roleMappingIndex).toBeGreaterThanOrEqual(0);
          expect(logoutIndex).toBeGreaterThan(roleMappingIndex);
          expect(calls[logoutIndex]!.url).toBe(
            `http://keycloak.test:8080/admin/realms/openshapeforge/users/${nora.claims.subject}/logout`,
          );

          // And the durable side effect (the flag) is cleared regardless of
          // the logout outcome, since it is not part of the same transaction.
          const clearedRow = (
            await sql<{ needs_role_assignment: boolean }>`
              select needs_role_assignment from platform.identity_relations
               where identity_id = ${noraSignIn.state!.identityId} and tenant_id = ${tenantA}
            `.execute(adminDb)
          ).rows[0]!;
          expect(clearedRow.needs_role_assignment).toBe(false);
        });
      } finally {
        globalThis.fetch = originalFetch;
        for (const [key, value] of Object.entries(previousEnv)) {
          if (value === undefined) delete (process.env as Record<string, string | undefined>)[key];
          else process.env[key] = value;
        }
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "set_member_role still reports the grant as successful when forcing re-authentication fails",
    async () => {
      const previousEnv = {
        OPENSHAPEFORGE_CONTROL_KEYCLOAK_BASE_URL: process.env.OPENSHAPEFORGE_CONTROL_KEYCLOAK_BASE_URL,
        KEYCLOAK_CLIENT_SECRET_OPENSHAPEFORGE_AUTH_API:
          process.env.KEYCLOAK_CLIENT_SECRET_OPENSHAPEFORGE_AUTH_API,
        OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_ISSUER:
          process.env.OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_ISSUER,
        OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_JWKS_URI:
          process.env.OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_JWKS_URI,
        OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_CLIENT_ID:
          process.env.OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_CLIENT_ID,
        OPENSHAPEFORGE_PUBLIC_ORIGIN: process.env.OPENSHAPEFORGE_PUBLIC_ORIGIN,
      };
      const originalFetch = globalThis.fetch;
      process.env.OPENSHAPEFORGE_CONTROL_KEYCLOAK_BASE_URL = "http://keycloak.test:8080";
      process.env.KEYCLOAK_CLIENT_SECRET_OPENSHAPEFORGE_AUTH_API = "test-secret";
      process.env.OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_ISSUER = "http://keycloak.test:8080/realms/control";
      process.env.OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_JWKS_URI =
        "http://keycloak.test:8080/realms/control/protocol/openid-connect/certs";
      process.env.OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_CLIENT_ID = "operator-gateway";
      process.env.OPENSHAPEFORGE_PUBLIC_ORIGIN = "https://tenant.example.com";

      globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
        const url = String(input);
        const method = init.method ?? "GET";
        if (url.includes("/protocol/openid-connect/token")) {
          return Response.json({ access_token: "service-account-token", expires_in: 900 });
        }
        if (url.endsWith("/clients?clientId=erp-provider")) {
          return Response.json([{ id: "erp-provider-uuid", clientId: "erp-provider" }]);
        }
        if (url.endsWith("/clients/erp-provider-uuid/roles")) {
          return Response.json([{ id: "role-1", name: "General.All.Read" }]);
        }
        if (url.includes("/role-mappings/clients/erp-provider-uuid") && method === "POST") {
          return new Response(null, { status: 204 });
        }
        if (url.endsWith("/logout") && method === "POST") {
          // Simulate a Keycloak hiccup on the logout call specifically.
          return Response.json({ error: "server_error" }, { status: 500 });
        }
        throw new Error(`Unexpected admin call in test: ${method} ${url}`);
      }) as unknown as typeof globalThis.fetch;

      try {
        await withScratchDb(async (appDb, adminDb) => {
          await seedTenants(adminDb);
          const admin = person("oswald-admin", ADMIN_ROLES);
          const paula = person("paula");

          const adminSignIn = await signIn(appDb, admin, tenantA);
          const paulaSignIn = await signIn(appDb, paula, tenantA);

          const result = await callIdentityLinkTool(
            "set_member_role",
            { identityId: paulaSignIn.state!.identityId, role: "org_employee" },
            appDb,
            adminSignIn.session,
          );

          // The role grant itself succeeded, so the tool call is NOT an
          // error — a failed best-effort logout must never roll this back.
          expect(result?.isError).not.toBe(true);
          expect(result?.structuredContent).toMatchObject({
            granted: true,
            forcedReauthentication: false,
          });

          const clearedRow = (
            await sql<{ needs_role_assignment: boolean }>`
              select needs_role_assignment from platform.identity_relations
               where identity_id = ${paulaSignIn.state!.identityId} and tenant_id = ${tenantA}
            `.execute(adminDb)
          ).rows[0]!;
          expect(clearedRow.needs_role_assignment).toBe(false);
        });
      } finally {
        globalThis.fetch = originalFetch;
        for (const [key, value] of Object.entries(previousEnv)) {
          if (value === undefined) delete (process.env as Record<string, string | undefined>)[key];
          else process.env[key] = value;
        }
      }
    },
    TEST_TIMEOUT,
  );
});
