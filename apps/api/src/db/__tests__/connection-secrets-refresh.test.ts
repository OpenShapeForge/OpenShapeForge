// SPDX-License-Identifier: BUSL-1.1
/**
 * The module seam hands over a LIVE OAuth token.
 *
 * `resolveConnectionValues` is how a koppeling that opens a socket (IMAP,
 * SMTP, a database) learns its own credentials. For a personal OAuth sign-in
 * those credentials are an access token that the provider lets expire after
 * about an hour, and the module cannot renew it: the keyring stays in core.
 * So core renews it first — with the row lock, leeway, rotation and audit the
 * HTTP path already has — and this is the proof, against a real database,
 * that an expired token comes back fresh and persisted, that a live one is
 * not exchanged again, that a refusal at the token endpoint becomes
 * REAUTHORIZATION_REQUIRED, and that an app-password Adapter never touches a
 * token endpoint at all.
 *
 * Runs in the db-tests job (`bun test src/db`).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Kysely } from "kysely";
import type { DB } from "../../generated/db/types.js";
import type { TrustedSessionContext } from "../../auth/trusted-context.js";
import { createDatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import { APP_ROLE } from "../migrations/app-role.js";
import { withDbSession } from "../session.js";
import { decryptSecret, encryptSecret, keyringFromEnv } from "../../connectors/secrets.js";
import { connectionTokenSecretScope } from "../../connectors/secrets.js";
import { resolveConnectionValues } from "../../modules/connection-secrets.js";
import { requestConnectionHttp } from "../../modules/connection-http-egress.js";
import {
  inheritConnectionControls,
  parseConnectionExpectation,
  withConnectionControls,
} from "../../mcp/connection-expectation.js";
import { mintInvocationSourceReference } from "../../modules/source-reference.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const APP_ROLE_PASSWORD = "openshapeforge_app";
const TEST_TIMEOUT = 180_000;

const KEYRING = keyringFromEnv(`k1:${Buffer.alloc(32, 9).toString("base64")}`)!;
/** The manifest's vocabulary: Connections are elicited from Adapters. */
const CONNECTION_TABLE = "integration.connections";
const ELICIT_SCOPE = "integration.adapters";
const TOKEN_SCOPE = connectionTokenSecretScope(CONNECTION_TABLE);
const TOKEN_URL = "https://auth.provider.example/token";

const ARTIFACTS = {
  catalog: {
    entities: [{ table: CONNECTION_TABLE, elicitOnCreate: { sourceTable: ELICIT_SCOPE } }],
    derivedTools: [{ execution: {
      providerTable: ELICIT_SCOPE,
      connectionTable: CONNECTION_TABLE,
      connectionProviderRef: "adapterId",
      connectionValuesField: "configurationValues",
    } }],
  },
  manifest: {
    tables: [
      {
        name: ELICIT_SCOPE, schema: "integration", table: "adapters", primaryKey: "id",
        columns: [
          { name: "key", sourceField: "key" },
          { name: "auth", sourceField: "auth" },
          { name: "transport", sourceField: "transport" },
          { name: "egress_hosts", sourceField: "egressHosts" },
          { name: "configuration_fields", sourceField: "configurationFields" },
        ],
      },
      {
        name: CONNECTION_TABLE, schema: "integration", table: "connections", primaryKey: "id",
        columns: [
          { name: "key", sourceField: "key" },
          { name: "adapter_id", sourceField: "adapterId" },
          { name: "configuration_values", sourceField: "configurationValues" },
          { name: "owner_user_id", sourceField: "ownerUserId" },
        ],
        source: { authorization: { rowAccess: { owner: { column: "owner_user_id" } } } },
      },
    ],
  },
};

function scratchUrl(name: string, asApp: boolean): string {
  const url = new URL(ADMIN_URL);
  if (url.pathname === "/openshapeforge_dev") {
    throw new Error("admin URL must not point at openshapeforge_dev");
  }
  if (asApp) {
    url.username = APP_ROLE;
    url.password = APP_ROLE_PASSWORD;
  }
  url.pathname = `/${name}`;
  return url.toString();
}

/**
 * One migrated scratch database for the whole file, seen both as the owner
 * (to seed) and as the app role (what the runtime is). Every test seeds its
 * own tenant, so they share the schema and nothing else.
 */
