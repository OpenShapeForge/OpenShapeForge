// SPDX-License-Identifier: BUSL-1.1
/**
 * The integration catalog against a real PostgreSQL, under the restricted app
 * role, in a scratch database this file creates and drops.
 *
 * Everything here is a property of the DATABASE rather than of the handlers,
 * and so cannot be shown with a fake connection:
 *
 *   - a keyset page walks the whole set, one row at a time, past the hundredth
 *     page, with no row skipped and none repeated;
 *   - rows that tie on the sort field still page in one definite order,
 *     because the order ends in the row id;
 *   - NULLs ("no expiry", "never used") sort last in both directions;
 *   - rows inserted or disabled DURING the walk cannot shift the pages
 *     already handed out, which is what an offset silently does;
 *   - the tenant fence is the policy, not the predicate: another tenant's
 *     rows are invisible to the app role even when its id is asked for;
 *   - the integration row lock serializes issue against disable, so neither
 *     interleaving leaves a live credential under a disabled parent.
 *
 * The concurrency test uses a real lock and a real wait: a second connection
 * holds the integration row and the blocked statement is observed WAITING in
 * `pg_stat_activity` before the holder commits. No sleeps, and no dependence
 * on timing.
 */
import { describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Kysely } from "kysely";
import { API_KEY_MANAGE_ROLE } from "../auth/api-key/ceiling.js";
import { mintApiKey } from "../auth/api-key/format.js";
import {
  ApiKeyNotFoundError,
  createIntegration,
  disableIntegration,
  issueKey,
  pageIntegrations,
  pageKeys,
  type ApiKeyServiceDeps,
  type CredentialSortField,
  type IntegrationSortField,
  type ProvisioningSession,
} from "../auth/api-key/service.js";
import { UNDECLARED_CREDENTIAL_LIFETIME_POLICY } from "../auth/api-key/lifetime.js";
import { readApiKeyProvisioningConfig } from "../auth/api-key/runtime-config.js";
import { stubRealm, type StubRealm } from "../auth/api-key/__tests__/fixtures.js";
import { createDatabaseRuntime } from "../db/connection.js";
import { runMigrationChain } from "../db/migration-chain.js";
import { APP_ROLE } from "../db/migrations/app-role.js";
import type { DB } from "../generated/db/types.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const APP_ROLE_PASSWORD = "openshapeforge_app";
const TEST_TIMEOUT = 180_000;

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const USER = randomUUID();
const READ_ROLE = "Relations.All.Read";

function databaseUrl(name: string, app = false): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  if (app) {
    url.username = APP_ROLE;
    url.password = APP_ROLE_PASSWORD;
  }
  return url.toString();
}

type Scratch = {
  appDb: Kysely<DB>;
  adminDb: Kysely<DB>;
  /** A second connection as the app role, for holding a lock. */
  rival: SQL;
  databaseName: string;
};

async function withScratchDb<T>(work: (scratch: Scratch) => Promise<T>): Promise<T> {
  const name = `api_key_catalog_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const server = new SQL(ADMIN_URL, { max: 1 });
  try {
    await server.unsafe(`create database "${name}"`);
    const admin = createDatabaseRuntime({ databaseUrl: databaseUrl(name), maxConnections: 4 });
    try {
      await admin.db.connection().execute((trx) => runMigrationChain(trx));
      const app = createDatabaseRuntime({ databaseUrl: databaseUrl(name, true), maxConnections: 8 });
      const rival = new SQL(databaseUrl(name, true), { max: 2 });
      try {
        return await work({ appDb: app.db, adminDb: admin.db, rival, databaseName: name });
      } finally {
        await rival.close();
        await app.close();
      }
    } finally {
      await admin.close();
      await server.unsafe(`drop database if exists "${name}" with (force)`);
    }
  } finally {
    await server.close();
  }
}

async function seedTenants(adminDb: Kysely<DB>) {
  await sql`
    insert into platform.tenants (id, slug, name, status, keycloak_realm)
    values (${TENANT_A}, 'tenant-a', 'Tenant A', 'active', 'openshapeforge'),
           (${TENANT_B}, 'tenant-b', 'Tenant B', 'active', 'openshapeforge')
  `.execute(adminDb);
}

/** The state provisioning leaves behind, written as the owner. */
async function seedIntegration(adminDb: Kysely<DB>, input: {
  tenantId: string;
  displayName: string;
  status?: string;
  createdAt?: Date;
  grantedRoles?: string[];
}): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into platform.api_key_integrations
      (id, tenant_id, display_name, keycloak_client_id, status, granted_roles,
       client_secret_ciphertext, client_secret_key_id, client_secret_algorithm,
       created_by, created_at, updated_at)
    values
      (${id}, ${input.tenantId}, ${input.displayName}, ${`osf-int-${id}`},
       ${input.status ?? "active"}, cast(${input.grantedRoles ?? [READ_ROLE]} as jsonb),
       'ciphertext', 'k1', 'aes-256-gcm', ${USER},
       ${input.createdAt ?? new Date()}, ${input.createdAt ?? new Date()})
  `.execute(adminDb);
  return id;
}

