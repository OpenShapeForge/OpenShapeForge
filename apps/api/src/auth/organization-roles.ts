// SPDX-License-Identifier: BUSL-1.1
/**
 * The two role names the organization-membership modules have to agree on,
 * and nothing else.
 *
 * They live in a leaf module on purpose. ./identity-link.ts and
 * ./employee-invitations.ts import each other — an invitation is what admits
 * a person, and admission is what accepts an invitation — and that cycle is
 * harmless for FUNCTIONS, which are read when they are called. It is not
 * harmless for a `const` that another module's own top-level `const` reads
 * while the first one is still evaluating: whichever of the two happens to be
 * imported first wins, and the other gets `ReferenceError: Cannot access
 * 'IDENTITY_LINK_ADMIN_ROLE' before initialization`. That is not a
 * hypothetical — it is what `EMPLOYEE_INVITATION_ROLE_GRANTS` did until these
 * two names moved down here, where nothing imports anything.
 *
 * Both are re-exported from ./identity-link.ts (and, for
 * NEEDS_ROLE_ASSIGNMENT_ROLES, from ./identity.ts) so no existing importer
 * has to know this file exists.
 */

/** Gates every organization-admin surface: link_identity, invite_employee, set_member_role. */
export const IDENTITY_LINK_ADMIN_ROLE = "Organization.All.ReadWrite";

/**
 * What a brand-new identity's session may do before an administrator has
 * assigned it a real role — see `platform.identity_relations
 * .needs_role_assignment` (db/migrations/identity-link.ts) for why this has
 * to be a code-level override rather than a Keycloak admin-API role grant:
 * `session.roles` in identity.ts is computed from the JWT that is ALREADY
 * ISSUED by the time `resolveIdentityLink` runs and could grant a role, so
 * nothing short of overriding the session itself can affect that very first
 * request.
 *
 * `General.All.Read` is read-only access to the generic entity surface
 * (whatever the realm's "read everything" composite grants) — enough to look
 * around — deliberately not `Organization.All.ReadWrite` (org admin) or any
 * `Pentest.*` role. `whoami`/`day_start` need no role at all, so they keep
 * working regardless of this override.
 */
export const NEEDS_ROLE_ASSIGNMENT_ROLES: readonly string[] = ["General.All.Read"];
