// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { DB } from "../../generated/db/types.js";
import { createDatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import { APP_ROLE } from "../migrations/app-role.js";
import { inviteEmployee } from "../../auth/employee-invitations.js";
import { callEmployeeInvitationTool, INVITE_EMPLOYEE_TOOL } from "../../mcp/employee-invitation-tools.js";
import { __resetIdentityLinkForTests, resolveIdentityLink } from "../../auth/identity-link.js";
import type { KeycloakOrganizationMembersClient } from "../../control/keycloak-organization-members.js";

const adminUrl = process.env.SCRATCH_ADMIN_DATABASE_URL ?? "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
async function scratch(run: (app: Kysely<DB>, admin: Kysely<DB>) => Promise<void>) {
  const name = `invitation_target_${randomUUID().replaceAll("-", "")}`;
  const server = new SQL(adminUrl, { max: 1 });
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  let admin: ReturnType<typeof createDatabaseRuntime> | undefined;
  let app: ReturnType<typeof createDatabaseRuntime> | undefined;
  try {
    await server.unsafe(`create database "${name}"`);
    admin = createDatabaseRuntime({ databaseUrl: url.toString(), maxConnections: 2 });
    await admin.db.connection().execute(trx => runMigrationChain(trx));
    url.username = APP_ROLE;
    url.password = "openshapeforge_app";
    app = createDatabaseRuntime({ databaseUrl: url.toString(), maxConnections: 2 });
    await run(app.db, admin.db);
  } finally {
    await app?.close();
    await admin?.close();
    await server.unsafe(`drop database if exists "${name}" with (force)`);
    await server.close();
  }
}
function keycloak() {
  const calls: string[] = [];
  const client = {
    hasMemberByEmail: async () => false,
    findPendingInvitationByEmail: async () => null,
    inviteUser: async (_organization: string, input: { email: string }) => { calls.push(input.email); },
  } as unknown as KeycloakOrganizationMembersClient;
  return { client, calls };
}
function session(tenantId: string, admin = false) {
  return { tenantId, userId: randomUUID(), roles: admin ? ["Organization.All.ReadWrite", "Relations.All.ReadWrite"] : [], groups: [], scope: "self" as const };
}
async function tenant(db: Kysely<DB>) {
  const id = randomUUID();
  await sql`insert into platform.tenants (id, slug, name, status, keycloak_organization_id, keycloak_realm)
    values (${id}, ${id}, 'Test organization', 'active', ${`kc-${id}`}, 'openshapeforge')`.execute(db);
  return id;
}
async function relation(db: Kysely<DB>, tenantId: string, email?: string) {
  const id = randomUUID();
  await sql`insert into erp.relations (id, tenant_id, display_name, relation_type, status)
    values (${id}, ${tenantId}, 'Existing person', 'person', 'active')`.execute(db);
  if (email) await sql`insert into erp.contact_details (tenant_id, relation_id, type, value, is_primary)
    values (${tenantId}, ${id}, 'email', ${email}, true)`.execute(db);
  return id;
}

test("a relation invitation rejects a different tenant before sending mail", () => scratch(async (app, db) => {
  const own = await tenant(db), other = await tenant(db);
  const foreignRelation = await relation(db, other);
  const kc = keycloak();
  await expect(inviteEmployee(app, session(own, true), kc.client, {
    relationId: foreignRelation, email: "scope@example.test", role: "org_employee",
  })).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  expect(kc.calls).toEqual([]);
  expect((await sql`select id from platform.employee_invitations`.execute(db)).rows).toHaveLength(0);
}), 120_000);

test("first login honors the explicitly invited relation over email candidates without duplicating a relation", () => scratch(async (app, db) => {
  const own = await tenant(db), other = await tenant(db);
  const email = "Invited@Example.test";
  const target = await relation(db, own);
  const candidate = await relation(db, own, email);
  const foreignCandidate = await relation(db, other, email);
  const kc = keycloak();
  await inviteEmployee(app, session(own, true), kc.client, { relationId: target, email, role: "org_employee" });
  const claims = { issuer: "https://identity.example.test/realms/test", subject: randomUUID(), email: email.toLowerCase(), name: "Invited Person" };
  const login = session(own);
  login.userId = claims.subject;
  __resetIdentityLinkForTests();
  const first = await resolveIdentityLink(app, login, claims);
  expect(first).toMatchObject({ status: "linked", relationId: target, needsRoleAssignment: false });
  expect(first?.relationId).not.toBe(candidate);
  __resetIdentityLinkForTests();
  expect(await resolveIdentityLink(app, login, claims)).toMatchObject({ status: "linked", relationId: target });
  expect((await sql`select id from erp.relations where tenant_id = ${own}`.execute(db)).rows).toHaveLength(2);
  expect((await sql`select relation_id from platform.identity_relations where tenant_id = ${own}`.execute(db)).rows)
    .toEqual([{ relation_id: target }]);
  expect((await sql`select status from platform.employee_invitations where tenant_id = ${own}`.execute(db)).rows)
    .toEqual([{ status: "accepted" }]);
  __resetIdentityLinkForTests();
  expect(await resolveIdentityLink(app, { ...login, tenantId: other }, claims)).toMatchObject({
    status: "pending_confirmation", relationId: null, candidateRelationId: foreignCandidate,
  });
}), 120_000);

test("an existing linked account cannot be invited onto a different relation", () => scratch(async (app, db) => {
  const own = await tenant(db);
  const original = await relation(db, own), other = await relation(db, own);
  const kc = keycloak(), admin = session(own, true);
  const email = "linked@example.test";
  await inviteEmployee(app, admin, kc.client, { relationId: original, email, role: "org_employee" });
  const login = session(own);
  const claims = { issuer: "https://identity.example.test/realms/test", subject: login.userId, email, name: "Linked Person" };
  __resetIdentityLinkForTests();
  const state = await resolveIdentityLink(app, login, claims);
  const callsBefore = kc.calls.length;
  await expect(inviteEmployee(app, admin, kc.client, { relationId: other, email, role: "org_admin" }))
    .rejects.toMatchObject({ status: 409, code: "CONFLICT" });
  expect(kc.calls).toHaveLength(callsBefore);
  __resetIdentityLinkForTests();
  const after = await resolveIdentityLink(app, login, claims);
  expect(after?.relationId).toBe(original);
  expect(after?.roles).toEqual(state?.roles);
}), 120_000);

test("invite_employee links the invitation to the Relation the assistant just created", () => scratch(async (app, db) => {
  const own = await tenant(db), other = await tenant(db);
  const created = await relation(db, own);
  const foreign = await relation(db, other);
  const kc = keycloak();
  const admin = { ...session(own, true), credential: "trusted-context" as const };
  const refused = await callEmployeeInvitationTool(INVITE_EMPLOYEE_TOOL, {
    email: "foreign@example.test", role: "org_employee", relationId: foreign,
  }, app as never, admin, kc.client);
  expect(refused?.isError).toBe(true);
  expect(kc.calls).toEqual([]);
  const admitted = await callEmployeeInvitationTool(INVITE_EMPLOYEE_TOOL, {
    email: "linked@example.test", role: "org_employee", relationId: created,
  }, app as never, admin, kc.client);
  expect(admitted?.isError).toBeFalsy();
  const rows = (await sql<{ relation_id: string | null }>`select relation_id from platform.employee_invitations
    where lower(email) = 'linked@example.test'`.execute(db)).rows;
  expect(rows).toEqual([{ relation_id: created }]);
}), 120_000);
