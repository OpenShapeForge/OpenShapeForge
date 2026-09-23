// @ts-nocheck
// SPDX-License-Identifier: BUSL-1.1
/**
 * Authorization reference validation — cross-checks role names referenced in
 * compiled entity authorizations against the realm vocabulary declared in
 * `authorization.yaml`.
 *
 * Pipeline position: called once after all entities compile, with the loaded
 * `AuthorizationConfigFile`. Fails the build if any entity references a role
 * that doesn't exist as a client role or realm role, or if any realm-role
 * composite resolves to an unknown client role.
 *
 * Why a separate pass: the authorization sub-compiler runs per entity and has
 * no view of the realm-wide role catalog. Centralizing the validation here
 * keeps `buildAuthorization` a pure transform and lets us produce a single
 * aggregated error report rather than failing on the first missing role.
 *
 * Soft warnings (returned, not thrown):
 *   - clientRoles entries that no entity references (likely dead, but might
 *     be reserved for non-API uses).
 */
import type {
  AuthorizationConfigFile,
  AuthorizationRealmRole,
} from "../types/authoring.js";
import type { CompiledEntityContract } from "../types/compiled.js";

export interface AuthorizationValidationResult {
  errors: string[];
  warnings: string[];
}

/**
 * Validate the roles carried by compiler-lowered transition Operations.
 *
 * Transition lowering is deliberately per-entity, while the declared role
 * vocabulary is realm-wide. Keep this check at the corpus boundary where the
 * compiled Operations and the applicable authorization contract are both
 * available. In particular, do not let the Keycloak generator treat a typo as
 * a new role merely because it occurs on an Operation.
 */
export function validateTransitionAuthorizationReferences(
  contracts: CompiledEntityContract[],
  authConfig: AuthorizationConfigFile,
): AuthorizationValidationResult {
  const errors: string[] = [];
  const { clientRoles, realmRoles } = buildDeclaredRoleSet(authConfig);
  const declared = new Set<string>([...clientRoles, ...realmRoles]);

  for (const contract of contracts) {
    for (const operation of contract.pluginOperations ?? []) {
      if (
        operation.definition.implementation.type !== "plugin" ||
        operation.definition.implementation.plugin !== "osf-transitions" ||
        operation.definition.auth.mode !== "session"
      ) {
        continue;
      }
      for (const role of operation.definition.auth.roles ?? []) {
        if (!declared.has(role)) {
          errors.push(
            `[${contract.entity.name}] transition Operation "${operation.id}" ` +
              `references role "${role}", which is not declared in the applicable ` +
              `authorization contract. Declare the role before using it on a transition.`,
          );
        }
      }
    }
  }

  return { errors, warnings: [] };
}

/**
 * Build the set of role names that are valid to reference from an entity.
 * A role is valid if it appears under any client in `clientRoles` or as a
 * top-level realm role.
 */
function buildDeclaredRoleSet(authConfig: AuthorizationConfigFile): {
  clientRoles: Set<string>;
  realmRoles: Set<string>;
  perClient: Map<string, Set<string>>;
} {
  const clientRoles = new Set<string>();
  const perClient = new Map<string, Set<string>>();

  for (const [client, roles] of Object.entries(authConfig.clientRoles ?? {})) {
    const set = new Set<string>();
    for (const r of roles) {
      clientRoles.add(r);
      set.add(r);
    }
    perClient.set(client, set);
  }

  for (const [client, definitions] of Object.entries(
    authConfig.clientRoleComposites ?? {},
  )) {
    const set = perClient.get(client) ?? new Set<string>();
    for (const role of Object.keys(definitions)) {
      clientRoles.add(role);
      set.add(role);
    }
    perClient.set(client, set);
  }

  const realmRoleMap =
    authConfig.realmRoles ?? authConfig.keycloak?.realmRoles ?? {};
  const realmRoles = new Set<string>(Object.keys(realmRoleMap));

  return { clientRoles, realmRoles, perClient };
}

function entityRoleClientId(authConfig: AuthorizationConfigFile): string {
  return (
    authConfig.keycloak?.entityRoleClient ??
    authConfig.keycloak?.client ??
    "erp-provider"
  );
}

/**
 * Validate every role referenced by every compiled entity against the realm
 * vocabulary. Mutations to the entity contracts are NOT performed here; the
 * caller decides how to react to errors (typically: print + exit nonzero).
 */
