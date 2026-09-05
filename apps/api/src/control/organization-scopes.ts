// SPDX-License-Identifier: BUSL-1.1
/**
 * The per-organization MCP audience scope, provisioned by the control plane.
 *
 * ── WHAT THE SCOPE IS FOR ───────────────────────────────────────────────────
 *
 * The runtime serves one MCP resource per Keycloak Organization,
 * `<origin>/api/mcp/organizations/<alias>` (`mcp/organization-resource.ts`),
 * and `auth/organization-binding.ts` admits a token there only when its `aud`
 * names that exact URL. Keycloak 26 does not turn the OAuth `resource`
 * parameter into an audience, so the audience has to come from a static client
 * scope carrying one `oidc-audience-mapper` per public origin. That scope is
 * `mcp-resource:<alias>` — deliberately NOT `organization:<alias>`, which would
 * shadow Keycloak's built-in dynamic organization scope (the token then carries
 * the audience but no membership claim; verified on 26.5.3). A client requests
 * both, and the per-resource protected-resource metadata advertises both.
 *
 * ── WHY THE CONTROL PLANE OWNS IT ───────────────────────────────────────────
 *
 * The scope is identity configuration that exists BECAUSE the Organization
 * exists, so it is provisioned where the Organization is: `provisionTenant` and
 * `provisionSubOrganization` ensure it right after the link is stamped, and
 * reconciliation reports and repairs it alongside the hierarchy attributes. A
 * dev script that has to be re-run after every tenant create is exactly the
 * kind of second, out-of-band owner the control plane exists to replace.
 *
 * ── WHAT IS ENSURED, AND HOW ────────────────────────────────────────────────
 *
 * For an Organization alias, idempotently:
 *   - client scope `mcp-resource:<alias>` exists (`include.in.token.scope`,
 *     hidden from consent and from the provider metadata);
 *   - it carries exactly one audience mapper per configured resource origin,
 *     value `<origin>/api/mcp/organizations/<alias>` — mappers for origins no
 *     longer configured are removed, so an origin change converges;
 *   - it is an OPTIONAL scope of every configured client and of the realm's
 *     default optional scopes, so dynamically registered MCP clients can
 *     request it too. A scope a client already holds as DEFAULT is left alone:
 *     that is a stronger binding someone chose, not drift.
 *   - it is listed in the realm's anonymous `Allowed Client Scopes`
 *     client-registration policy, so a client that registers itself may ask
 *     for it at all — see below.
 *
 * ── THE CLIENT-REGISTRATION ALLOW-LIST ──────────────────────────────────────
 *
 * Attaching the scope is not enough for a client that arrives through Dynamic
 * Client Registration (RFC 7591) rather than pre-registered in the realm export
 * — Claude Code does, Codex does not. Keycloak runs the requested `scope`
 * string of a registration through the `allowed-client-templates` policy
 * component (`subType: anonymous`), which admits only the names in its
 * `allowed-client-scopes` config. A default realm ships that list with `openid`
 * and `offline_access`, so every tenant the control plane provisions used to
 * create a scope that self-registering clients were then forbidden to request:
 * `403 insufficient_scope, Policy 'Allowed Client Scopes' rejected request`.
 * Provisioning therefore owns that list too, for the scopes it creates.
 *
 * Three things about that component decide the shape of the code here, all
 * verified against Keycloak 26.5.3 (`ClientScopesClientRegistrationPolicy`,
 * `…PolicyFactory` and `oidc/DescriptionConverter`):
 *
 *   1. The list is EDITED, never replaced: whatever else a deployment allows —
 *      `openid`, `offline_access`, another product's scope — is not this
 *      module's to drop. Only entries this module owns (`mcp-resource:*`) are
 *      ever removed, and only as orphans.
 *   2. An entry must NAME AN EXISTING CLIENT SCOPE in the realm (plus the
 *      literal `openid`). `validateConfiguration` refuses the whole list
 *      otherwise, so a wanted entry with no client scope behind it is skipped
 *      rather than written — that is what makes a realm without the
 *      organizations feature a no-op instead of a failed provision.
 *   3. The registration request's scope tokens are compared LITERALLY, before
 *      Keycloak resolves them. `organization:<alias>` is therefore not a name
 *      this list can hold (rule 2 refuses it) and not one it can match; the
 *      entry is the client scope it instantiates, `organization`. See
 *      {@link organizationResourceScopeNames} — and the caveat below.
 *
 * If the realm has NO such component at all — a deployment that never
 * configured client registration — this module does nothing and says so
 * (`registrationPolicyPresent: false`, no drift finding). Creating one would be
 * inventing a client-registration security policy for a deployment that never
 * asked for one, and a realm with no policy already permits every scope.
 *
 * ── CAVEAT: `organization:<alias>` AT REGISTRATION TIME ─────────────────────
 *
 * Rule 3 has a consequence this module cannot fix: a client that puts the
 * per-organization metadata's `scopes_supported` verbatim into its REGISTRATION
 * request asks for `organization:<alias>`, which no allow-list entry can match.
 * Nothing is broken about the token flow — the registered client gets
 * `organization` as a realm default scope and may request `organization:<alias>`
 * at the authorization endpoint — but the registration itself is refused while
 * the policy is enabled. Closing that is a decision about what
 * `scopes_supported` advertises, or about whether the anonymous policy belongs
 * in this realm at all; both belong to whoever owns the realm, not here.
 *
 * Realm-wide reconciliation additionally REMOVES `mcp-resource:*` scopes whose
 * alias names no Organization in the realm. That is the one deletion the
 * control plane performs in Keycloak, and it is safe in a way deleting an
 * Organization is not: a scope holds no members, no identity providers and no
 * domains — it is derived configuration, fully recomputable from the alias and
 * the origins. It has to be removed here because an Organization alias is
 * immutable in Keycloak, so a tenant rename is a new Organization plus deletion
 * of the old one, and the old scope would otherwise survive forever.
 *
 * ── WHY THE SERVICE ACCOUNT NEEDS manage-clients ────────────────────────────
 *
 * Client scopes, protocol mappers, a client's optional scopes and the realm
 * default scopes are all CLIENT configuration in Keycloak's admin permission
 * model, gated by realm-management `manage-clients`. `manage-realm`, which the
 * Organization endpoints and the SPI require, does not cover them (verified on
 * 26.5.3: every `/client-scopes` call answers 403 with `manage-realm` alone).
 * So `openshapeforge-auth-api` holds both, and the error a missing grant
 * produces names the role rather than presenting as the operator's 403. The
 * `/components` calls the registration allow-list needs go the other way —
 * they are REALM configuration, gated by `manage-realm` — which is why holding
 * both is what makes this module work at all.
 *
 * Nothing here reads a database: every function takes the client and the
 * settings explicitly, so the pure parts are testable against an in-memory
 * fake and the HTTP client against a stub fetch.
 */