async function seedKey(adminDb: Kysely<DB>, input: {
  tenantId: string;
  integrationId: string;
  displayName: string;
  createdAt?: Date;
  expiresAt?: Date | null;
  revokedAt?: Date | null;
  lastUsedAt?: Date | null;
}): Promise<string> {
  const id = randomUUID();
  const minted = mintApiKey();
  await sql`
    insert into platform.api_keys
      (id, tenant_id, integration_id, lookup_id, secret_hash, display_name,
       created_by, created_at, expires_at, revoked_at, last_used_at)
    values
      (${id}, ${input.tenantId}, ${input.integrationId}, ${minted.lookupId},
       ${minted.secretHash}, ${input.displayName}, ${USER},
       ${input.createdAt ?? new Date()}, ${input.expiresAt ?? null},
       ${input.revokedAt ?? null}, ${input.lastUsedAt ?? null})
  `.execute(adminDb);
  return id;
}

/** A verified human administrator of one tenant. */
function manager(tenantId: string, roles: string[] = [READ_ROLE]): ProvisioningSession {
  return {
    tenantId,
    userId: USER,
    roles: [API_KEY_MANAGE_ROLE, ...roles],
    groups: [],
    credential: "bearer",
    principalKind: "person",
  };
}

function serviceDeps(appDb: Kysely<DB>): ApiKeyServiceDeps {
  // Only the database half is reached by the paths under test: issuing and
  // disabling touch neither the keyring nor the realm.
  return {
    db: appDb as never,
    keyring: undefined as never,
    admin: undefined as never,
    entityRoleClientId: "erp-provider",
    lifetime: UNDECLARED_CREDENTIAL_LIFETIME_POLICY,
  };
}

/**
 * Walk a listing to its end, one page at a time.
 *
 * Deliberately `first: 1`: it maximises the number of cursor round trips, so
 * an off-by-one in the resume predicate shows up as a skipped or repeated row
 * rather than hiding inside a wide page.
 */
async function walkIntegrations(
  appDb: Kysely<DB>,
  session: ProvisioningSession,
  query: { sortField: IntegrationSortField; sortDirection: "asc" | "desc"; first?: number },
  mutate?: (page: number) => Promise<void>,
): Promise<{ ids: string[]; pages: number; totals: number[] }> {
  const ids: string[] = [];
  const totals: number[] = [];
  let after: { id: string } | undefined;
  let pages = 0;
  for (;;) {
    const page = await pageIntegrations(serviceDeps(appDb), session, {
      ...query, first: query.first ?? 1, ...(after ? { after } : {}),
    });
    pages += 1;
    totals.push(page.totalCount);
    for (const row of page.rows) ids.push(row.id);
    if (mutate) await mutate(pages);
    if (!page.nextCursor) break;
    after = page.nextCursor;
    if (pages > 400) throw new Error("Paging did not terminate.");
  }
  return { ids, pages, totals };
}

async function walkCredentials(
  appDb: Kysely<DB>,
  session: ProvisioningSession,
  integrationId: string,
  query: { sortField: CredentialSortField; sortDirection: "asc" | "desc"; first?: number },
): Promise<string[]> {
  const ids: string[] = [];
  let after: { id: string } | undefined;
  for (;;) {
    const page = await pageKeys(serviceDeps(appDb), session, { integrationId }, {
      ...query, first: query.first ?? 1, ...(after ? { after } : {}),
    });
    for (const row of page.rows) ids.push(row.id);
    if (!page.nextCursor) break;
    after = page.nextCursor;
    if (ids.length > 400) throw new Error("Paging did not terminate.");
  }
  return ids;
}

