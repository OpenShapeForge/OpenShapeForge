// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import { createDatabaseRuntime, type DatabaseRuntime } from "../../db/connection.js";
import { applyAppHelpersMigration } from "../../db/migrations/app-helpers.js";
import { applyEmployeeInvitationsMigration } from "../../db/migrations/employee-invitations.js";
import { applyGeneratedTables } from "../../db/__tests__/__fixtures__/generated-tables.js";
import { inviteEmployee } from "../../auth/employee-invitations.js";
import { manageTenantInvitations } from "../tenant-invitations.js";
import {
  invitationDeliveryUnconfirmed,
  inviteFirstTenantAdministrator,
  KeycloakInvitationDiagnosticError,
  type FirstAdministratorClients,
} from "../first-tenant-administrator.js";
import { KeycloakAdminError } from "../keycloak-organization-admin.js";
import type { PlatformAdministrator } from "../platform-admin.js";

// Explicit disposable database only: never fall back to a developer's DATABASE_URL.
// Run against a fresh local Postgres database named bootstrap_proof.
const url = process.env.FIRST_ADMIN_PROOF_DATABASE_URL;
if (url && (!['localhost', '127.0.0.1'].includes(new URL(url).hostname) || new URL(url).pathname !== '/bootstrap_proof'))
  throw new Error('FIRST_ADMIN_PROOF_DATABASE_URL must address a disposable local bootstrap_proof database.');
const administrator: PlatformAdministrator = {
  subject: 'operator', issuer: 'https://identity.example/realms/control', username: 'platform-admin',
  name: null, email: null, authorizedParty: 'platform-mcp', expiresAtMs: Date.now() + 60000,
};

describe("first tenant administrator error boundary", () => {
  it("logs only safe Keycloak subcall metadata and preserves the public error", () => {
    const logged: unknown[] = [];
    const publicError = invitationDeliveryUnconfirmed(
      new KeycloakAdminError(
        "KEYCLOAK_ADMIN_UNAVAILABLE",
        "private@example.com at https://keycloak/private-org",
        503,
        { operation: "invite_member", durationMs: 10_004 },
      ),
      (error) => logged.push(error),
      "mcp-request-42",
    );

    expect(publicError).toMatchObject({ code: "INVITATION_DELIVERY_UNCONFIRMED" });
    expect(logged[0]).toBeInstanceOf(KeycloakInvitationDiagnosticError);
    expect(logged[0]).toMatchObject({
      code: "KEYCLOAK_ADMIN_UNAVAILABLE",
      operation: "invite_member",
      durationMs: 10_004,
      status: 503,
      correlationId: "mcp-request-42",
      message: "Keycloak invitation subcall failed.",
    });
    expect(JSON.stringify(logged[0])).not.toContain("private");
    expect(JSON.stringify(logged[0])).not.toContain("keycloak/private-org");
  });
});

