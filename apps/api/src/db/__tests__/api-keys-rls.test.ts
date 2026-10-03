// SPDX-License-Identifier: BUSL-1.1
/**
 * `platform.api_keys` and `platform.system_bypass_audit` under the restricted
 * app role, against a migrated scratch database: the tenant fence on key
 * rows, the authentication read that runs before a tenant is known, the
 * append-only audit trail, and the provisioning ceiling on an issued key.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Kysely } from "kysely";
import type { DB } from "../../generated/db/types.js";
import { API_KEY_MANAGE_ROLE } from "../../auth/api-key/ceiling.js";
import { mintApiKey, parseApiKey } from "../../auth/api-key/format.js";
import { issueKey, type ApiKeyServiceDeps } from "../../auth/api-key/service.js";
import { recordApiKeyUse, resolveApiKey } from "../../auth/api-key/store.js";
import { createDatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import { APP_ROLE } from "../migrations/app-role.js";
import { withCredentialResolutionSession, withDbSession } from "../session.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const APP_ROLE_PASSWORD = "openshapeforge_app";
const TEST_TIMEOUT = 120_000;

function databaseUrl(name: string, app = false): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  if (app) {
    url.username = APP_ROLE;
    url.password = APP_ROLE_PASSWORD;
  }
  return url.toString();
}

async function withDb<T>(url: string, fn: (db: Kysely<DB>) => Promise<T>) {
  const runtime = createDatabaseRuntime({ databaseUrl: url, maxConnections: 4 });
  try {
    return await fn(runtime.db);
  } finally {
    await runtime.close();
  }
}

async function withScratchDb<T>(fn: (appDb: Kysely<DB>, adminDb: Kysely<DB>) => Promise<T>) {
  const name = `api_keys_rls_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const server = new SQL(ADMIN_URL, { max: 1 });
  try {
    await server.unsafe(`create database "${name}"`);
    try {
      return await withDb(databaseUrl(name), async (adminDb) => {
        await adminDb.connection().execute((trx) => runMigrationChain(trx));
        return withDb(databaseUrl(name, true), (appDb) => fn(appDb, adminDb));
      });
    } finally {
      await server.unsafe(`drop database if exists "${name}" with (force)`);
    }
  } finally {
    await server.close();
  }
}

const tenantA = randomUUID();
const tenantB = randomUUID();
const USER = randomUUID();

async function seed(adminDb: Kysely<DB>) {
  await sql`
    insert into platform.tenants (id, slug, name, status, keycloak_realm)
    values (${tenantA}, 'tenant-a', 'Tenant A', 'active', 'openshapeforge'),
           (${tenantB}, 'tenant-b', 'Tenant B', 'active', 'openshapeforge')
  `.execute(adminDb);
}

/** An active integration with one key, written as the owner: the state provisioning left behind. */
async function integrationWithKey(adminDb: Kysely<DB>, tenantId: string, grantedRoles: string[]) {
  const integrationId = randomUUID();
  const keyId = randomUUID();
  const minted = mintApiKey();
  await sql`
    insert into platform.api_key_integrations
      (id, tenant_id, display_name, keycloak_client_id, status, granted_roles,
       client_secret_ciphertext, client_secret_key_id, client_secret_algorithm, created_by)
    values
      (${integrationId}, ${tenantId}, 'integration', ${`osf-int-${integrationId}`}, 'active',
       cast(${grantedRoles} as jsonb), 'ciphertext', 'k1', 'aes-256-gcm', ${USER})
  `.execute(adminDb);
  await sql`
    insert into platform.api_keys
      (id, tenant_id, integration_id, lookup_id, secret_hash, display_name, created_by)
    values
      (${keyId}, ${tenantId}, ${integrationId}, ${minted.lookupId}, ${minted.secretHash}, 'key', ${USER})
  `.execute(adminDb);
  return { integrationId, keyId, token: minted.token, lookupId: minted.lookupId };
}

function session(tenantId: string, roles: string[]) {
  return { tenantId, userId: USER, roles, groups: [], scope: "tenant" as const, credential: "bearer" as const };
}

