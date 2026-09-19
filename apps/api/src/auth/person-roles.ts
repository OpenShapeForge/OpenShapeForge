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
 * A client role on the Keycloak USER is user-wide — an administrator of
 * organization A granting it would have made the person that in organization
 * B too — so a person's session never reads `resource_access`. Realm roles
 * remain issuer-wide grants by design (`Platform.*`), and the just-in-time
 * minimum applies while the row still carries nothing.
 */
import type { AuthIdentity } from "@openshapeforge/auth";
import generatedComposites from "../generated/compiler/role-composites.json" with { type: "json" };
import { NEEDS_ROLE_ASSIGNMENT_ROLES } from "./organization-roles.js";

export type RoleComposites = Record<string, Record<string, readonly string[]>>;

let composites: RoleComposites = generatedComposites as RoleComposites;

/** Test-only: stand in for the generated realm composites. */
export function __setRoleCompositesForTests(value: RoleComposites | null): void {
  composites = value ?? (generatedComposites as RoleComposites);
}

/**
 * `roles` plus every role they transitively expand to in `realm`, sorted.
 * A realm the artifact does not know expands nothing — the declared names
 * still count on their own.
 */
export function expandRoleComposites(realm: string | undefined, roles: readonly string[]): string[] {
  const table = realm ? composites[realm] ?? {} : {};
  const expanded = new Set(roles);
  const pending = [...expanded];
  for (const role of pending) {
    for (const member of table[role] ?? []) {
      if (!expanded.has(member)) {
        expanded.add(member);
        pending.push(member);
      }
    }
  }
  return [...expanded].sort();
}

export type PersonMembership = {
  roles: readonly string[];
  needsRoleAssignment: boolean;
};

/** Realm roles ∪ the expanded membership roles; the JIT minimum for an empty row. */
export function personSessionRoles(
  identity: Pick<AuthIdentity, "roles">,
  membership: PersonMembership | null,
  realm: string | undefined,
): string[] {
  if (membership?.needsRoleAssignment && membership.roles.length === 0) {
    return [...NEEDS_ROLE_ASSIGNMENT_ROLES];
  }
  return [...new Set([
    ...identity.roles,
    ...expandRoleComposites(realm, membership?.roles ?? []),
  ])].sort();
}
