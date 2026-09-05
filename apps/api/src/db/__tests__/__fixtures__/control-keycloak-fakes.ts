// SPDX-License-Identifier: BUSL-1.1
/**
 * In-memory stand-ins for the two Keycloak surfaces the control plane uses.
 *
 * Shared by the database-backed control-plane suites (`control-provisioning`
 * and `control-reconciliation`) because they need the SAME fake: the
 * reconciliation tests desync state that the provisioning tests create, and two
 * fakes that drifted apart would make one suite's "converged" mean something
 * the other's does not.
 *
 * Not a test file itself — it defines no `test()` — so the runner does not
 * collect it; it lives under `__fixtures__` for exactly that reason.
 *
 * FIDELITY, AND WHERE IT STOPS. These fakes reproduce the behaviours the
 * database half has to cope with, each established against the running Keycloak
 * 26.5.3 and documented at its source:
 *
 *   - upsert-shaped creates (`getByAlias` before create, every attribute
 *     rewritten each call) — `keycloak-spi-client.ts`;
 *   - `setEnabled(true)` on EVERY create, including a replay, which is what
 *     `reconcileOrganizationEnabled` exists to correct — `provisioning.ts`;
 *   - an OPAQUE generated organization id, unrelated to the alias or the name.
 *     It used to be the derived `name` string, mirroring the SPI's
 *     `create(name, alias, null)` binding; #294 fixed that binding, so Keycloak
 *     generates a uuid. Minting one here is what keeps these suites honest —
 *     with id == name they would pass while depending on a coincidence
 *     production no longer supplies. It is also what forces the replay lookup
 *     below to go through the ALIAS, which is what the SPI actually does.
 *
 * What they do NOT reproduce is Keycloak's own validation (alias immutability,
 * realm-unique names, the SPI's parent/root agreement check). Those are proven
 * against the real server, not here.
 */
import { randomUUID } from "node:crypto";
import type {
  KeycloakOrganizationAdminClient,
  KeycloakOrganizationSnapshot,
} from "../../../control/keycloak-organization-admin.js";
import type {
  CreateOrganizationRequest,
  KeycloakOrganization,
  KeycloakSpiClient,
} from "../../../control/keycloak-spi-client.js";
import type { OrganizationScopeAdminClient } from "../../../control/organization-scopes.js";

/**
 * One organization as the fake realm holds it: the last create request that
 * touched it, plus the native `enabled` flag the admin API owns.
 *
 * `request` is deliberately mutable and public, because corrupting exactly one
 * projected value — a path, a parent id — is how a drift fixture is built.
 */
export type FakeOrganization = { request: CreateOrganizationRequest; enabled: boolean };

export type FakeSpiClient = KeycloakSpiClient & {
  /** The realm, keyed by the generated organization id. */
  organizations: Map<string, FakeOrganization>;
  calls: CreateOrganizationRequest[];
  failNext: (error: Error) => void;
  /**
   * Fail every call matching a predicate, for as long as it is set. `failNext`
   * cannot express "the third node of a subtree move fails", which is exactly
   * the case the partial-projection failure path has to be proven on.
   */
  failWhen: (match: ((request: CreateOrganizationRequest) => boolean) | null) => void;
  pathOf: (organizationId: string) => string | undefined;
};

