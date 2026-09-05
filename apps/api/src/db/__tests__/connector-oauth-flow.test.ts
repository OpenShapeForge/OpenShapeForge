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
import { withDbSession } from "../session.js";
import {
  buildState,
  consumeAuthorizationState,
  createAuthorizationState,
  purgeExpiredAuthorizationStates,
} from "../../connectors/oauth-state.js";
import {
  ensureAccessToken,
  PLATFORM_OAUTH_FIELD,
  writeOAuthTokens,
} from "../../connectors/oauth.js";
import {
  contractSecrets,
  decryptSecret,
  encryptSecret,
  keyringFromEnv,
} from "../../connectors/secrets.js";
import { readSecrets } from "../../connectors/store.js";
import type { ConnectorContract } from "../../connectors/catalog.js";
import type { FetchLike } from "../../connectors/executor.js";
import {
  refreshConnectionRowLocked,
  selectOAuthConnectionRow,
} from "../../mcp/generated-mcp-server.js";

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

async function withMigratedDbAndAdmin<T>(
  fn: (db: Kysely<DB>, admin: Kysely<DB>) => Promise<T>,
): Promise<T> {
  return withScratchDb(async (name) => {
    return withDb(scratchAdminUrl(name), async (admin) => {
      await admin.connection().execute((conn) => runMigrationChain(conn));
      return withDb(scratchAppUrl(name), (db) => fn(db, admin));
    });
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

/**
 * Client credentials: the application authenticates as itself. No consent, no
 * callback, and no refresh token — so the interesting question is what happens
 * when there is nothing stored, which for authorization code is an error and
 * here is simply the first call.
 */
describe("the client-credentials flow", () => {
  const APP_CONTRACT = {
    ...CONTRACT,
    slug: "probe-oauth",
    auth: {
      ...CONTRACT.auth,
      flow: "clientCredentials",
      authorizeUrl: undefined,
      scopes: ["https://{host}/.default"],
    },
  } as unknown as ConnectorContract;

  const APP_CONFIG = { clientId: "client-abc", host: "contoso.example" };

  test(
    "mints a token on first use rather than demanding authorization",
    async () => {
      await withMigratedDb(async (db) => {
        const tenantId = randomUUID();
        const session = { tenantId, userId: randomUUID(), roles: [] };
        const installationId = await seedInstallation(db, tenantId);

        const sent: string[] = [];
        const boundFetch: FetchLike = async (_url, init) => {
          sent.push(String(init?.body ?? ""));
          return Response.json({ access_token: "app-1", expires_in: 600 });
        };

        const token = await ensureAccessToken({
          db,
          session,
          keyring: KEYRING,
          contract: APP_CONTRACT,
          installationId,
          instanceKey: "default",
          config: APP_CONFIG,
          secrets: { clientSecret: "secret-abc" },
          boundFetch,
        });

        expect(token).toBe("app-1");
        expect(sent[0]).toContain("grant_type=client_credentials");
        // The scope template is filled from configuration. Unfilled, Entra
        // issues a token for the wrong audience and the API rejects it later
        // as a 401 that explains nothing.
        expect(decodeURIComponent(sent[0]!)).toContain("https://contoso.example/.default");
        // And no refresh token was sent, because there is none.
        expect(sent[0]).not.toContain("refresh_token");
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "stores the minted token encrypted, and withholds it from the package",
    async () => {
      await withMigratedDb(async (db) => {
        const tenantId = randomUUID();
        const session = { tenantId, userId: randomUUID(), roles: [] };
        const installationId = await seedInstallation(db, tenantId);

        await ensureAccessToken({
          db,
          session,
          keyring: KEYRING,
          contract: APP_CONTRACT,
          installationId,
          instanceKey: "default",
          config: APP_CONFIG,
          secrets: { clientSecret: "secret-abc" },
          boundFetch: async () => Response.json({ access_token: "app-1", expires_in: 600 }),
        });

        const all = await readSecrets(db, session, KEYRING, installationId);
        expect(all[PLATFORM_OAUTH_FIELD]).toBeDefined();
        const narrowed = contractSecrets(all, APP_CONTRACT.configuration.secretFields);
        expect(narrowed[PLATFORM_OAUTH_FIELD]).toBeUndefined();
        expect(JSON.stringify(narrowed)).not.toContain("app-1");
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "reuses a valid token, and re-requests an expired one",
    async () => {
      await withMigratedDb(async (db) => {
        const tenantId = randomUUID();
        const session = { tenantId, userId: randomUUID(), roles: [] };
        const installationId = await seedInstallation(db, tenantId);

        let issued = 0;
        const boundFetch: FetchLike = async () => {
          issued += 1;
          return Response.json({ access_token: `app-${issued}`, expires_in: 600 });
        };
        const call = () =>
          ensureAccessToken({
            db,
            session,
            keyring: KEYRING,
            contract: APP_CONTRACT,
            installationId,
            instanceKey: "default",
            config: APP_CONFIG,
            secrets: { clientSecret: "secret-abc" },
            boundFetch,
          });

        expect(await call()).toBe("app-1");
        // Still valid: no second request.
        expect(await call()).toBe("app-1");
        expect(issued).toBe(1);

        // Expire it, and the next call mints again — no refresh token involved.
        await writeOAuthTokens({
          db,
          session,
          keyring: KEYRING,
          installationId,
          tokens: { accessToken: "app-1", expiresAt: Math.floor(Date.now() / 1000) - 10 },
        });
        expect(await call()).toBe("app-2");
        expect(issued).toBe(2);
      });
    },
    TEST_TIMEOUT,
  );

  // A refused grant here is a configuration problem an administrator fixes —
  // there is nobody to re-authorize as, so it must NOT report
  // CONNECTOR_REAUTHORIZATION_REQUIRED.
  test(
    "reports a refused grant as a configuration failure, not as needing authorization",
    async () => {
      await withMigratedDb(async (db) => {
        const tenantId = randomUUID();
        const session = { tenantId, userId: randomUUID(), roles: [] };
        const installationId = await seedInstallation(db, tenantId);

        const error = await ensureAccessToken({
          db,
          session,
          keyring: KEYRING,
          contract: APP_CONTRACT,
          installationId,
          instanceKey: "default",
          config: APP_CONFIG,
          secrets: { clientSecret: "wrong" },
          boundFetch: async () =>
            new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 }),
        }).catch((caught: unknown) => caught);

        expect((error as { code?: string }).code).toBe("CONNECTOR_OAUTH_FAILED");
        expect(String((error as Error).message)).toMatch(/check the client id, secret and scope/);
      });
    },
    TEST_TIMEOUT,
  );
});

describe("token storage and refresh", () => {
  test(
    "cancellation aborts refresh and releases the installation row lock",
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
            refreshToken: "refresh-cancelled",
            expiresAt: Math.floor(Date.now() / 1000) - 10,
          },
        });

        const controller = new AbortController();
        let entered!: () => void;
        const started = new Promise<void>((resolve) => { entered = resolve; });
        const cancelled = ensureAccessToken({
          db,
          session,
          keyring: KEYRING,
          contract: CONTRACT,
          installationId,
          instanceKey: "default",
          config: { clientId: "client-abc" },
          secrets: { clientSecret: "secret-abc" },
          signal: controller.signal,
          boundFetch: async (_url, init) => {
            entered();
            return new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener(
                "abort",
                () => reject(init.signal?.reason),
                { once: true },
              );
            });
          },
        });
        await started;
        controller.abort();
        await expect(cancelled).rejects.toBe(controller.signal.reason);

        const recovered = await ensureAccessToken({
          db,
          session,
          keyring: KEYRING,
          contract: CONTRACT,
          installationId,
          instanceKey: "default",
          config: { clientId: "client-abc" },
          secrets: { clientSecret: "secret-abc" },
          boundFetch: async () => Response.json({
            access_token: "access-recovered",
            refresh_token: "refresh-recovered",
            expires_in: 600,
          }),
        });
        expect(recovered).toBe("access-recovered");
      });
    },
    TEST_TIMEOUT,
  );

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

        const audit = await db.connection().execute(async (conn) => {
          await sql`select set_config('app.tenant_id', ${tenantId}, false)`.execute(conn);
          return sql<{ event_type: string; payload: unknown }>`
            select event_type, payload from platform.entity_events
             where event_type = 'connector.token_refreshed'
          `.execute(conn);
        });
        expect(audit.rows).toHaveLength(1);
        // The durable signal identifies the lifecycle change without becoming
        // a second location where token material can leak.
        expect(JSON.stringify(audit.rows[0]?.payload)).not.toContain("refresh-1");
        expect(JSON.stringify(audit.rows[0]?.payload)).not.toContain("access-2");
      });
    },
    TEST_TIMEOUT,
  );

  // The refresh holds a row lock precisely so a single-use refresh token is
  // never spent twice. Without it, concurrent invocations race and the loser
  // gets invalid_grant — or overwrites the winner's set.
  test(
    "concurrent user- and tenant-scoped invocations rotate once per connection",
    async () => {
      await withMigratedDb(async (db) => {
        for (const scope of ["self", "tenant"] as const) {
          const tenantId = randomUUID();
          const session = {
            tenantId,
            userId: randomUUID(),
            roles: [],
            scope,
          };
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
        }
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
        ).rejects.toThrow(/authorization is required again/);

        const audit = await db.connection().execute(async (conn) => {
          await sql`select set_config('app.tenant_id', ${tenantId}, false)`.execute(conn);
          return sql<{ event_type: string; payload: unknown }>`
            select event_type, payload from platform.entity_events
             where event_type = 'connector.reauthorization_required'
          `.execute(conn);
        });
        expect(audit.rows).toHaveLength(1);
        expect(JSON.stringify(audit.rows[0]?.payload)).not.toContain("spent");
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
        ).rejects.toThrow(/authorization is required again/);
      });
    },
    TEST_TIMEOUT,
  );
});

