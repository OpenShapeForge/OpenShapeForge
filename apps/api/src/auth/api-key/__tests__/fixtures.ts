// SPDX-License-Identifier: BUSL-1.1
/**
 * Shared doubles for the API-key provisioning tests that must not need a
 * database or a realm.
 *
 * Two of them, and both are deliberately NARROW:
 *
 *   - {@link fixtureDatabase} is a real Kysely with a fake connection. Every
 *     statement is compiled by Kysely exactly as production compiles it, and
 *     the connection answers from an in-memory store while MATCHING the tenant
 *     parameter. That last part is the point: a read that lost its tenant
 *     predicate gets another tenant's rows here and fails the isolation tests,
 *     instead of passing because nothing was checking.
 *   - {@link stubRealm} is a real HTTP server speaking the slice of the
 *     Keycloak Admin API that `keycloak-admin.ts` actually calls, so the
 *     provisioning path runs its own client rather than a mock of it.
 *
 * What these doubles do NOT do is implement SQL. Ordering, keyset paging and
 * row locking are database behaviour and are proven against a real PostgreSQL
 * in `operations/api-key-catalog-db.test.ts`; the tests built on this fixture
 * assert the statements that were SENT (fence, parameters, bounds) and the
 * projection of the rows that came back.
 */
import { randomUUID } from "node:crypto";
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type QueryResult,
} from "kysely";
import type { DB } from "../../../generated/db/types.js";

export type FixtureIntegration = {
  id: string;
  tenantId: string;
  displayName: string;
  status: "pending" | "active" | "disabled";
  grantedRoles: string[];
  createdAt: Date;
  updatedAt: Date;
};

export type FixtureKey = {
  id: string;
  tenantId: string;
  integrationId: string;
  displayName: string;
  roleSubset: string[] | null;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
};

export type FixtureStore = {
  integrations: FixtureIntegration[];
  keys: FixtureKey[];
  /** Statements that locked an integration row, in order. */
  locked: string[];
};

export function fixtureStore(
  integrations: FixtureIntegration[] = [],
  keys: FixtureKey[] = [],
): FixtureStore {
  return { integrations, keys, locked: [] };
}

function isLive(key: FixtureKey, now: Date): boolean {
  return key.revokedAt === null &&
    (key.expiresAt === null || key.expiresAt.getTime() > now.getTime());
}

function credentialStatusOf(key: FixtureKey, now: Date): string {
  if (key.revokedAt !== null) return "revoked";
  if (key.expiresAt !== null && key.expiresAt.getTime() <= now.getTime()) return "expired";
  return "active";
}

/**
 * The answer to one compiled statement.
 *
 * Dispatch is on distinctive fragments of the statement Kysely produced, most
 * specific first, and every branch that reaches an api-key table requires the
 * tenant id to be among the bound parameters.
 */
