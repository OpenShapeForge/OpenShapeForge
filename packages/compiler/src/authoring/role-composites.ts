// SPDX-License-Identifier: BUSL-1.1
/**
 * The role composites of every generated realm, for the API.
 *
 * Keycloak expands a composite role into its members when it mints a token
 * (`resource_access`). A person's organization roles no longer travel in the
 * token — they are recorded per membership in `platform.identity_relations`
 * (apps/api/src/auth/identity-link.ts) as the DECLARED grant names, and the
 * API expands them itself through this table so a person invited as an
 * administrator holds exactly what the realm's composite says an
 * administrator holds. Derived from the realm export the generator already
 * produced, so the two can never disagree: whatever a role expands to in
 * Keycloak, it expands to here.
 *
 * Shape: `{ [realmName]: { [roleName]: [memberRoleName, ...] } }`, direct
 * members only (the API walks transitively), sorted for determinism.
 */
import type { KeycloakRealmArtifact } from "./generators/keycloak.js";

export const ROLE_COMPOSITES_PATH = "apps/api/src/generated/compiler/role-composites.json";

export type RoleCompositesByRealm = Record<string, Record<string, string[]>>;

type RealmRole = {
  name?: string;
  composite?: boolean;
  composites?: { realm?: string[]; client?: Record<string, string[]> };
};

type RealmExport = {
  realm?: string;
  roles?: { realm?: RealmRole[]; client?: Record<string, RealmRole[]> };
};

function membersOf(role: RealmRole): string[] {
  const members = [
    ...(role.composites?.realm ?? []),
    ...Object.values(role.composites?.client ?? {}).flat(),
  ];
  return [...new Set(members)].sort();
}

export function buildRoleComposites(realms: readonly KeycloakRealmArtifact[]): RoleCompositesByRealm {
  const byRealm: RoleCompositesByRealm = {};
  for (const artifact of realms) {
    const realm = JSON.parse(artifact.contents) as RealmExport;
    if (!realm.realm) continue;
    const composites: Record<string, string[]> = {};
    const roles = [
      ...(realm.roles?.realm ?? []),
      ...Object.values(realm.roles?.client ?? {}).flat(),
    ];
    for (const role of roles) {
      if (!role.name) continue;
      const members = membersOf(role);
      if (members.length === 0) continue;
      composites[role.name] = [...new Set([...(composites[role.name] ?? []), ...members])].sort();
    }
    byRealm[realm.realm] = Object.fromEntries(
      Object.entries(composites).sort(([left], [right]) => left.localeCompare(right)),
    );
  }
  return Object.fromEntries(
    Object.entries(byRealm).sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function renderRoleComposites(composites: RoleCompositesByRealm): string {
  return `${JSON.stringify(composites, null, 2)}\n`;
}