describe("platform.api_keys under the app role", () => {
  test(
    "key rows are invisible across tenants, while authentication still resolves a presented key",
    async () => {
      await withScratchDb(async (appDb, adminDb) => {
        await seed(adminDb);
        const a = await integrationWithKey(adminDb, tenantA, ["Relations.All.Read"]);
        const b = await integrationWithKey(adminDb, tenantB, ["Relations.All.Read"]);

        const lookupIdsSeenFrom = (tenantId: string) =>
          withDbSession(appDb, session(tenantId, []), async (trx) =>
            (await sql<{ lookup_id: string }>`select lookup_id from platform.api_keys order by 1`.execute(trx))
              .rows.map((row) => row.lookup_id),
          );
        expect(await lookupIdsSeenFrom(tenantA)).toEqual([a.lookupId]);
        expect(await lookupIdsSeenFrom(tenantB)).toEqual([b.lookupId]);

        // A tenant session cannot reach another tenant's row by its lookup id
        // either — the column authentication searches on.
        expect(
          await withCredentialResolutionSession(appDb, tenantA, async (trx) =>
            (await sql<{ n: string }>`
              select count(*)::text as n from platform.api_keys where lookup_id = ${b.lookupId}
            `.execute(trx)).rows[0]!.n,
          ),
        ).toBe("0");
        // Nor without any session at all: no tenant, no rows.
        expect(
          (await sql<{ n: string }>`select count(*)::text as n from platform.api_keys`.execute(appDb))
            .rows[0]!.n,
        ).toBe("0");

        // Authentication, which starts with no tenant, still finds the key:
        // the point lookup answers the tenant, the rest runs fenced to it.
        const parsedA = parseApiKey(a.token)!;
        const resolvedA = await resolveApiKey(appDb, parsedA.lookupId, parsedA.secret);
        expect(resolvedA).toMatchObject({ ok: true, key: { keyId: a.keyId, tenantId: tenantA } });
        const parsedB = parseApiKey(b.token)!;
        expect(await resolveApiKey(appDb, parsedB.lookupId, parsedB.secret)).toMatchObject({
          ok: true,
          key: { keyId: b.keyId, tenantId: tenantB },
        });
        expect(await resolveApiKey(appDb, parsedA.lookupId, "wrong-secret")).toEqual({
          ok: false,
          reason: "bad-secret",
        });
        expect(await resolveApiKey(appDb, "no-such-lookup", parsedA.secret)).toEqual({
          ok: false,
          reason: "unknown",
        });

        await recordApiKeyUse(appDb, { keyId: a.keyId, tenantId: tenantA });
        const used = (
          await sql<{ last_used_at: Date | null }>`
            select last_used_at from platform.api_keys where id = ${a.keyId}
          `.execute(adminDb)
        ).rows[0]!;
        expect(used.last_used_at).not.toBeNull();
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "issueKey checks the ceiling against what the key will hold, and refuses an empty subset",
    async () => {
      await withScratchDb(async (appDb, adminDb) => {
        await seed(adminDb);
        const a = await integrationWithKey(adminDb, tenantA, ["Relations.All.ReadWrite", "Relations.All.Read"]);
        const deps = {
          db: appDb,
          keyring: undefined,
          admin: undefined,
          entityRoleClientId: "erp-provider",
        } as unknown as ApiKeyServiceDeps;
        // The caller holds LESS than the integration does. An unrestricted
        // key would carry Relations.All.ReadWrite, which the caller cannot
        // grant — so the ceiling refuses it, where before only the (absent)
        // subset was checked.
        const reader = session(tenantA, [API_KEY_MANAGE_ROLE, "Relations.All.Read"]);
        await expect(
          issueKey(deps, reader, { integrationId: a.integrationId, displayName: "rotated" }),
        ).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("Relations.All.ReadWrite") });
        // A subset within the caller's own roles is fine.
        const narrowed = await issueKey(deps, reader, {
          integrationId: a.integrationId,
          displayName: "narrowed",
          roleSubset: ["Relations.All.Read"],
        });
        expect(narrowed.integrationId).toBe(a.integrationId);
        // An explicit empty subset is neither a narrowing nor an absence: the
        // store would read it back as unrestricted. Refused as input.
        await expect(
          issueKey(deps, reader, { integrationId: a.integrationId, displayName: "empty", roleSubset: [] }),
        ).rejects.toMatchObject({ code: "VALIDATION" });
        // Somebody who holds everything the integration holds may mint an
        // unrestricted key.
        const full = session(tenantA, [API_KEY_MANAGE_ROLE, "Relations.All.ReadWrite", "Relations.All.Read"]);
        await expect(
          issueKey(deps, full, { integrationId: a.integrationId, displayName: "full" }),
        ).resolves.toMatchObject({ integrationId: a.integrationId });
        // And nobody may issue against another tenant's integration.
        await expect(
          issueKey(deps, session(tenantB, [API_KEY_MANAGE_ROLE, "Relations.All.ReadWrite", "Relations.All.Read"]), {
            integrationId: a.integrationId,
            displayName: "cross",
          }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
      });
    },
    TEST_TIMEOUT,
  );
});

describe("platform.system_bypass_audit under the app role", () => {
  test(
    "append-only: a tenant session neither reads nor deletes the trail",
    async () => {
      await withScratchDb(async (appDb, adminDb) => {
        await seed(adminDb);
        const marker = `test-${randomUUID()}`;
        // Appending needs no session: the failure row in db/session.ts is
        // written after the transaction that failed.
        await sql`
          insert into platform.system_bypass_audit (actor_subject, reason, started_at)
          values (${marker}, 'test', now())
        `.execute(appDb);
        expect(
          (await sql<{ n: string }>`
            select count(*)::text as n from platform.system_bypass_audit where actor_subject = ${marker}
          `.execute(adminDb)).rows[0]!.n,
        ).toBe("1");

        // Reading it back takes the bypass session; a tenant session sees nothing.
        expect(
          await withDbSession(appDb, session(tenantA, []), async (trx) =>
            (await sql<{ n: string }>`
              select count(*)::text as n from platform.system_bypass_audit
            `.execute(trx)).rows[0]!.n,
          ),
        ).toBe("0");
        // Deleting is not a privilege the runtime role holds at all.
        await expect(
          sql`delete from platform.system_bypass_audit where actor_subject = ${marker}`.execute(appDb),
        ).rejects.toMatchObject({ errno: "42501" });
        expect(
          (await sql<{ n: string }>`
            select count(*)::text as n from platform.system_bypass_audit where actor_subject = ${marker}
          `.execute(adminDb)).rows[0]!.n,
        ).toBe("1");
      });
    },
    TEST_TIMEOUT,
  );
});