function answer(store: FixtureStore, text: string, params: readonly unknown[], now: Date): unknown[] {
  const named = (value: string) => params.includes(value);
  const integrationOf = () =>
    store.integrations.find((row) => named(row.id) && named(row.tenantId));

  const integrationMetadata = (row: FixtureIntegration, sortValue?: string | null) => ({
    id: row.id,
    display_name: row.displayName,
    status: row.status,
    granted_roles: row.grantedRoles,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    key_count: String(store.keys.filter((key) => key.integrationId === row.id).length),
    active_key_count: String(
      store.keys.filter((key) => key.integrationId === row.id && isLive(key, now)).length,
    ),
    ...(sortValue === undefined ? {} : { sort_value: sortValue }),
  });

  const keyMetadata = (row: FixtureKey, sortValue?: string | null) => ({
    id: row.id,
    integration_id: row.integrationId,
    integration_name:
      store.integrations.find((item) => item.id === row.integrationId)?.displayName ?? "",
    display_name: row.displayName,
    role_subset: row.roleSubset,
    created_at: row.createdAt,
    expires_at: row.expiresAt,
    revoked_at: row.revokedAt,
    last_used_at: row.lastUsedAt,
    ...(sortValue === undefined ? {} : { sort_value: sortValue }),
  });

  if (text.includes("set_config(")) return [];

  // The shared parent lock. Recorded so a test can prove it was taken, and
  // taken BEFORE the statements that follow it.
  if (text.includes("for update")) {
    const integration = integrationOf();
    if (!integration) return [];
    store.locked.push(integration.id);
    return [{
      id: integration.id,
      status: integration.status,
      granted_roles: integration.grantedRoles,
    }];
  }

  if (text.includes("insert into platform.api_key_integrations")) {
    const [id, tenantId, displayName, , grantedRoles] =
      params as [string, string, string, string, unknown];
    store.integrations.push({
      id, tenantId, displayName, status: "pending",
      grantedRoles: Array.isArray(grantedRoles)
        ? grantedRoles.filter((role): role is string => typeof role === "string")
        : [],
      createdAt: now, updatedAt: now,
    });
    return [];
  }
  if (text.includes("insert into platform.api_keys")) {
    const [id, tenantId, integrationId, , , displayName] =
      params as [string, string, string, string, string, string];
    store.keys.push({
      id, tenantId, integrationId, displayName, roleSubset: null,
      createdAt: now, expiresAt: null, revokedAt: null, lastUsedAt: null,
    });
    return [];
  }
  if (text.includes("set status = 'active'")) {
    const integration = integrationOf();
    if (!integration) return [];
    integration.status = "active";
    integration.updatedAt = now;
    // The activation RETURNS the row, which is how the create path reports an
    // integration's metadata without a second read of it (service.ts step 3).
    return [{
      display_name: integration.displayName,
      status: integration.status,
      granted_roles: integration.grantedRoles,
      created_at: integration.createdAt,
      updated_at: integration.updatedAt,
    }];
  }
  if (text.includes("update platform.api_keys k")) {
    const key = store.keys.find((row) => named(row.id) && named(row.tenantId));
    if (!key) return [];
    key.revokedAt = key.revokedAt ?? now;
    return [{ id: key.id, revoked_at: key.revokedAt }];
  }
  if (text.includes("set status = 'disabled'")) {
    const integration = integrationOf();
    if (integration) integration.status = "disabled";
    return [];
  }
  if (text.includes("update platform.api_keys")) {
    const revoked = store.keys.filter((row) =>
      named(row.integrationId) && named(row.tenantId) && row.revokedAt === null
    );
    for (const key of revoked) key.revokedAt = now;
    return revoked.map((row) => ({ id: row.id }));
  }

  // Dispatch on the FROM clause, not on any mention of a table: the credential
  // page JOINS the integrations table for its parent's name, so matching
  // `api_key_integrations` anywhere would answer it with integration rows.
  const from = (table: string) => text.includes(`from platform.${table}`);

  if (text.includes("count(*) as total")) {
    const rows = from("api_key_integrations i")
      ? store.integrations.filter((row) => named(row.tenantId))
      : store.keys.filter((row) => named(row.tenantId) && named(row.integrationId));
    return [{ total: String(rows.length) }];
  }

  if (from("api_keys k")) {
    const rows = store.keys.filter((row) => named(row.tenantId));
    const byParent = text.includes("k.integration_id =")
      ? rows.filter((row) => named(row.integrationId))
      : rows;
    const scoped = text.includes("k.id =") ? byParent.filter((row) => named(row.id)) : byParent;
    return scoped.map((row) =>
      text.includes("sort_value")
        ? keyMetadata(row, credentialStatusOf(row, now))
        : keyMetadata(row)
    );
  }

  if (from("api_key_integrations i")) {
    const rows = store.integrations.filter((row) => named(row.tenantId));
    const scoped = text.includes("and i.id =") ? rows.filter((row) => named(row.id)) : rows;
    return scoped.map((row) =>
      text.includes("sort_value")
        ? integrationMetadata(row, row.displayName.toLowerCase())
        : integrationMetadata(row)
    );
  }

  return [];
}

export type FixtureDatabase = {
  db: Kysely<DB>;
  statements: CompiledQuery[];
};

export function fixtureDatabase(store: FixtureStore, now: Date = new Date()): FixtureDatabase {
  const statements: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      statements.push(query);
      return { rows: answer(store, query.sql, query.parameters, now) as R[] };
    },
    async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
      throw new Error("Unexpected stream.");
    },
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (database) => new PostgresIntrospector(database),
      createQueryCompiler: () => new PostgresQueryCompiler(),
      createDriver: () => ({
        async init() {}, async acquireConnection() { return connection; },
        async beginTransaction() {}, async commitTransaction() {}, async rollbackTransaction() {},
        async releaseConnection() {}, async destroy() {},
      }),
    },
  });
  return { db, statements };
}

/** Statements that touched an api-key table, for fence assertions. */
export function apiKeyStatements(statements: readonly CompiledQuery[]): CompiledQuery[] {
  return statements.filter((query) => query.sql.includes("platform.api_key"));
}

export type StubRealm = {
  baseUrl: string;
  realm: string;
  /** Admin paths the provisioning client requested, in order. */
  requests: string[];
  clientSecret: string;
  serviceAccountUserId: string;
  /** Integration clients this realm currently holds, as `clientId`s. */
  clients(): string[];
  stop(): Promise<void>;
};