describe.skipIf(!url)('first tenant administrator (real PostgreSQL, stubbed Keycloak)', () => {
  let owner: DatabaseRuntime;
  let runtime: DatabaseRuntime;
  let clients: FirstAdministratorClients;
  let sends: string[];
  let pending: Set<string>;
  let admins: { email: string | null }[];
  let smtp: boolean;
  let deliveryFails: boolean;
  const invite = (email = 'admin@example.com', slug = 'acme') => inviteFirstTenantAdministrator({
    db: runtime.db, administrator, firstAdministrator: clients,
  }, { slug, email });

  beforeAll(async () => {
    owner = createDatabaseRuntime({ databaseUrl: url! });
    // No IF NOT EXISTS: refuse a reused/nonempty fixture rather than overwrite it.
    await sql`create schema platform; create table platform.tenants (
      id uuid primary key default gen_random_uuid(), slug text unique not null, status text not null,
      keycloak_realm text, keycloak_organization_id text
    )`.execute(owner.db);
    await applyAppHelpersMigration(owner.db);
    // Both tables come from the manifest; the invitations migration file owns
    // only the checks, the pending-address index and the policy.
    await applyGeneratedTables(owner.db, [
      "platform.system_bypass_audit",
      "platform.employee_invitations",
    ]);
    await applyEmployeeInvitationsMigration(owner.db);
    await sql`create role bootstrap_runtime login;
      grant usage on schema platform, app to bootstrap_runtime;
      grant select, insert, update on all tables in schema platform to bootstrap_runtime;
      alter table platform.tenants enable row level security;
      alter table platform.tenants force row level security;
      create policy tenant_fence on platform.tenants using (app.bypass_rls() or id = app.current_tenant());
    `.execute(owner.db);
    const restricted = new URL(url!); restricted.username = 'bootstrap_runtime'; restricted.password = '';
    runtime = createDatabaseRuntime({ databaseUrl: restricted.toString() });
  });
  afterAll(async () => { await runtime?.close(); await owner?.close(); });
  beforeEach(async () => {
    await sql`truncate platform.employee_invitations, platform.tenants, platform.system_bypass_audit;
      insert into platform.tenants (slug, status, keycloak_realm, keycloak_organization_id)
      values ('acme', 'active', 'tenant', 'org-acme'), ('other', 'active', 'tenant', 'org-other')`.execute(owner.db);
    sends = []; pending = new Set(); admins = []; smtp = true; deliveryFails = false;
    clients = {
      tenantRealm: 'tenant',
      organizations: { getOrganization: async id => ({ id, alias: id.slice(4), name: id, enabled: true }) },
      members: {
        hasMemberByEmail: async (_id, email) => admins.some(admin => admin.email?.toLowerCase() === email.toLowerCase()),
        hasInvitationMailConfiguration: async () => smtp,
        organizationAdministrators: async () => admins,
        findPendingInvitationByEmail: async (id, email) => pending.has(`${id}:${email}`) ? { id: 'invite', email } as never : null,
        inviteUser: async (id, input) => {
          if (deliveryFails) throw new KeycloakAdminError('KEYCLOAK_ADMIN_UNAVAILABLE', 'SMTP rejected the message');
          sends.push(`${id}:${input.email}`); pending.add(`${id}:${input.email}`);
        },
        listInvitations: async id => [...pending].filter(value => value.startsWith(`${id}:`)).map(value => ({
          id: `${id}-invite`, email: value.slice(id.length + 1), firstName: null, lastName: null,
          status: 'PENDING', sentDate: 1788647960, expiresAt: 1788691160,
        })),
        deleteInvitation: async id => {
          for (const value of pending) if (value.startsWith(`${id}:`)) pending.delete(value);
          return true;
        },
        resendInvitation: async id => {
          if (deliveryFails) throw new KeycloakAdminError('KEYCLOAK_ADMIN_UNAVAILABLE', 'mail failed');
          sends.push(`resent:${id}`);
        },
      },
    };
  });

  it('records only the requested tenant and deferred org_admin role; preserves control identity and replay', async () => {
    const first = await invite(' Admin@Example.com ');
    expect(first.status).toBe('pending');
    expect(await invite()).toEqual(first);
    expect(sends).toEqual(['org-acme:admin@example.com']);
    const rows = (await sql<any>`select i.*, t.slug from platform.employee_invitations i join platform.tenants t on t.id=i.tenant_id`.execute(owner.db)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ slug: 'acme', role: 'org_admin', invited_by: `${administrator.issuer}#operator` });
    const audit = (await sql<any>`select * from platform.system_bypass_audit`.execute(owner.db)).rows;
    expect(audit).toHaveLength(2);
    expect(audit.every(a => a.tenant_id === null && a.succeeded && a.actor_subject === `${administrator.issuer}#operator (platform-admin)` && a.reason === 'platform-mcp: control.invite-first-tenant-admin acme')).toBe(true);
    expect((await sql`select * from platform.employee_invitations`.execute(runtime.db)).rows).toHaveLength(0);
  });
  it('serializes concurrent same-address retries to one mail and one invitation', async () => {
    const results = await Promise.all([invite(), invite(), invite()]);
    expect(results[1]).toEqual(results[0]); expect(results[2]).toEqual(results[0]);
    expect(sends).toHaveLength(1);
  });
  it('serializes competing first admins, while allowing a separate tenant bootstrap', async () => {
    const results = await Promise.allSettled([invite(), invite('second@example.com')]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(sends).toHaveLength(1);
    await invite('second@example.com', 'other');
    expect(sends[1]).toBe('org-other:second@example.com');
  });
  it('refuses missing SMTP without persisting an invitation', async () => {
    smtp = false;
    await expect(invite()).rejects.toMatchObject({ code: 'SMTP_NOT_CONFIGURED' });
    expect(sends).toHaveLength(0);
    expect((await sql`select * from platform.employee_invitations`.execute(owner.db)).rows).toHaveLength(0);
  });
  it('does not claim success or persist intent when Keycloak fails delivery', async () => {
    deliveryFails = true;
    await expect(invite()).rejects.toMatchObject({ code: 'INVITATION_DELIVERY_UNCONFIRMED' });
    expect((await sql`select * from platform.employee_invitations`.execute(owner.db)).rows).toHaveLength(0);
    expect((await sql<any>`select succeeded from platform.system_bypass_audit`.execute(owner.db)).rows[0].succeeded).toBe(false);
  });
  it('recovers an existing remote invitation without resending', async () => {
    pending.add('org-acme:admin@example.com'); smtp = false;
    expect((await invite()).status).toBe('pending'); expect(sends).toHaveLength(0);
    expect((await sql`select * from platform.employee_invitations`.execute(owner.db)).rows).toHaveLength(1);
  });
  it('refuses an existing different administrator; same administrator gets local admission without mail', async () => {
    admins = [{ email: 'someone@example.com' }];
    await expect(invite()).rejects.toMatchObject({ code: 'FIRST_ADMIN_ALREADY_ASSIGNED' });
    admins = [{ email: 'admin@example.com' }];
    expect((await invite()).status).toBe('pending'); expect(sends).toHaveLength(0);
    expect((await sql<any>`select email, role, status from platform.employee_invitations`.execute(owner.db)).rows)
      .toEqual([{ email: 'admin@example.com', role: 'org_admin', status: 'pending' }]);
  });
  it('does not elevate a pending employee invitation', async () => {
    await sql`insert into platform.employee_invitations (tenant_id,email,role,invited_by)
      select id,'admin@example.com','org_employee','tenant-admin' from platform.tenants where slug='acme'`.execute(owner.db);
    await expect(invite()).rejects.toMatchObject({ code: 'FIRST_ADMIN_ALREADY_ASSIGNED' });
    expect(sends).toHaveLength(0);
  });
  it('rejects missing, inactive, wrong-realm and mismatched organizations', async () => {
    await expect(invite('admin@example.com','missing')).rejects.toMatchObject({ code: 'TENANT_NOT_FOUND' });
    await sql`update platform.tenants set status='suspended' where slug='acme'`.execute(owner.db);
    await expect(invite()).rejects.toMatchObject({ code: 'TENANT_NOT_READY' });
    await sql`update platform.tenants set status='active',keycloak_realm='control' where slug='acme'`.execute(owner.db);
    await expect(invite()).rejects.toMatchObject({ code: 'TENANT_NOT_READY' });
    await sql`update platform.tenants set keycloak_realm='tenant',keycloak_organization_id='org-other' where slug='acme'`.execute(owner.db);
    await expect(invite()).rejects.toMatchObject({ code: 'TENANT_NOT_READY' });
    expect(sends).toHaveLength(0);
  });
  it('leaves the ordinary invitation org_admin gate intact', async () => {
    await expect(inviteEmployee(runtime.db, { roles: ['platform-operator'] } as never, clients.members,
      { email: 'admin@example.com', role: 'org_admin' })).rejects.toMatchObject({ status: 403 });
    expect(sends).toHaveLength(0);
  });

  const manage = (
    action: 'list' | 'revoke' | 'resend',
    invitationId?: string,
    slug = 'acme',
  ) => manageTenantInvitations(
    { db: runtime.db, administrator, firstAdministrator: clients },
    action,
    { slug, ...(invitationId ? { invitationId } : {}) },
  );

  it('lists provider state with its stored role and no redeemable link', async () => {
    await invite();
    const result = await manage('list') as any;
    expect(result.invitations).toHaveLength(1);
    expect(result.invitations[0]).toMatchObject({
      email: 'admin@example.com', role: 'org_admin', canResend: true, canRevoke: true,
      sentAt: '2026-09-05T22:39:20.000Z', expiresAt: '2026-09-06T10:39:20.000Z',
    });
    expect(JSON.stringify(result)).not.toContain('inviteLink');
    const audit = (await sql<any>`select reason, actor_subject from platform.system_bypass_audit order by started_at desc limit 1`.execute(owner.db)).rows[0];
    expect(audit).toMatchObject({
      reason: 'platform-mcp: control.list-tenant-invitations acme',
      actor_subject: `${administrator.issuer}#operator (platform-admin)`,
    });
  });

  it('keeps expired provider history readable without offering an invalid revoke', async () => {
    pending.add('org-acme:expired@example.com');
    clients.members.listInvitations = async () => [{
      id: 'expired-invite', email: 'expired@example.com', firstName: null, lastName: null,
      status: 'EXPIRED', sentDate: 1788647960, expiresAt: 1788691160,
    }];
    const result = await manage('list') as any;
    expect(result.invitations[0]).toMatchObject({
      invitationId: 'expired-invite', status: 'EXPIRED', canResend: false, canRevoke: false,
    });
  });

  it('revokes provider and local intent, then permits a replacement administrator', async () => {
    await invite();
    await manage('revoke', 'org-acme-invite');
    expect(pending.size).toBe(0);
    expect((await sql<any>`select status from platform.employee_invitations`.execute(owner.db)).rows[0].status)
      .toBe('revoked');
    expect((await invite('replacement@example.com')).status).toBe('pending');
  });

  it('resends without changing recipient, role or stored invitation', async () => {
    const original = await invite();
    expect(await manage('resend', 'org-acme-invite')).toMatchObject({
      status: 'resent', email: 'admin@example.com', role: 'org_admin',
    });
    expect(await invite()).toEqual(original);
    expect(sends).toEqual(['org-acme:admin@example.com', 'resent:org-acme']);
  });

  it('refuses foreign, stale, accepted and untracked invitations before mutation', async () => {
    await invite();
    await expect(manage('revoke', 'org-acme-invite', 'other'))
      .rejects.toMatchObject({ code: 'INVITATION_NOT_FOUND' });
    await expect(manage('resend', 'stale'))
      .rejects.toMatchObject({ code: 'INVITATION_NOT_FOUND' });
    pending.clear();
    pending.add('org-acme:untracked@example.com');
    await expect(manage('resend', 'org-acme-invite'))
      .rejects.toMatchObject({ code: 'INVITATION_ROLE_MISSING' });
    pending.clear();
    pending.add('org-acme:admin@example.com');
    await sql`update platform.employee_invitations set status='accepted', accepted_at=now()`.execute(owner.db);
    await expect(manage('revoke', 'org-acme-invite'))
      .rejects.toMatchObject({ code: 'INVITATION_ALREADY_ACCEPTED' });
  });

  it('reports missing provider state and never guesses acceptance', async () => {
    await invite();
    pending.clear();
    const result = await manage('list') as any;
    expect(result.invitations).toEqual([]);
    expect(result.unresolved[0]).toMatchObject({
      email: 'admin@example.com', status: 'provider_missing',
    });
    expect(sends).toHaveLength(1);
  });

  it('does not claim resend success after an uncertain provider response', async () => {
    await invite();
    deliveryFails = true;
    await expect(manage('resend', 'org-acme-invite'))
      .rejects.toMatchObject({ code: 'INVITATION_DELIVERY_UNCONFIRMED' });
    expect((await sql<any>`select status from platform.employee_invitations`.execute(owner.db)).rows[0].status)
      .toBe('pending');
  });
});