import {
  isOrganizationAlias,
  organizationMcpPath,
  organizationResourceScope,
  organizationResourceScopeNames,
} from "../mcp/organization-resource.js";
import { KeycloakAdminError } from "./keycloak-organization-admin.js";
import {
  createServiceAccountTokenProvider,
  describeError,
  readJson,
  REQUEST_TIMEOUT_MS,
  type KeycloakServiceAccountConfig,
  type ServiceAccountTokenProvider,
} from "./keycloak-service-account.js";

/** `mcp-resource:` — every scope this module owns starts with it. */
export const ORGANIZATION_SCOPE_PREFIX = organizationResourceScope("");

export const AUDIENCE_MAPPER_TYPE = "oidc-audience-mapper";

/** The realm component the client-registration policies are stored as. */
export const CLIENT_REGISTRATION_POLICY_TYPE =
  "org.keycloak.services.clientregistration.policy.ClientRegistrationPolicy";

/** `Allowed Client Scopes` — the one policy provider this module edits. */
export const ALLOWED_CLIENT_SCOPES_PROVIDER = "allowed-client-templates";

/**
 * Anonymous registration only. The `authenticated` policy of the same provider
 * governs updates made with a registration access token, which is a different
 * and already-authenticated party; a client that registers itself with no
 * credential at all is the one that needs the scope allowed up front.
 */
export const ANONYMOUS_POLICY_SUBTYPE = "anonymous";

/** The config key holding the allow-list, inside that component. */
export const ALLOWED_CLIENT_SCOPES_CONFIG = "allowed-client-scopes";

/**
 * The clients the scope is attached to when `OPENSHAPEFORGE_MCP_CLIENTS` is
 * unset: the local Codex client, the product gateway, and the MCP inspector.
 * A client that does not exist in the realm is skipped, not created.
 */
export const DEFAULT_MCP_CLIENTS = [
  "codex",
  "openshapeforge-gateway",
  "openshapeforge-inspector",
] as const;

export type OrganizationScopeSettings = {
  /** Public origins the MCP resources are served on; no trailing slash. */
  origins: readonly string[];
  /** `clientId`s the scope is attached to as an optional scope. */
  clients: readonly string[];
};

/** The audience value one mapper carries: the canonical resource URL. */
export function resourceAudience(origin: string, alias: string): string {
  return `${origin}${organizationMcpPath(alias)}`;
}

/** The alias a `mcp-resource:<alias>` scope names, or null for any other scope. */
export function organizationAliasOfScope(scopeName: string): string | null {
  if (!scopeName.startsWith(ORGANIZATION_SCOPE_PREFIX)) return null;
  const alias = scopeName.slice(ORGANIZATION_SCOPE_PREFIX.length);
  return isOrganizationAlias(alias) ? alias : null;
}

// ---------------------------------------------------------------------------
// The admin-API surface this module needs, narrowed to what it uses

export type ClientScopeSummary = { id: string; name: string };

export type AudienceMapper = {
  id: string;
  /** `included.custom.audience`; null when the mapper carries none. */
  audience: string | null;
  /** `access.token.claim` — a mapper that only lands in the id token is useless here. */
  accessTokenClaim: boolean;
};