describe("integration catalog paging against PostgreSQL", () => {
  test("walks past the hundredth page without skipping or repeating a row", async () => {
    await withScratchDb(async ({ appDb, adminDb }) => {
      await seedTenants(adminDb);
      // 120 integrations of this tenant, plus one of another tenant that must
      // never appear. Half of them share a `created_at` to the microsecond so
      // the tie-break is exercised on more than one page.
      const shared = new Date("2026-05-05T05:05:05.000Z");
      const mine: string[] = [];
      for (let index = 0; index < 120; index += 1) {
        mine.push(await seedIntegration(adminDb, {
          tenantId: TENANT_A,
          displayName: `integration ${String(index).padStart(3, "0")}`,
          createdAt: index % 2 === 0 ? shared : new Date(Date.UTC(2026, 0, 1 + index)),
        }));
      }
      const theirs = await seedIntegration(adminDb, {
        tenantId: TENANT_B, displayName: "another tenant",
      });

      const walk = await walkIntegrations(appDb, manager(TENANT_A),
        { sortField: "createdAt", sortDirection: "asc" });
      // One page per row plus the final empty-cursor page: well past 100.
      expect(walk.pages).toBeGreaterThan(100);
      expect(walk.ids).toHaveLength(120);
      expect(new Set(walk.ids).size).toBe(120);
      expect([...walk.ids].sort()).toEqual([...mine].sort());
      expect(walk.ids).not.toContain(theirs);
      // Every page reported the same total, from a count over the same fence.
      expect(new Set(walk.totals)).toEqual(new Set([120]));
    }, );
  }, TEST_TIMEOUT);

  test("orders ties deterministically and the same way in both directions", async () => {
    await withScratchDb(async ({ appDb, adminDb }) => {
      await seedTenants(adminDb);
      const tie = new Date("2026-07-07T07:07:07.000Z");
      for (let index = 0; index < 8; index += 1) {
        await seedIntegration(adminDb, {
          tenantId: TENANT_A, displayName: `tied ${index}`, createdAt: tie,
        });
      }
      const session = manager(TENANT_A);
      const ascending = await walkIntegrations(appDb, session,
        { sortField: "createdAt", sortDirection: "asc" });
      const wide = await walkIntegrations(appDb, session,
        { sortField: "createdAt", sortDirection: "asc", first: 100 });
      // A page size of one and a page size of a hundred must produce the same
      // sequence: if they differ, the keyset and the ORDER BY disagree.
      expect(ascending.ids).toEqual(wide.ids);
      // Within one tied block the tie-break is the row id, ascending, and it
      // does NOT flip with the sort direction.
      expect(ascending.ids).toEqual([...ascending.ids].sort());
      const descending = await walkIntegrations(appDb, session,
        { sortField: "createdAt", sortDirection: "desc" });
      expect(descending.ids).toEqual(ascending.ids);
    });
  }, TEST_TIMEOUT);

  test("sorts absent values last in both directions", async () => {
    await withScratchDb(async ({ appDb, adminDb }) => {
      await seedTenants(adminDb);
      const integrationId = await seedIntegration(adminDb, {
        tenantId: TENANT_A, displayName: "parent",
      });
      const used = await seedKey(adminDb, {
        tenantId: TENANT_A, integrationId, displayName: "used",
        lastUsedAt: new Date("2026-02-02T00:00:00.000Z"),
      });
      const usedLater = await seedKey(adminDb, {
        tenantId: TENANT_A, integrationId, displayName: "used later",
        lastUsedAt: new Date("2026-03-03T00:00:00.000Z"),
      });
      const never = await seedKey(adminDb, {
        tenantId: TENANT_A, integrationId, displayName: "never used",
      });

      const session = manager(TENANT_A);
      // "Never used" is the ABSENCE of a last use, not the earliest one, so it
      // comes last ascending AND last descending.
      expect(await walkCredentials(appDb, session, integrationId,
        { sortField: "lastUsedAt", sortDirection: "asc" }))
        .toEqual([used, usedLater, never]);
      expect(await walkCredentials(appDb, session, integrationId,
        { sortField: "lastUsedAt", sortDirection: "desc" }))
        .toEqual([usedLater, used, never]);
    });
  }, TEST_TIMEOUT);

  test("pages the derived credential status from the database, not after the cut", async () => {
    await withScratchDb(async ({ appDb, adminDb }) => {
      await seedTenants(adminDb);
      const integrationId = await seedIntegration(adminDb, {
        tenantId: TENANT_A, displayName: "parent",
      });
      const live = await seedKey(adminDb, {
        tenantId: TENANT_A, integrationId, displayName: "live",
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      });
      await seedKey(adminDb, {
        tenantId: TENANT_A, integrationId, displayName: "lapsed",
        expiresAt: new Date("2020-01-01T00:00:00.000Z"),
      });
      await seedKey(adminDb, {
        tenantId: TENANT_A, integrationId, displayName: "retired",
        revokedAt: new Date("2025-01-01T00:00:00.000Z"),
      });

      const session = manager(TENANT_A);
      // A filtered page is a page of matching rows, not a page cut and then
      // filtered: asking for one active credential returns the active one.
      const page = await pageKeys(serviceDeps(appDb), session, { integrationId }, {
        sortField: "createdAt", sortDirection: "asc", first: 1, status: "active",
      });
      expect(page.rows.map((row) => row.id)).toEqual([live]);
      expect(page.totalCount).toBe(1);
      expect(page.nextCursor).toBeNull();

      for (const [status, expected] of [["expired", "lapsed"], ["revoked", "retired"]] as const) {
        const filtered = await pageKeys(serviceDeps(appDb), session, { integrationId }, {
          sortField: "createdAt", sortDirection: "asc", first: 10, status,
        });
        expect(filtered.rows.map((row) => row.displayName)).toEqual([expected]);
      }

      // A name filter is a CONTAINS, case-insensitively, and never a pattern:
      // the underscore is a literal, not a single-character wildcard.
      await seedKey(adminDb, { tenantId: TENANT_A, integrationId, displayName: "a_b" });
      const literal = await pageKeys(serviceDeps(appDb), session, { integrationId }, {
        sortField: "createdAt", sortDirection: "asc", first: 10, displayName: "A_B",
      });
      expect(literal.rows.map((row) => row.displayName)).toEqual(["a_b"]);
      const noWildcard = await pageKeys(serviceDeps(appDb), session, { integrationId }, {
        sortField: "createdAt", sortDirection: "asc", first: 10, displayName: "%",
      });
      expect(noWildcard.rows).toEqual([]);
    });
  }, TEST_TIMEOUT);

  test("a row written during the walk cannot shift the pages already handed out", async () => {
    await withScratchDb(async ({ appDb, adminDb }) => {
      await seedTenants(adminDb);
      const original: string[] = [];
      for (let index = 0; index < 6; index += 1) {
        original.push(await seedIntegration(adminDb, {
          tenantId: TENANT_A,
          displayName: `row ${index}`,
          createdAt: new Date(Date.UTC(2026, 0, 10 + index)),
        }));
      }
      // Insert a row that sorts BEFORE the cursor after the first page. With an
      // offset this shifts everything and repeats a row; with a keyset it
      // cannot be seen at all, because the walk has moved past that value.
      const walk = await walkIntegrations(appDb, manager(TENANT_A),
        { sortField: "createdAt", sortDirection: "asc" },
        async (page) => {
          if (page !== 1) return;
          await seedIntegration(adminDb, {
            tenantId: TENANT_A, displayName: "inserted behind",
            createdAt: new Date(Date.UTC(2026, 0, 1)),
          });
        });
      expect(walk.ids).toEqual(original);
      expect(new Set(walk.ids).size).toBe(walk.ids.length);
      // The count is read per page, so it does reflect the insert — reporting
      // a stale total would be the dishonest option.
      expect(walk.totals[0]).toBe(6);
      expect(walk.totals.at(-1)).toBe(7);
    });
  }, TEST_TIMEOUT);

  test("an integration disabled during the walk is reported as it then stands", async () => {
    await withScratchDb(async ({ appDb, adminDb }) => {
      await seedTenants(adminDb);
      const ids: string[] = [];
      for (let index = 0; index < 4; index += 1) {
        ids.push(await seedIntegration(adminDb, {
          tenantId: TENANT_A,
          displayName: `row ${index}`,
          createdAt: new Date(Date.UTC(2026, 0, 10 + index)),
        }));
      }
      const session = manager(TENANT_A);
      const seen: string[] = [];
      let after: { id: string } | undefined;
      for (;;) {
        const page = await pageIntegrations(serviceDeps(appDb), session, {
          sortField: "createdAt", sortDirection: "asc", first: 1, ...(after ? { after } : {}),
        });
        for (const row of page.rows) seen.push(`${row.displayName}:${row.status}`);
        // Disable the row the NEXT page will return, before reading it.
        if (seen.length === 1) {
          await disableIntegration(serviceDeps(appDb), session, ids[1]!);
        }
        if (!page.nextCursor) break;
        after = page.nextCursor;
      }
      expect(seen).toEqual([
        "row 0:active", "row 1:disabled", "row 2:active", "row 3:active",
      ]);
    });
  }, TEST_TIMEOUT);

  test("another tenant's rows are invisible, by policy and not only by predicate", async () => {
    await withScratchDb(async ({ appDb, adminDb }) => {
      await seedTenants(adminDb);
      const mine = await seedIntegration(adminDb, { tenantId: TENANT_A, displayName: "mine" });
      const theirs = await seedIntegration(adminDb, { tenantId: TENANT_B, displayName: "theirs" });
      await seedKey(adminDb, { tenantId: TENANT_B, integrationId: theirs, displayName: "their key" });

      const page = await pageIntegrations(serviceDeps(appDb), manager(TENANT_A), {
        sortField: "displayName", sortDirection: "asc", first: 10,
      });
      expect(page.rows.map((row) => row.id)).toEqual([mine]);
      expect(page.totalCount).toBe(1);

      // Naming the other tenant's integration explicitly yields an empty page,
      // not its credentials: the parent predicate and the row policy agree.
      const credentials = await pageKeys(serviceDeps(appDb), manager(TENANT_A),
        { integrationId: theirs }, { sortField: "createdAt", sortDirection: "asc", first: 10 });
      expect(credentials.rows).toEqual([]);
      expect(credentials.totalCount).toBe(0);
    });
  }, TEST_TIMEOUT);
});