/**
 * The slice of the Keycloak Admin API that provisioning calls, over real HTTP.
 *
 * `roles` is what the realm is willing to grant; a request for anything else
 * makes `grantClientRoles` fail exactly as it would against a real realm,
 * which is how the "nothing usable was handed out" path gets exercised without
 * a Keycloak container.
 *
 * Integration clients are KEPT, not merely acknowledged: a created one is
 * findable, a deleted one is not, and an unknown one was never there. That is
 * what makes `clientExists` and `deleteClient` — the reconciler's probe and
 * the activation's compensation — mean anything here.
 *
 * This is a stub, not Keycloak. It speaks the admin paths `keycloak-admin.ts`
 * calls over real HTTP, and nothing else: no token validation, no realm
 * import, no persistence. A test that needs the real server is the e2e suite
 * in this directory, which runs only against a reachable Keycloak.
 */
export function stubRealm(options: {
  realm?: string;
  roles?: readonly string[];
  failClientCreation?: boolean;
  /**
   * Awaited before each admin request is answered, with the method and path.
   *
   * The seam a concurrency test holds provisioning open on: a caller can block
   * the attempt INSIDE the realm — after the 'pending' row is committed and
   * before the activation — and let something else commit meanwhile. The
   * default awaits nothing, so every other suite is unaffected.
   *
   * Returning a `Response` answers the request instead of this server, which
   * is how a test makes ONE admin call fail — a realm that refuses to delete a
   * client while still answering the probe that finds it, say. Returning
   * nothing lets the request through. It must not throw: an exception out of
   * `fetch` is reported as a server error rather than as a refusal the
   * provisioning client can read.
   */
  onAdminRequest?: (method: string, path: string) => Promise<Response | void>;
} = {}): StubRealm {
  const realm = options.realm ?? "openshapeforge";
  const roles = options.roles ?? [];
  const requests: string[] = [];
  const clientSecret = "stub-realm-client-secret";
  const serviceAccountUserId = "9f1d6b8c-7a2e-4c1b-9f4a-2d3c5e6f7a8b";
  const roleClientInternalId = "22ca2f30-5b6c-4d7e-8f90-1a2b3c4d5e6f";
  /** clientId → the realm's own internal id, for the clients that exist. */
  const clients = new Map<string, string>();
  const internalIdOf = (clientId: string) => {
    const existing = clients.get(clientId);
    if (existing) return existing;
    const minted = randomUUID();
    clients.set(clientId, minted);
    return minted;
  };

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname + (url.search || "");
      requests.push(`${request.method} ${path}`);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

      if (path === `/realms/${realm}/protocol/openid-connect/token`) {
        return json({ access_token: "stub-admin-token", expires_in: 300 });
      }
      if (options.onAdminRequest) {
        const answered = await options.onAdminRequest(request.method, path);
        if (answered) return answered;
      }
      const admin = `/admin/realms/${realm}`;
      if (request.method === "POST" && url.pathname === `${admin}/clients`) {
        if (options.failClientCreation) return new Response(null, { status: 500 });
        const body = await request.json() as { clientId?: string };
        if (typeof body.clientId === "string") {
          if (clients.has(body.clientId)) return new Response(null, { status: 409 });
          internalIdOf(body.clientId);
        }
        return new Response(null, { status: 201 });
      }
      if (request.method === "GET" && url.pathname === `${admin}/clients`) {
        const clientId = url.searchParams.get("clientId") ?? "";
        // The role client is this realm's own fixture and always there; an
        // integration client is there only while it has been created and not
        // deleted, which is what the reconciler's probe asks about.
        if (!clientId.startsWith("osf-int-")) return json([{ id: roleClientInternalId }]);
        const existing = clients.get(clientId);
        return json(existing ? [{ id: existing }] : []);
      }
      const integration = [...clients].find(([, id]) =>
        url.pathname.startsWith(`${admin}/clients/${id}`));
      if (integration) {
        const [clientId, id] = integration;
        if (request.method === "DELETE" && url.pathname === `${admin}/clients/${id}`) {
          clients.delete(clientId);
          return new Response(null, { status: 204 });
        }
        if (url.pathname === `${admin}/clients/${id}/client-secret`) {
          return json({ value: clientSecret });
        }
        if (url.pathname === `${admin}/clients/${id}/service-account-user`) {
          return json({ id: serviceAccountUserId });
        }
      }
      if (url.pathname === `${admin}/clients/${roleClientInternalId}/roles`) {
        return json(roles.map((name, index) => ({ id: `role-${index}`, name })));
      }
      if (request.method === "GET" && url.pathname === `${admin}/users/${serviceAccountUserId}`) {
        return json({ attributes: {} });
      }
      if (request.method === "PUT" && url.pathname === `${admin}/users/${serviceAccountUserId}`) {
        return new Response(null, { status: 204 });
      }
      if (url.pathname.startsWith(`${admin}/users/${serviceAccountUserId}/role-mappings/clients/`)) {
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    realm,
    requests,
    clientSecret,
    serviceAccountUserId,
    clients: () => [...clients.keys()],
    async stop() { await server.stop(true); },
  };
}