export type ClientScopeAttachment = {
  /** The client's uuid, which the attach endpoint is addressed by. */
  id: string;
  clientId: string;
  defaultClientScopes: string[];
  optionalClientScopes: string[];
};

export type RealmDefaultScopes = {
  defaultScopes: string[];
  optionalScopes: string[];
};

/** The realm's anonymous `Allowed Client Scopes` policy, narrowed to its list. */
export type RegistrationPolicySnapshot = {
  /** The component's id, which the update is addressed by. */
  id: string;
  /** `allowed-client-scopes`, in the order the realm holds it. */
  allowedScopes: string[];
};

export type OrganizationScopeAdminClient = {
  listClientScopes(): Promise<ClientScopeSummary[]>;
  createClientScope(input: { name: string; description: string }): Promise<ClientScopeSummary>;
  deleteClientScope(scopeId: string): Promise<void>;
  listAudienceMappers(scopeId: string): Promise<AudienceMapper[]>;
  createAudienceMapper(scopeId: string, audience: string): Promise<void>;
  deleteProtocolMapper(scopeId: string, mapperId: string): Promise<void>;
  /** Null when no client with that `clientId` exists in the realm. */
  findClient(clientId: string): Promise<ClientScopeAttachment | null>;
  addOptionalClientScope(clientUuid: string, scopeId: string): Promise<void>;
  getRealmDefaultScopes(): Promise<RealmDefaultScopes>;
  addRealmOptionalScope(scopeId: string): Promise<void>;
  /** Null when the realm has no anonymous `allowed-client-templates` component. */
  findRegistrationPolicy(): Promise<RegistrationPolicySnapshot | null>;
  /**
   * Replace ONLY the `allowed-client-scopes` config of that component, leaving
   * `allow-default-scopes` and every other key it carries untouched.
   */
  setRegistrationPolicyScopes(policyId: string, scopes: readonly string[]): Promise<void>;
};

// ---------------------------------------------------------------------------
// Ensure / reconcile / compare

export type OrganizationScopeActionKind =
  | "SCOPE_CREATED"
  | "SCOPE_REMOVED"
  | "AUDIENCE_ADDED"
  | "AUDIENCE_REMOVED"
  | "CLIENT_ATTACHED"
  | "REALM_ATTACHED"
  /** A name added to the anonymous `Allowed Client Scopes` policy. */
  | "POLICY_ALLOWED"
  /** An orphan `mcp-resource:*` name removed from that policy. */
  | "POLICY_REVOKED";

export type OrganizationScopeAction = {
  kind: OrganizationScopeActionKind;
  scope: string;
  /**
   * The audience, the clientId, the allow-list entry, or null when the scope
   * itself is the subject.
   */
  subject: string | null;
};

export type OrganizationScopeState = {
  scope: string;
  /** The audiences the scope carries after the call, sorted. */
  audiences: string[];
  actions: OrganizationScopeAction[];
  /**
   * Whether the realm has an anonymous `Allowed Client Scopes` policy at all.
   * False means the allow-list step was a deliberate no-op, not a failure: this
   * module never CREATES that component (see the module header), and a realm
   * without one already lets a self-registering client ask for any scope.
   */
  registrationPolicyPresent: boolean;
};

export type OrganizationScopeDriftCode =
  /** No `mcp-resource:<alias>` scope for an Organization that exists. */
  | "ORGANIZATION_SCOPE_MISSING"
  /** The scope exists but its audience mappers do not match the configured origins. */
  | "ORGANIZATION_SCOPE_AUDIENCE_MISMATCH"
  /** The scope is not an optional scope of a configured client or of the realm defaults. */
  | "ORGANIZATION_SCOPE_NOT_ATTACHED"
  /**
   * The scope exists but the realm's anonymous `Allowed Client Scopes`
   * client-registration policy does not list it, so a dynamically registering
   * MCP client is refused when it asks for it.
   */
  | "ORGANIZATION_SCOPE_NOT_REGISTRABLE"
  /** A `mcp-resource:*` scope, or allow-list entry, whose alias names no Organization. */
  | "ORGANIZATION_SCOPE_ORPHANED";

export const ORGANIZATION_SCOPE_DRIFT_CODES: readonly OrganizationScopeDriftCode[] = [
  "ORGANIZATION_SCOPE_MISSING",
  "ORGANIZATION_SCOPE_AUDIENCE_MISMATCH",
  "ORGANIZATION_SCOPE_NOT_ATTACHED",
  "ORGANIZATION_SCOPE_NOT_REGISTRABLE",
  "ORGANIZATION_SCOPE_ORPHANED",
];

export function isOrganizationScopeDriftCode(code: string): code is OrganizationScopeDriftCode {
  return (ORGANIZATION_SCOPE_DRIFT_CODES as readonly string[]).includes(code);
}