/**
 * Observe a statement of this database WAITING on a lock.
 *
 * This is the barrier the concurrency tests turn on: it polls a real
 * condition — a backend in this database blocked on a lock — rather than
 * waiting a guessed interval, so they neither race nor sleep.
 */
async function waitForBlockedBackend(rival: SQL, databaseName: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const rows = await rival.unsafe(
      `select count(*)::int as waiting
         from pg_stat_activity
        where datname = $1 and wait_event_type = 'Lock' and state = 'active'`,
      [databaseName],
    ) as Array<{ waiting: number }>;
    if ((rows[0]?.waiting ?? 0) > 0) return;
    if (Date.now() > deadline) throw new Error("No backend ever blocked on the integration lock.");
  }
}

describe("issue and disable under the shared integration lock", () => {
  test("a disable holding the lock makes a concurrent issue refuse", async () => {
    await withScratchDb(async ({ appDb, adminDb, rival, databaseName }) => {
      await seedTenants(adminDb);
      const integrationId = await seedIntegration(adminDb, {
        tenantId: TENANT_A, displayName: "contended",
      });
      const session = manager(TENANT_A);

      // Stand in for the disable's transaction: take the SAME row lock it
      // takes, tenant-fenced, and hold it.
      const holder = await rival.reserve();
      try {
        await holder.unsafe("begin");
        await holder.unsafe("select set_config('app.tenant_id', $1, true)", [TENANT_A]);
        await holder.unsafe("select set_config('app.user_id', $1, true)", [USER]);
        await holder.unsafe("select set_config('app.scope', 'tenant', true)");
        const locked = await holder.unsafe(
          `select id from platform.api_key_integrations
            where id = $1 and tenant_id = $2 for update`,
          [integrationId, TENANT_A],
        ) as Array<{ id: string }>;
        expect(locked).toHaveLength(1);

        // The issue now reaches the same lock and waits there.
        const issuing = issueKey(serviceDeps(appDb), session, {
          integrationId, displayName: "racing", expiresInDays: 30,
        });
        const settled = { done: false };
        void issuing.then(() => { settled.done = true; }, () => { settled.done = true; });
        await waitForBlockedBackend(rival, databaseName);
        expect(settled.done).toBe(false);

        // Disable wins the race and commits.
        await holder.unsafe(
          `update platform.api_key_integrations set status = 'disabled', updated_at = now()
            where id = $1 and tenant_id = $2`,
          [integrationId, TENANT_A],
        );
        await holder.unsafe(
          `update platform.api_keys set revoked_at = now()
            where integration_id = $1 and tenant_id = $2 and revoked_at is null`,
          [integrationId, TENANT_A],
        );
        await holder.unsafe("commit");

        // The issue re-reads the status it was waiting for and refuses, so no
        // credential is committed under the disabled parent.
        await expect(issuing).rejects.toThrow(ApiKeyNotFoundError);
      } finally {
        await holder.unsafe("rollback").catch(() => undefined);
        holder.release();
      }

      const live = await sql<{ n: string }>`
        select count(*)::text as n from platform.api_keys
         where integration_id = ${integrationId} and revoked_at is null
      `.execute(adminDb);
      expect(live.rows[0]!.n).toBe("0");
    });
  }, TEST_TIMEOUT);

  test("an issue that commits first has its credential revoked by the disable", async () => {
    await withScratchDb(async ({ appDb, adminDb }) => {
      await seedTenants(adminDb);
      const integrationId = await seedIntegration(adminDb, {
        tenantId: TENANT_A, displayName: "rotated then disabled",
      });
      const session = manager(TENANT_A);

      // The other ordering: the key exists before the disable runs.
      const issued = await issueKey(serviceDeps(appDb), session, {
        integrationId, displayName: "first", expiresInDays: 30,
      });
      const disabled = await disableIntegration(serviceDeps(appDb), session, integrationId);
      expect(disabled.revokedKeys).toBe(1);

      const rows = await sql<{ id: string; revoked_at: Date | null }>`
        select id, revoked_at from platform.api_keys where integration_id = ${integrationId}
      `.execute(adminDb);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]!.id).toBe(issued.keyId);
      expect(rows.rows[0]!.revoked_at).not.toBeNull();

      // And no further credential can be issued against it.
      await expect(issueKey(serviceDeps(appDb), session, {
        integrationId, displayName: "after", expiresInDays: 30,
      })).rejects.toThrow(ApiKeyNotFoundError);
    });
  }, TEST_TIMEOUT);
});