const scratchName = `connection_secrets_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
let control: SQL;
let adminRuntime: ReturnType<typeof createDatabaseRuntime>;
let appRuntime: ReturnType<typeof createDatabaseRuntime>;
let admin: Kysely<DB>;
let app: Kysely<DB>;

beforeAll(async () => {
  control = new SQL(ADMIN_URL, { max: 1 });
  await control.unsafe(`create database "${scratchName}"`);
  adminRuntime = createDatabaseRuntime({ databaseUrl: scratchUrl(scratchName, false), maxConnections: 4 });
  admin = adminRuntime.db;
  await admin.connection().execute((conn) => runMigrationChain(conn));
  await admin.connection().execute(async (conn) => {
    await sql`
      create schema integration;
      create table integration.adapters (
        id uuid primary key, tenant_id uuid not null, key text not null,
        name text not null, description text not null, transport text not null,
        discovery text not null, auth jsonb not null,
        configuration_fields jsonb not null, egress_hosts jsonb not null
      );
      create table integration.connections (
        id uuid primary key, tenant_id uuid not null, key text not null,
        name text not null, adapter_id uuid not null references integration.adapters(id),
        configuration_values jsonb not null, owner_user_id uuid
      );
      alter table integration.adapters enable row level security;
      alter table integration.adapters force row level security;
      alter table integration.connections enable row level security;
      alter table integration.connections force row level security;
      create policy adapters_tenant_scope on integration.adapters
        using (app.bypass_rls() or tenant_id = app.current_tenant());
      create policy connections_owner_scope on integration.connections
        using (app.bypass_rls() or (tenant_id = app.current_tenant()
          and (owner_user_id is null or owner_user_id = app.current_relation_id())))
        with check (app.bypass_rls() or (tenant_id = app.current_tenant()
          and (owner_user_id is null or owner_user_id = app.current_relation_id())));
      grant usage on schema integration to ${sql.id(APP_ROLE)};
      grant select on integration.adapters to ${sql.id(APP_ROLE)};
      grant select, update on integration.connections to ${sql.id(APP_ROLE)}
    `.execute(conn);
  });
  appRuntime = createDatabaseRuntime({ databaseUrl: scratchUrl(scratchName, true), maxConnections: 4 });
  app = appRuntime.db;
}, TEST_TIMEOUT);

afterAll(async () => {
  await appRuntime?.close();
  await adminRuntime?.close();
  await control?.unsafe(`drop database if exists "${scratchName}" with (force)`);
  await control?.close();
});

/** A person's login and the Relation it acts as are different ids, as in production. */
function sessionFor(tenantId: string, userId: string, relationId?: string): TrustedSessionContext {
  return {
    tenantId,
    userId,
    ...(relationId ? { relationId } : {}),
    roles: [],
    groups: [],
    scope: "self",
    credential: "trusted-context",
  } as TrustedSessionContext;
}

type Seed = {
  tenantId: string;
  adapterId: string;
  adapterKey: string;
  personalId: string;
  userId: string;
  relationId: string;
};

/** An OAuth Adapter, the organization's client credentials, and one person's expired sign-in. */
async function seedOAuthMailbox(
  admin: Kysely<DB>,
  expiresAt: Date,
  overrides: {
    auth?: Record<string, unknown>;
    support?: Record<string, unknown>;
    personal?: Record<string, unknown>;
  } = {},
): Promise<Seed> {
  const tenantId = randomUUID();
  const userId = randomUUID();
  const relationId = randomUUID();
  const adapterId = randomUUID();
  const adapterKey = `mailbox-oauth-${adapterId.slice(0, 8)}`;
  const personalId = randomUUID();
  const auth = {
    scheme: "none",
    profile: "oauth2AuthorizationCode",
    connectionScope: "user",
    tokenUrl: TOKEN_URL,
    ...overrides.auth,
  };
  const fields = [
    { key: "clientId", classification: { sensitivity: "internal" } },
    { key: "clientSecret", classification: { sensitivity: "confidential" } },
    { key: "address", classification: { sensitivity: "internal" } },
  ];
  const support = overrides.support ?? {
    clientId: "client",
    clientSecret: encryptSecret(KEYRING, ELICIT_SCOPE, "clientSecret", "secret"),
  };
  const personal = {
    address: "anna@example.test",
    accessToken: encryptSecret(KEYRING, TOKEN_SCOPE, "accessToken", "access-1"),
    refreshToken: encryptSecret(KEYRING, TOKEN_SCOPE, "refreshToken", "refresh-1"),
    accessTokenExpiresAt: expiresAt.toISOString(),
    ...overrides.personal,
  };
  await admin.connection().execute(async (conn) => {
    await sql`
      insert into integration.adapters (id, tenant_id, key, name, description, transport, discovery, auth, configuration_fields, egress_hosts)
      values (${adapterId}::uuid, ${tenantId}::uuid, ${adapterKey}, 'Mailbox', 'test', 'socket', 'none',
              ${JSON.stringify(auth)}::text::jsonb, ${JSON.stringify(fields)}::text::jsonb,
              ${JSON.stringify(["auth.provider.example", "imap.provider.example:993"])}::text::jsonb)
    `.execute(conn);
    await sql`
      insert into integration.connections (id, tenant_id, key, name, adapter_id, configuration_values, owner_user_id)
      values (${randomUUID()}::uuid, ${tenantId}::uuid, 'oauth-client', 'OAuth client', ${adapterId}::uuid, ${JSON.stringify(support)}::text::jsonb, null),
             (${personalId}::uuid, ${tenantId}::uuid, 'mailbox-anna', 'Mailbox van Anna', ${adapterId}::uuid, ${JSON.stringify(personal)}::text::jsonb, ${relationId}::uuid)
    `.execute(conn);
  });
  return { tenantId, adapterId, adapterKey, personalId, userId, relationId };
}

/** An Adapter of one scope with an organization row and one person's own row. */
async function seedScopedAdapter(admin: Kysely<DB>, connectionScope: "user" | "tenant" | "both") {
  const tenantId = randomUUID();
  const userId = randomUUID();
  const relationId = randomUUID();
  const adapterId = randomUUID();
  const adapterKey = `scoped-${adapterId.slice(0, 8)}`;
  const organizationId = randomUUID();
  const personalId = randomUUID();
  await admin.connection().execute(async (conn) => {
    await sql`
      insert into integration.adapters (id, tenant_id, key, name, description, transport, discovery, auth, configuration_fields, egress_hosts)
      values (${adapterId}::uuid, ${tenantId}::uuid, ${adapterKey}, 'Scoped', 'test', 'socket', 'none',
              ${JSON.stringify({ scheme: "none", connectionScope })}::text::jsonb, '[]'::jsonb, '[]'::jsonb)
    `.execute(conn);
    await sql`
      insert into integration.connections (id, tenant_id, key, name, adapter_id, configuration_values, owner_user_id)
      values (${organizationId}::uuid, ${tenantId}::uuid, 'organization', 'Organization', ${adapterId}::uuid, '{"account":"organization"}'::jsonb, null),
             (${personalId}::uuid, ${tenantId}::uuid, 'personal', 'Personal', ${adapterId}::uuid, '{"account":"personal"}'::jsonb, ${relationId}::uuid)
    `.execute(conn);
  });
  return { tenantId, userId, relationId, adapterKey, organizationId, personalId };
}

function tokenEndpoint(reply: () => Response): { fetchImpl: typeof fetch; exchanges: () => number } {
  let count = 0;
  return {
    fetchImpl: (async () => {
      count += 1;
      return reply();
    }) as unknown as typeof fetch,
    exchanges: () => count,
  };
}

describe("a public client's token stays bound to its resource", () => {
  const RESOURCE = "https://auth.provider.example/mcp";
  const PUBLIC_AUTH = { clientAuthentication: "none", resource: RESOURCE };
  const PUBLIC_SUPPORT = { clientId: "public-client" };
  const BOUND = { oauthBinding: { resource: RESOURCE, issuer: null } };

  function recordingEndpoint(reply: () => Response) {
    const forms: URLSearchParams[] = [];
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      forms.push(new URLSearchParams(String(init?.body ?? "")));
      return reply();
    }) as unknown as typeof fetch;
    return { forms, fetchImpl };
  }

  const resolve = (seed: Seed, fetchImpl: typeof fetch) =>
    resolveConnectionValues({
      db: app,
      session: sessionFor(seed.tenantId, seed.userId, seed.relationId),
      selector: { adapterKey: seed.adapterKey },
      keyring: KEYRING,
      fetchImpl,
      artifacts: ARTIFACTS,
    });

  async function storedValues(seed: Seed): Promise<Record<string, unknown>> {
    const session = sessionFor(seed.tenantId, seed.userId, seed.relationId);
    const result = await withDbSession(app, session, (trx) =>
      sql<{ values: Record<string, unknown> }>`
        select configuration_values as values from integration.connections
         where id = ${seed.personalId}::uuid
      `.execute(trx),
    );
    return result.rows[0]!.values;
  }

  test(
    "refreshes without a secret, repeats the resource and records a stated scope",
    async () => {
      const seed = await seedOAuthMailbox(admin, new Date(Date.now() - 60_000), {
        auth: PUBLIC_AUTH,
        support: PUBLIC_SUPPORT,
        personal: { ...BOUND, grantedScopes: ["mail.read", "mail.write"] },
      });
      const endpoint = recordingEndpoint(() =>
        Response.json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600, scope: "mail.read" }),
      );
      const result = await resolve(seed, endpoint.fetchImpl);
      if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
      expect(result.connection.values.accessToken).toBe("access-2");
      const form = endpoint.forms[0]!;
      expect(form.get("client_id")).toBe("public-client");
      expect(form.has("client_secret")).toBe(false);
      expect(form.get("resource")).toBe(RESOURCE);
      const stored = await storedValues(seed);
      expect(stored.grantedScopes).toEqual(["mail.read"]);
      expect(stored.oauthBinding).toEqual(BOUND.oauthBinding);
    },
    TEST_TIMEOUT,
  );

  test(
    "refuses a still-live token minted for another resource, spending nothing",
    async () => {
      const seed = await seedOAuthMailbox(admin, new Date(Date.now() + 3_600_000), {
        auth: PUBLIC_AUTH,
        support: PUBLIC_SUPPORT,
        personal: { oauthBinding: { resource: "https://auth.provider.example/rest", issuer: null } },
      });
      const endpoint = recordingEndpoint(() => Response.json({ access_token: "must-not-be-issued" }));
      const result = await resolve(seed, endpoint.fetchImpl);
      expect(result).toMatchObject({ ok: false, code: "REAUTHORIZATION_REQUIRED" });
      expect(endpoint.forms).toHaveLength(0);
    },
    TEST_TIMEOUT,
  );

  test(
    "keeps the stored tokens when a refresh answers for another audience",
    async () => {
      const seed = await seedOAuthMailbox(admin, new Date(Date.now() - 60_000), {
        auth: PUBLIC_AUTH,
        support: PUBLIC_SUPPORT,
        personal: BOUND,
      });
      const endpoint = recordingEndpoint(() =>
        Response.json({ access_token: "wrong-audience", expires_in: 3600, aud: "https://auth.provider.example/rest" }),
      );
      const result = await resolve(seed, endpoint.fetchImpl);
      expect(result).toMatchObject({ ok: false, code: "REAUTHORIZATION_REQUIRED" });
      const stored = await storedValues(seed);
      expect(decryptSecret(KEYRING, TOKEN_SCOPE, "accessToken", stored.accessToken as never)).toBe("access-1");
    },
    TEST_TIMEOUT,
  );

  test(
    "goes to consent without calling a server whose metadata has no refresh grant",
    async () => {
      const issuer = "https://auth.provider.example";
      const seed = await seedOAuthMailbox(admin, new Date(Date.now() - 60_000), {
        auth: {
          ...PUBLIC_AUTH,
          serverMetadata: {
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: TOKEN_URL,
            grant_types_supported: ["authorization_code"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
          },
        },
        support: PUBLIC_SUPPORT,
        personal: { oauthBinding: { resource: RESOURCE, issuer } },
      });
      const endpoint = recordingEndpoint(() => Response.json({ access_token: "must-not-be-issued" }));
      const result = await resolve(seed, endpoint.fetchImpl);
      expect(result).toMatchObject({ ok: false, code: "REAUTHORIZATION_REQUIRED" });
      expect(endpoint.forms).toHaveLength(0);
    },
    TEST_TIMEOUT,
  );

  test(
    "still asks a confidential Adapter for its secret",
    async () => {
      const seed = await seedOAuthMailbox(admin, new Date(Date.now() - 60_000), { support: PUBLIC_SUPPORT });
      const endpoint = recordingEndpoint(() => Response.json({ access_token: "must-not-be-issued" }));
      const result = await resolve(seed, endpoint.fetchImpl);
      expect(result).toMatchObject({ ok: false, code: "TOKEN_REFRESH_FAILED" });
      expect(endpoint.forms).toHaveLength(0);
    },
    TEST_TIMEOUT,
  );
});

describe("resolveConnectionValues hands a module a live OAuth token", () => {
  test(
    "renews an expired token before handing it over, once, and persists the rotation",
    async () => {
        const seed = await seedOAuthMailbox(admin, new Date(Date.now() - 60_000));
        const session = sessionFor(seed.tenantId, seed.userId, seed.relationId);
        const endpoint = tokenEndpoint(() =>
          Response.json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 }),
        );
        const resolve = () =>
          resolveConnectionValues({
            db: app,
            session,
            selector: { adapterKey: seed.adapterKey },
            keyring: KEYRING,
            fetchImpl: endpoint.fetchImpl,
            artifacts: ARTIFACTS,
          });

        const first = await resolve();
        if (!first.ok) throw new Error(`${first.code}: ${first.message}`);
        // What the module gets is the renewed token, never the stale one.
        expect(first.connection.values.accessToken).toBe("access-2");
        expect(first.connection.values.address).toBe("anna@example.test");
        expect(first.connection.connectionScope).toBe("user");
        expect(endpoint.exchanges()).toBe(1);

        // A live token is handed over as is: no second round trip to the provider.
        const second = await resolve();
        if (!second.ok) throw new Error(`${second.code}: ${second.message}`);
        expect(second.connection.values.accessToken).toBe("access-2");
        expect(endpoint.exchanges()).toBe(1);

        const persisted = await withDbSession(app, session, (trx) =>
          sql<{ values: Record<string, unknown>; kind: string }>`
            select configuration_values as values, jsonb_typeof(configuration_values) as kind
              from integration.connections where id = ${seed.personalId}::uuid
          `.execute(trx),
        );
        expect(persisted.rows[0]?.kind).toBe("object");
        const stored = persisted.rows[0]!.values;
        expect(decryptSecret(KEYRING, TOKEN_SCOPE, "accessToken", stored.accessToken as never)).toBe("access-2");
        expect(decryptSecret(KEYRING, TOKEN_SCOPE, "refreshToken", stored.refreshToken as never)).toBe("refresh-2");
        expect(stored.address).toBe("anna@example.test");

        const audit = await withDbSession(app, session, (trx) =>
          sql<{ event_type: string; payload: unknown }>`
            select event_type, payload from platform.entity_events
             where aggregate_id = ${seed.personalId} and event_type = 'connection.token_refreshed'
          `.execute(trx),
        );
        expect(audit.rows).toHaveLength(1);
        const auditJson = JSON.stringify(audit.rows[0]?.payload);
        for (const secret of ["access-1", "access-2", "refresh-1", "refresh-2", "secret"]) {
          expect(auditJson).not.toContain(secret);
        }
    },
    TEST_TIMEOUT,
  );

  test(
    "says REAUTHORIZATION_REQUIRED when the provider refuses the renewal, and hands nothing over",
    async () => {
        const seed = await seedOAuthMailbox(admin, new Date(Date.now() - 60_000));
        const session = sessionFor(seed.tenantId, seed.userId, seed.relationId);
        const endpoint = tokenEndpoint(() => new Response("invalid_grant", { status: 400 }));
        const refused = await resolveConnectionValues({
          db: app,
          session,
          selector: { adapterKey: seed.adapterKey },
          keyring: KEYRING,
          fetchImpl: endpoint.fetchImpl,
          artifacts: ARTIFACTS,
        });
        expect(refused.ok).toBe(false);
        if (refused.ok) throw new Error("expected a refusal");
        expect(refused.code).toBe("REAUTHORIZATION_REQUIRED");
        expect(refused.message).toContain("signs in");
        expect(endpoint.exchanges()).toBe(1);

        const audit = await withDbSession(app, session, (trx) =>
          sql<{ event_type: string }>`
            select event_type from platform.entity_events
             where aggregate_id = ${seed.personalId} and event_type = 'connection.reauthorization_required'
          `.execute(trx),
        );
        expect(audit.rows).toHaveLength(1);
    },
    TEST_TIMEOUT,
  );

  test.each(["appPassword", "accessToken"])(
    "leaves a live OAuth token and a manually elicited %s alone",
    async (field) => {
        const live = await seedOAuthMailbox(admin, new Date(Date.now() + 30 * 60_000));
        const endpoint = tokenEndpoint(() => {
          throw new Error("no token endpoint may be called");
        });
        const fresh = await resolveConnectionValues({
          db: app,
          session: sessionFor(live.tenantId, live.userId, live.relationId),
          selector: { adapterKey: live.adapterKey },
          keyring: KEYRING,
          fetchImpl: endpoint.fetchImpl,
          artifacts: ARTIFACTS,
        });
        if (!fresh.ok) throw new Error(`${fresh.code}: ${fresh.message}`);
        expect(fresh.connection.values.accessToken).toBe("access-1");
        expect(endpoint.exchanges()).toBe(0);

        // Neither manually configured variant uses authorization-code OAuth;
        // even the field named accessToken has nothing to renew.
        const tenantId = randomUUID();
        const userId = randomUUID();
        const relationId = randomUUID();
        const adapterId = randomUUID();
        const adapterKey = `mailbox-password-${adapterId.slice(0, 8)}`;
        await admin.connection().execute(async (conn) => {
          await sql`
            insert into integration.adapters (id, tenant_id, key, name, description, transport, discovery, auth, configuration_fields, egress_hosts)
            values (${adapterId}::uuid, ${tenantId}::uuid, ${adapterKey}, 'Mailbox', 'test', 'socket', 'none',
                    ${JSON.stringify(field === "accessToken" ? { scheme: "bearer", profile: "apiKey", tokenFrom: field, connectionScope: "user" } : { scheme: "none", connectionScope: "user" })}::text::jsonb,
                    ${JSON.stringify([{ key: field, classification: { sensitivity: "confidential" } }])}::text::jsonb,
                    ${JSON.stringify(["imap.provider.example:993"])}::text::jsonb)
          `.execute(conn);
          await sql`
            insert into integration.connections (id, tenant_id, key, name, adapter_id, configuration_values, owner_user_id)
            values (${randomUUID()}::uuid, ${tenantId}::uuid, 'mailbox-bram', 'Mailbox van Bram', ${adapterId}::uuid,
                    ${JSON.stringify({ address: "bram@example.test", [field]: encryptSecret(KEYRING, ELICIT_SCOPE, field, "app-pw") })}::text::jsonb,
                    ${relationId}::uuid)
          `.execute(conn);
        });
        const password = await resolveConnectionValues({
          db: app,
          session: sessionFor(tenantId, userId, relationId),
          selector: { adapterKey },
          keyring: KEYRING,
          fetchImpl: endpoint.fetchImpl,
          artifacts: ARTIFACTS,
        });
        if (!password.ok) throw new Error(`${password.code}: ${password.message}`);
        expect(password.connection.values[field]).toBe("app-pw");
        expect(password.connection.values[field === "accessToken" ? "appPassword" : "accessToken"]).toBeUndefined();
        expect(endpoint.exchanges()).toBe(0);
    },
    TEST_TIMEOUT,
  );
});

/**
 * A module Operation reached through the NATIVE binding of a declarative
 * Service is inside that Service's invocation, and this function is where it
 * obtains provider credentials. So the invocation's expected-Connection
 * control reaches here too: a Service bound to one account cannot open a
 * second one through an Operation it composes, and the invocation's capture
 * knows about every account it opened. Without this the `every-provider-call`
 * scope would stop at the engine's own bindings and advertise more than the
 * host keeps. The controls are core-owned and ambient; nothing a module
 * passes in can set, relax or read them.
 */
describe("resolveConnectionValues inside a bound declarative invocation", () => {
  const boundTo = (tenantId: string, connectionId: string, userId: string) =>
    inheritConnectionControls(
      parseConnectionExpectation(
        {
          sourceReference: mintInvocationSourceReference({
            tenantId,
            actorId: userId,
            scope: "personal",
            connectionTable: CONNECTION_TABLE,
            connectionId,
          }),
          appliesTo: "every-provider-call",
        },
        sessionFor(tenantId, userId),
      ),
    );

  /** The same binding, from the Connection id a caller holds on its first call. */
  const boundToId = (tenantId: string, connectionId: string, userId: string) =>
    inheritConnectionControls(
      parseConnectionExpectation(
        { connectionId, appliesTo: "every-provider-call" },
        sessionFor(tenantId, userId),
      ),
    );

  test(
    "refuses another Connection before the token endpoint is reached",
    async () => {
      // The token is expired, so handing this row over means a live exchange
      // with the provider. The refusal has to land first: a Service bound to
      // one account must not renew, let alone use, another account's sign-in.
      const seed = await seedOAuthMailbox(admin, new Date(Date.now() - 60_000));
      const session = sessionFor(seed.tenantId, seed.userId, seed.relationId);
      const endpoint = tokenEndpoint(() => {
        throw new Error("no token endpoint may be called");
      });
      const controls = boundTo(seed.tenantId, randomUUID(), seed.userId);
      await withConnectionControls(controls, async () => {
        await expect(
          resolveConnectionValues({
            db: app,
            session,
            selector: { adapterKey: seed.adapterKey },
            keyring: KEYRING,
            fetchImpl: endpoint.fetchImpl,
            artifacts: ARTIFACTS,
          }),
        ).rejects.toThrow(/expectation names/);
      });
      expect(endpoint.exchanges()).toBe(0);
      // A refusal reached no account, so the invocation reports none.
      expect(controls.connectionUse?.used()).toEqual({
        outcome: "no-provider-call",
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "refuses another Connection when the invocation named one by id",
    async () => {
      // The same refusal at the same boundary for the other representation.
      // A nested canonical Operation is where the demonstrated race landed: an
      // invocation bound to the Connection its caller read must not open a
      // replacement here, one call before any reference exists.
      const seed = await seedOAuthMailbox(admin, new Date(Date.now() - 60_000));
      const session = sessionFor(seed.tenantId, seed.userId, seed.relationId);
      const endpoint = tokenEndpoint(() => {
        throw new Error("no token endpoint may be called");
      });
      const controls = boundToId(seed.tenantId, randomUUID(), seed.userId);
      await withConnectionControls(controls, async () => {
        await expect(
          resolveConnectionValues({
            db: app,
            session,
            selector: { adapterKey: seed.adapterKey },
            keyring: KEYRING,
            fetchImpl: endpoint.fetchImpl,
            artifacts: ARTIFACTS,
          }),
        ).rejects.toThrow(/expectation names/);
      });
      expect(endpoint.exchanges()).toBe(0);
      expect(controls.connectionUse?.used()).toEqual({
        outcome: "no-provider-call",
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "hands over the Connection named by id, and captures its reference",
    async () => {
      // And the round trip that makes the first call usable: the caller set an
      // id, and what comes back is the core-minted reference every later page
      // presents.
      const seed = await seedOAuthMailbox(admin, new Date(Date.now() - 60_000));
      const session = sessionFor(seed.tenantId, seed.userId, seed.relationId);
      const endpoint = tokenEndpoint(() =>
        Response.json({ access_token: "access-3", refresh_token: "refresh-3", expires_in: 3600 }),
      );
      const controls = boundToId(seed.tenantId, seed.personalId, seed.userId);
      await withConnectionControls(controls, async () => {
        const resolved = await resolveConnectionValues({
          db: app,
          session,
          selector: { connectionId: seed.personalId },
          keyring: KEYRING,
          fetchImpl: endpoint.fetchImpl,
          artifacts: ARTIFACTS,
        });
        if (!resolved.ok) throw new Error(`${resolved.code}: ${resolved.message}`);
        expect(resolved.connection.values.accessToken).toBe("access-3");
      });
      expect(endpoint.exchanges()).toBe(1);
      expect(controls.connectionUse?.used()).toEqual({
        outcome: "one-connection",
        sourceReference: mintInvocationSourceReference({
          tenantId: seed.tenantId,
          actorId: seed.userId,
          scope: "personal",
          connectionTable: CONNECTION_TABLE,
          connectionId: seed.personalId,
        }),
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "hands over the Connection the invocation is bound to, and records it",
    async () => {
      const seed = await seedOAuthMailbox(admin, new Date(Date.now() - 60_000));
      const session = sessionFor(seed.tenantId, seed.userId, seed.relationId);
      const endpoint = tokenEndpoint(() =>
        Response.json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 }),
      );
      const controls = boundTo(seed.tenantId, seed.personalId, seed.userId);
      await withConnectionControls(controls, async () => {
        const resolved = await resolveConnectionValues({
          db: app,
          session,
          selector: { connectionId: seed.personalId },
          keyring: KEYRING,
          fetchImpl: endpoint.fetchImpl,
          artifacts: ARTIFACTS,
        });
        if (!resolved.ok) throw new Error(`${resolved.code}: ${resolved.message}`);
        expect(resolved.connection.values.accessToken).toBe("access-2");
      });
      expect(endpoint.exchanges()).toBe(1);
      // The reference the capture hands back is the one the check accepted, so
      // a later invocation may present it verbatim.
      expect(controls.connectionUse?.used()).toEqual({
        outcome: "one-connection",
        sourceReference: mintInvocationSourceReference({
          tenantId: seed.tenantId,
          actorId: seed.userId,
          scope: "personal",
          connectionTable: CONNECTION_TABLE,
          connectionId: seed.personalId,
        }),
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "refuses nothing without an expectation, and still counts what was opened",
    async () => {
      // The opt-out: a Service that sets no expectation behaves exactly as
      // before. What changes is only the honesty of the answer — an Operation
      // that opened a second account makes the invocation unbindable instead
      // of leaving it naming one.
      const seed = await seedOAuthMailbox(admin, new Date(Date.now() + 30 * 60_000));
      const second = await seedOAuthMailbox(admin, new Date(Date.now() + 30 * 60_000));
      const endpoint = tokenEndpoint(() => {
        throw new Error("no token endpoint may be called");
      });
      const controls = inheritConnectionControls(undefined);
      expect(controls.expectedConnection).toBeUndefined();
      await withConnectionControls(controls, async () => {
        for (const owned of [seed, second]) {
          const resolved = await resolveConnectionValues({
            db: app,
            session: sessionFor(owned.tenantId, owned.userId, owned.relationId),
            selector: { connectionId: owned.personalId },
            keyring: KEYRING,
            fetchImpl: endpoint.fetchImpl,
            artifacts: ARTIFACTS,
          });
          expect(resolved.ok).toBe(true);
        }
      });
      expect(endpoint.exchanges()).toBe(0);
      expect(controls.connectionUse?.used()).toEqual({
        outcome: "no-single-connection",
      });
    },
    TEST_TIMEOUT,
  );
});

/**
 * A personal Connection is owned by the Relation a login acts as, which is
 * what the OAuth callback writes and row-level security compares. Every session
 * here has a userId that differs from its relationId, so a comparison against
 * the login cannot pass by accident.
 */
describe("resolveConnectionValues compares ownership with the acting Relation", () => {
  const resolve = (
    session: TrustedSessionContext,
    selector: { adapterKey: string } | { connectionId: string },
  ) => resolveConnectionValues({ db: app, session, selector, keyring: KEYRING, artifacts: ARTIFACTS });

  test("hands a person their own Connection, by Adapter and by id", async () => {
    const seed = await seedScopedAdapter(admin, "user");
    const session = sessionFor(seed.tenantId, seed.userId, seed.relationId);
    expect(seed.userId).not.toBe(seed.relationId);
    for (const selector of [{ adapterKey: seed.adapterKey }, { connectionId: seed.personalId }]) {
      const resolved = await resolve(session, selector);
      if (!resolved.ok) throw new Error(`${resolved.code}: ${resolved.message}`);
      expect(resolved.connection.connectionId).toBe(seed.personalId);
      expect(resolved.connection.connectionScope).toBe("user");
      expect(resolved.connection.ownerUserId).toBe(seed.relationId);
    }
  }, TEST_TIMEOUT);

  test("refuses another person, an unlinked login and a login named like the owner", async () => {
    const seed = await seedScopedAdapter(admin, "user");
    const sessions = [
      sessionFor(seed.tenantId, randomUUID(), randomUUID()),
      sessionFor(seed.tenantId, seed.userId),
      // The owner's id as a login id is not the owner's Relation.
      sessionFor(seed.tenantId, seed.relationId, randomUUID()),
    ];
    for (const session of sessions) {
      for (const selector of [{ adapterKey: seed.adapterKey }, { connectionId: seed.personalId }]) {
        expect(await resolve(session, selector)).toMatchObject({ ok: false, code: "NOT_FOUND" });
      }
    }
  }, TEST_TIMEOUT);

  test("refuses the same login and Relation in another tenant", async () => {
    const seed = await seedScopedAdapter(admin, "user");
    const elsewhere = sessionFor(randomUUID(), seed.userId, seed.relationId);
    for (const selector of [{ adapterKey: seed.adapterKey }, { connectionId: seed.personalId }]) {
      expect(await resolve(elsewhere, selector)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    }
  }, TEST_TIMEOUT);

  test("keeps an organization Connection open to members, linked or not", async () => {
    const seed = await seedScopedAdapter(admin, "tenant");
    for (const session of [
      sessionFor(seed.tenantId, randomUUID(), randomUUID()),
      sessionFor(seed.tenantId, randomUUID()),
    ]) {
      const resolved = await resolve(session, { connectionId: seed.organizationId });
      if (!resolved.ok) throw new Error(`${resolved.code}: ${resolved.message}`);
      expect(resolved.connection.connectionScope).toBe("tenant");
      expect(resolved.connection.ownerUserId).toBeNull();
    }
    // Its owner may reach a personal row on a tenant Adapter; nobody else can.
    const owner = await resolve(sessionFor(seed.tenantId, seed.userId, seed.relationId), { connectionId: seed.personalId });
    expect(owner).toMatchObject({ ok: true, connection: { connectionScope: "tenant" } });
    expect(await resolve(sessionFor(seed.tenantId, randomUUID(), randomUUID()), { connectionId: seed.personalId }))
      .toMatchObject({ ok: false, code: "NOT_FOUND" });
  }, TEST_TIMEOUT);

  test("reads a `both` Adapter as the row it selected", async () => {
    const seed = await seedScopedAdapter(admin, "both");
    const owner = await resolve(sessionFor(seed.tenantId, seed.userId, seed.relationId), { adapterKey: seed.adapterKey });
    expect(owner).toMatchObject({ ok: true, connection: { connectionId: seed.personalId, connectionScope: "user" } });
    const colleague = await resolve(sessionFor(seed.tenantId, randomUUID(), randomUUID()), { adapterKey: seed.adapterKey });
    expect(colleague).toMatchObject({ ok: true, connection: { connectionId: seed.organizationId, connectionScope: "tenant" } });
  }, TEST_TIMEOUT);
});

test("a real personal Connection mints a single-use HTTP grant and revocation stops the next resolution", async () => {
  const seed = await seedOAuthMailbox(admin, new Date(Date.now() + 3_600_000));
  const session = sessionFor(seed.tenantId, seed.userId, seed.relationId);
  const resolve = () => resolveConnectionValues({
    db: app, session, selector: { connectionId: seed.personalId }, keyring: KEYRING, artifacts: ARTIFACTS,
  });
  const result = await resolve();
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  let calls = 0;
  const dependencies = {
    owner: { pinsResolvedAddresses: true as const, fetch: async () => { calls++; return Response.json({ ok: true }); } },
    resolve: async () => ["1.1.1.1"],
  };
  const request = { url: "https://auth.provider.example/mcp", json: { jsonrpc: "2.0" } };
  expect((await requestConnectionHttp(session, result.connection.egressGrant, request, dependencies)).status).toBe(200);
  await expect(requestConnectionHttp(session, result.connection.egressGrant, request, dependencies))
    .rejects.toMatchObject({ code: "EGRESS_DENIED" });
  await sql`delete from integration.connections where id = ${seed.personalId}::uuid`.execute(admin);
  expect(await resolve()).toMatchObject({ ok: false, code: "NOT_FOUND" });
  expect(calls).toBe(1);
}, TEST_TIMEOUT);

test("transaction-scoped Connection resolution locks against rotation and avoids token refresh", async () => {
  const seed = await seedOAuthMailbox(admin, new Date(Date.now() - 60_000));
  const session = sessionFor(seed.tenantId, seed.userId, seed.relationId);
  const endpoint = tokenEndpoint(() => { throw new Error("unexpected refresh"); });
  await withDbSession(app, session, async (trx) => {
    const result = await resolveConnectionValues({ db: app, session,
      selector: { connectionId: seed.personalId }, transaction: trx, skipTokenRefresh: true,
      keyring: KEYRING, fetchImpl: endpoint.fetchImpl, artifacts: ARTIFACTS });
    expect(result.ok).toBe(true);
    expect(endpoint.exchanges()).toBe(0);
    // A concurrent credential rotation must not commit during the checked operation.
    await expect(withDbSession(app, session, async (other) => {
      await sql`set local lock_timeout = '100ms'`.execute(other);
      await sql`update integration.connections set configuration_values = '{}'::jsonb where id = ${seed.personalId}::uuid`.execute(other);
    }, { independent: true })).rejects.toThrow();
  });
  await withDbSession(app, session, async (trx) => {
    const changed = await sql`update integration.connections set configuration_values = '{}'::jsonb where id = ${seed.personalId}::uuid`.execute(trx);
    expect(Number(changed.numAffectedRows)).toBe(1);
  });
}, TEST_TIMEOUT);
