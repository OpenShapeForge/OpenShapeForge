// SPDX-License-Identifier: BUSL-1.1
/**
 * Keycloak `openshapeforge-realm.json` generator.
 *
 * Pipeline position: cross-entity generator. Combines hand-authored YAML
 * (`packages/compiler/config/authoring/authorization.yaml`) with the
 * entity-derived client roles emitted by every compiled entity contract.
 *
 * Output (single file):
 *   `keycloak/openshapeforge-realm.json`
 *
 * The output is mounted into the local Keycloak container by
 * `docker-compose.local.yml` and into production Keycloak configuration.
 * Hand-editing the file is forbidden — see
 * `docs/auth-spi-migration/boundaries.md`.
 *
 * Defaults intentionally hardcoded (not in YAML):
 *   - gateway client's protocolMappers (tid, organization, act, audience-*)
 *   - bearerOnly / serviceAccount client shape (bearerOnly flag, direct-access, etc.)
 *   - realm name falls back to "openshapeforge"
 *
 * Security-sensitive values that MUST come from YAML (never hardcoded):
 *   - gateway redirectUris / webOrigins — explicit per-client allow-list;
 *     wildcards ("*") are refused and generation fails without a concrete list.
 *   - client secrets — either a dev-only `devSecret` (permitted only on a dev
 *     realm) or a `${env:VAR}` reference resolved at generate time. A non-dev
 *     realm carrying a checked-in literal secret fails generation.
 */
// @ts-nocheck
import type { CompiledEntityContract } from "../types/compiled.js";
import type {
  AuthorizationConfigFile,
  AuthorizationClient,
  AuthorizationGroupNode,
  AuthorizationRealmConfig,
  AuthorizationRealmRole,
} from "../types/authoring.js";
import { KEYCLOAK_ROLE_SEGMENT_RENAMES, normalizeKeycloakRoleName } from "../role-names.js";

const DEFAULT_REALM_NAME = "openshapeforge";
export const KEYCLOAK_REALM_OUTPUT_PATH = "keycloak/openshapeforge-realm.json";

// Canonical rename table + normalizer live in ../role-names.ts so the
// backend manifest's authorization bridge can share them; re-exported here to
// keep existing import sites (UI oracle) working.
export { KEYCLOAK_ROLE_SEGMENT_RENAMES, normalizeKeycloakRoleName };

interface KeycloakRole {
  name: string;
  description?: string;
  composite: boolean;
  composites?: {
    client: Record<string, string[]>;
  };
  attributes?: Record<string, string[]>;
}

interface KeycloakUser {
  username: string;
  enabled: boolean;
  email?: string;
  firstName?: string;
  lastName?: string;
  credentials?: { type: "password"; value: string; temporary: false }[];
  attributes?: Record<string, string[]>;
  realmRoles?: string[];
  /** Group paths; realm import resolves membership by path. */
  groups?: string[];
  clientRoles?: Record<string, string[]>;
  /**
   * Marks this user as the service account of the named client. The realm
   * import binds it to that client (instead of treating it as a login user)
   * and applies its `clientRoles` to the service account.
   */
  serviceAccountClientId?: string;
}

interface KeycloakGroup {
  name: string;
  path: string;
  realmRoles: string[];
  clientRoles: Record<string, string[]>;
  subGroups: KeycloakGroup[];
}

interface KeycloakProtocolMapper {
  name: string;
  protocol: "openid-connect";
  protocolMapper: string;
  consentRequired: boolean;
  config: Record<string, string>;
}

interface KeycloakClient {
  clientId: string;
  name?: string;
  enabled: boolean;
  clientAuthenticatorType: "client-secret";
  secret?: string;
  bearerOnly?: boolean;
  publicClient: boolean;
  protocol: "openid-connect";
  directAccessGrantsEnabled: boolean;
  serviceAccountsEnabled: boolean;
  standardFlowEnabled: boolean;
  fullScopeAllowed?: boolean;
  redirectUris?: string[];
  webOrigins?: string[];
  defaultClientScopes?: string[];
  protocolMappers?: KeycloakProtocolMapper[];
}