/**
 * Provisioning wired exactly as a deployment wires it, against a stub realm.
 *
 * The configuration comes from `readApiKeyProvisioningConfig` rather than a
 * hand-built object, so the keyring, the admin client and the lifetime policy
 * under test are the ones a host resolves — the realm's base URL is the only
 * thing that differs from production.
 */
function provisioningDeps(appDb: Kysely<DB>, realm: StubRealm): ApiKeyServiceDeps {
  const config = readApiKeyProvisioningConfig({
    OPENSHAPEFORGE_API_KEY_SECRET_KEYS: `test:${randomBytes(32).toString("base64")}`,
    OPENSHAPEFORGE_API_KEY_MAX_TTL_DAYS: "366",
    OPENSHAPEFORGE_API_KEY_DEFAULT_TTL_DAYS: "365",
    OPENSHAPEFORGE_KEYCLOAK_BASE_URL: realm.baseUrl,
    OPENSHAPEFORGE_KEYCLOAK_REALM: realm.realm,
    OPENSHAPEFORGE_KEYCLOAK_ADMIN_CLIENT_ID: "provisioner",
    OPENSHAPEFORGE_KEYCLOAK_ADMIN_CLIENT_SECRET: "provisioner-secret",
  });
  if (!config) throw new Error("The provisioning configuration under test is incomplete.");
  return {
    db: appDb as never,
    keyring: config.keyring,
    admin: config.admin,
    entityRoleClientId: config.entityRoleClientId,
    lifetime: config.lifetime,
  };
}

