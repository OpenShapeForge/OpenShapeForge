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
import {
  consumeHandoffForSession,
  createHandoff,
  readHandoff,
  readLatestHandoffForSession,
} from "../../mcp/handoff-store.js";
import { keyringFromEnv } from "../../connectors/secrets.js";
import { withDbSession } from "../session.js";
import { mintAuthorization } from "../../mcp/entity-oauth.js";
import { mintConfiguration } from "../../mcp/configuration-handoff.js";

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
  test("canonical OAuth and configuration handoffs retain the live session and transaction", async () => {
    const previous = process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS;
    process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS = `test:${Buffer.alloc(32, 11).toString("base64")}`;
    try {
      await withScratchDb(async (name) => {
        await withDb(databaseUrl(name), db => db.connection().execute(conn => runMigrationChain(conn)));
        await withDb(databaseUrl(name, true), async (db) => {
          const session = {
            tenantId: randomUUID(), userId: randomUUID(), relationId: randomUUID(),
            roles: ["integration_admin", "Finance.All.ReadWrite"], groups: [randomUUID()],
            relationGroupIds: [randomUUID()], scope: "tenant" as const,
          };
          const context = (trx: Kysely<DB>) => sql`
            select current_setting('app.roles') as roles, current_setting('app.scope') as scope,
              current_setting('app.relation_id') as relation, current_setting('app.user_groups_exact') as groups,
              current_setting('app.relation_group_ids') as relation_groups
          `.execute(trx).then(result => result.rows[0]);
          const tokens = await withDbSession(db, session, async (trx) => {
            const before = await context(trx);
            const oauth = await mintAuthorization({
              db, session, tenantId: session.tenantId, userId: session.userId,
              connectionScope: "tenant", providerTable: "erp.providers", providerRowId: randomUUID(),
              connectionTable: "erp.connections", connectionProviderRef: "providerId", connectionValuesField: "values",
              tokenUrl: "https://auth.example.test/token", authorizationUrl: "https://auth.example.test/authorize",
              clientId: "test-client", clientSecret: "synthetic-secret", egress: ["auth.example.test"], scopes: [],
              redirectUri: "https://host.example.test/api/entity-oauth/callback", providerName: "Example",
            });
            const configuration = await mintConfiguration({
              db, session, tenantId: session.tenantId, userId: session.userId, table: "erp.connections",
              elicit: { sourceField: "providerId", sourceEntity: "Provider", sourceTable: "erp.providers", definitionsField: "fields", into: "values" },
              modelValues: {}, definitions: [], displayName: "Example",
            });
            const artifact = await createHandoff({
              db, session, keyring: KEYRING, kind: "artifact_upload", tenantId: session.tenantId,
              userId: session.userId, payload: { marker: "artifact" }, expiresAtMs: Date.now() + 60_000,
            });
            expect(await context(trx)).toEqual(before);
            expect((before as {roles:string}).roles.split(",")).toContain("integration_admin");
            expect((await sql<{count:number}>`select count(*)::int as count from platform.mcp_handoffs`.execute(trx)).rows[0]?.count).toBe(3);
            await expect(createHandoff({
              db, session: { ...session, roles: ["different-authority"] }, keyring: KEYRING, kind: "entity_oauth",
              tenantId: session.tenantId, userId: session.userId, payload: {}, expiresAtMs: Date.now() + 60_000,
            })).rejects.toThrow("Nested database work cannot replace the active session.");
            // A caught SQL insert error must not poison the owning transaction.
            await expect(createHandoff({
              id: "not-a-uuid", db, session, keyring: KEYRING, kind: "entity_oauth",
              tenantId: session.tenantId, userId: session.userId, payload: {}, expiresAtMs: Date.now() + 60_000,
            })).rejects.toThrow();
            expect(await context(trx)).toEqual(before);
            expect((await sql<{count:number}>`select count(*)::int as count from platform.mcp_handoffs`.execute(trx)).rows[0]?.count).toBe(3);
            return { oauth: oauth.state, configuration: configuration.token, artifact };
          });
          for (const [kind, token] of [["entity_oauth", tokens.oauth], ["entity_configuration", tokens.configuration], ["artifact_upload", tokens.artifact]] as const) {
            const payload = await readHandoff({ db, keyring: KEYRING, kind, token, consume: false });
            expect(payload).not.toBeNull();
            expect(payload).not.toHaveProperty("session");
          }
          for (const changedOwner of [{ userId: randomUUID() }, { tenantId: randomUUID() }]) {
            await expect(createHandoff({
              db, session: { ...session, ...changedOwner }, keyring: KEYRING, kind: "entity_oauth",
              tenantId: session.tenantId, userId: session.userId, payload: {}, expiresAtMs: Date.now() + 60_000,
            })).rejects.toThrow("The handoff owner must match its database session.");
          }
          const rolledBackId = randomUUID();
          await expect(withDbSession(db, session, async () => {
            await createHandoff({
              id: rolledBackId, db, session, keyring: KEYRING, kind: "entity_oauth",
              tenantId: session.tenantId, userId: session.userId, payload: {}, expiresAtMs: Date.now() + 60_000,
            });
            throw new Error("Abort the owning Operation");
          })).rejects.toThrow("Abort the owning Operation");
          expect(await readLatestHandoffForSession({ db, keyring: KEYRING, kind: "entity_oauth", session, id: rolledBackId })).toBeNull();
        });
      });
    } finally {
      if (previous === undefined) delete process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS;
      else process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS = previous;
    }
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
          const token = await createHandoff({
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
