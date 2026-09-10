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
import { connectionTokenSecretScope } from "../../mcp/entity-oauth.js";
import { resolveConnectionValues } from "../../modules/connection-secrets.js";

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
          and (owner_user_id is null or owner_user_id = app.current_user_id())))
        with check (app.bypass_rls() or (tenant_id = app.current_tenant()
          and (owner_user_id is null or owner_user_id = app.current_user_id())));
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

function sessionFor(tenantId: string, userId: string): TrustedSessionContext {
  return {
    tenantId,
    userId,
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
};

/** An OAuth Adapter, the organization's client credentials, and one person's expired sign-in. */
async function seedOAuthMailbox(admin: Kysely<DB>, expiresAt: Date): Promise<Seed> {
  const tenantId = randomUUID();
  const userId = randomUUID();
  const adapterId = randomUUID();
  const adapterKey = `mailbox-oauth-${adapterId.slice(0, 8)}`;
  const personalId = randomUUID();
  const auth = {
    scheme: "none",
    profile: "oauth2AuthorizationCode",
    connectionScope: "user",
    tokenUrl: TOKEN_URL,
  };
  const fields = [
    { key: "clientId", classification: { sensitivity: "internal" } },
    { key: "clientSecret", classification: { sensitivity: "confidential" } },
    { key: "address", classification: { sensitivity: "internal" } },
  ];
  const support = {
    clientId: "client",
    clientSecret: encryptSecret(KEYRING, ELICIT_SCOPE, "clientSecret", "secret"),
  };
  const personal = {
    address: "anna@example.test",
    accessToken: encryptSecret(KEYRING, TOKEN_SCOPE, "accessToken", "access-1"),
    refreshToken: encryptSecret(KEYRING, TOKEN_SCOPE, "refreshToken", "refresh-1"),
    accessTokenExpiresAt: expiresAt.toISOString(),
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
             (${personalId}::uuid, ${tenantId}::uuid, 'mailbox-anna', 'Mailbox van Anna', ${adapterId}::uuid, ${JSON.stringify(personal)}::text::jsonb, ${userId}::uuid)
    `.execute(conn);
  });
  return { tenantId, adapterId, adapterKey, personalId, userId };
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

describe("resolveConnectionValues hands a module a live OAuth token", () => {
  test(
    "renews an expired token before handing it over, once, and persists the rotation",
    async () => {
        const seed = await seedOAuthMailbox(admin, new Date(Date.now() - 60_000));
        const session = sessionFor(seed.tenantId, seed.userId);
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
        const session = sessionFor(seed.tenantId, seed.userId);
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

  test(
    "leaves a token that is still live, and an app-password Adapter, alone",
    async () => {
        const live = await seedOAuthMailbox(admin, new Date(Date.now() + 30 * 60_000));
        const endpoint = tokenEndpoint(() => {
          throw new Error("no token endpoint may be called");
        });
        const fresh = await resolveConnectionValues({
          db: app,
          session: sessionFor(live.tenantId, live.userId),
          selector: { adapterKey: live.adapterKey },
          keyring: KEYRING,
          fetchImpl: endpoint.fetchImpl,
          artifacts: ARTIFACTS,
        });
        if (!fresh.ok) throw new Error(`${fresh.code}: ${fresh.message}`);
        expect(fresh.connection.values.accessToken).toBe("access-1");
        expect(endpoint.exchanges()).toBe(0);

        // The app-password mailbox: no profile, no token, nothing to renew.
        const tenantId = randomUUID();
        const userId = randomUUID();
        const adapterId = randomUUID();
        const adapterKey = `mailbox-password-${adapterId.slice(0, 8)}`;
        await admin.connection().execute(async (conn) => {
          await sql`
            insert into integration.adapters (id, tenant_id, key, name, description, transport, discovery, auth, configuration_fields, egress_hosts)
            values (${adapterId}::uuid, ${tenantId}::uuid, ${adapterKey}, 'Mailbox', 'test', 'socket', 'none',
                    ${JSON.stringify({ scheme: "none", connectionScope: "user" })}::text::jsonb,
                    ${JSON.stringify([{ key: "appPassword", classification: { sensitivity: "confidential" } }])}::text::jsonb,
                    ${JSON.stringify(["imap.provider.example:993"])}::text::jsonb)
          `.execute(conn);
          await sql`
            insert into integration.connections (id, tenant_id, key, name, adapter_id, configuration_values, owner_user_id)
            values (${randomUUID()}::uuid, ${tenantId}::uuid, 'mailbox-bram', 'Mailbox van Bram', ${adapterId}::uuid,
                    ${JSON.stringify({ address: "bram@example.test", appPassword: encryptSecret(KEYRING, ELICIT_SCOPE, "appPassword", "app-pw") })}::text::jsonb,
                    ${userId}::uuid)
          `.execute(conn);
        });
        const password = await resolveConnectionValues({
          db: app,
          session: sessionFor(tenantId, userId),
          selector: { adapterKey },
          keyring: KEYRING,
          fetchImpl: endpoint.fetchImpl,
          artifacts: ARTIFACTS,
        });
        if (!password.ok) throw new Error(`${password.code}: ${password.message}`);
        expect(password.connection.values.appPassword).toBe("app-pw");
        expect(password.connection.values.accessToken).toBeUndefined();
        expect(endpoint.exchanges()).toBe(0);
    },
    TEST_TIMEOUT,
  );
});