/**
 * A realm that can be HELD inside the one request provisioning makes first.
 *
 * `entered` resolves when the create reaches `POST /clients`, which is after
 * the 'pending' intent row is committed and before the activation — the whole
 * window in which the integration is visible but not live. `release` lets it
 * continue. Neither is a sleep: the test waits on the realm having been
 * reached, and the realm waits on the test having finished with it.
 *
 * Nothing about this is Keycloak. It is the stub HTTP server from
 * `__tests__/fixtures.ts` speaking the admin paths `keycloak-admin.ts` calls;
 * a real server cannot be paused mid-provisioning, which is exactly why the
 * interleavings below need it. What a real Keycloak proves instead — that
 * those paths are the right ones — is the e2e suite's job.
 */
function pausedRealm(): StubRealm & { entered: Promise<void>; release: () => void } {
  let entered!: () => void;
  let released!: () => void;
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  const releasedPromise = new Promise<void>((resolve) => { released = resolve; });
  let held = false;
  const realm = stubRealm({
    roles: [READ_ROLE],
    onAdminRequest: async (method, path) => {
      if (held || method !== "POST" || !path.endsWith("/clients")) return;
      held = true;
      entered();
      await releasedPromise;
    },
  });
  return { ...realm, entered: enteredPromise, release: released };
}