export type OrganizationScopeDrift = {
  code: OrganizationScopeDriftCode;
  /** Null only for an orphan whose scope name does not parse as an alias. */
  alias: string | null;
  scope: string;
  expected: string | null;
  actual: string | null;
  message: string;
};

type RealmScopeSnapshot = {
  scopes: ClientScopeSummary[];
  /** Keyed by clientId; null when the realm has no such client. */
  clients: Map<string, ClientScopeAttachment | null>;
  realm: RealmDefaultScopes;
  /** Null when the realm has no anonymous `Allowed Client Scopes` policy. */
  policy: RegistrationPolicySnapshot | null;
};

function normaliseSettings(settings: OrganizationScopeSettings): {
  origins: string[];
  clients: string[];
} {
  return {
    origins: [...new Set(settings.origins.map((origin) => origin.replace(/\/+$/, "")))].filter(
      (origin) => origin.length > 0,
    ),
    clients: [...new Set(settings.clients.map((client) => client.trim()))].filter(
      (client) => client.length > 0,
    ),
  };
}

async function readSnapshot(
  client: OrganizationScopeAdminClient,
  clients: readonly string[],
): Promise<RealmScopeSnapshot> {
  const scopes = await client.listClientScopes();
  const attachments = new Map<string, ClientScopeAttachment | null>();
  for (const clientId of clients) {
    attachments.set(clientId, await client.findClient(clientId));
  }
  return {
    scopes,
    clients: attachments,
    realm: await client.getRealmDefaultScopes(),
    policy: await client.findRegistrationPolicy(),
  };
}

function wantedAudiences(alias: string, origins: readonly string[]): string[] {
  return [...new Set(origins.map((origin) => resourceAudience(origin, alias)))].sort();
}

/**
 * The allow-list entries one Organization's resource needs, restricted to the
 * ones the realm can actually hold.
 *
 * The wanted set is {@link organizationResourceScopeNames}, which is derived
 * from what the protected-resource metadata advertises rather than written out
 * again here. The filter is Keycloak's own rule (rule 2 in the module header):
 * a name with no client scope behind it makes `validateConfiguration` refuse
 * the WHOLE list, so it is skipped instead — a realm without the organizations
 * feature simply gets `mcp-resource:<alias>` allowed and no error.
 */
function wantedPolicyEntries(
  alias: string,
  scopes: readonly ClientScopeSummary[],
): string[] {
  const realmScopes = new Set(scopes.map((scope) => scope.name));
  return organizationResourceScopeNames(alias).filter((name) => realmScopes.has(name));
}

/**
 * Bring one Organization's scope to the configured state, with a snapshot the
 * caller already holds. The snapshot is MUTATED as things are created and
 * attached, so a realm-wide run stays consistent across aliases without
 * re-reading the realm between them.
 */
async function ensureWithSnapshot(
  client: OrganizationScopeAdminClient,
  alias: string,
  settings: { origins: string[]; clients: string[] },
  snapshot: RealmScopeSnapshot,
): Promise<OrganizationScopeState> {
  const name = organizationResourceScope(alias);
  const actions: OrganizationScopeAction[] = [];

  // ── the scope ────────────────────────────────────────────────────────────
  let scope = snapshot.scopes.find((item) => item.name === name);
  if (!scope) {
    scope = await client.createClientScope({
      name,
      description: `Audience of the per-organization MCP resource(s) of Keycloak Organization \`${alias}\`.`,
    });
    snapshot.scopes.push(scope);
    actions.push({ kind: "SCOPE_CREATED", scope: name, subject: null });
  }

  // ── the audience mappers ─────────────────────────────────────────────────
  // One mapper per wanted audience and nothing else. A mapper that is not an
  // audience mapper is not this module's to judge and is left alone; an
  // audience mapper for an origin no longer configured, a duplicate, or one that
  // does not land in the access token is removed and — for the wanted ones —
  // recreated correctly.
  const wanted = wantedAudiences(alias, settings.origins);
  const present = new Set<string>();
  for (const mapper of await client.listAudienceMappers(scope.id)) {
    if (
      mapper.audience !== null &&
      wanted.includes(mapper.audience) &&
      !present.has(mapper.audience) &&
      mapper.accessTokenClaim
    ) {
      present.add(mapper.audience);
      continue;
    }
    await client.deleteProtocolMapper(scope.id, mapper.id);
    actions.push({ kind: "AUDIENCE_REMOVED", scope: name, subject: mapper.audience });
  }
  for (const audience of wanted) {
    if (present.has(audience)) continue;
    await client.createAudienceMapper(scope.id, audience);
    actions.push({ kind: "AUDIENCE_ADDED", scope: name, subject: audience });
  }

  // ── the clients ──────────────────────────────────────────────────────────
  for (const clientId of settings.clients) {
    const attachment = snapshot.clients.get(clientId);
    // Absent client: nothing to attach to. Not an error — the default list names
    // clients a deployment may legitimately not have (no inspector in production).
    if (!attachment) continue;
    if (
      attachment.defaultClientScopes.includes(name) ||
      attachment.optionalClientScopes.includes(name)
    ) {
      continue;
    }
    await client.addOptionalClientScope(attachment.id, scope.id);
    attachment.optionalClientScopes.push(name);
    actions.push({ kind: "CLIENT_ATTACHED", scope: name, subject: clientId });
  }

  // ── the realm defaults ───────────────────────────────────────────────────
  if (
    !snapshot.realm.defaultScopes.includes(name) &&
    !snapshot.realm.optionalScopes.includes(name)
  ) {
    await client.addRealmOptionalScope(scope.id);
    snapshot.realm.optionalScopes.push(name);
    actions.push({ kind: "REALM_ATTACHED", scope: name, subject: null });
  }

  // ── the client-registration allow-list ───────────────────────────────────
  // Append-only: the entries already there are somebody's policy, and one of
  // them (`organization`) is shared with every other alias. A realm with no
  // such component is left alone entirely — that is the documented no-op, and
  // `registrationPolicyPresent` is how a caller sees it happened.
  const policy = snapshot.policy;
  if (policy) {
    const missing = wantedPolicyEntries(alias, snapshot.scopes).filter(
      (entry) => !policy.allowedScopes.includes(entry),
    );
    if (missing.length > 0) {
      const next = [...policy.allowedScopes, ...missing];
      await client.setRegistrationPolicyScopes(policy.id, next);
      policy.allowedScopes = next;
      for (const entry of missing) {
        actions.push({ kind: "POLICY_ALLOWED", scope: name, subject: entry });
      }
    }
  }

  return {
    scope: name,
    audiences: wanted,
    actions,
    registrationPolicyPresent: policy !== null,
  };
}

