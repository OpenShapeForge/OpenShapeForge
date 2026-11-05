// SPDX-License-Identifier: BUSL-1.1
/**
 * Browser continuation state is encrypted, single-use, and isolated to both
 * the tenant and user at the database layer.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Kysely } from "kysely";
import type { DB } from "../../generated/db/types.js";
import { createDatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import { withDbSession } from "../session.js";
import {
  consumeHandoffForSession,
  createHandoff,
  readHandoff,
  readLatestHandoffForSession,
} from "../../mcp/handoff-store.js";
import { keyringFromEnv } from "../../connectors/secrets.js";
import { mintAuthorization } from "../../mcp/entity-oauth.js";
import { mintConfiguration } from "../../mcp/configuration-handoff.js";
import { readPublicMcpOAuthClient, savePublicMcpOAuthClient } from "../../mcp/native-oauth-client-store.js";
import { preparePublicMcpOAuth } from "../../mcp/native-oauth-setup.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const APP_ROLE = "openshapeforge_app";
const APP_PASSWORD = "openshapeforge_app";
const KEYRING = keyringFromEnv(
  `test:${Buffer.alloc(32, 11).toString("base64")}`,
)!;
const TEST_TIMEOUT = 90_000;

function databaseUrl(name: string, appRole = false): string {
  const url = new URL(ADMIN_URL);
  if (url.pathname === "/openshapeforge_dev") {
    throw new Error("admin URL must not point at openshapeforge_dev");
  }
  if (appRole) {
    url.username = APP_ROLE;
    url.password = APP_PASSWORD;
  }
  url.pathname = `/${name}`;
  return url.toString();
}

async function withDb<T>(
  url: string,
  fn: (db: Kysely<DB>) => Promise<T>,
): Promise<T> {
  const runtime = createDatabaseRuntime({
    databaseUrl: url,
    maxConnections: 2,
  });
  try {
    return await fn(runtime.db);
  } finally {
    await runtime.close();
  }
}

async function withScratchDb<T>(fn: (name: string) => Promise<T>): Promise<T> {
  const name = `mcp_handoff_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
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

describe("MCP browser handoff persistence", () => {
  test("stores public MCP client registration per tenant and provider revision", async () => {
    await withScratchDb(async name => {
      await withDb(databaseUrl(name), db => db.connection().execute(conn => runMigrationChain(conn)));
      await withDb(databaseUrl(name, true), async db => {
        const session = { tenantId: randomUUID(), userId: randomUUID(), roles: [], groups: [], scope: "tenant" as const };
        const binding = { session, providerTable: "integration.adapters", providerId: randomUUID(), providerUpdatedAt: "2026-01-01T00:00:00Z", resource: "https://mcp.example/mcp", redirectUri: "https://app.example/callback" };
        const first = { resource: binding.resource, issuer: "https://auth.example", clientId: "public-1", redirectUri: binding.redirectUri, metadata: { test: true } };
        expect(await savePublicMcpOAuthClient(db, binding, first)).toEqual(first);
        await expect(savePublicMcpOAuthClient(db, binding, { ...first, metadata: { nested: { client_secret: "must-not-be-stored" } } })).rejects.toThrow("invalid");
        expect(await readPublicMcpOAuthClient(db, { ...binding, session: { ...session, tenantId: randomUUID() } })).toBeUndefined();
        expect(await readPublicMcpOAuthClient(db, { ...binding, providerUpdatedAt: "2026-01-02T00:00:00Z" })).toBeUndefined();
        expect(await savePublicMcpOAuthClient(db, binding, { ...first, clientId: "public-racing" })).toEqual(first);
        const concurrent = { ...binding, providerId: randomUUID() };
        const races = await Promise.all([
          savePublicMcpOAuthClient(db, concurrent, { ...first, clientId: "race-1" }),
          savePublicMcpOAuthClient(db, concurrent, { ...first, clientId: "race-2" }),
        ]);
        expect(races[0]?.clientId).toBe(races[1]?.clientId);
        const updated = { ...binding, providerUpdatedAt: "2026-01-02T00:00:00Z" };
        expect(await savePublicMcpOAuthClient(db, updated, { ...first, clientId: "public-2" })).toMatchObject({ clientId: "public-2" });
        expect(await readPublicMcpOAuthClient(db, binding)).toBeUndefined();
        await expect(savePublicMcpOAuthClient(db, binding, first)).rejects.toThrow("changed during setup");
        let registrations = 0;
        const setup = { ...binding, db, providerId: randomUUID(), owner: undefined, clientName: "Kern", auth: {},
          egress: ["mcp.example", "auth.example"],
          fetchMetadata: async ({ url }: { url: string }) => ({ status: 200, contentType: "application/json", body: JSON.stringify(
            url.includes("oauth-protected-resource") ? { resource: binding.resource, authorization_servers: ["https://auth.example"] } :
              { issuer: "https://auth.example", authorization_endpoint: "https://auth.example/authorize", token_endpoint: "https://auth.example/token", registration_endpoint: "https://auth.example/register", token_endpoint_auth_methods_supported: ["none"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"] }
          ) }),
          fetchRegistration: async () => { registrations++; return { status: 201, contentType: "application/json", body: JSON.stringify({ client_id: "auto-public", token_endpoint_auth_method: "none", redirect_uris: [binding.redirectUri] }) }; },
        };
        expect(await preparePublicMcpOAuth(setup)).toMatchObject({ clientId: "auto-public", profile: { resource: binding.resource, issuer: "https://auth.example" } });
        expect(await preparePublicMcpOAuth(setup)).toMatchObject({ clientId: "auto-public" });
        expect(registrations).toBe(1);
      });
    });
  }, TEST_TIMEOUT);
  test("OAuth handoff joins its canonical Operation transaction without replacing identity or authority", async () => {
    await withScratchDb(async name => {
      await withDb(databaseUrl(name), db => db.connection().execute(conn => runMigrationChain(conn)));
      await withDb(databaseUrl(name, true), async db => {
        const session = { tenantId: randomUUID(), userId: randomUUID(), relationId: randomUUID(),
          roles: ["integration_user"], groups: [], scope: "tenant" as const };
        const input = { db, keyring: KEYRING, kind: "entity_oauth" as const,
          tenantId: session.tenantId, userId: session.userId,
          payload: { marker: "canonical-oauth" }, expiresAtMs: Date.now() + 60_000, session };
        const token = await withDbSession(db, session, () => createHandoff(input));
        expect(await readHandoff({ db, keyring: KEYRING, kind: "entity_oauth", token, consume: false }))
          .toEqual(input.payload);
        for (const changed of [{ tenantId: randomUUID() }, { userId: randomUUID() }]) {
          await expect(createHandoff({ ...input, session: { ...session, ...changed } }))
            .rejects.toThrow("Handoff identity must match");
        }
        let rolledBack = "";
        await expect(withDbSession(db, session, async () => {
          rolledBack = await createHandoff(input);
          throw new Error("Abort operation");
        })).rejects.toThrow("Abort operation");
        expect(await readHandoff({ db, keyring: KEYRING, kind: "entity_oauth", token: rolledBack, consume: false }))
          .toBeNull();
      });
    });
  }, TEST_TIMEOUT);

  test(
    "encrypts the payload, isolates it by user, and consumes it exactly once",
    async () => {
      await withScratchDb(async (name) => {
        await withDb(databaseUrl(name), (db) =>
          db.connection().execute((conn) => runMigrationChain(conn)),
        );

        await withDb(databaseUrl(name, true), async (db) => {
          const tenantId = randomUUID();
          const userId = randomUUID();
          const otherUserId = randomUUID();
          const formId = randomUUID();
          const token = await createHandoff({
            id: formId,
            db,
            keyring: KEYRING,
            kind: "entity_configuration",
            tenantId,
            userId,
            payload: { marker: "not-plaintext" },
            expiresAtMs: Date.now() + 60_000,
          });

          const stored = await db.connection().execute(async (conn) => {
            await sql`select set_config('app.tenant_id', ${tenantId}, false)`.execute(
              conn,
            );
            await sql`select set_config('app.user_id', ${userId}, false)`.execute(
              conn,
            );
            return sql<{
              payload_ciphertext: string;
              visible: number;
            }>`
              select payload_ciphertext, count(*) over ()::int as visible
                from platform.mcp_handoffs
            `.execute(conn);
          });
          expect(stored.rows).toHaveLength(1);
          expect(stored.rows[0]?.payload_ciphertext).not.toContain(
            "not-plaintext",
          );

          const otherUserCount = await db.connection().execute(async (conn) => {
            await sql`select set_config('app.tenant_id', ${tenantId}, false)`.execute(
              conn,
            );
            await sql`select set_config('app.user_id', ${otherUserId}, false)`.execute(
              conn,
            );
            return sql<{ count: number }>`
              select count(*)::int as count from platform.mcp_handoffs
            `.execute(conn);
          });
          expect(otherUserCount.rows[0]?.count).toBe(0);

          const session = {
            tenantId,
            userId,
            roles: [],
            groups: [],
            scope: "self" as const,
          };
          const latest = await readLatestHandoffForSession<{
            marker: string;
          }>({
            db,
            keyring: KEYRING,
            kind: "entity_configuration",
            session,
          });
          expect(latest?.payload).toEqual({ marker: "not-plaintext" });
          expect(latest?.id).toBe(formId);
          expect(await readHandoff({db,keyring:KEYRING,kind:"entity_configuration",token:formId,consume:false})).toBeNull();
          expect(
            await readLatestHandoffForSession({
              db,
              keyring: KEYRING,
              kind: "entity_configuration",
              session: { ...session, userId: otherUserId },
            }),
          ).toBeNull();
          expect(
            await consumeHandoffForSession({
              db,
              kind: "entity_configuration",
              id: latest?.id,
              session,
            }),
          ).toBe(true);
          expect(
            await consumeHandoffForSession({
              db,
              kind: "entity_configuration",
              id: latest?.id,
              session,
            }),
          ).toBe(false);
          expect(
            await readHandoff({
              db,
              keyring: KEYRING,
              kind: "entity_configuration",
              token,
              consume: true,
            }),
          ).toBeNull();
        });
      });
    },
    TEST_TIMEOUT,
  );
});