export function fakeSpi(): FakeSpiClient {
  const organizations = new Map<string, FakeOrganization>();
  const calls: CreateOrganizationRequest[] = [];
  let pendingFailure: Error | null = null;
  let failMatch: ((request: CreateOrganizationRequest) => boolean) | null = null;

  return {
    organizations,
    calls,
    failNext(error: Error) {
      pendingFailure = error;
    },
    failWhen(match) {
      failMatch = match;
    },
    pathOf(organizationId) {
      return organizations.get(organizationId)?.request.organizationPath;
    },
    async createOrganization(request): Promise<KeycloakOrganization> {
      if (pendingFailure) {
        const error = pendingFailure;
        pendingFailure = null;
        throw error;
      }
      if (failMatch?.(request)) {
        throw new Error(`keycloak refused ${request.organizationPath}`);
      }
      calls.push(request);
      // `getByAlias` before create: a replay keeps the id it was first given,
      // which is what makes the provisioning layer's retry a repair rather than
      // a second organization. The id itself is opaque, so nothing downstream
      // can recover the alias from it.
      const existingId = [...organizations.entries()].find(
        ([, organization]) => organization.request.alias === request.alias,
      )?.[0];
      const id = existingId ?? randomUUID();
      // `setEnabled(true)` on every create, including a replay — the behaviour
      // `reconcileOrganizationEnabled` exists to correct for. Note the whole
      // request replaces the old one, which is the SPI's "rewrite every
      // attribute" shape and therefore what makes a replay a repair.
      organizations.set(id, { request, enabled: true });
      return { id, alias: request.alias, name: request.name };
    },
  };
}

/** The admin-API half, keyed by the same ids the SPI fake hands out. */
export function fakeAdmin(spi: FakeSpiClient): KeycloakOrganizationAdminClient {
  const require_ = (id: string): FakeOrganization => {
    const found = spi.organizations.get(id);
    if (!found) throw new Error(`fake admin: no organization "${id}"`);
    return found;
  };
  // organizationId -> aliases of identity providers linked to it. A realm-wide
  // map, not per-organization state on FakeOrganization, so cross-tenant
  // isolation is provable the same way the real Keycloak Organizations
  // endpoint's per-id scoping is: two organizations never share a Set.
  const identityProviders = new Map<string, Set<string>>();
  const linkedAliases = (id: string): Set<string> => {
    let aliases = identityProviders.get(id);
    if (!aliases) {
      aliases = new Set();
      identityProviders.set(id, aliases);
    }
    return aliases;
  };
  const state = (id: string) => {
    const org = require_(id);
    return {
      id,
      alias: org.request.alias,
      name: org.request.name,
      enabled: org.enabled,
    };
  };
  const snapshot = (id: string, org: FakeOrganization): KeycloakOrganizationSnapshot => ({
    id,
    alias: org.request.alias,
    name: org.request.name,
    enabled: org.enabled,
    organizationLevel: org.request.organizationLevel,
    organizationPath: org.request.organizationPath,
    // Absent means "the attribute is not set", which is a meaningful state for a
    // root organization rather than a missing value — the real client makes the
    // same distinction.
    parentOrganizationId: org.request.parentOrganizationId ?? null,
    rootOrganizationId:
      org.request.rootOrganizationId ??
      // The SPI stamps a ROOT organization's own id as its root; the request
      // never carries one because there is nothing to point at yet.
      (org.request.organizationLevel === "root" ? id : null),
  });
  return {
    async getOrganization(id) {
      return state(id);
    },
    async setOrganizationEnabled(id, enabled) {
      const org = require_(id);
      const changed = org.enabled !== enabled;
      org.enabled = enabled;
      return { organization: state(id), changed };
    },
    async listOrganizations(limit) {
      const rows = [...spi.organizations.entries()].map(([id, org]) => snapshot(id, org));
      return { organizations: rows.slice(0, limit), truncated: rows.length > limit };
    },
    async linkIdentityProvider(id, alias) {
      require_(id);
      linkedAliases(id).add(alias);
    },
    async listIdentityProviders(id) {
      require_(id);
      return [...linkedAliases(id)].map((alias) => ({
        alias,
        providerId: "google",
        enabled: true,
      }));
    },
    async unlinkIdentityProvider(id, alias) {
      require_(id);
      linkedAliases(id).delete(alias);
    },
  };
}

/** One client scope as the fake realm holds it: its mappers, by mapper id. */
export type FakeClientScope = {
  id: string;
  name: string;
  mappers: Map<string, { audience: string | null; accessTokenClaim: boolean }>;
};

/**
 * The realm's anonymous `Allowed Client Scopes` policy as the fake holds it:
 * the whole component config, so a test can assert that only the one key this
 * module owns is touched. `null` reproduces a realm that has no such component.
 */
