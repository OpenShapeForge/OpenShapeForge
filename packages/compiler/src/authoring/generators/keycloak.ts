// SPDX-License-Identifier: BUSL-1.1
/**
 * Keycloak realm-export generator.
 *
 * Pipeline position: cross-entity generator. Combines hand-authored YAML
 * (every `kind: authorizationConfig` document in the resolved authoring tree)
 * with the entity-derived client roles emitted by every compiled entity
 * contract.
 *
 * Output — ONE FILE PER AUTHORED REALM:
 *   `keycloak/<realm-name>-realm.json`
 *
 * Plural since #288. The tenant realm (`openshapeforge`) and the control realm
 * (`openshapeforge-control`, the issuer `apps/admin` signs operators in
 * against) are separate documents on purpose: an operator identity must never
 * exist in the realm tenants log into. Both files land in the same directory
 * because Keycloak's `--import-realm` imports every file under its import
 * directory — see `docker-compose.local.yml`, which mounts both.
 *
 * The output is mounted into the local Keycloak container by
 * `docker-compose.local.yml` and into production Keycloak configuration.
 * Hand-editing a generated file is forbidden — see
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
 *     realm carrying a checked-in literal secret fails generation. The rule is
 *     per-realm and mode-driven, so it fires for EVERY authored realm, not just
 *     the first one.
 *   - external identity providers (`keycloak.identityProviders`) — the host
 *     authors every provider, id, URL, scope and mapper; OSF emits them
 *     unchanged and never adds one of its own. See buildIdentityProviders for
 *     the (purely security) validations that can reject an entry.
 */
// @ts-nocheck
import type { CompiledEntityContract } from "../types/compiled.js";
import type {
  AuthorizationConfigFile,
  AuthorizationClient,
  AuthorizationGroupNode,
  AuthorizationIdentityProvider,
  AuthorizationIdentityProviderMapper,
  AuthorizationRealmConfig,
  AuthorizationRealmRole,
} from "../types/authoring.js";
import { KEYCLOAK_ROLE_SEGMENT_RENAMES, normalizeKeycloakRoleName } from "../role-names.js";

const DEFAULT_REALM_NAME = "openshapeforge";

/**
 * The compiler-owned directory every realm export is written under. Registered
 * in `generated-artifact-paths.ts`, where `check:generated` treats anything
 * under it that this generator did not emit as an orphan.
 */
export const KEYCLOAK_OUTPUT_ROOT = "keycloak";

/**
 * Realm names accepted as an output FILENAME segment.
 *
 * Deliberately narrower than what Keycloak itself accepts. The name is spliced
 * straight into a path, so a name carrying `/`, `\` or a leading `.` would let
 * an authoring document decide where on disk the compiler writes — outside the
 * one root `check:generated` polices, with no gate able to notice. Anything
 * outside this alphabet fails generation instead.
 */
const REALM_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** `keycloak/<realm>-realm.json` for a realm name, or throw if unsafe. */
export function keycloakRealmOutputPath(realmName: string): string {
  if (!REALM_NAME_RE.test(realmName)) {
    throw new Error(
      `Realm name "${realmName}" cannot be used as an output filename. ` +
        "A realm name is spliced into keycloak/<realm>-realm.json, so it must " +
        "start with a letter or digit and contain only letters, digits, '-' or '_'.",
    );
  }
  return `${KEYCLOAK_OUTPUT_ROOT}/${realmName}-realm.json`;
}

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

interface KeycloakIdentityProvider {
  alias: string;
  displayName?: string;
  providerId: string;
  enabled: boolean;
  trustEmail: boolean;
  storeToken: boolean;
  linkOnly: boolean;
  hideOnLogin: boolean;
  firstBrokerLoginFlowAlias?: string;
  postBrokerLoginFlowAlias?: string;
  config: Record<string, string>;
}

