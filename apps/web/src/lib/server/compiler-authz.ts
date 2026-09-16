// SPDX-License-Identifier: BUSL-1.1
import "server-only";

import {
  GENERATED_ENTITY_AUTH,
  GENERATED_PERSONAS,
  GENERATED_REALM_ROLE_COMPOSITES,
  type GeneratedAccessOp,
} from "@/compiler/entity-manifest";

export type AccessOp = GeneratedAccessOp;

export type EntityAuthRequirements = {
  slug: string;
  entity: string;
  required: Record<AccessOp, ReadonlySet<string>>;
};

export type PersonaSummary = {
  username: string;
  tid: string | null;
  realmRoles: string[];
  groupPaths: string[];
  /** Flat client-role set, expanded from realmRoles + clientRoles. */
  effectiveClientRoles: ReadonlySet<string>;
};

function toEntityAuthRequirements(
  entry: (typeof GENERATED_ENTITY_AUTH)[keyof typeof GENERATED_ENTITY_AUTH],
): EntityAuthRequirements {
  return {
    slug: entry.slug,
    entity: entry.entity,
    required: {
      read: new Set(entry.required.read),
      create: new Set(entry.required.create),
      update: new Set(entry.required.update),
      delete: new Set(entry.required.delete),
    },
  };
}

const entityAuth = new Map<string, EntityAuthRequirements>(
  Object.entries(GENERATED_ENTITY_AUTH).map(([slug, entry]) => [
    slug,
    toEntityAuthRequirements(entry),
  ]),
);

const personas = new Map<string, PersonaSummary>(
  GENERATED_PERSONAS.map((persona) => [
    persona.username,
    {
      username: persona.username,
      tid: persona.tid,
      realmRoles: [...persona.realmRoles],
      groupPaths: [...persona.groupPaths],
      effectiveClientRoles: new Set(persona.effectiveClientRoles),
    },
  ]),
);

const realmRoleComposites = GENERATED_REALM_ROLE_COMPOSITES as Record<
  string,
  readonly string[]
>;

export function getPersona(username: string): PersonaSummary {
  const persona = personas.get(username);
  if (!persona) {
    throw new Error(
      `Unknown persona "${username}". Update generated runtime authorization metadata or fix the test fixture.`,
    );
  }
  return persona;
}

export function getEntityAuth(slug: string): EntityAuthRequirements {
  const entry = entityAuth.get(slug);
  if (!entry) {
    throw new Error(
      `Entity slug "${slug}" not found in generated runtime authorization metadata.`,
    );
  }
  return entry;
}

export function listAuthorizedEntitySlugs(): string[] {
  return [...entityAuth.keys()].sort();
}

export function listPersonaUsernames(): string[] {
  return [...personas.keys()].sort();
}

export function canPersonaPerform(
  username: string,
  op: AccessOp,
  entitySlug: string,
): boolean {
  const persona = getPersona(username);
  const entity = getEntityAuth(entitySlug);
  const required = entity.required[op];
  if (required.size === 0) return false;
  for (const role of required) {
    if (persona.effectiveClientRoles.has(role)) return true;
  }
  return false;
}

/**
 * Same logic as `canPersonaPerform` but driven by an explicit role set
 * from the live session. Roles may be flat client roles or generated
 * realm-role names with generated composite client roles.
 */
export function rolesGrantOp(
  roles: readonly string[],
  op: AccessOp,
  entitySlug: string,
): boolean {
  const entity = getEntityAuth(entitySlug);
  const required = entity.required[op];
  if (required.size === 0) return false;
  if (roles.some((role) => required.has(role))) return true;

  for (const roleName of roles) {
    for (const composite of realmRoleComposites[roleName] ?? []) {
      if (required.has(composite)) return true;
    }
  }
  return false;
}

export function expandRolesWithRealmComposites(roles: readonly string[]): string[] {
  const expanded = new Set(roles);
  for (const roleName of roles) {
    for (const composite of realmRoleComposites[roleName] ?? []) {
      expanded.add(composite);
    }
  }
  return [...expanded];
}

/** Test-only compatibility hook; generated metadata is static. */
export function __resetCompilerAuthzCacheForTests(): void {}