export type FakeRegistrationPolicy = { id: string; config: Record<string, string[]> };

export type FakeScopeClient = OrganizationScopeAdminClient & {
  scopes: Map<string, FakeClientScope>;
  /** Keyed by clientId; the realm's clients and their attached scope NAMES. */
  clients: Map<string, { id: string; defaultScopes: string[]; optionalScopes: string[] }>;
  realm: { defaultScopes: string[]; optionalScopes: string[] };
  /** Every write, in order, as `"<op> <subject>"` — what idempotency is asserted on. */
  writes: string[];
  scopeNamed: (name: string) => FakeClientScope | undefined;
  audiencesOf: (name: string) => string[];
  /** The component as the fake realm holds it; null when the realm has none. */
  policy: FakeRegistrationPolicy | null;
  /** `allowed-client-scopes`, in realm order. */
  allowedClientScopes: () => string[];
};

export type FakeOrganizationScopesOptions = {
  clientIds?: readonly string[];
  /**
   * The realm's client scopes, beyond the `mcp-resource:*` ones the module
   * creates. The default is the two the allow-list refers to out of the box —
   * an entry naming no client scope makes Keycloak refuse the whole write.
   */
  realmScopes?: readonly string[];
  /** `null` for a realm with no client-registration policy at all. */
  policy?: FakeRegistrationPolicy | null;
};

/**
 * The client-scope half of the admin API. It reproduces exactly the behaviours
 * `organization-scopes.ts` relies on: deleting a scope detaches it from every
 * client and from the realm defaults (Keycloak does this as part of the
 * delete), `?clientId=` is an exact match, and an attach is addressed by the
 * client's uuid rather than its clientId.
 *
 * It also reproduces the client-registration policy component: its update
 * REPLACES the component (so a test can catch a config key being dropped), and
 * a name that is not a realm client scope is refused exactly as Keycloak's
 * `validateConfiguration` refuses it — the whole write, not just the entry.
 */