/**
 * Ensure one Organization's scope. What provisioning calls after the
 * Organization exists; idempotent, so a replay of a converged scope reports no
 * actions and writes nothing.
 */
export async function ensureOrganizationScope(
  client: OrganizationScopeAdminClient,
  alias: string,
  settings: OrganizationScopeSettings,
): Promise<OrganizationScopeState> {
  const normalised = normaliseSettings(settings);
  const snapshot = await readSnapshot(client, normalised.clients);
  return ensureWithSnapshot(client, alias, normalised, snapshot);
}

export type ReconcileOrganizationScopesInput = {
  /** Every Organization alias the realm holds. */
  aliases: readonly string[];
  /**
   * False when the alias list is known to be incomplete (a truncated listing).
   * Orphan removal is then suppressed: a scope whose Organization was simply not
   * listed must not be deleted on the strength of a partial view.
   */
  removeOrphans: boolean;
};

export type ReconcileOrganizationScopesResult = {
  states: OrganizationScopeState[];
  /** Scope names removed because their Organization is gone. */
  removed: string[];
  actions: OrganizationScopeAction[];
  /** See {@link OrganizationScopeState.registrationPolicyPresent}. */
  registrationPolicyPresent: boolean;
};

/**
 * Bring every Organization's scope to the configured state and remove the
 * scopes of Organizations that no longer exist. Orphans go first so a rename
 * (new Organization, old one deleted) converges in one pass.
 */
export async function reconcileOrganizationScopes(
  client: OrganizationScopeAdminClient,
  input: ReconcileOrganizationScopesInput,
  settings: OrganizationScopeSettings,
): Promise<ReconcileOrganizationScopesResult> {
  const normalised = normaliseSettings(settings);
  const snapshot = await readSnapshot(client, normalised.clients);
  const known = new Set(input.aliases);
  const actions: OrganizationScopeAction[] = [];
  const removed: string[] = [];

  if (input.removeOrphans) {
    for (const scope of [...snapshot.scopes]) {
      if (!scope.name.startsWith(ORGANIZATION_SCOPE_PREFIX)) continue;
      const alias = scope.name.slice(ORGANIZATION_SCOPE_PREFIX.length);
      if (known.has(alias)) continue;
      // Detaching from clients and from the realm defaults is part of the scope
      // delete in Keycloak; nothing else has to be unwound.
      await client.deleteClientScope(scope.id);
      snapshot.scopes = snapshot.scopes.filter((item) => item.id !== scope.id);
      removed.push(scope.name);
      actions.push({ kind: "SCOPE_REMOVED", scope: scope.name, subject: null });
    }
    // The allow-list is NOT unwound by the scope delete — Keycloak keeps the
    // configured name, which then also blocks a later `validateConfiguration`
    // on that component. Swept separately, and independently of whether the
    // scope was still there: an entry left behind by an earlier deletion is
    // the same orphan. Only `mcp-resource:*` names are considered; every other
    // entry, `organization` included, belongs to the deployment.
    const policy = snapshot.policy;
    if (policy) {
      const orphans = policy.allowedScopes.filter(
        (entry) =>
          entry.startsWith(ORGANIZATION_SCOPE_PREFIX) &&
          !known.has(entry.slice(ORGANIZATION_SCOPE_PREFIX.length)),
      );
      if (orphans.length > 0) {
        const next = policy.allowedScopes.filter((entry) => !orphans.includes(entry));
        await client.setRegistrationPolicyScopes(policy.id, next);
        policy.allowedScopes = next;
        for (const entry of orphans) {
          actions.push({ kind: "POLICY_REVOKED", scope: entry, subject: null });
        }
      }
    }
  }

  const states: OrganizationScopeState[] = [];
  for (const alias of [...known].sort()) {
    const state = await ensureWithSnapshot(client, alias, normalised, snapshot);
    states.push(state);
    actions.push(...state.actions);
  }
  return { states, removed, actions, registrationPolicyPresent: snapshot.policy !== null };
}

