// SPDX-License-Identifier: BUSL-1.1
/**
 * A person's effective roles in the organization the token selected.
 *
 * The identity provider says WHICH organizations the account is a member of;
 * the membership row in `platform.identity_relations` says what the person
 * may do in the one the token selected (auth/identity-link.ts), as declared
 * names — a persona (`org_admin`) and the OSF baseline beside it. Keycloak
 * used to expand such a name into its composite members when it minted the
 * token; that expansion now happens here, from the same realm export
 * (`generated/compiler/role-composites.json`, emitted beside the realm), so
 * an invited administrator holds exactly what the realm's composite says.
 *
 * Names on the membership row are roles of the AUDIENCE client — the client
 * entity roles live on (`memberRoleClientId()`) — and are expanded through
 * that client's table; each member is then followed into the namespace it
 * belongs to (the realm, or its own client), never into a same-named role of
 * another client. The result is the flat set of names the entity guard
 * matches, which is what `resource_access` used to flatten to.
 *
 * A client role on the Keycloak USER is user-wide — an administrator of
 * organization A granting it would have made the person that in organization
 * B too — so a person's session never reads `resource_access`. Realm roles
 * remain issuer-wide grants by design (`Platform.*`) and are unioned in every
 * case, the just-in-time minimum included.
 */
import type { AuthIdentity } from "@openshapeforge/auth";
import generatedComposites from "../generated/compiler/role-composites.json" with { type: "json" };
import { memberRoleClientId } from "./employee-invitations.js";
import { NEEDS_ROLE_ASSIGNMENT_ROLES } from "./organization-roles.js";

export type RoleCompositeMember = { realm: string } | { client: string; role: string };
export type RealmRoleComposites = {
  realm: Record<string, readonly RoleCompositeMember[]>;
  clients: Record<string, Record<string, readonly RoleCompositeMember[]>>;
};
export type RoleComposites = Record<string, RealmRoleComposites>;

let composites: RoleComposites = generatedComposites as RoleComposites;

/** Test-only: stand in for the generated realm composites. */
export function __setRoleCompositesForTests(value: RoleComposites | null): void {
  composites = value ?? (generatedComposites as RoleComposites);
}

function memberKey(member: RoleCompositeMember): string {
  return "realm" in member ? `realm/${member.realm}` : `client/${member.client}/${member.role}`;
}

/**
 * `roles` (names on the audience client) plus every role they transitively
 * expand to in `realm`, as names, sorted. A realm the artifact does not know
 * expands nothing — the declared names still count on their own.
 */
export function expandRoleComposites(
  realm: string | undefined,
  roles: readonly string[],
  audience: string = memberRoleClientId(),
): string[] {
  const table = realm ? composites[realm] : undefined;
  const names = new Set(roles);
  if (!table) return [...names].sort();
  const seen = new Set<string>();
  const pending: RoleCompositeMember[] = roles.map((role) => ({ client: audience, role }));
  for (const member of pending) {
    const key = memberKey(member);
    if (seen.has(key)) continue;
    seen.add(key);
    names.add("realm" in member ? member.realm : member.role);
    const owned = "realm" in member
      ? table.realm[member.realm]
      : table.clients[member.client]?.[member.role];
    for (const next of owned ?? []) pending.push(next);
  }
  return [...names].sort();
}

export type PersonMembership = {
  roles: readonly string[];
  needsRoleAssignment: boolean;
};

/**
 * Realm roles ∪ the expanded membership roles. A linked member whose row
 * carries nothing yet runs on the just-in-time minimum beside their realm
 * roles until an administrator records a persona. `membership` is never null
 * here: identity.ts refuses a person whose membership could not be resolved.
 */
export function personSessionRoles(
  identity: Pick<AuthIdentity, "roles">,
  membership: PersonMembership,
  realm: string | undefined,
): string[] {
  const organizationRoles =
    membership.needsRoleAssignment && membership.roles.length === 0
      ? NEEDS_ROLE_ASSIGNMENT_ROLES
      : expandRoleComposites(realm, membership.roles);
  return [...new Set([...identity.roles, ...organizationRoles])].sort();
}