export function validateAuthorizationReferences(
  contracts: CompiledEntityContract[],
  authConfig: AuthorizationConfigFile,
): AuthorizationValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const { clientRoles, realmRoles, perClient } = buildDeclaredRoleSet(authConfig);
  const referenced = new Set<string>();
  const declared = new Set<string>([...clientRoles, ...realmRoles]);

  for (const c of contracts) {
    const entity = c.entity.name;
    const auth = c.authorization;

    // CRUD ops
    for (const [op, roles] of Object.entries(auth.roles)) {
      for (const role of roles) {
        referenced.add(role);
        if (!declared.has(role)) {
          errors.push(
            `[${entity}] authorization.roles.${op} references "${role}" — ` +
              `not declared in authorization.yaml.clientRoles or realmRoles. ` +
              `Add it to authorization.yaml first, then reference it here.`,
          );
        }
      }
    }

    // Field-level
    for (const fa of auth.fieldAuthorizations) {
      for (const role of [...fa.readRoles, ...fa.writeRoles]) {
        referenced.add(role);
        if (!declared.has(role)) {
          errors.push(
            `[${entity}] field "${fa.fieldKey}" references "${role}" — ` +
              `not declared in authorization.yaml.clientRoles or realmRoles.`,
          );
        }
      }
    }

    // Profile-level
    for (const [profileId, pa] of Object.entries(auth.profileAuthorizations)) {
      for (const role of pa.readRoles) {
        referenced.add(role);
        if (!declared.has(role)) {
          errors.push(
            `[${entity}] profile "${profileId}" readRoles references "${role}" — ` +
              `not declared in authorization.yaml.clientRoles or realmRoles.`,
          );
        }
      }
    }
  }

  // Validate realm-role composites resolve against the same client role set.
  const realmRoleMap = authConfig.realmRoles ?? authConfig.keycloak?.realmRoles ?? {};
  for (const [roleName, roleDef] of Object.entries(realmRoleMap)) {
    const composites = (roleDef as AuthorizationRealmRole).composites;
    if (!composites || typeof composites !== "object") continue;
    for (const [client, clientRoleNames] of Object.entries(composites)) {
      if (!Array.isArray(clientRoleNames)) continue;
      const clientSet = perClient.get(client);
      if (!clientSet) {
        errors.push(
          `realmRoles.${roleName}.composites references client "${client}" ` +
            `but authorization.yaml.clientRoles has no entry for that client.`,
        );
        continue;
      }
      for (const compositeRole of clientRoleNames) {
        if (!clientSet.has(compositeRole)) {
          errors.push(
            `realmRoles.${roleName}.composites.${client} references "${compositeRole}" ` +
              `which is not declared in authorization.yaml.clientRoles.${client}.`,
          );
        }
      }
    }
  }


  // Validate audience-scoped composite client roles against the same declared
  // per-client vocabulary as realm composites.
  for (const [ownerClient, roleDefinitions] of Object.entries(
    authConfig.clientRoleComposites ?? {},
  )) {
    for (const [roleName, roleDef] of Object.entries(roleDefinitions)) {
      for (const [client, compositeRoleNames] of Object.entries(roleDef.composites)) {
        const clientSet = perClient.get(client);
        if (!clientSet) {
          errors.push(
            `clientRoleComposites.${ownerClient}.${roleName}.composites references ` +
              `client "${client}" but authorization.yaml declares no roles for that client.`,
          );
          continue;
        }
        for (const compositeRole of compositeRoleNames) {
          if (!clientSet.has(compositeRole)) {
            errors.push(
              `clientRoleComposites.${ownerClient}.${roleName}.composites.${client} ` +
                `references "${compositeRole}" which is not declared for that client.`,
            );
          }
        }
      }
    }
  }

  // Soft warnings: client roles on the entityRoleClient that no entity ever
  // references. Likely dead; could also be intentionally reserved.
  const entityClient = entityRoleClientId(authConfig);
  const entityClientRoles = perClient.get(entityClient) ?? new Set<string>();
  for (const role of entityClientRoles) {
    if (!referenced.has(role)) {
      // Filter known non-entity roles (e.g. realm composites that target a
      // module umbrella) — for now flag everything; teams can ignore.
      warnings.push(
        `clientRoles.${entityClient}: "${role}" is not referenced by any entity ` +
          `authorization block. If unused, remove it; otherwise document why ` +
          `it lives in the realm.`,
      );
    }
  }

  return { errors, warnings };
}
