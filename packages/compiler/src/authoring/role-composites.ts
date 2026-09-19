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
 * Ownership is preserved: a client role name is scoped by its owning client
 * in Keycloak, and two clients may legally declare the same persona with
 * different members. So the artifact keys realm roles and each client's
 * roles separately, and every member names its own namespace, so the API
 * expands a name through the configured audience client and follows each
 * member into the namespace it belongs to — never into a same-named role of
 * an unrelated client.
 *
 * Shape, per realm:
 *   { realm: { [role]: Member[] }, clients: { [clientId]: { [role]: Member[] } } }
 *   Member = { realm: role } | { client: clientId, role }
 * Direct members only (the API walks transitively), sorted for determinism.
 */
import type { KeycloakRealmArtifact } from "./generators/keycloak.js";

export const ROLE_COMPOSITES_PATH = "apps/api/src/generated/compiler/role-composites.json";

export type RoleCompositeMember = { realm: string } | { client: string; role: string };
export type RoleCompositeTable = Record<string, RoleCompositeMember[]>;
export type RealmRoleComposites = {
  realm: RoleCompositeTable;
  clients: Record<string, RoleCompositeTable>;
};
export type RoleCompositesByRealm = Record<string, RealmRoleComposites>;

type RealmRole = {
  name?: string;
  composite?: boolean;
  composites?: { realm?: string[]; client?: Record<string, string[]> };
};

type RealmExport = {
  realm?: string;
  roles?: { realm?: RealmRole[]; client?: Record<string, RealmRole[]> };
};

function memberKey(member: RoleCompositeMember): string {
  return "realm" in member ? `realm/${member.realm}` : `client/${member.client}/${member.role}`;
}

function membersOf(role: RealmRole): RoleCompositeMember[] {
  const members: RoleCompositeMember[] = [
    ...(role.composites?.realm ?? []).map((name) => ({ realm: name })),
    ...Object.entries(role.composites?.client ?? {}).flatMap(([client, names]) =>
      names.map((name) => ({ client, role: name })),
    ),
  ];
  const unique = new Map(members.map((member) => [memberKey(member), member]));
  return [...unique.values()].sort((left, right) => memberKey(left).localeCompare(memberKey(right)));
}

function sortedTable(roles: readonly RealmRole[]): RoleCompositeTable {
  const table: RoleCompositeTable = {};
  for (const role of roles) {
    if (!role.name) continue;
    const members = membersOf(role);
    if (members.length === 0) continue;
    if (table[role.name]) {
      throw new Error(`Role "${role.name}" is declared twice in one namespace of the realm export.`);
    }
    table[role.name] = members;
  }
  return Object.fromEntries(Object.entries(table).sort(([left], [right]) => left.localeCompare(right)));
}

export function buildRoleComposites(realms: readonly KeycloakRealmArtifact[]): RoleCompositesByRealm {
  const byRealm: RoleCompositesByRealm = {};
  for (const artifact of realms) {
    const realm = JSON.parse(artifact.contents) as RealmExport;
    if (!realm.realm) continue;
    const clients = Object.entries(realm.roles?.client ?? {})
      .map(([clientId, roles]) => [clientId, sortedTable(roles)] as const)
      .filter(([, table]) => Object.keys(table).length > 0)
      .sort(([left], [right]) => left.localeCompare(right));
    byRealm[realm.realm] = {
      realm: sortedTable(realm.roles?.realm ?? []),
      clients: Object.fromEntries(clients),
    };
  }
  return Object.fromEntries(
    Object.entries(byRealm).sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function renderRoleComposites(composites: RoleCompositesByRealm): string {
  return `${JSON.stringify(composites, null, 2)}\n`;
}
