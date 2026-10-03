// SPDX-License-Identifier: BUSL-1.1
import { sql } from 'kysely';
import type { ModuleOperationHandler } from '../modules/contract.js';
import { UUID_PATTERN, withDbSession, registerDbSessionAfterCommit } from '../db/session.js';
import { HttpError } from '../rest/http-error.js';
import { protectDirectAdministrator } from '../auth/member-administrator.js';
import { appendScopedEntityEventInTransaction } from '../platform/entity-events.js';
import { invalidateIdentityLink } from '../auth/identity-link-session.js';
import { IDENTITY_LINK_ADMIN_ROLE } from '../auth/organization-roles.js';
import { accountSession } from './account-session.js';
import { accessSession, guarded } from './custom-roles.js';
import { roleCatalog } from './roles.js';
import { customRoleId } from './access-policy.js';
import { assertCurrentAccountAuthority } from './account-current-authority.js';
import { writeMembershipRoles } from '../auth/identity-link-store.js';

/** Opaque optimistic revision, including microseconds without browser timestamp rounding. */
export const accountRevision = sql<string>`md5(extract(epoch from ir.updated_at)::text || ':' || ir.status || ':' || ir.access_blocked::text || ':' || array_to_string(ir.roles, ','))`;
type Member = { issuer: string; subject: string; roles: string[]; access_blocked: boolean; needs_role_assignment: boolean; revision: string };

function change(kind: 'block' | 'restore' | 'assignRole' | 'revokeRole'): ModuleOperationHandler {
  return guarded(async (input, context) => {
    // Role assignment belongs to the existing access-administrator contract;
    // Account state management alone must never confer another permission.
    const session = kind === 'assignRole' || kind === 'revokeRole'
      ? accessSession(context) : accountSession(context, 'manage');
    if (typeof input.id !== 'string' || !UUID_PATTERN.test(input.id)) throw new HttpError(400, 'VALIDATION', 'Select an account.');
    if (typeof input.revision !== 'string' || !/^[a-f0-9]{32}$/.test(input.revision)) throw new HttpError(400, 'VALIDATION', 'Read the current account revision first.');
    const id = input.id, revision = input.revision;
    const result = await withDbSession(context.db!, session, async tx => {
      // Same lock order as existing account mutations: serialize last-admin decisions before row locks.
      await sql`select pg_advisory_xact_lock(hashtextextended(${session.tenantId}, 7921))`.execute(tx);
      await assertCurrentAccountAuthority(context.db!, tx, session,
        kind === 'assignRole' || kind === 'revokeRole' ? IDENTITY_LINK_ADMIN_ROLE : 'Organization.Accounts.Manage');
      const rows = await sql<Member>`select i.issuer,i.subject,ir.roles,ir.access_blocked,ir.needs_role_assignment,${accountRevision} as revision
        from platform.identity_relations ir join platform.identities i on i.id=ir.identity_id
        where ir.tenant_id=${session.tenantId}::uuid and ir.identity_id=${id}::uuid and ir.status='linked'
        for update of ir`.execute(tx);
      const member = rows.rows[0];
      if (!member) throw new HttpError(404, 'NOT_FOUND', 'Linked account not found in this organization.');
      if (member.revision !== revision) throw new HttpError(409, 'VERSION_CONFLICT', 'The account changed. Read it again before continuing.');
      if ((kind === 'block' && member.access_blocked) || (kind === 'restore' && !member.access_blocked)) {
        throw new HttpError(409, 'INVALID_STATE', 'Organization access is already in that state. Read the account again.');
      }
      let roles = member.roles, blocked = member.access_blocked;
      if (kind === 'block' || kind === 'restore') {
        blocked = kind === 'block';
        if (blocked && member.subject === session.userId && member.issuer === session.issuer) throw new HttpError(409, 'SELF_BLOCK', 'You cannot block your own organization access.');
        if (blocked && !member.access_blocked) await protectDirectAdministrator(tx, session.tenantId, id, []);
      } else {
        const key = input.roleKey;
        if (typeof key !== 'string') throw new HttpError(400, 'VALIDATION', 'Choose a role from this organization.');
        const custom = customRoleId(key);
        // Catalog membership is read-only authority. FOR SHARE also applies the
        // catalog UPDATE policy and would wrongly require role-definition management.
        // Custom role definitions cannot currently be deleted through an Operation.
        const known = custom ? (await sql`select id from platform.organization_access_roles where tenant_id=${session.tenantId}::uuid and id=${custom}::uuid`.execute(tx)).rows.length > 0
          : roleCatalog(session.locale).some(role => role.key === key);
        if (!known) throw new HttpError(400, 'VALIDATION', 'Choose a role from this organization.');
        roles = kind === 'assignRole' ? [...new Set([...roles, key])].sort() : roles.filter(role => role !== key);
        await protectDirectAdministrator(tx, session.tenantId, id, roles);
      }
      const roleChange = kind === 'assignRole' || kind === 'revokeRole';
      const updated = blocked !== member.access_blocked || JSON.stringify([...roles].sort()) !== JSON.stringify([...member.roles].sort())
        || (roleChange && member.needs_role_assignment);
      if (updated) {
        if (roleChange) await writeMembershipRoles(tx, session.tenantId, id, roles);
        else await sql`update platform.identity_relations set access_blocked=${blocked},updated_at=clock_timestamp()
          where tenant_id=${session.tenantId}::uuid and identity_id=${id}::uuid`.execute(tx);
        await appendScopedEntityEventInTransaction(tx, { aggregateType: 'Account', aggregateId: id, eventType: 'updated',
          payload: { action: kind, actor: session.userId, ...(typeof input.roleKey === 'string' ? { role: input.roleKey } : {}) } });
        registerDbSessionAfterCommit(() => invalidateIdentityLink(member.issuer, member.subject, session.tenantId));
      }
      return { issuer: member.issuer, subject: member.subject, updated };
    });
    return { value: { updated: result.updated } };
  });
}
export const blockOrganizationAccount = change('block');
export const restoreOrganizationAccount = change('restore');
export const assignOrganizationAccountRole = change('assignRole');
export const revokeOrganizationAccountRole = change('revokeRole');