interface KeycloakIdentityProviderMapper {
  name: string;
  identityProviderAlias: string;
  identityProviderMapper: string;
  config: Record<string, string>;
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
  identityProviders?: KeycloakIdentityProvider[];
  identityProviderMappers?: KeycloakIdentityProviderMapper[];
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

/**
 * The one secret-resolution policy, shared by client secrets and identity-
 * provider secrets so a tightening applied to one cannot be missed in the
 * other:
 *   - development takes the dev-only literal FIRST, before any env reference
 *     is resolved, so local work never needs a production variable;
 *   - a `${env:VAR}` / `${env:VAR:-fallback}` value is resolved in any mode
 *     (the fallback is development-only, see resolveEnvRef);
 *   - a literal value is accepted in development only;
 *   - production with nothing but a dev-only literal is refused.
 *
 * Error messages name `what` and, through resolveEnvRef, a variable name —
 * never a resolved or authored value.
 */
function resolveSecretValue(
  what: string,
  value: string | undefined,
  devValue: string | undefined,
  dev: boolean,
  wording: { literal: string; devOnly: string; devOnlyHint: string },
): string | undefined {
  if (dev && devValue !== undefined) return devValue;

  if (value !== undefined) {
    const resolved = resolveEnvRef(value, dev, what);
    if (resolved !== undefined) return resolved;
    // Literal secret: acceptable only where committed credentials are.
    if (!dev) {
      throw new Error(
        `${what}: a literal ${wording.literal} is committed for a non-dev realm. Use a \${env:VAR} reference resolved at generate/deploy time instead.`,
      );
    }
    return value;
  }

  if (devValue !== undefined) {
    // Production, and the only value on offer is a committed literal. Refusing
    // here is the whole point of the guard: it is what stops a published realm
    // shipping a secret that is readable in the repository.
    throw new Error(
      `${what}: only a ${wording.devOnly} is configured, but the realm is not a development realm. ${wording.devOnlyHint}`,
    );
  }

  return undefined;
}

const CLIENT_SECRET_WORDING = {
  literal: "client secret",
  devOnly: "devSecret",
  devOnlyHint: 'Add "secret: ${env:VAR}" alongside it for production.',
};

const IDP_SECRET_WORDING = {
  literal: "secret",
  devOnly: "devSecrets entry",
  devOnlyHint: "Supply `secrets` as ${env:VAR} references instead.",
};

export function resolveClientSecret(
  def: AuthorizationClient,
  dev: boolean,
): string | undefined {
  return resolveSecretValue(`Client "${def.id}"`, def.secret, def.devSecret, dev, CLIENT_SECRET_WORDING);
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

// ---------------------------------------------------------------------------
// External identity providers
// ---------------------------------------------------------------------------

/**
 * Config keys whose VALUE is a credential and so must not sit in the plain
 * `config` map.
 *
 * A key is secret-like when its name, lower-cased with every separator
 * removed, CONTAINS `secret`, `password`, `token`, `privatekey`, `p8key` or
 * `apikey`. Matching a substring anywhere in the flattened name — not a
 * suffix, and not a camelCase/snake_case segment — is what closes both
 * `clientSecretValue` / `passwordCredential` / `accessTokenValue` (a longer
 * name) and `clientsecret` / `p8key` / `privatekey` (no segment boundary at
 * all): a literal credential must not get through under any spelling.
 *
 * The cost is that a few legitimate non-secret Keycloak keys carry `token` in
 * their name. Those are listed explicitly in NON_SECRET_CONFIG_KEYS — an
 * allow-list of exact keys, deliberately short, rather than a looser pattern
 * that could be gamed the same way.
 */
const SECRET_WORDS = ["secret", "password", "token", "privatekey", "p8key", "apikey"];

/**
 * Exact Keycloak identity-provider config keys that mention a secret word but
 * name a URL or a switch, never a credential. Extend only with a key from
 * Keycloak's own provider representations.
 */
const NON_SECRET_CONFIG_KEYS = new Set([
  // OIDC endpoints and switches.
  "tokenUrl",
  "tokenIntrospectionUrl",
  "accessTokenIsJwt",
  "tokenExchangeAccountLinkingEnabled",
  // Keycloak-to-Keycloak / OIDC token-exchange switches.
  "tokenExchangeEnabled",
  "tokenExchangeExternalInternalEnabled",
  "tokenExchangeSupported",
]);

function keyNameSegments(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.toLowerCase());
}

/**
 * Exported for tests: is this a key that names a secret value?
 *
 * The key is flattened — lower-cased, every separator removed — and matched
 * for the secret words as SUBSTRINGS. Splitting on camelCase / separators is
 * deliberately not relied on: `p8key`, `privatekey`, `clientsecret` and
 * `apikey` are one segment each and would slip past a per-segment rule while
 * naming exactly the credential this check exists to keep out of a realm.
 */
export function isSecretLikeConfigKey(key: string): boolean {
  if (NON_SECRET_CONFIG_KEYS.has(key)) return false;
  const flat = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return SECRET_WORDS.some((word) => flat.includes(word));
}

/**
 * Config keys that carry an endpoint, issuer or metadata URL. Held to the
 * production URL rule below. Anything ending in `Url`/`Uri`/`Endpoint` plus the
 * OIDC `issuer`, which is also a URL by the discovery spec.
 *
 * Keycloak also has SWITCHES named after a URL — `useJwksUrl`,
 * `validateSignature`-style booleans — so a key whose first segment is a
 * verb-like prefix, or whose authored value is a YAML boolean, is a flag and
 * not an endpoint.
 */
const SWITCH_PREFIXES = new Set(["use", "validate", "require", "enable", "disable", "is", "has", "should", "allow"]);

function isEndpointConfigKey(key: string, raw: unknown): boolean {
  if (typeof raw === "boolean") return false;
  const segments = keyNameSegments(key);
  if (SWITCH_PREFIXES.has(segments[0])) return false;
  const last = segments[segments.length - 1];
  return last === "url" || last === "uri" || last === "endpoint" || key === "issuer";
}

/**
 * Production endpoint rule: an absolute https URL, no embedded credentials, no
 * fragment. The validated value is emitted EXACTLY as authored — this only
 * accepts or rejects, it never rewrites — so a host's dedicated provider
 * endpoints survive byte-for-byte.
 *
 * Development is exempt: a local mock issuer runs over plain http.
 */
function assertProductionEndpoint(alias: string, key: string, value: string): void {
  const reject = (why: string) => {
    throw new Error(
      `Identity provider "${alias}": config.${key} ${why} in production. ` +
        "Endpoint, issuer and JWKS URLs must be absolute https URLs without embedded credentials or a fragment.",
    );
  };
  if (value.trim() !== value || value.length === 0) reject("must be a non-empty URL without surrounding whitespace");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    reject("is not an absolute URL");
    return;
  }
  if (url.protocol !== "https:") reject(`uses ${url.protocol.replace(/:$/, "")}, not https`);
  if (url.username !== "" || url.password !== "") reject("embeds credentials");
  if (value.includes("#")) reject("carries a fragment");
}