export function fakeOrganizationScopes(
  options: FakeOrganizationScopesOptions = {},
): FakeScopeClient {
  const clientIds = options.clientIds ?? [
    "codex",
    "openshapeforge-gateway",
    "openshapeforge-inspector",
  ];
  const scopes = new Map<string, FakeClientScope>();
  for (const name of options.realmScopes ?? ["organization", "offline_access"]) {
    const id = randomUUID();
    scopes.set(id, { id, name, mappers: new Map() });
  }
  const clients = new Map<
    string,
    { id: string; defaultScopes: string[]; optionalScopes: string[] }
  >();
  for (const clientId of clientIds) {
    clients.set(clientId, { id: randomUUID(), defaultScopes: [], optionalScopes: [] });
  }
  const realm = { defaultScopes: [] as string[], optionalScopes: [] as string[] };
  const writes: string[] = [];
  const policy: FakeRegistrationPolicy | null =
    options.policy === undefined
      ? {
          id: "allowed-client-scopes-anonymous",
          config: {
            "allow-default-scopes": ["true"],
            "allowed-client-scopes": ["openid", "offline_access"],
          },
        }
      : options.policy;

  const requireScope = (scopeId: string): FakeClientScope => {
    const scope = scopes.get(scopeId);
    if (!scope) throw new Error(`fake scopes: no client scope "${scopeId}"`);
    return scope;
  };
  const scopeNamed = (name: string) =>
    [...scopes.values()].find((scope) => scope.name === name);

  return {
    scopes,
    clients,
    realm,
    writes,
    scopeNamed,
    policy,
    allowedClientScopes() {
      return [...(policy?.config["allowed-client-scopes"] ?? [])];
    },
    audiencesOf(name) {
      const scope = scopeNamed(name);
      return scope
        ? [...scope.mappers.values()]
            .filter((mapper) => mapper.accessTokenClaim && mapper.audience !== null)
            .map((mapper) => mapper.audience!)
            .sort()
        : [];
    },
    async listClientScopes() {
      return [...scopes.values()].map(({ id, name }) => ({ id, name }));
    },
    async createClientScope(input) {
      if (scopeNamed(input.name)) {
        throw new Error(`fake scopes: client scope "${input.name}" already exists`);
      }
      const id = randomUUID();
      scopes.set(id, { id, name: input.name, mappers: new Map() });
      writes.push(`create-scope ${input.name}`);
      return { id, name: input.name };
    },
    async deleteClientScope(scopeId) {
      const scope = requireScope(scopeId);
      scopes.delete(scopeId);
      for (const client of clients.values()) {
        client.defaultScopes = client.defaultScopes.filter((name) => name !== scope.name);
        client.optionalScopes = client.optionalScopes.filter((name) => name !== scope.name);
      }
      realm.defaultScopes = realm.defaultScopes.filter((name) => name !== scope.name);
      realm.optionalScopes = realm.optionalScopes.filter((name) => name !== scope.name);
      writes.push(`delete-scope ${scope.name}`);
    },
    async listAudienceMappers(scopeId) {
      return [...requireScope(scopeId).mappers.entries()].map(([id, mapper]) => ({
        id,
        ...mapper,
      }));
    },
    async createAudienceMapper(scopeId, audience) {
      const scope = requireScope(scopeId);
      scope.mappers.set(randomUUID(), { audience, accessTokenClaim: true });
      writes.push(`add-audience ${scope.name} ${audience}`);
    },
    async deleteProtocolMapper(scopeId, mapperId) {
      const scope = requireScope(scopeId);
      const mapper = scope.mappers.get(mapperId);
      if (!mapper) throw new Error(`fake scopes: no mapper "${mapperId}"`);
      scope.mappers.delete(mapperId);
      writes.push(`remove-audience ${scope.name} ${mapper.audience ?? "<none>"}`);
    },
    async findClient(clientId) {
      const client = clients.get(clientId);
      return client
        ? {
            id: client.id,
            clientId,
            defaultClientScopes: [...client.defaultScopes],
            optionalClientScopes: [...client.optionalScopes],
          }
        : null;
    },
    async addOptionalClientScope(clientUuid, scopeId) {
      const client = [...clients.entries()].find(([, value]) => value.id === clientUuid);
      if (!client) throw new Error(`fake scopes: no client with uuid "${clientUuid}"`);
      const scope = requireScope(scopeId);
      if (!client[1].optionalScopes.includes(scope.name)) {
        client[1].optionalScopes.push(scope.name);
      }
      writes.push(`attach-client ${client[0]} ${scope.name}`);
    },
    async getRealmDefaultScopes() {
      return { defaultScopes: [...realm.defaultScopes], optionalScopes: [...realm.optionalScopes] };
    },
    async addRealmOptionalScope(scopeId) {
      const scope = requireScope(scopeId);
      if (!realm.optionalScopes.includes(scope.name)) realm.optionalScopes.push(scope.name);
      writes.push(`attach-realm ${scope.name}`);
    },
    async findRegistrationPolicy() {
      return policy
        ? { id: policy.id, allowedScopes: [...(policy.config["allowed-client-scopes"] ?? [])] }
        : null;
    },
    async setRegistrationPolicyScopes(policyId, next) {
      if (!policy || policy.id !== policyId) {
        throw new Error(`fake scopes: no client-registration policy "${policyId}"`);
      }
      // Keycloak's own `validateConfiguration`: every entry must name a realm
      // client scope, or the literal `openid`. It refuses the whole list.
      const allowed = new Set([...[...scopes.values()].map((scope) => scope.name), "openid"]);
      const rejected = next.filter((entry) => !allowed.has(entry));
      if (rejected.length > 0) {
        throw new Error(`fake scopes: client scopes not allowed: [${next.join(", ")}]`);
      }
      policy.config = { ...policy.config, "allowed-client-scopes": [...next] };
      writes.push(`set-registration-policy ${next.join(",")}`);
    },
  };
}
