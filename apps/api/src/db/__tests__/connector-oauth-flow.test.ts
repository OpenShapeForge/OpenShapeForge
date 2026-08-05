// SPDX-License-Identifier: BUSL-1.1
/**
 * The OAuth flow against a real database and a stubbed provider.
 *
 * This is the suite that proves the parts no unit test can. The state claim is
 * one SQL statement whose correctness IS its atomicity; the refresh is a row
 * lock; token storage is an encrypted upsert under RLS. Every one of those is a
 * property of Postgres plus the statement, so a stub would be testing the mock.
 *
 * The provider is stubbed, and that is the honest boundary of what runs here: a
 * real authorization needs a registered application, a browser consent screen
 * and a public redirect URI. What is proved below is that everything on OUR
 * side of that redirect is correct — including the properties that would be a
 * cross-tenant credential vulnerability if they were not.
 *
 * Runs in the db-tests job (`bun test src/db`), which is the job that has a
 * database. The connector unit suites are not currently run by any CI job.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Kysely } from "kysely";
import type { DB } from "../../generated/db/types.js";
import { createDatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import { APP_ROLE } from "../migrations/app-role.js";
import {
  buildState,
  consumeAuthorizationState,
  createAuthorizationState,
  purgeExpiredAuthorizationStates,
} from "../../connectors/oauth-state.js";
import { PLATFORM_OAUTH_FIELD, writeOAuthTokens, ensureAccessToken } from "../../connectors/oauth.js";
import { contractSecrets, keyringFromEnv } from "../../connectors/secrets.js";
import { readSecrets } from "../../connectors/store.js";
import type { ConnectorContract } from "../../connectors/catalog.js";
import type { FetchLike } from "../../connectors/executor.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const APP_ROLE_PASSWORD = "openshapeforge_app";
const TEST_TIMEOUT = 90_000;

const KEYRING = keyringFromEnv(`k1:${Buffer.alloc(32, 7).toString("base64")}`)!;

function scratchAdminUrl(name: string): string {
  const url = new URL(ADMIN_URL);
  if (url.pathname === "/openshapeforge_dev") {
    throw new Error("admin URL must not point at openshapeforge_dev");
  }
  url.pathname = `/${name}`;
  return url.toString();
}

function scratchAppUrl(name: string): string {
  const url = new URL(ADMIN_URL);
  url.username = APP_ROLE;
  url.password = APP_ROLE_PASSWORD;
  url.pathname = `/${name}`;
  return url.toString();
}

async function withScratchDb<T>(fn: (name: string) => Promise<T>): Promise<T> {
  const name = `connector_oauth_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`unsafe scratch database name: ${name}`);
  const admin = new SQL(ADMIN_URL, { max: 1 });
  try {
    await admin.unsafe(`create database "${name}"`);
    try {
      return await fn(name);
    } finally {
      await admin.unsafe(`drop database if exists "${name}" with (force)`);
    }
  } finally {
    await admin.close();
  }
}

async function withDb<T>(url: string, fn: (db: Kysely<DB>) => Promise<T>): Promise<T> {
  const runtime = createDatabaseRuntime({ databaseUrl: url, maxConnections: 4 });
  try {
    return await fn(runtime.db);
  } finally {
    await runtime.close();
  }
}

/** A migrated scratch database, handed to the test as the restricted app role. */
async function withMigratedDb<T>(fn: (db: Kysely<DB>) => Promise<T>): Promise<T> {
  return withScratchDb(async (name) => {
    await withDb(scratchAdminUrl(name), (db) =>
      db.connection().execute((conn) => runMigrationChain(conn)),
    );
    return withDb(scratchAppUrl(name), fn);
  });
}

const CONTRACT = {
  slug: "probe-oauth",
  network: { egress: ["*.provider.example"] },
  configuration: { secretFields: ["clientSecret"] },
  auth: {
    type: "oauth2",
    flow: "authorizationCode",
    authorizeUrl: "https://auth.provider.example/authorize",
    tokenUrl: "https://auth.provider.example/token",
    scopes: [],
    clientIdField: "clientId",
    clientSecretField: "clientSecret",
    refreshLeewaySeconds: 60,
  },
} as unknown as ConnectorContract;