function assertNonBlank(what: string, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${what} must be a non-blank string.`);
  }
  return value;
}

/**
 * Keycloak's representation stores every config value as a string. Authors
 * may write YAML booleans and numbers (`useJwksUrl: true`); this is the ONLY
 * transformation applied to a config value besides env-ref resolution.
 */
function normalizeConfigScalar(alias: string, key: string, value: unknown): string {
  switch (typeof value) {
    case "string":
      return value;
    case "boolean":
    case "number":
      return String(value);
    default:
      throw new Error(
        `Identity provider "${alias}": config.${key} must be a string, number or boolean.`,
      );
  }
}

function buildIdentityProviderConfig(
  def: AuthorizationIdentityProvider,
  dev: boolean,
): Record<string, string> {
  const alias = def.alias;
  const out: Record<string, string> = {};

  for (const [key, raw] of Object.entries(def.config ?? {})) {
    assertNonBlank(`Identity provider "${alias}": a config key`, key);
    if (isSecretLikeConfigKey(key)) {
      throw new Error(
        `Identity provider "${alias}": config.${key} looks like a credential. ` +
          "Move it to `secrets` (production: a ${env:VAR} reference) or `devSecrets` (development only).",
      );
    }
    const scalar = normalizeConfigScalar(alias, key, raw);
    const resolved =
      resolveEnvRef(scalar, dev, `Identity provider "${alias}": config.${key}`) ?? scalar;
    if (!dev && isEndpointConfigKey(key, raw)) {
      assertProductionEndpoint(alias, key, resolved);
    }
    out[key] = resolved;
  }

  // Secrets. resolveSecretValue is the same policy resolveClientSecret uses:
  // development takes devSecrets FIRST so local work never needs a production
  // variable. Production additionally refuses devSecrets as a whole, up front,
  // so a committed literal cannot ship even next to a valid env reference.
  const devSecrets = def.devSecrets ?? {};
  const secrets = def.secrets ?? {};
  if (!dev && Object.keys(devSecrets).length > 0) {
    throw new Error(
      `Identity provider "${alias}": devSecrets (${Object.keys(devSecrets).sort().join(", ")}) ` +
        "are development-only, but the realm is not a development realm. Supply `secrets` as ${env:VAR} references instead.",
    );
  }
  for (const key of [...Object.keys(secrets), ...Object.keys(devSecrets)]) {
    if (key in out) {
      throw new Error(
        `Identity provider "${alias}": "${key}" is authored in both config and secrets/devSecrets. Keep it in one place.`,
      );
    }
  }
  for (const key of new Set([...Object.keys(secrets), ...Object.keys(devSecrets)])) {
    assertNonBlank(`Identity provider "${alias}": a secrets key`, key);
    const what = `Identity provider "${alias}": secrets.${key}`;
    const value = secrets[key];
    const devValue = devSecrets[key];
    if (value !== undefined) assertNonBlank(what, value);
    if (devValue !== undefined) assertNonBlank(`Identity provider "${alias}": devSecrets.${key}`, devValue);
    // Error messages name the key only. resolveEnvRef reports the VARIABLE
    // name, never its value, so nothing below can leak a resolved secret.
    const resolved = resolveSecretValue(what, value, devValue, dev, IDP_SECRET_WORDING);
    if (resolved !== undefined) out[key] = resolved;
  }

  return out;
}

function buildIdentityProviderMappers(
  def: AuthorizationIdentityProvider,
  dev: boolean,
): KeycloakIdentityProviderMapper[] {
  const alias = def.alias;
  const seen = new Set<string>();
  return (def.mappers ?? []).map((mapper: AuthorizationIdentityProviderMapper) => {
    const name = assertNonBlank(`Identity provider "${alias}": a mapper name`, mapper.name);
    const type = assertNonBlank(
      `Identity provider "${alias}": mapper "${name}" identityProviderMapper`,
      mapper.identityProviderMapper,
    );
    if (seen.has(name)) {
      throw new Error(
        `Identity provider "${alias}": mapper name "${name}" is declared twice. Keycloak requires mapper names to be unique per provider.`,
      );
    }
    seen.add(name);
    const config: Record<string, string> = {};
    for (const [key, raw] of Object.entries(mapper.config ?? {})) {
      assertNonBlank(`Identity provider "${alias}": mapper "${name}" config key`, key);
      // Same rules as provider config: YAML scalars become strings and
      // `${env:VAR}` references resolve at generate time, so a parameterised
      // role or attribute mapper never imports a literal placeholder.
      const scalar = normalizeConfigScalar(alias, `mappers.${name}.${key}`, raw);
      config[key] =
        resolveEnvRef(scalar, dev, `Identity provider "${alias}": mapper "${name}" config.${key}`) ?? scalar;
    }
    return {
      name,
      identityProviderAlias: alias,
      identityProviderMapper: type,
      config,
    };
  });
}

/**
 * The bundled Apple provider can, on token exchange, link an incoming Apple
 * identity to an EXISTING account by matching e-mail address when
 * `tokenExchangeAccountLinkingEnabled` is on. That is exactly the silent
 * e-mail linking #488 rules out, so for `providerId: apple` the flag is not a
 * pass-through: it must be authored, and it must be `false`. An absent flag is
 * refused too — the provider's own default is not something this generator
 * vouches for, and an explicit `false` in the realm is what a reviewer can see.
 */
const APPLE_LINKING_KEY = "tokenExchangeAccountLinkingEnabled";

function assertAppleLinkingPolicy(
  alias: string,
  providerId: string,
  config: Record<string, unknown>,
): void {
  if (providerId !== "apple") return;
  const raw = config[APPLE_LINKING_KEY];
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : raw;
  if (value === false || value === "false") return;
  throw new Error(
    raw === undefined
      ? `Identity provider "${alias}" (apple): config.${APPLE_LINKING_KEY} must be authored explicitly as false. ` +
          "Automatic e-mail-based account linking on token exchange is outside the approved design."
      : `Identity provider "${alias}" (apple): config.${APPLE_LINKING_KEY} must be false, not ${JSON.stringify(raw)}. ` +
          "Enabling it would let the Apple provider link an existing account by e-mail address without the user's first-broker-login confirmation.",
  );
}

/**
 * Emit the host's identity providers, unchanged.
 *
 * What this deliberately does NOT do: supply endpoint defaults for a built-in
 * provider, rename an alias, add a mapper, or enable anything. A host that
 * wants Google authors `providerId: google`; a host that wants its own
 * workforce IdP authors `providerId: oidc` with its own URLs; a host that
 * wants neither authors nothing and gets a realm with no external provider.
 * The defaults applied are the conservative Keycloak ones — `enabled` on,
 * `trustEmail`/`storeToken`/`linkOnly`/`hideOnLogin` off — and every other
 * field is passed through as authored.
 */
function buildIdentityProviders(
  defs: AuthorizationIdentityProvider[],
  dev: boolean,
): { identityProviders: KeycloakIdentityProvider[]; identityProviderMappers: KeycloakIdentityProviderMapper[] } {
  const identityProviders: KeycloakIdentityProvider[] = [];
  const identityProviderMappers: KeycloakIdentityProviderMapper[] = [];
  const aliases = new Set<string>();

  for (const def of defs) {
    const alias = assertNonBlank("Identity provider alias", def.alias);
    const providerId = assertNonBlank(`Identity provider "${alias}": providerId`, def.providerId);
    if (aliases.has(alias)) {
      throw new Error(
        `Identity provider alias "${alias}" is declared twice in one realm. Aliases must be unique per realm.`,
      );
    }
    aliases.add(alias);
    assertAppleLinkingPolicy(alias, providerId, def.config ?? {});

    identityProviders.push({
      alias,
      displayName: def.displayName,
      providerId,
      enabled: def.enabled ?? true,
      trustEmail: def.trustEmail ?? false,
      storeToken: def.storeToken ?? false,
      linkOnly: def.linkOnly ?? false,
      hideOnLogin: def.hideOnLogin ?? false,
      firstBrokerLoginFlowAlias: def.firstBrokerLoginFlowAlias,
      postBrokerLoginFlowAlias: def.postBrokerLoginFlowAlias,
      config: buildIdentityProviderConfig(def, dev),
    });
    identityProviderMappers.push(...buildIdentityProviderMappers(def, dev));
  }

  return { identityProviders, identityProviderMappers };
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
  entityRoleClient: string | undefined,
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
    // `includes` is a wildcard expansion over ENTITY-derived roles, which only
    // exist on the entity-role client. A realm that declares no such client has
    // nothing to expand onto, so the pattern would silently resolve to an empty
    // composite that reads like a grant. Refuse instead.
    if (!entityRoleClient) {
      throw new Error(
        `Realm role "${name}" uses \`includes\`, which expands entity-derived ` +
          "roles onto the entity-role client, but this realm authors no " +
          "keycloak.entityRoleClient. Use explicit `composites` instead.",
      );
    }
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

  const realmCfg = authConfig.realm ?? {};
  const realmName = realmCfg.name ?? DEFAULT_REALM_NAME;
  // Validated up front rather than at the return: an unusable realm name is a
  // fault in the authoring, and reporting it only after a realm has been fully
  // assembled (or, worse, only when the assembly happens to reach the return)
  // would make it depend on unrelated config.
  const outputPath = keycloakRealmOutputPath(realmName);

  // Which client receives the entity-derived roles (natural-person:read, …).
  //
  // No fallback: absence means "this realm does not participate in entity role
  // generation" and is the supported shape for a realm with no entities behind
  // it — the control realm operators sign in against has no entity model, and
  // pushing this repo's entity roles onto a client it never declares would
  // emit a realm export referencing a client that does not exist. The former
  // hardcoded "erp-provider" default made that the silent outcome for every
  // realm that stayed quiet about it.
  const entityRoleClient =
    authConfig.keycloak?.entityRoleClient ?? authConfig.keycloak?.client;

  const realmRolesDef = authConfig.realmRoles ?? authConfig.keycloak?.realmRoles ?? {};

  const clientDefs = authConfig.keycloak?.clients ?? [];
  const resourceClientIds = clientDefs
    .filter((c) => c.kind === "bearerOnly")
    .map((c) => c.id);
  const dev = isDevRealm(authConfig.realm, mode);

  const entityAggregate = entityRoleClient
    ? aggregateFromEntities(contracts, entityRoleClient)
    : { clientRoles: new Map(), entityComposites: new Map() };

  const identityProviderDefs = authConfig.keycloak?.identityProviders ?? [];

  if (
    clientDefs.length === 0 &&
    entityAggregate.clientRoles.size === 0 &&
    identityProviderDefs.length === 0
  ) {
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

  // External identity providers: host-authored, emitted unchanged, none by
  // default. Only present in the export when the realm authors at least one,
  // so a realm that stays quiet gets no `identityProviders` key at all rather
  // than an empty list that reads like a decision.
  const idp = buildIdentityProviders(identityProviderDefs, dev);

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

  const legacyEvents = authConfig.keycloak?.realm;
  const realm: KeycloakRealmExport = {
    realm: realmName,
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
    ...(idp.identityProviders.length > 0
      ? {
          identityProviders: idp.identityProviders,
          identityProviderMappers: idp.identityProviderMappers,
        }
      : {}),
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
      path: outputPath,
      contents: JSON.stringify(cleaned, null, 2) + "\n",
    },
  ];
}