interface KeycloakRealmExport {
  realm: string;
  displayName?: string;
  enabled: boolean;
  sslRequired?: string;
  loginTheme?: string;
  accountTheme?: string;
  adminTheme?: string;
  emailTheme?: string;
  registrationAllowed?: boolean;
  loginWithEmailAllowed?: boolean;
  duplicateEmailsAllowed?: boolean;
  resetPasswordAllowed?: boolean;
  editUsernameAllowed?: boolean;
  bruteForceProtected?: boolean;
  organizationsEnabled?: boolean;
  accessTokenLifespan?: number;
  ssoSessionIdleTimeout?: number;
  ssoSessionMaxLifespan?: number;
  eventsEnabled?: boolean;
  adminEventsEnabled?: boolean;
  eventsListeners?: string[];
  clients: KeycloakClient[];
  roles: {
    realm: KeycloakRole[];
    client: Record<string, KeycloakRole[]>;
  };
  groups?: KeycloakGroup[];
  users: KeycloakUser[];
}

function normalizeKeycloakRoleNames(roleNames: string[]): string[] {
  return roleNames.map(normalizeKeycloakRoleName);
}

function normalizeClientRoleMap(
  clientRoles: Record<string, string[]> | undefined,
): Record<string, string[]> | undefined {
  if (!clientRoles) return undefined;
  return Object.fromEntries(
    Object.entries(clientRoles).map(([clientId, roles]) => [
      clientId,
      normalizeKeycloakRoleNames(roles),
    ]),
  );
}

function audienceMappers(resourceClientIds: string[]): KeycloakProtocolMapper[] {
  return resourceClientIds.map((clientId) => ({
    name: `${clientId}-audience`,
    protocol: "openid-connect",
    protocolMapper: "oidc-audience-mapper",
    consentRequired: false,
    config: {
      "included.client.audience": clientId,
      "id.token.claim": "false",
      "access.token.claim": "true",
    },
  }));
}

function gatewayProtocolMappers(resourceClientIds: string[]): KeycloakProtocolMapper[] {
  return [
    {
      name: "tid-mapper",
      protocol: "openid-connect",
      protocolMapper: "oidc-usermodel-attribute-mapper",
      consentRequired: false,
      config: {
        "user.attribute": "tid",
        "claim.name": "tid",
        "jsonType.label": "String",
        "id.token.claim": "true",
        "access.token.claim": "true",
        "userinfo.token.claim": "true",
        "multivalued": "false",
        "aggregate.attrs": "false",
      },
    },
    {
      name: "organization-mapper",
      protocol: "openid-connect",
      protocolMapper: "oidc-usermodel-attribute-mapper",
      consentRequired: false,
      config: {
        "user.attribute": "tid",
        "claim.name": "organization",
        "jsonType.label": "String",
        "id.token.claim": "true",
        "access.token.claim": "true",
        "userinfo.token.claim": "true",
        "multivalued": "true",
        "aggregate.attrs": "false",
      },
    },
    {
      name: "act-mapper",
      protocol: "openid-connect",
      protocolMapper: "oidc-hardcoded-claim-mapper",
      consentRequired: false,
      config: {
        "claim.name": "act",
        "claim.value": "employee",
        "jsonType.label": "String",
        "id.token.claim": "true",
        "access.token.claim": "true",
        "userinfo.token.claim": "true",
      },
    },
    ...audienceMappers(resourceClientIds),
  ];
}

/** Which kind of realm the compiler should emit. */
export type RealmMode = "development" | "production";

/** Env var selecting the mode. Absent or unrecognised means development. */
export const REALM_MODE_ENV = "OPENSHAPEFORGE_REALM_MODE";

/**
 * Resolve the realm mode.
 *
 * Development is the default deliberately: `bun run generate` is run constantly
 * — locally, in CI, in every image build — and the safe failure for a missing
 * setting is the realm that only ever reaches a laptop, not the one that gets
 * published. Producing a production realm is an explicit act.
 */
export function resolveRealmMode(env: NodeJS.ProcessEnv = process.env): RealmMode {
  return env[REALM_MODE_ENV]?.trim().toLowerCase() === "production"
    ? "production"
    : "development";
}

/**
 * Whether committed literal `devSecret`s and plain-text user passwords are
 * acceptable. The MODE is the only input.
 *
 * It deliberately no longer infers from the realm's `sslRequired` or its NAME:
 *
 *   - `sslRequired` would contradict itself. The authored config carries
 *     `sslRequired: none` for local work, and production mode OVERRIDES that to
 *     `external`. Reading the authored value would make production mode
 *     classify itself as development and harden nothing.
 *   - the NAME was safe to read only while the default ended in `-dev`. With
 *     the default now `openshapeforge`, name inference would classify every
 *     production realm using the default name as development and silently
 *     permit checked-in secrets — precisely the failure this guard exists to
 *     prevent.
 */