describe("authored connection token lifecycle", () => {
  test(
    "serializes rotating refreshes and journals user and tenant connection recovery",
    async () => {
      await withMigratedDbAndAdmin(async (db, admin) => {
        await admin.connection().execute(async (conn) => {
          await sql`
            create table public.oauth_authored_connection_test (
              id uuid primary key, tenant_id uuid not null, owner_user_id uuid,
              provider_id uuid not null, values jsonb not null
            )
          `.execute(conn);
          await sql`
            alter table public.oauth_authored_connection_test enable row level security;
            alter table public.oauth_authored_connection_test force row level security;
            create policy oauth_authored_connection_test_row_scope
              on public.oauth_authored_connection_test
              using (
                app.bypass_rls()
                or (
                  tenant_id = app.current_tenant()
                  and (
                    owner_user_id = app.current_user_id()
                    or owner_user_id is null
                  )
                )
              )
              with check (
                app.bypass_rls()
                or (
                  tenant_id = app.current_tenant()
                  and (
                    owner_user_id = app.current_user_id()
                    or owner_user_id is null
                  )
                )
              )
          `.execute(conn);
          await sql`grant select, insert, update on public.oauth_authored_connection_test to ${sql.id(APP_ROLE)}`.execute(conn);
        });
        const table = {
          schema: "public",
          table: "oauth_authored_connection_test",
          primaryKey: "id",
          columns: [
            { name: "values", sourceField: "values" },
            { name: "provider_id", sourceField: "providerId" },
            { name: "owner_user_id", sourceField: "ownerUserId" },
          ],
        } as any;
        for (const scope of ["user", "tenant"] as const) {
          const tenantId = randomUUID();
          const session = { tenantId, userId: randomUUID(), roles: [], scope: "self" as const };
          const actorRowId = randomUUID();
          const foreignId = randomUUID();
          const tenantRowId = randomUUID();
          const foreignUserId = randomUUID();
          const providerId = randomUUID();
          const secretScope = "oauth_authored_connection_test:personal";
          const initial = {
            accessToken: encryptSecret(KEYRING, secretScope, "accessToken", "access-1"),
            refreshToken: encryptSecret(KEYRING, secretScope, "refreshToken", "refresh-1"),
            accessTokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
          };
          await admin.connection().execute(async (conn) => {
            await sql`
              insert into public.oauth_authored_connection_test (id, tenant_id, owner_user_id, provider_id, values)
              values (${actorRowId}::uuid, ${tenantId}::uuid, ${session.userId}::uuid, ${providerId}::uuid, ${JSON.stringify(initial)}::text::jsonb),
                     (${foreignId}::uuid, ${tenantId}::uuid, ${foreignUserId}::uuid, ${providerId}::uuid, ${JSON.stringify(initial)}::text::jsonb),
                     (${tenantRowId}::uuid, ${tenantId}::uuid, null, ${providerId}::uuid, ${JSON.stringify(initial)}::text::jsonb)
            `.execute(conn);
            // The user row starts out double-encoded (what the pre-fix writer
            // left behind); the tenant row starts out as a proper object.
            if (scope === "user") {
              await sql`
                update public.oauth_authored_connection_test
                   set values = to_jsonb(${JSON.stringify(initial)}::text)
                 where id = ${actorRowId}::uuid
              `.execute(conn);
            }
          });
          const seeded = await admin.connection().execute((conn) => sql<{ kind: string }>`
            select jsonb_typeof(values) as kind
              from public.oauth_authored_connection_test
             where id = ${scope === "user" ? actorRowId : tenantRowId}::uuid
          `.execute(conn));
          expect(seeded.rows[0]!.kind).toBe(scope === "user" ? "string" : "object");
          const visible = await withDbSession(db, session, (trx) => sql<{
            id: string;
            owner_user_id: string | null;
          }>`
            select id, owner_user_id
              from public.oauth_authored_connection_test
             where tenant_id = ${tenantId}::uuid
          `.execute(trx));
          expect(new Set(visible.rows.map((row) => row.id))).toEqual(
            new Set([actorRowId, tenantRowId]),
          );
          expect(visible.rows.some((row) => row.id === foreignId)).toBe(false);
          const shaped = visible.rows.map((row) => ({
            id: row.id,
            ownerUserId: row.owner_user_id,
          }));
          const selected = selectOAuthConnectionRow(shaped, scope, session.userId)!;
          expect(selected.id).toBe(scope === "user" ? actorRowId : tenantRowId);
          const selectedId = String(selected.id);
          let exchanges = 0;
          const refresh = () => refreshConnectionRowLocked({
            db, session, table, rowId: selectedId, valuesField: "values",
            providerField: "providerId", expectedProviderId: providerId,
            expectedOwnerUserId: scope === "user" ? session.userId : null,
            refreshLeewaySeconds: 60,
            audit: { sourceTable: "test.providers", connectionId: selectedId, scope, correlationId: `request-${scope}` },
            tokenUrl: "https://auth.provider.example/token", clientId: "client", clientSecret: "secret",
            egress: ["auth.provider.example"], keyring: KEYRING, secretScope,
            fetchImpl: (async () => {
              exchanges += 1;
              return Response.json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 600 });
            }) as unknown as typeof fetch,
          });
          const results = await Promise.all([refresh(), refresh()]);
          expect(exchanges).toBe(1);
          for (const values of results) {
            expect(decryptSecret(KEYRING, secretScope, "accessToken", values.accessToken as any)).toBe("access-2");
          }
          const persisted = await withDbSession(db, session, (conn) => sql<{ values: any; kind: string }>`
            select values, jsonb_typeof(values) as kind
              from public.oauth_authored_connection_test where id = ${selectedId}::uuid
          `.execute(conn));
          // The refreshed row must be a jsonb object: a jsonb *string* (the
          // driver JSON-encoding an already-serialized parameter) hides every
          // field from source selection, which then demands re-authorization.
          expect(persisted.rows[0]!.kind).toBe("object");
          const persistedValues = persisted.rows[0]!.values;
          expect(typeof persistedValues).toBe("object");
          expect(decryptSecret(KEYRING, secretScope, "accessToken", persistedValues.accessToken)).toBe("access-2");
          expect(decryptSecret(KEYRING, secretScope, "refreshToken", persistedValues.refreshToken)).toBe("refresh-2");
          const audit = await withDbSession(db, session, async (conn) => {
            return sql<{ event_type: string; payload: unknown }>`
              select event_type, payload from platform.entity_events
               where aggregate_id = ${selectedId}
                 and event_type = 'connection.token_refreshed'
               order by sequence
            `.execute(conn);
          });
          expect(audit.rows).toHaveLength(1);
          expect(audit.rows[0]?.event_type).toBe("connection.token_refreshed");
          const refreshAuditJson = JSON.stringify(audit.rows[0]?.payload);
          expect(refreshAuditJson).toContain(`request-${scope}`);
          for (const secret of [
            "access-1",
            "access-2",
            "refresh-1",
            "refresh-2",
            "secret",
          ]) {
            expect(refreshAuditJson).not.toContain(secret);
          }
          await withDbSession(db, session, (conn) => sql`
            update public.oauth_authored_connection_test
               set values = ${JSON.stringify(initial)}::jsonb
             where id = ${selectedId}::uuid
          `.execute(conn));
          const beforeFailure = await withDbSession(db, session, (conn) => sql<{ values: unknown }>`
            select values from public.oauth_authored_connection_test where id = ${selectedId}::uuid
          `.execute(conn));
          await expect(refreshConnectionRowLocked({
            db, session, table, rowId: selectedId, valuesField: "values", refreshLeewaySeconds: 60,
            providerField: "providerId", expectedProviderId: providerId,
            expectedOwnerUserId: scope === "user" ? session.userId : null,
            audit: { sourceTable: "test.providers", connectionId: selectedId, scope, correlationId: `reauth-${scope}` },
            tokenUrl: "https://auth.provider.example/token", clientId: "client", clientSecret: "secret",
            egress: ["auth.provider.example"], keyring: KEYRING, secretScope,
            fetchImpl: (async () => new Response("provider body", { status: 400 })) as unknown as typeof fetch,
          })).rejects.toMatchObject({ code: "REAUTHORIZATION_REQUIRED" });
          const reauthAudit = await withDbSession(db, session, async (conn) => {
            return sql<{ event_type: string; payload: unknown }>`
              select event_type, payload from platform.entity_events
               where aggregate_id = ${selectedId} and event_type = 'connection.reauthorization_required'
            `.execute(conn);
          });
          expect(reauthAudit.rows).toHaveLength(1);
          const reauthAuditJson = JSON.stringify(reauthAudit.rows[0]?.payload);
          expect(reauthAuditJson).toContain(`reauth-${scope}`);
          for (const secret of [
            "provider body",
            "access-1",
            "refresh-1",
            "secret",
          ]) {
            expect(reauthAuditJson).not.toContain(secret);
          }
          const afterFailure = await withDbSession(db, session, (conn) => sql<{ values: unknown }>`
            select values from public.oauth_authored_connection_test where id = ${selectedId}::uuid
          `.execute(conn));
          expect(afterFailure.rows[0]?.values).toEqual(beforeFailure.rows[0]?.values);

          const beforeDrift = exchanges;
          const replacementProvider = randomUUID();
          await admin.connection().execute((conn) => sql`
            update public.oauth_authored_connection_test
               set provider_id = ${replacementProvider}::uuid
             where id = ${selectedId}::uuid
          `.execute(conn));
          await expect(refresh()).rejects.toMatchObject({
            status: 404,
            code: "NOT_FOUND",
          });
          expect(exchanges).toBe(beforeDrift);
          await admin.connection().execute((conn) => sql`
            update public.oauth_authored_connection_test
               set provider_id = ${providerId}::uuid,
                   owner_user_id = ${scope === "user" ? foreignUserId : session.userId}::uuid
             where id = ${selectedId}::uuid
          `.execute(conn));
          await expect(refresh()).rejects.toMatchObject({
            status: 404,
            code: "NOT_FOUND",
          });
          expect(exchanges).toBe(beforeDrift);
        }
      });
    },
    TEST_TIMEOUT,
  );
});