async function seedInstallation(
  db: Kysely<DB>,
  tenantId: string,
): Promise<string> {
  const installationId = randomUUID();
  await db.connection().execute(async (conn) => {
    await sql`select set_config('app.tenant_id', ${tenantId}, false)`.execute(conn);
    await sql`
      insert into platform.connector_installations
        (id, tenant_id, connector_slug, instance_key, config, enabled,
         contract_version, contract_checksum)
      values (${installationId}::uuid, ${tenantId}::uuid, ${CONTRACT.slug}, 'default',
              ${JSON.stringify({ clientId: "client-abc" })}::jsonb, true, 1, 'checksum')
    `.execute(conn);
  });
  return installationId;
}

describe("the authorization state", () => {
  test(
    "is claimed exactly once, and a replay finds nothing",
    async () => {
      await withMigratedDb(async (db) => {
        const tenantId = randomUUID();
        const session = { tenantId, userId: randomUUID(), roles: [] };

        const { state } = await createAuthorizationState({
          db,
          session,
          keyring: KEYRING,
          connectorSlug: CONTRACT.slug,
          instanceKey: "default",
          redirectUri: "https://app.example/callback",
        });

        const first = await consumeAuthorizationState({ db, keyring: KEYRING, state });
        expect(first.tenantId).toBe(tenantId);
        expect(first.record.connectorSlug).toBe(CONTRACT.slug);
        expect(first.record.redirectUri).toBe("https://app.example/callback");
        // The PKCE verifier survives the encrypt/decrypt round trip, which is
        // what makes the exchange able to prove it started this flow.
        expect(first.record.codeVerifier.length).toBeGreaterThanOrEqual(43);

        // The replay. Without this refusal a leaked state could attach an
        // attacker's provider account to somebody else's installation.
        await expect(
          consumeAuthorizationState({ db, keyring: KEYRING, state }),
        ).rejects.toThrow(/unknown, already used, or expired/);
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "cannot be claimed twice concurrently",
    async () => {
      await withMigratedDb(async (db) => {
        const session = { tenantId: randomUUID(), userId: randomUUID(), roles: [] };
        const { state } = await createAuthorizationState({
          db,
          session,
          keyring: KEYRING,
          connectorSlug: CONTRACT.slug,
          instanceKey: "default",
          redirectUri: "https://app.example/callback",
        });

        // The claim and the check are one statement precisely so this holds.
        const results = await Promise.allSettled(
          Array.from({ length: 5 }, () =>
            consumeAuthorizationState({ db, keyring: KEYRING, state }),
          ),
        );
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "is refused once expired",
    async () => {
      await withMigratedDb(async (db) => {
        const session = { tenantId: randomUUID(), userId: randomUUID(), roles: [] };
        const { state } = await createAuthorizationState({
          db,
          session,
          keyring: KEYRING,
          connectorSlug: CONTRACT.slug,
          instanceKey: "default",
          redirectUri: "https://app.example/callback",
          // Minted as though eleven minutes ago; the TTL is ten.
          now: Date.now() - 11 * 60_000,
        });
        await expect(
          consumeAuthorizationState({ db, keyring: KEYRING, state }),
        ).rejects.toThrow(/unknown, already used, or expired/);
      });
    },
    TEST_TIMEOUT,
  );

  // The binding that makes the callback safe without a session of ours.
  test(
    "belonging to one tenant is invisible to another",
    async () => {
      await withMigratedDb(async (db) => {
        const tenantA = randomUUID();
        const tenantB = randomUUID();
        const { state } = await createAuthorizationState({
          db,
          session: { tenantId: tenantA, userId: randomUUID(), roles: [] },
          keyring: KEYRING,
          connectorSlug: CONTRACT.slug,
          instanceKey: "default",
          redirectUri: "https://app.example/callback",
        });

        // Re-point the state at another tenant, exactly as an attacker holding
        // a captured value would. RLS then hides the row from the session the
        // callback opens, so the claim finds nothing.
        const forged = `${tenantB}.${state.split(".").slice(1).join(".")}`;
        await expect(
          consumeAuthorizationState({ db, keyring: KEYRING, state: forged }),
        ).rejects.toThrow(/unknown, already used, or expired/);
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "an unknown state is refused without revealing that it never existed",
    async () => {
      await withMigratedDb(async (db) => {
        const { state } = buildState(randomUUID(), randomUUID());
        await expect(
          consumeAuthorizationState({ db, keyring: KEYRING, state }),
        ).rejects.toThrow(/unknown, already used, or expired/);
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "expired rows are purged, live ones are not",
    async () => {
      await withMigratedDb(async (db) => {
        const session = { tenantId: randomUUID(), userId: randomUUID(), roles: [] };
        await createAuthorizationState({
          db,
          session,
          keyring: KEYRING,
          connectorSlug: CONTRACT.slug,
          instanceKey: "default",
          redirectUri: "https://app.example/callback",
          now: Date.now() - 11 * 60_000,
        });
        const live = await createAuthorizationState({
          db,
          session,
          keyring: KEYRING,
          connectorSlug: CONTRACT.slug,
          instanceKey: "default",
          redirectUri: "https://app.example/callback",
        });

        expect(await purgeExpiredAuthorizationStates(db, session)).toBe(1);
        // The live one still works after the sweep.
        await expect(
          consumeAuthorizationState({ db, keyring: KEYRING, state: live.state }),
        ).resolves.toBeDefined();
      });
    },
    TEST_TIMEOUT,
  );
});

describe("token storage and refresh", () => {
  test(
    "tokens are stored encrypted, and withheld from the connector's own secrets",
    async () => {
      await withMigratedDb(async (db) => {
        const tenantId = randomUUID();
        const session = { tenantId, userId: randomUUID(), roles: [] };
        const installationId = await seedInstallation(db, tenantId);

        await writeOAuthTokens({
          db,
          session,
          keyring: KEYRING,
          installationId,
          tokens: {
            accessToken: "access-1",
            refreshToken: "refresh-1",
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
          },
        });

        // Ciphertext at rest: a database read yields nothing usable.
        const stored = await db.connection().execute(async (conn) => {
          await sql`select set_config('app.tenant_id', ${tenantId}, false)`.execute(conn);
          return sql<{ ciphertext: string }>`
            select ciphertext from platform.connector_secrets
             where installation_id = ${installationId}::uuid
               and field_key = ${PLATFORM_OAUTH_FIELD}
          `.execute(conn);
        });
        expect(stored.rows[0]?.ciphertext).not.toContain("refresh-1");

        // And the narrowing: the package's own view never includes the token
        // row, whatever the store answered with.
        const all = await readSecrets(db, session, KEYRING, installationId);
        expect(all[PLATFORM_OAUTH_FIELD]).toBeDefined();
        const narrowed = contractSecrets(all, CONTRACT.configuration.secretFields);
        expect(narrowed[PLATFORM_OAUTH_FIELD]).toBeUndefined();
        expect(JSON.stringify(narrowed)).not.toContain("refresh-1");
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "a valid token is returned without contacting the provider",
    async () => {
      await withMigratedDb(async (db) => {
        const tenantId = randomUUID();
        const session = { tenantId, userId: randomUUID(), roles: [] };
        const installationId = await seedInstallation(db, tenantId);
        await writeOAuthTokens({
          db,
          session,
          keyring: KEYRING,
          installationId,
          tokens: {
            accessToken: "still-good",
            refreshToken: "refresh-1",
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
          },
        });

        let called = 0;
        const boundFetch: FetchLike = async () => {
          called += 1;
          return Response.json({});
        };

        const token = await ensureAccessToken({
          db,
          session,
          keyring: KEYRING,
          contract: CONTRACT,
          installationId,
          instanceKey: "default",
          config: { clientId: "client-abc" },
          secrets: { clientSecret: "secret-abc" },
          boundFetch,
        });
        expect(token).toBe("still-good");
        expect(called).toBe(0);
      });
    },
    TEST_TIMEOUT,
  );

  // The behaviour this whole design exists for. Exact Online replaces the
  // refresh token on every refresh; dropping the replacement breaks the
  // installation on its next call.
  test(
    "an expired token is refreshed and the ROTATED refresh token is persisted",
    async () => {
      await withMigratedDb(async (db) => {
        const tenantId = randomUUID();
        const session = { tenantId, userId: randomUUID(), roles: [] };
        const installationId = await seedInstallation(db, tenantId);
        await writeOAuthTokens({
          db,
          session,
          keyring: KEYRING,
          installationId,
          tokens: {
            accessToken: "expired",
            refreshToken: "refresh-1",
            expiresAt: Math.floor(Date.now() / 1000) - 10,
          },
        });

        const sent: string[] = [];
        const boundFetch: FetchLike = async (_url, init) => {
          sent.push(String(init?.body ?? ""));
          return Response.json({
            access_token: "access-2",
            refresh_token: "refresh-2",
            expires_in: 600,
          });
        };

        const token = await ensureAccessToken({
          db,
          session,
          keyring: KEYRING,
          contract: CONTRACT,
          installationId,
          instanceKey: "default",
          config: { clientId: "client-abc" },
          secrets: { clientSecret: "secret-abc" },
          boundFetch,
        });

        expect(token).toBe("access-2");
        expect(sent[0]).toContain("grant_type=refresh_token");
        expect(sent[0]).toContain("refresh_token=refresh-1");

        // The rotation actually landed: a second call uses refresh-2, and the
        // spent refresh-1 is gone.
        const persisted = await readSecrets(db, session, KEYRING, installationId);
        const tokens = JSON.parse(persisted[PLATFORM_OAUTH_FIELD]!) as {
          refreshToken: string;
          accessToken: string;
        };
        expect(tokens.refreshToken).toBe("refresh-2");
        expect(tokens.accessToken).toBe("access-2");
      });
    },
    TEST_TIMEOUT,
  );

  // The refresh holds a row lock precisely so a single-use refresh token is
  // never spent twice. Without it, concurrent invocations race and the loser
  // gets invalid_grant — or overwrites the winner's set.
  test(
    "concurrent invocations refresh once, not once each",
    async () => {
      await withMigratedDb(async (db) => {
        const tenantId = randomUUID();
        const session = { tenantId, userId: randomUUID(), roles: [] };
        const installationId = await seedInstallation(db, tenantId);
        await writeOAuthTokens({
          db,
          session,
          keyring: KEYRING,
          installationId,
          tokens: {
            accessToken: "expired",
            refreshToken: "refresh-1",
            expiresAt: Math.floor(Date.now() / 1000) - 10,
          },
        });

        let exchanges = 0;
        const boundFetch: FetchLike = async () => {
          exchanges += 1;
          return Response.json({
            access_token: `access-${exchanges + 1}`,
            refresh_token: `refresh-${exchanges + 1}`,
            expires_in: 600,
          });
        };

        const tokens = await Promise.all(
          Array.from({ length: 4 }, () =>
            ensureAccessToken({
              db,
              session,
              keyring: KEYRING,
              contract: CONTRACT,
              installationId,
              instanceKey: "default",
              config: { clientId: "client-abc" },
              secrets: { clientSecret: "secret-abc" },
              boundFetch,
            }),
          ),
        );

        expect(exchanges).toBe(1);
        expect(new Set(tokens)).toEqual(new Set(["access-2"]));
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "a refused refresh reports that the installation must be authorized again",
    async () => {
      await withMigratedDb(async (db) => {
        const tenantId = randomUUID();
        const session = { tenantId, userId: randomUUID(), roles: [] };
        const installationId = await seedInstallation(db, tenantId);
        await writeOAuthTokens({
          db,
          session,
          keyring: KEYRING,
          installationId,
          tokens: {
            accessToken: "expired",
            refreshToken: "spent",
            expiresAt: Math.floor(Date.now() / 1000) - 10,
          },
        });

        const boundFetch: FetchLike = async () =>
          new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });

        await expect(
          ensureAccessToken({
            db,
            session,
            keyring: KEYRING,
            contract: CONTRACT,
            installationId,
            instanceKey: "default",
            config: { clientId: "client-abc" },
            secrets: { clientSecret: "secret-abc" },
            boundFetch,
          }),
        ).rejects.toThrow(/must be\s+authorized again/);
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "an installation with no tokens says so rather than failing obscurely",
    async () => {
      await withMigratedDb(async (db) => {
        const tenantId = randomUUID();
        const session = { tenantId, userId: randomUUID(), roles: [] };
        const installationId = await seedInstallation(db, tenantId);
        await expect(
          ensureAccessToken({
            db,
            session,
            keyring: KEYRING,
            contract: CONTRACT,
            installationId,
            instanceKey: "default",
            config: { clientId: "client-abc" },
            secrets: { clientSecret: "secret-abc" },
            boundFetch: async () => Response.json({}),
          }),
        ).rejects.toThrow(/must\s+be authorized before it can be used/);
      });
    },
    TEST_TIMEOUT,
  );
});