export function isDevRealm(
  _realm: AuthorizationRealmConfig | undefined,
  mode: RealmMode = resolveRealmMode(),
): boolean {
  return mode === "development";
}

const ENV_REF_RE = /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)(?::-(.*))?\}$/;

/**
 * Resolve a `${env:VAR}` / `${env:VAR:-fallback}` reference.
 *
 * Returns undefined when the value is not an env reference at all, so callers
 * can apply their own rule to literals.
 *
 * The fallback is DEVELOPMENT-ONLY. In production an unset variable is an
 * error even when a fallback is written, because the fallback is by definition
 * a value committed to the repository — silently substituting it would ship
 * exactly the credential the env indirection exists to avoid, while looking
 * like it had been configured.
 */
function resolveEnvRef(
  raw: string,
  dev: boolean,
  what: string,
): string | undefined {
  const match = ENV_REF_RE.exec(raw.trim());
  if (!match) return undefined;
  const [, varName, fallback] = match;
  const fromEnv = process.env[varName];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  if (fallback !== undefined && dev) return fallback;
  throw new Error(
    fallback !== undefined
      ? `${what}: env var ${varName} is not set. Its \${env:${varName}:-fallback} default is development-only and will not be used for a production realm.`
      : `${what}: references env var ${varName}, but it is not set and no \${env:${varName}:-fallback} default was given.`,
  );
}

/**
 * Resolve a client secret for a given realm.
 *
 * Precedence and rules:
 *   - `${env:VAR}` / `${env:VAR:-fallback}` in `secret` is resolved from the
 *     environment at generate time (allowed in any realm). Fails if unset and
 *     no fallback is given.
 *   - a literal `secret` (not an env ref) is only allowed on a dev realm.
 *   - `devSecret` is a dev-only literal; allowed only on a dev realm.
 *   - a non-dev realm that still carries a literal `secret` or any `devSecret`
 *     fails generation, so checked-in default credentials can never ship to
 *     production.
 */
/**
 * Resolve a seeded user's password, under the same rule as a client secret:
 * a `${env:VAR}` reference works in any mode, a committed literal only in
 * development.
 *
 * Authored as `${env:VAR:-literal}`, one line serves both: development falls
 * back to the readable literal, production requires the variable to be set and
 * refuses to substitute the fallback.
 */
export function resolveUserPassword(
  user: { username: string; password: string },
  dev: boolean,
): string {
  const resolved = resolveEnvRef(user.password, dev, `User "${user.username}": password`);
  if (resolved !== undefined) return resolved;
  if (!dev) {
    throw new Error(
      `User "${user.username}": a literal password is committed for a non-dev realm. Use a \${env:VAR:-devDefault} reference so production supplies a real one.`,
    );
  }
  return user.password;
}

export function resolveClientSecret(
  def: AuthorizationClient,
  dev: boolean,
): string | undefined {
  // Development takes devSecret FIRST, before any env reference is resolved.
  // The order matters: `secret: ${env:VAR}` and `devSecret: literal` are
  // complementary — one value per mode — so resolving the env ref first would
  // make local work fail on an unset production variable it has no business
  // needing.
  if (dev && def.devSecret !== undefined) {
    return def.devSecret;
  }

  if (def.secret !== undefined) {
    const resolved = resolveEnvRef(def.secret, dev, `Client "${def.id}": secret`);
    if (resolved !== undefined) return resolved;
    // Literal secret: acceptable only where committed credentials are.
    if (!dev) {
      throw new Error(
        `Client "${def.id}": a literal client secret is committed for a non-dev realm. Use a \${env:VAR} reference resolved at generate/deploy time instead.`,
      );
    }
    return def.secret;
  }

  if (def.devSecret !== undefined) {
    // Production, and the only value on offer is a committed literal. Refusing
    // here is the whole point of the guard: it is what stops a published realm
    // shipping a secret that is readable in the repository.
    throw new Error(
      `Client "${def.id}": only a devSecret is configured, but the realm is not a development realm. Add "secret: \${env:VAR}" alongside it for production.`,
    );
  }

  return undefined;
}