/**
 * Read-only: what {@link reconcileOrganizationScopes} WOULD change, as drift.
 * Every finding here is repairable by that call, and a realm with no findings
 * is one that call would not write to.
 */
export async function compareOrganizationScopes(
  client: OrganizationScopeAdminClient,
  input: ReconcileOrganizationScopesInput,
  settings: OrganizationScopeSettings,
): Promise<OrganizationScopeDrift[]> {
  const normalised = normaliseSettings(settings);
  const snapshot = await readSnapshot(client, normalised.clients);
  const known = new Set(input.aliases);
  const findings: OrganizationScopeDrift[] = [];

  if (input.removeOrphans) {
    // One finding per orphan NAME, wherever it lives, so a scope that is both
    // present and still allow-listed is not reported twice.
    const orphans = new Map<string, { scope: boolean; policy: boolean }>();
    const note = (name: string, where: "scope" | "policy") => {
      if (!name.startsWith(ORGANIZATION_SCOPE_PREFIX)) return;
      if (known.has(name.slice(ORGANIZATION_SCOPE_PREFIX.length))) return;
      const seen = orphans.get(name) ?? { scope: false, policy: false };
      seen[where] = true;
      orphans.set(name, seen);
    };
    for (const scope of snapshot.scopes) note(scope.name, "scope");
    for (const entry of snapshot.policy?.allowedScopes ?? []) note(entry, "policy");

    for (const [name, where] of orphans) {
      const places = [
        ...(where.scope ? ["the realm's client scopes"] : []),
        ...(where.policy ? ['the anonymous "Allowed Client Scopes" policy'] : []),
      ];
      findings.push({
        code: "ORGANIZATION_SCOPE_ORPHANED",
        alias: organizationAliasOfScope(name),
        scope: name,
        expected: null,
        actual: name,
        message:
          `"${name}" names an Organization the realm no longer has and is still in ` +
          `${places.join(" and ")}; a re-apply removes it.`,
      });
    }
  }

  for (const alias of [...known].sort()) {
    const name = organizationResourceScope(alias);
    const wanted = wantedAudiences(alias, normalised.origins);
    const scope = snapshot.scopes.find((item) => item.name === name);
    if (!scope) {
      findings.push({
        code: "ORGANIZATION_SCOPE_MISSING",
        alias,
        scope: name,
        expected: wanted.join(" "),
        actual: null,
        message: `Organization "${alias}" has no client scope "${name}"; tokens cannot be minted for its MCP resource.`,
      });
      continue;
    }

    const mappers = await client.listAudienceMappers(scope.id);
    const actual = mappers
      .filter((mapper) => mapper.accessTokenClaim && mapper.audience !== null)
      .map((mapper) => mapper.audience!)
      .sort();
    const duplicates = new Set(actual).size !== actual.length;
    const expected = wanted.join(" ");
    const carried = actual.join(" ");
    if (carried !== expected || duplicates) {
      findings.push({
        code: "ORGANIZATION_SCOPE_AUDIENCE_MISMATCH",
        alias,
        scope: name,
        expected,
        actual: carried,
        message: `Client scope "${name}" carries audiences [${carried}], expected [${expected}].`,
      });
    }

    const detached: string[] = [];
    for (const clientId of normalised.clients) {
      const attachment = snapshot.clients.get(clientId);
      if (!attachment) continue;
      if (
        !attachment.defaultClientScopes.includes(name) &&
        !attachment.optionalClientScopes.includes(name)
      ) {
        detached.push(clientId);
      }
    }
    if (
      !snapshot.realm.defaultScopes.includes(name) &&
      !snapshot.realm.optionalScopes.includes(name)
    ) {
      detached.push("<realm default optional scopes>");
    }
    if (detached.length > 0) {
      findings.push({
        code: "ORGANIZATION_SCOPE_NOT_ATTACHED",
        alias,
        scope: name,
        expected: [...normalised.clients, "<realm default optional scopes>"].join(" "),
        actual: detached.join(" "),
        message: `Client scope "${name}" is not an optional scope of: ${detached.join(", ")}.`,
      });
    }

    // A realm with no such policy is not drift: nothing to repair, and the
    // module would not write there anyway. See the header.
    if (snapshot.policy) {
      const wantedEntries = wantedPolicyEntries(alias, snapshot.scopes);
      const missing = wantedEntries.filter(
        (entry) => !snapshot.policy!.allowedScopes.includes(entry),
      );
      if (missing.length > 0) {
        findings.push({
          code: "ORGANIZATION_SCOPE_NOT_REGISTRABLE",
          alias,
          scope: name,
          expected: wantedEntries.join(" "),
          actual: missing.join(" "),
          message:
            `The anonymous "Allowed Client Scopes" client-registration policy does not allow ` +
            `[${missing.join(", ")}], so a dynamically registered MCP client for Organization ` +
            `"${alias}" is refused with insufficient_scope.`,
        });
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// The HTTP client

export type OrganizationScopeAdminOptions = {
  /** Injected in tests; defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Injected in tests; defaults to Date.now. */
  now?: () => number;
  /** Shared with the SPI and organization-admin clients so one token serves all. */
  tokens?: ServiceAccountTokenProvider;
};

export function createOrganizationScopeAdminClient(
  config: KeycloakServiceAccountConfig,
  options: OrganizationScopeAdminOptions = {},
): OrganizationScopeAdminClient {
  const doFetch = options.fetch ?? globalThis.fetch;
  const adminBase = `${config.baseUrl}/admin/realms/${encodeURIComponent(config.tenantRealm)}`;

  const tokens =
    options.tokens ??
    createServiceAccountTokenProvider(config, {
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.now ? { now: options.now } : {}),
      unauthorized: (message, status) =>
        new KeycloakAdminError("KEYCLOAK_ADMIN_UNAUTHORIZED", message, status),
      unavailable: (message, status) =>
        new KeycloakAdminError("KEYCLOAK_ADMIN_UNAVAILABLE", message, status),
    });

  async function request(
    path: string,
    init: RequestInit,
  ): Promise<{ status: number; body: unknown; headers: Headers }> {
    const url = `${adminBase}${path}`;
    const token = await tokens.get();
    let response: Response;
    try {
      response = await doFetch(url, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...init.headers,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new KeycloakAdminError(
        "KEYCLOAK_ADMIN_UNAVAILABLE",
        `Could not reach the Keycloak admin API at ${url}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }

    const body = await readJson(response);
    if (response.ok) return { status: response.status, body, headers: response.headers };

    if (response.status === 401 || response.status === 403) {
      tokens.invalidate();
      throw new KeycloakAdminError(
        "KEYCLOAK_ADMIN_UNAUTHORIZED",
        `The Keycloak admin API refused "${config.clientId}" on ${init.method ?? "GET"} ${path}: ` +
          `${describeError(body, response.statusText)}. Client scopes are client configuration: ` +
          "the service account must hold realm-management manage-clients as well as manage-realm.",
        response.status,
      );
    }
    if (response.status === 400 || response.status === 404 || response.status === 409) {
      throw new KeycloakAdminError(
        "KEYCLOAK_ADMIN_REJECTED",
        `The Keycloak admin API rejected ${init.method ?? "GET"} ${path}: ` +
          describeError(body, response.statusText),
        response.status,
      );
    }
    throw new KeycloakAdminError(
      "KEYCLOAK_ADMIN_UNAVAILABLE",
      `The Keycloak admin API answered ${response.status} on ${path}: ` +
        describeError(body, response.statusText),
      response.status,
    );
  }

  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

  function toScope(row: unknown): ClientScopeSummary | null {
    const record = (row ?? {}) as Record<string, unknown>;
    return typeof record.id === "string" && typeof record.name === "string"
      ? { id: record.id, name: record.name }
      : null;
  }

  async function listScopes(): Promise<ClientScopeSummary[]> {
    const { body } = await request("/client-scopes", { method: "GET" });
    return (Array.isArray(body) ? body : [])
      .map(toScope)
      .filter((scope): scope is ClientScopeSummary => scope !== null);
  }

  return {
    listClientScopes: listScopes,

    async createClientScope(input) {
      const { headers } = await request("/client-scopes", {
        method: "POST",
        body: JSON.stringify({
          name: input.name,
          description: input.description,
          protocol: "openid-connect",
          attributes: {
            "include.in.token.scope": "true",
            "display.on.consent.screen": "false",
            "include.in.openid.provider.metadata": "false",
          },
        }),
      });
      // Keycloak answers 201 with the new resource in `Location`. Read the id
      // off it when present; otherwise one listing finds the scope by name.
      const location = headers.get("location") ?? "";
      const id = location.split("/").filter(Boolean).pop();
      if (id && location.includes("/client-scopes/")) return { id, name: input.name };
      const created = (await listScopes()).find((scope) => scope.name === input.name);
      if (!created) {
        throw new KeycloakAdminError(
          "KEYCLOAK_ADMIN_UNAVAILABLE",
          `Keycloak accepted client scope "${input.name}" but it is not in the listing afterwards.`,
        );
      }
      return created;
    },

    async deleteClientScope(scopeId) {
      await request(`/client-scopes/${encodeURIComponent(scopeId)}`, { method: "DELETE" });
    },

    async listAudienceMappers(scopeId) {
      const { body } = await request(
        `/client-scopes/${encodeURIComponent(scopeId)}/protocol-mappers/models`,
        { method: "GET" },
      );
      const mappers: AudienceMapper[] = [];
      for (const row of Array.isArray(body) ? body : []) {
        const record = (row ?? {}) as Record<string, unknown>;
        if (record.protocolMapper !== AUDIENCE_MAPPER_TYPE || typeof record.id !== "string") {
          continue;
        }
        const mapperConfig = (record.config ?? {}) as Record<string, unknown>;
        const audience = mapperConfig["included.custom.audience"];
        mappers.push({
          id: record.id,
          audience: typeof audience === "string" && audience.length > 0 ? audience : null,
          accessTokenClaim: mapperConfig["access.token.claim"] === "true",
        });
      }
      return mappers;
    },

    async createAudienceMapper(scopeId, audience) {
      await request(`/client-scopes/${encodeURIComponent(scopeId)}/protocol-mappers/models`, {
        method: "POST",
        body: JSON.stringify({
          name: audience,
          protocol: "openid-connect",
          protocolMapper: AUDIENCE_MAPPER_TYPE,
          consentRequired: false,
          config: {
            "included.custom.audience": audience,
            "access.token.claim": "true",
            "id.token.claim": "false",
            "introspection.token.claim": "true",
            "lightweight.claim": "false",
          },
        }),
      });
    },

    async deleteProtocolMapper(scopeId, mapperId) {
      await request(
        `/client-scopes/${encodeURIComponent(scopeId)}/protocol-mappers/models/${encodeURIComponent(mapperId)}`,
        { method: "DELETE" },
      );
    },

    async findClient(clientId) {
      const search = new URLSearchParams({ clientId });
      const { body } = await request(`/clients?${search.toString()}`, { method: "GET" });
      // `?clientId=` is an exact match on Keycloak 26, but the answer is a list;
      // matching the name again costs nothing and guards a looser server.
      const rows = Array.isArray(body) ? body : [];
      for (const row of rows) {
        const record = (row ?? {}) as Record<string, unknown>;
        if (record.clientId !== clientId || typeof record.id !== "string") continue;
        return {
          id: record.id,
          clientId,
          defaultClientScopes: strings(record.defaultClientScopes),
          optionalClientScopes: strings(record.optionalClientScopes),
        };
      }
      return null;
    },

    async addOptionalClientScope(clientUuid, scopeId) {
      await request(
        `/clients/${encodeURIComponent(clientUuid)}/optional-client-scopes/${encodeURIComponent(scopeId)}`,
        { method: "PUT" },
      );
    },

    async getRealmDefaultScopes() {
      const names = async (path: string) => {
        const { body } = await request(path, { method: "GET" });
        return (Array.isArray(body) ? body : [])
          .map(toScope)
          .filter((scope): scope is ClientScopeSummary => scope !== null)
          .map((scope) => scope.name);
      };
      return {
        defaultScopes: await names("/default-default-client-scopes"),
        optionalScopes: await names("/default-optional-client-scopes"),
      };
    },

    async addRealmOptionalScope(scopeId) {
      await request(`/default-optional-client-scopes/${encodeURIComponent(scopeId)}`, {
        method: "PUT",
      });
    },

    async findRegistrationPolicy() {
      const search = new URLSearchParams({ type: CLIENT_REGISTRATION_POLICY_TYPE });
      const { body } = await request(`/components?${search.toString()}`, { method: "GET" });
      // `?type=` narrows to the policies; the provider and the subType are what
      // pick the ONE of them this module edits, and both are matched here
      // rather than trusted from the query.
      for (const row of Array.isArray(body) ? body : []) {
        const record = (row ?? {}) as Record<string, unknown>;
        if (
          record.providerId !== ALLOWED_CLIENT_SCOPES_PROVIDER ||
          record.subType !== ANONYMOUS_POLICY_SUBTYPE ||
          typeof record.id !== "string"
        ) {
          continue;
        }
        const policyConfig = (record.config ?? {}) as Record<string, unknown>;
        return { id: record.id, allowedScopes: strings(policyConfig[ALLOWED_CLIENT_SCOPES_CONFIG]) };
      }
      return null;
    },

    async setRegistrationPolicyScopes(policyId, scopes) {
      // Read-modify-write of the WHOLE component: the update endpoint replaces
      // it, and `allow-default-scopes` — plus anything a future Keycloak adds —
      // has to survive. Re-read rather than reuse the snapshot so the write
      // carries the component as it is now, not as the pass first saw it.
      const path = `/components/${encodeURIComponent(policyId)}`;
      const { body } = await request(path, { method: "GET" });
      const component = (body ?? {}) as Record<string, unknown>;
      const policyConfig = { ...((component.config ?? {}) as Record<string, unknown>) };
      policyConfig[ALLOWED_CLIENT_SCOPES_CONFIG] = [...scopes];
      await request(path, {
        method: "PUT",
        body: JSON.stringify({ ...component, config: policyConfig }),
      });
    },
  };
}