/**
 * Every authored realm, in one pass over the shared entity contracts.
 *
 * Separate from the single-config entry point so the ONE property that only
 * exists across realms — that two documents cannot claim the same realm — is
 * enforced somewhere testable. Two documents naming the same realm would
 * otherwise resolve to the same output path, and whichever ran last would win
 * silently: an authoring mistake that hands one realm another's clients,
 * secrets and users.
 *
 * The collision is caught here rather than left to the compiler's global
 * artifact-path check because by then the message is "path emitted twice",
 * which says nothing about which two realm documents disagree.
 */
export function generateAllKeycloakRealmArtifacts(
  contracts: CompiledEntityContract[],
  authConfigs: readonly (AuthorizationConfigFile | null | undefined)[],
  mode: RealmMode = resolveRealmMode(),
): KeycloakRealmArtifact[] {
  const artifacts: KeycloakRealmArtifact[] = [];
  const seenPaths = new Set<string>();

  for (const authConfig of authConfigs) {
    for (const artifact of generateKeycloakRealmArtifacts(contracts, authConfig, mode)) {
      if (seenPaths.has(artifact.path)) {
        throw new Error(
          `Two authorizationConfig documents declare realm "${authConfig?.realm?.name ?? DEFAULT_REALM_NAME}". ` +
            `Each realm is generated to ${artifact.path}, so one would overwrite the other. ` +
            "Give every authored realm its own `realm.name`.",
        );
      }
      seenPaths.add(artifact.path);
      artifacts.push(artifact);
    }
  }

  return artifacts;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}