/**
 * Reject open-redirect-enabling wildcards. A bare "*" (any host) is always
 * refused. For redirectUris a trailing PATH wildcard on a concrete origin
 * (e.g. `https://app.example.com/*`) is the pattern Keycloak recommends and is
 * allowed; a wildcard anywhere in the scheme/host is refused. webOrigins are
 * CORS origins with no path, so any "*" is refused.
 */
function assertNoOpenWildcard(
  def: AuthorizationClient,
  field: "redirectUris" | "webOrigins",
  value: string,
): void {
  const reject = () => {
    throw new Error(
      `Gateway client "${def.id}": ${field} entry "${value}" uses an open/host wildcard, which is forbidden. List a concrete origin (a trailing "/path/*" is allowed for redirectUris).`,
    );
  };

  if (!value.includes("*")) return;
  if (value === "*") reject();

  if (field === "webOrigins") reject();

  // redirectUris: only a single trailing "*" that lands in the path portion of
  // an absolute http(s) URL is permitted. Anything else (host wildcard,
  // multiple "*", protocol-relative, etc.) is refused.
  const match = /^(https?:\/\/[^/*]+)(\/[^*]*)?\*$/.exec(value);
  if (!match) reject();
}

function validateGatewayAllowList(
  def: AuthorizationClient,
  field: "redirectUris" | "webOrigins",
  values: string[] | undefined,
): string[] {
  if (!values || values.length === 0) {
    throw new Error(
      `Gateway client "${def.id}": ${field} must be an explicit allow-list in authorization.yaml. Wildcard/standard-flow OIDC clients without concrete ${field} are refused.`,
    );
  }
  for (const value of values) {
    assertNoOpenWildcard(def, field, value);
  }
  return values;
}

function buildClient(
  def: AuthorizationClient,
  resourceClientIds: string[],
  dev: boolean,
): KeycloakClient {
  const base = {
    clientId: def.id,
    name: def.name,
    enabled: true,
    clientAuthenticatorType: "client-secret" as const,
    secret: resolveClientSecret(def, dev),
    publicClient: false,
    protocol: "openid-connect" as const,
  };

  switch (def.kind) {
    case "gateway":
      return {
        ...base,
        directAccessGrantsEnabled: true,
        serviceAccountsEnabled: false,
        standardFlowEnabled: true,
        redirectUris: validateGatewayAllowList(def, "redirectUris", def.redirectUris),
        webOrigins: validateGatewayAllowList(def, "webOrigins", def.webOrigins),
        defaultClientScopes: ["basic", "profile", "email", "roles", "organization"],
        protocolMappers: gatewayProtocolMappers(resourceClientIds),
      };
    case "bearerOnly":
      return {
        ...base,
        bearerOnly: true,
        directAccessGrantsEnabled: false,
        serviceAccountsEnabled: false,
        standardFlowEnabled: false,
        fullScopeAllowed: false,
      };
    case "serviceAccount":
      return {
        ...base,
        directAccessGrantsEnabled: false,
        serviceAccountsEnabled: true,
        standardFlowEnabled: false,
      };
  }
}

interface EntityRoleAggregate {
  clientRoles: Map<string, KeycloakRole[]>;
  entityComposites: Map<string, { entity: string; roles: string[] }>;
}

function aggregateFromEntities(
  contracts: CompiledEntityContract[],
  entityRoleClient: string,
): EntityRoleAggregate {
  const clientRoles = new Map<string, KeycloakRole[]>();
  const entityComposites = new Map<string, { entity: string; roles: string[] }>();
  // Tracks, per client, which distinct authored (pre-normalization) role names
  // collapse onto each normalized Keycloak role name. Two different source
  // spellings mapping to one normalized name silently merge access grants, so
  // this is used to fail generation on collision.
  const normalizedSources = new Map<string, Map<string, Set<string>>>();

  const push = (clientId: string, role: KeycloakRole) => {
    const normalizedName = normalizeKeycloakRoleName(role.name);
    const perClient = normalizedSources.get(clientId) ?? new Map<string, Set<string>>();
    const sources = perClient.get(normalizedName) ?? new Set<string>();
    sources.add(role.name);
    perClient.set(normalizedName, sources);
    normalizedSources.set(clientId, perClient);
    const list = clientRoles.get(clientId) ?? [];
    list.push({
      ...role,
      name: normalizedName,
      composites: role.composites
        ? {
            client: Object.fromEntries(
              Object.entries(role.composites.client).map(([compositeClientId, composites]) => [
                compositeClientId,
                normalizeKeycloakRoleNames(composites),
              ]),
            ),
          }
        : undefined,
    });
    clientRoles.set(clientId, list);
  };

  for (const contract of contracts) {
    const auth = contract.authorization;
    if (!auth) {
      continue;
    }
    const entityName = contract.entity.name;

    for (const [op, roles] of Object.entries(auth.roles ?? {})) {
      if (!Array.isArray(roles)) continue;
      for (const role of roles) {
        push(entityRoleClient, {
          name: role,
          description: `${capitalize(op)} access to ${entityName}`,
          composite: false,
        });
      }
    }

    for (const fa of auth.fieldAuthorizations ?? []) {
      for (const role of fa.readRoles ?? []) {
        push(entityRoleClient, {
          name: role,
          description: `Read access to ${entityName}.${fa.fieldKey}`,
          composite: false,
        });
      }
      for (const role of fa.writeRoles ?? []) {
        push(entityRoleClient, {
          name: role,
          description: `Write access to ${entityName}.${fa.fieldKey}`,
          composite: false,
        });
      }
    }

    for (const [profileName, profileAuth] of Object.entries(auth.profileAuthorizations ?? {})) {
      for (const role of profileAuth.readRoles ?? []) {
        push(entityRoleClient, {
          name: role,
          description: `Read access to ${entityName} ${profileName} profile`,
          composite: false,
        });
      }
    }

    for (const composite of auth.compositeRoles ?? []) {
      push(entityRoleClient, {
        name: composite.name,
        description: composite.description,
        composite: true,
        composites: {
          client: {
            [entityRoleClient]: composite.composites ?? [],
          },
        },
      });
      entityComposites.set(normalizeKeycloakRoleName(composite.name), {
        entity: auth.entitySlug,
        roles: normalizeKeycloakRoleNames(composite.composites ?? []),
      });
    }
  }

  for (const [clientId, perClient] of normalizedSources) {
    for (const [normalizedName, sources] of perClient) {
      if (sources.size > 1) {
        const spellings = [...sources].sort().map((name) => `"${name}"`).join(", ");
        throw new Error(
          `Keycloak role-name collision on client "${clientId}": ` +
            `distinct authored roles ${spellings} all normalize to "${normalizedName}". ` +
            `Merging them would silently combine their access grants. ` +
            `Use a single canonical spelling for this role.`,
        );
      }
    }
  }

  for (const [clientId, roles] of clientRoles) {
    const seen = new Set<string>();
    const deduped: KeycloakRole[] = [];
    for (const role of roles) {
      if (!seen.has(role.name)) {
        seen.add(role.name);
        deduped.push(role);
      }
    }
    clientRoles.set(clientId, deduped);
  }

  return { clientRoles, entityComposites };
}

function expandIncludes(
  includes: string[],
  entityComposites: Map<string, { entity: string; roles: string[] }>,
): string[] {
  const expanded: string[] = [];
  const suffixIndex = new Map<string, string[]>();
  for (const [name] of entityComposites) {
    const colonIndex = name.indexOf(":");
    if (colonIndex === -1) continue;
    const suffix = name.slice(colonIndex);
    const list = suffixIndex.get(suffix) ?? [];
    list.push(name);
    suffixIndex.set(suffix, list);
  }

  for (const include of includes) {
    if (include.startsWith("*:")) {
      const suffix = include.slice(1);
      expanded.push(...(suffixIndex.get(suffix) ?? []));
    } else {
      expanded.push(normalizeKeycloakRoleName(include));
    }
  }
  return expanded;
}

function buildRealmRole(
  name: string,
  def: AuthorizationRealmRole,
  entityComposites: Map<string, { entity: string; roles: string[] }>,
  entityRoleClient: string,
): KeycloakRole {
  const composites: Record<string, string[]> = {};
  if (def.composites) {
    for (const [clientId, roles] of Object.entries(def.composites)) {
      composites[clientId] = [
        ...(composites[clientId] ?? []),
        ...normalizeKeycloakRoleNames(roles),
      ];
    }
  }
  if (def.includes && def.includes.length > 0) {
    const expanded = expandIncludes(def.includes, entityComposites);
    composites[entityRoleClient] = [...(composites[entityRoleClient] ?? []), ...expanded];
  }

  const hasComposites = Object.values(composites).some((v) => v.length > 0);
  const result: KeycloakRole = {
    name,
    description: def.description,
    composite: def.composite ?? hasComposites,
  };
  if (result.composite && hasComposites) {
    result.composites = { client: composites };
  }
  if (def.attributes) {
    result.attributes = def.attributes;
  }
  return result;
}

function buildKeycloakGroupsFromAuthoring(nodes: AuthorizationGroupNode[], parentPath: string): KeycloakGroup[] {
  return nodes.map((node) => {
    const path = parentPath ? `${parentPath}/${node.name}` : `/${node.name}`;
    const subGroups = node.subGroups?.length
      ? buildKeycloakGroupsFromAuthoring(node.subGroups, path)
      : [];
    return {
      name: node.name,
      path,
      realmRoles: node.realmRoles ? normalizeKeycloakRoleNames(node.realmRoles) : [],
      clientRoles: normalizeClientRoleMap(node.clientRoles) ?? {},
      subGroups,
    };
  });
}

export interface KeycloakRealmArtifact {
  path: string;
  contents: string;
}

export function generateKeycloakRealmArtifacts(
  contracts: CompiledEntityContract[],
  authConfig: AuthorizationConfigFile | null | undefined,
  // Explicit rather than read from process.env inside: the mode decides whether
  // committed secrets are refused, and a security rule that can only be
  // exercised by mutating global state is a rule that stops being tested.
  mode: RealmMode = resolveRealmMode(),
): KeycloakRealmArtifact[] {
  if (!authConfig) {
    return [];
  }

  const entityRoleClient =
    authConfig.keycloak?.entityRoleClient ??
    authConfig.keycloak?.client ??
    "erp-provider";

  const realmRolesDef = authConfig.realmRoles ?? authConfig.keycloak?.realmRoles ?? {};

  const clientDefs = authConfig.keycloak?.clients ?? [];
  const resourceClientIds = clientDefs
    .filter((c) => c.kind === "bearerOnly")
    .map((c) => c.id);
  const dev = isDevRealm(authConfig.realm, mode);

  const entityAggregate = aggregateFromEntities(contracts, entityRoleClient);

  if (clientDefs.length === 0 && entityAggregate.clientRoles.size === 0) {
    return [];
  }

  const realmRoles: KeycloakRole[] = [];
  for (const [name, def] of Object.entries(realmRolesDef)) {
    realmRoles.push(
      buildRealmRole(name, def, entityAggregate.entityComposites, entityRoleClient),
    );
  }

  const clientRolesOut: Record<string, KeycloakRole[]> = {};
  if (authConfig.clientRoles) {
    for (const [clientId, names] of Object.entries(authConfig.clientRoles)) {
      const seen = new Set<string>();
      const list: KeycloakRole[] = [];
      const sourcesByNormalized = new Map<string, Set<string>>();
      for (const rawName of names) {
        const name = normalizeKeycloakRoleName(rawName);
        const sources = sourcesByNormalized.get(name) ?? new Set<string>();
        sources.add(rawName);
        sourcesByNormalized.set(name, sources);
        if (seen.has(name)) continue;
        seen.add(name);
        list.push({ name, composite: false });
      }
      for (const [name, sources] of sourcesByNormalized) {
        if (sources.size > 1) {
          const spellings = [...sources].sort().map((s) => `"${s}"`).join(", ");
          throw new Error(
            `Keycloak role-name collision on client "${clientId}": ` +
              `distinct authored roles ${spellings} all normalize to "${name}". ` +
              `Merging them would silently combine their access grants. ` +
              `Use a single canonical spelling for this role.`,
          );
        }
      }
      clientRolesOut[clientId] = list;
    }
  }
  for (const [clientId, roles] of entityAggregate.clientRoles) {
    const existing = clientRolesOut[clientId] ?? [];
    const seen = new Set(existing.map((r) => r.name));
    for (const role of roles) {
      if (!seen.has(role.name)) {
        existing.push(role);
        seen.add(role.name);
      }
    }
    clientRolesOut[clientId] = existing;
  }

  const clients = clientDefs.map((c) => buildClient(c, resourceClientIds, dev));

  const groupNodes = authConfig.groups ?? [];
  const groupsOut = groupNodes.length > 0 ? buildKeycloakGroupsFromAuthoring(groupNodes, "") : undefined;

  // Seeded users are KEPT in production, but their passwords are held to the
  // same rule as client secrets: a committed literal is refused, a ${env:VAR}
  // reference is required.
  //
  // Dropping them instead would have been easier and wrong. These identities
  // are what the e2e suite authenticates as to prove realm roles are enforced
  // and that one tenant cannot read another's rows — assurances that matter
  // MORE against a deployed environment than a laptop. Removing them would
  // silently downgrade those tests to skipped exactly where they count.
  const users: KeycloakUser[] = (authConfig.users ?? []).map((u) => ({
    username: u.username,
    enabled: u.enabled ?? true,
    email: u.email,
    firstName: u.firstName,
    lastName: u.lastName,
    credentials: [
      { type: "password", value: resolveUserPassword(u, dev), temporary: false },
    ],
    attributes: u.tid ? { tid: [u.tid] } : undefined,
    realmRoles: u.realmRoles ? normalizeKeycloakRoleNames(u.realmRoles) : undefined,
    groups: u.groups?.length ? [...u.groups] : undefined,
    clientRoles: normalizeClientRoleMap(u.clientRoles),
  }));

  // Service-account client-role grants. Keycloak's realm import binds a client's
  // service account through a synthetic `service-account-<clientId>` user that
  // sets `serviceAccountClientId`; its `clientRoles` become the service
  // account's role mappings. These are NOT entity-derived roles (e.g.
  // realm-management/manage-realm), so they are emitted verbatim.
  const serviceAccountUsers: KeycloakUser[] = clientDefs
    .filter(
      (c) =>
        c.kind === "serviceAccount" &&
        c.serviceAccountClientRoles &&
        Object.keys(c.serviceAccountClientRoles).length > 0,
    )
    .map((c) => ({
      username: `service-account-${c.id}`,
      enabled: true,
      serviceAccountClientId: c.id,
      clientRoles: c.serviceAccountClientRoles,
    }));

  const realmCfg = authConfig.realm ?? {};
  const legacyEvents = authConfig.keycloak?.realm;
  const realm: KeycloakRealmExport = {
    realm: realmCfg.name ?? DEFAULT_REALM_NAME,
    displayName: realmCfg.displayName,
    enabled: realmCfg.enabled ?? true,
    // Forced in production rather than merely defaulted: the authored value is
    // `none`, which exists so the local compose stack works over plain HTTP.
    // Carrying that into a published realm would let Keycloak accept
    // unencrypted traffic, so the mode overrides it outright.
    sslRequired: dev ? realmCfg.sslRequired : "external",
    loginTheme: realmCfg.loginTheme,
    accountTheme: realmCfg.accountTheme,
    adminTheme: realmCfg.adminTheme,
    emailTheme: realmCfg.emailTheme,
    registrationAllowed: realmCfg.registrationAllowed,
    loginWithEmailAllowed: realmCfg.loginWithEmailAllowed,
    duplicateEmailsAllowed: realmCfg.duplicateEmailsAllowed,
    resetPasswordAllowed: realmCfg.resetPasswordAllowed,
    editUsernameAllowed: realmCfg.editUsernameAllowed,
    // Also forced: an internet-reachable login endpoint without lockout is an
    // open invitation to credential stuffing, and the authored default is off
    // so local test logins are not throttled.
    bruteForceProtected: dev ? realmCfg.bruteForceProtected : true,
    organizationsEnabled: realmCfg.organizationsEnabled,
    accessTokenLifespan: realmCfg.accessTokenLifespan,
    ssoSessionIdleTimeout: realmCfg.ssoSessionIdleTimeout,
    ssoSessionMaxLifespan: realmCfg.ssoSessionMaxLifespan,
    eventsEnabled: realmCfg.events?.enabled ?? legacyEvents?.eventsEnabled,
    adminEventsEnabled: realmCfg.events?.adminEnabled ?? legacyEvents?.adminEventsEnabled,
    eventsListeners: realmCfg.events?.listeners ?? legacyEvents?.eventsListeners,
    clients,
    roles: {
      realm: realmRoles,
      client: clientRolesOut,
    },
    ...(groupsOut ? { groups: groupsOut } : {}),
    users: [...users, ...serviceAccountUsers],
  };

  // JSON.parse(JSON.stringify(...)) drops undefined keys for stable output.
  const cleaned = JSON.parse(JSON.stringify(realm));
  return [
    {
      path: KEYCLOAK_REALM_OUTPUT_PATH,
      contents: JSON.stringify(cleaned, null, 2) + "\n",
    },
  ];
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}