/** The one integration this tenant has, as the database holds it. */
async function soleIntegration(adminDb: Kysely<DB>): Promise<{
  id: string;
  status: string;
  client_secret_ciphertext: string | null;
}> {
  const rows = await sql<{ id: string; status: string; client_secret_ciphertext: string | null }>`
    select id, status, client_secret_ciphertext
      from platform.api_key_integrations
     where tenant_id = ${TENANT_A}
  `.execute(adminDb);
  expect(rows.rows).toHaveLength(1);
  return rows.rows[0]!;
}

describe("create against a concurrent disable", () => {
  /**
   * The window this whole describe is about.
   *
   * Provisioning commits its 'pending' intent BEFORE it touches the realm, on
   * purpose: a crash in between must leave a record that names the realm
   * client so the reconciler can finish or sweep it. The cost is that the row
   * is visible and mutable while the external call is in flight, so an
   * administrator can disable the integration before it was ever live — and
   * the activation that follows used to `set status = 'active'` with no
   * condition but the id and the tenant, undoing that disable and then
   * minting a credential under it.
   *
   * Both orders are driven here against a real PostgreSQL, with the realm held
   * open so the interleaving is real rather than simulated.
   */
  test("a disable that lands during the realm call stands, and nothing is minted", async () => {
    await withScratchDb(async ({ appDb, adminDb }) => {
      await seedTenants(adminDb);
      const realm = pausedRealm();
      try {
        const deps = provisioningDeps(appDb, realm);
        const session = manager(TENANT_A);
        const creating = createIntegration(deps, session, {
          displayName: "disabled mid-flight", roles: [READ_ROLE], expiresInDays: 30,
        });
        let settled = false;
        void creating.then(() => { settled = true; }, () => { settled = true; });

        // Provisioning is now inside the realm, so the intent row is committed
        // — which is what makes the disable below possible at all.
        await realm.entered;
        expect(settled).toBe(false);
        const pending = await soleIntegration(adminDb);
        expect(pending.status).toBe("pending");
        expect(realm.clients()).toEqual([]);

        // The administrator disables it, to completion, while the create waits.
        const disabled = await disableIntegration(deps, session, pending.id);
        expect(disabled).toEqual({ id: pending.id, revokedKeys: 0 });

        realm.release();
        // The activation finds the attempt is no longer its own and refuses.
        await expect(creating).rejects.toThrow(ApiKeyNotFoundError);

        // The disable stands: still disabled, still never activated.
        const after = await soleIntegration(adminDb);
        expect(after).toMatchObject({
          id: pending.id, status: "disabled", client_secret_ciphertext: null,
        });
        // And nothing was minted under it — not a revoked key, no key at all.
        const keys = await sql<{ n: string }>`
          select count(*)::text as n from platform.api_keys
           where integration_id = ${pending.id}
        `.execute(adminDb);
        expect(keys.rows[0]!.n).toBe("0");
        // The realm client created in the window is gone again: the activation
        // compensated for what it could not finish.
        expect(realm.clients()).toEqual([]);
        expect(realm.requests.some((request) => request.startsWith("DELETE /admin/realms/")))
          .toBe(true);
      } finally {
        realm.release();
        await realm.stop();
      }
    });
  }, TEST_TIMEOUT);

  test("a disable that takes the lock while the activation waits on it still stands", async () => {
    await withScratchDb(async ({ appDb, adminDb, rival, databaseName }) => {
      await seedTenants(adminDb);
      const realm = pausedRealm();
      const holder = await rival.reserve();
      try {
        const deps = provisioningDeps(appDb, realm);
        const session = manager(TENANT_A);
        const creating = createIntegration(deps, session, {
          displayName: "disabled at the lock", roles: [READ_ROLE], expiresInDays: 30,
        });
        let settled = false;
        void creating.then(() => { settled = true; }, () => { settled = true; });
        await realm.entered;
        const pending = await soleIntegration(adminDb);
        expect(pending.status).toBe("pending");

        // Stand in for the disable's transaction: take the SAME row lock it
        // takes, tenant-fenced, and hold it while the activation arrives. The
        // row is still 'pending' at this point, so the activation cannot have
        // read its verdict before the status changes.
        await holder.unsafe("begin");
        await holder.unsafe("select set_config('app.tenant_id', $1, true)", [TENANT_A]);
        await holder.unsafe("select set_config('app.user_id', $1, true)", [USER]);
        await holder.unsafe("select set_config('app.scope', 'tenant', true)");
        expect(await holder.unsafe(
          `select id from platform.api_key_integrations
            where id = $1 and tenant_id = $2 for update`,
          [pending.id, TENANT_A],
        )).toHaveLength(1);

        // Let the realm answer. The activation now reaches the same lock and
        // waits there, observed waiting rather than assumed to be.
        realm.release();
        await waitForBlockedBackend(rival, databaseName);
        expect(settled).toBe(false);

        // Disable wins the race and commits.
        await holder.unsafe(
          `update platform.api_key_integrations set status = 'disabled', updated_at = now()
            where id = $1 and tenant_id = $2`,
          [pending.id, TENANT_A],
        );
        await holder.unsafe("commit");

        // The activation re-reads the status it was waiting for and refuses.
        await expect(creating).rejects.toThrow(ApiKeyNotFoundError);
        const after = await soleIntegration(adminDb);
        expect(after).toMatchObject({ status: "disabled", client_secret_ciphertext: null });
        const keys = await sql<{ n: string }>`
          select count(*)::text as n from platform.api_keys
           where integration_id = ${pending.id}
        `.execute(adminDb);
        expect(keys.rows[0]!.n).toBe("0");
        expect(realm.clients()).toEqual([]);
      } finally {
        await holder.unsafe("rollback").catch(() => undefined);
        holder.release();
        realm.release();
        await realm.stop();
      }
    });
  }, TEST_TIMEOUT);

  test("a create that commits first keeps its credential, which the disable then revokes", async () => {
    await withScratchDb(async ({ appDb, adminDb }) => {
      await seedTenants(adminDb);
      const realm = stubRealm({ roles: [READ_ROLE] });
      try {
        const deps = provisioningDeps(appDb, realm);
        const session = manager(TENANT_A);
        // The other order, with nothing held: provisioning finishes, so the
        // credential is handed over exactly once and must not be lost.
        const created = await createIntegration(deps, session, {
          displayName: "live then disabled", roles: [READ_ROLE], expiresInDays: 30,
        });
        expect(created.token).toBeTypeOf("string");
        expect(created.integration).toMatchObject({
          displayName: "live then disabled", status: "active", grantedRoles: [READ_ROLE],
        });
        expect(realm.clients()).toEqual([`osf-int-${created.integrationId}`]);

        const disabled = await disableIntegration(deps, session, created.integrationId);
        expect(disabled).toEqual({ id: created.integrationId, revokedKeys: 1 });

        const rows = await sql<{ id: string; revoked_at: Date | null }>`
          select id, revoked_at from platform.api_keys
           where integration_id = ${created.integrationId}
        `.execute(adminDb);
        expect(rows.rows).toHaveLength(1);
        expect(rows.rows[0]!.id).toBe(created.keyId);
        expect(rows.rows[0]!.revoked_at).not.toBeNull();
        // The disable revokes; it does not delete the realm client, because
        // this integration really was provisioned.
        expect(realm.clients()).toEqual([`osf-int-${created.integrationId}`]);
      } finally {
        await realm.stop();
      }
    });
  }, TEST_TIMEOUT);

  test("a second create cannot resurrect a disabled attempt", async () => {
    await withScratchDb(async ({ appDb, adminDb }) => {
      await seedTenants(adminDb);
      const realm = stubRealm({ roles: [READ_ROLE] });
      try {
        const deps = provisioningDeps(appDb, realm);
        const session = manager(TENANT_A);
        // A retry after the refusal above is an ordinary new attempt: its own
        // id, its own realm client, and the disabled row left as it stands.
        const disabledId = await seedIntegration(adminDb, {
          tenantId: TENANT_A, displayName: "abandoned", status: "disabled",
        });
        const created = await createIntegration(deps, session, {
          displayName: "the retry", roles: [READ_ROLE], expiresInDays: 30,
        });
        expect(created.integrationId).not.toBe(disabledId);
        const rows = await sql<{ id: string; status: string }>`
          select id, status from platform.api_key_integrations
           where tenant_id = ${TENANT_A} order by status
        `.execute(adminDb);
        expect(rows.rows).toEqual([
          { id: created.integrationId, status: "active" },
          { id: disabledId, status: "disabled" },
        ]);
      } finally {
        await realm.stop();
      }
    });
  }, TEST_TIMEOUT);
});
