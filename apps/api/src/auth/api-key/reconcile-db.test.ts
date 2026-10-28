// SPDX-License-Identifier: BUSL-1.1
/**
 * The realm reconciler against a real PostgreSQL and a stub realm.
 *
 * Narrow on purpose: this covers the branch that exists as a BACKSTOP, and the
 * rows it must keep its hands off.
 *
 * When an administrator disables an integration while provisioning is still
 * inside the realm, the activation refuses to finish (service.ts, step 3's
 * fence), records the attempt, and deletes the realm client it created. That
 * delete is best effort — a realm that cannot be reached must not turn the
 * refusal into a different, misleading failure — and the row it belongs to is
 * never-activated, which neither the stalled-attempt sweep ('pending') nor the
 * missing-client repair ('active') ever visits. So such a row whose client is
 * still there is swept here, and would otherwise be an orphaned confidential
 * client with roles granted, surviving every later run.
 *
 * "Never activated" is `client_secret_ciphertext is null`, which is what the
 * activation writes and therefore exactly the rows that never reached it. It
 * is deliberately NOT a list of statuses: the fence refuses on whatever status
 * it finds, so a status a later version adds would otherwise be an orphan no
 * run visits. And it is what keeps the repair from ever running on such a row:
 * minting a realm client and a fresh secret for an integration nobody
 * activated would be an enable nobody asked for.
 *
 * A disabled integration that WAS live keeps its realm client, as before: it
 * is not an abandoned attempt and deleting its client would be a second,
 * unrelated decision.
 *
 * That a REFUSED compensation reaches this sweep at all — for a row the
 * administrator disabled and for one removed out from under the attempt — is
 * driven end to end in `operations/api-key-catalog-db.test.ts`, where the
 * realm answers every read and refuses every delete.
 *
 * The realm is the stub HTTP server from `__tests__/fixtures.ts` — the admin
 * paths `keycloak-admin.ts` calls, over real HTTP, with the clients it creates
 * actually kept — and not Keycloak. Skips wholesale when no PostgreSQL is
 * reachable; point `SCRATCH_ADMIN_DATABASE_URL` at an isolated server.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Kysely } from "kysely";
import { createDatabaseRuntime } from "../../db/connection.js";
import { runMigrationChain } from "../../db/migration-chain.js";
import { APP_ROLE } from "../../db/migrations/app-role.js";
import type { DB } from "../../generated/db/types.js";
import { stubRealm, type StubRealm } from "./__tests__/fixtures.js";
import { reconcileApiKeyIntegrations } from "./reconcile.js";
import { readApiKeyProvisioningConfig } from "./runtime-config.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const APP_ROLE_PASSWORD = "openshapeforge_app";
const TEST_TIMEOUT = 180_000;

const TENANT = randomUUID();
const USER = randomUUID();
const READ_ROLE = "Relations.All.Read";

let reachable = false;

beforeAll(async () => {
  const probe = new SQL(ADMIN_URL, { max: 1 });
  try {
    await probe.unsafe("select 1");
    reachable = true;
  } catch {
    console.log(
      `[api-key reconcile] SKIPPED — no PostgreSQL at ${new URL(ADMIN_URL).host}. ` +
        "Set SCRATCH_ADMIN_DATABASE_URL to an isolated server to run this suite.",
    );
  } finally {
    await probe.close();
  }
});

function databaseUrl(name: string, app = false): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  if (app) {
    url.username = APP_ROLE;
    url.password = APP_ROLE_PASSWORD;
  }
  return url.toString();
}

async function withScratchDb(
  work: (scratch: { appDb: Kysely<DB>; adminDb: Kysely<DB> }) => Promise<void>,
): Promise<void> {
  const name = `api_key_reconcile_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const server = new SQL(ADMIN_URL, { max: 1 });
  try {
    await server.unsafe(`create database "${name}"`);
    const admin = createDatabaseRuntime({ databaseUrl: databaseUrl(name), maxConnections: 4 });
    try {
      await admin.db.connection().execute((trx) => runMigrationChain(trx));
      const app = createDatabaseRuntime({ databaseUrl: databaseUrl(name, true), maxConnections: 4 });
      try {
        await sql`
          insert into platform.tenants (id, slug, name, status, keycloak_realm)
          values (${TENANT}, 'reconcile', 'Reconcile', 'active', 'openshapeforge')
        `.execute(admin.db);
        await work({ appDb: app.db, adminDb: admin.db });
      } finally {
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

/**
 * An integration row in a chosen state, written as the owner.
 *
 * `activated` is the distinction the swept branch turns on: the ciphertext is
 * what the activation writes, so its absence marks an attempt that never got
 * that far.
 */
async function seedIntegration(adminDb: Kysely<DB>, input: {
  displayName: string;
  /** Any string: the column is `text`, which is what the widened sweep is about. */
  status: string;
  activated: boolean;
  createdAt?: Date;
}): Promise<string> {
  const id = randomUUID();
  const at = input.createdAt ?? new Date();
  await sql`
    insert into platform.api_key_integrations
      (id, tenant_id, display_name, keycloak_client_id, status, granted_roles,
       client_secret_ciphertext, client_secret_key_id, client_secret_algorithm,
       created_by, created_at, updated_at)
    values
      (${id}, ${TENANT}, ${input.displayName}, ${`osf-int-${id}`}, ${input.status},
       cast(${[READ_ROLE]} as jsonb),
       ${input.activated ? "ciphertext" : null},
       ${input.activated ? "k1" : null},
       ${input.activated ? "aes-256-gcm" : null},
       ${USER}, ${at}, ${at})
  `.execute(adminDb);
  return id;
}

/** Put a realm client there for a row, the way provisioning's step 2 would. */
async function provisionClient(realm: StubRealm, integrationId: string): Promise<void> {
  const config = readApiKeyProvisioningConfig(realmEnv(realm));
  await config!.admin.createServiceAccountClient(`osf-int-${integrationId}`, "seeded");
}

function realmEnv(realm: StubRealm) {
  return {
    OPENSHAPEFORGE_API_KEY_SECRET_KEYS: `test:${randomBytes(32).toString("base64")}`,
    OPENSHAPEFORGE_API_KEY_MAX_TTL_DAYS: "366",
    OPENSHAPEFORGE_API_KEY_DEFAULT_TTL_DAYS: "365",
    OPENSHAPEFORGE_KEYCLOAK_BASE_URL: realm.baseUrl,
    OPENSHAPEFORGE_KEYCLOAK_REALM: realm.realm,
    OPENSHAPEFORGE_KEYCLOAK_ADMIN_CLIENT_ID: "provisioner",
    OPENSHAPEFORGE_KEYCLOAK_ADMIN_CLIENT_SECRET: "provisioner-secret",
  };
}

describe("the abandoned-attempt backstop", () => {
  test("sweeps a never-activated disabled row whose realm client is still there", async () => {
    if (!reachable) return;
    await withScratchDb(async ({ appDb, adminDb }) => {
      const realm = stubRealm({ roles: [READ_ROLE] });
      try {
        // The residue of a disable that landed mid-provisioning, with the
        // activation's own compensating delete having failed.
        const abandoned = await seedIntegration(adminDb, {
          displayName: "abandoned", status: "disabled", activated: false,
        });
        // The ordinary case: the same shape of row, already compensated for.
        const alreadyGone = await seedIntegration(adminDb, {
          displayName: "already compensated", status: "disabled", activated: false,
        });
        // A disabled integration that really was live. Not an abandoned
        // attempt, so its realm client is none of this branch's business.
        const wasLive = await seedIntegration(adminDb, {
          displayName: "was live", status: "disabled", activated: true,
        });
        await provisionClient(realm, abandoned);
        await provisionClient(realm, wasLive);

        const config = readApiKeyProvisioningConfig(realmEnv(realm))!;
        const report = await reconcileApiKeyIntegrations({
          db: appDb as never,
          admin: config.admin,
          keyring: config.keyring,
          entityRoleClientId: config.entityRoleClientId,
          actorSubject: "reconcile-suite",
        });

        expect(report.sweptAbandoned).toEqual([abandoned]);
        expect(report.failed).toEqual([]);
        expect(report.rebuilt).toEqual([]);
        expect(realm.clients()).toEqual([`osf-int-${wasLive}`]);
        // Nothing about the rows themselves changed: they are already in their
        // final state, so only the realm was touched.
        const rows = await sql<{ id: string; status: string }>`
          select id, status from platform.api_key_integrations
           where tenant_id = ${TENANT} order by display_name
        `.execute(adminDb);
        expect(rows.rows).toEqual([
          { id: abandoned, status: "disabled" },
          { id: alreadyGone, status: "disabled" },
          { id: wasLive, status: "disabled" },
        ]);
      } finally {
        await realm.stop();
      }
    });
  }, TEST_TIMEOUT);

  test("recognises an abandoned attempt by its missing secret, not by its status", async () => {
    if (!reachable) return;
    await withScratchDb(async ({ appDb, adminDb }) => {
      const realm = stubRealm({ roles: [READ_ROLE] });
      try {
        // The activation's fence refuses on whatever status it finds the row
        // in, and records the attempt as 'disabled'. A later version that adds
        // a status — suspended, archived — would then write rows this sweep
        // must still visit, and enumerating statuses here is what would make
        // their realm clients invisible by default. "Never activated" is the
        // missing client secret, so this row is swept on that alone.
        const suspended = await seedIntegration(adminDb, {
          displayName: "a status this version does not write",
          status: "suspended",
          activated: false,
        });
        await provisionClient(realm, suspended);

        const config = readApiKeyProvisioningConfig(realmEnv(realm))!;
        const report = await reconcileApiKeyIntegrations({
          db: appDb as never,
          admin: config.admin,
          keyring: config.keyring,
          entityRoleClientId: config.entityRoleClientId,
          actorSubject: "reconcile-suite",
        });

        expect(report.sweptAbandoned).toEqual([suspended]);
        expect(report.rebuilt).toEqual([]);
        expect(report.failed).toEqual([]);
        expect(realm.clients()).toEqual([]);
        // The row is left exactly as it stands: this branch repairs the realm,
        // not the database.
        const rows = await sql<{ status: string }>`
          select status from platform.api_key_integrations where id = ${suspended}
        `.execute(adminDb);
        expect(rows.rows).toEqual([{ status: "suspended" }]);
      } finally {
        await realm.stop();
      }
    });
  }, TEST_TIMEOUT);

  test("never answers a row that was never activated by provisioning one", async () => {
    if (!reachable) return;
    await withScratchDb(async ({ appDb, adminDb }) => {
      const realm = stubRealm({ roles: [READ_ROLE] });
      try {
        // An 'active' row with no client secret is not a state anything here
        // writes — the activation writes both together. Rebuilding it would be
        // this reconciler creating a realm client and a fresh secret for an
        // integration nobody ever activated, which is an enable nobody asked
        // for. Reported for a human instead.
        const inconsistent = await seedIntegration(adminDb, {
          displayName: "active without a secret", status: "active", activated: false,
        });
        const config = readApiKeyProvisioningConfig(realmEnv(realm))!;
        const report = await reconcileApiKeyIntegrations({
          db: appDb as never,
          admin: config.admin,
          keyring: config.keyring,
          entityRoleClientId: config.entityRoleClientId,
          actorSubject: "reconcile-suite",
        });

        expect(report.rebuilt).toEqual([]);
        expect(report.sweptAbandoned).toEqual([]);
        expect(report.failed).toEqual([{
          integrationId: inconsistent,
          reason: "Active with no client secret: never activated, so it is not rebuilt.",
        }]);
        // Nothing reached the realm for it, and nothing was written.
        expect(realm.clients()).toEqual([]);
        const rows = await sql<{ status: string; client_secret_ciphertext: string | null }>`
          select status, client_secret_ciphertext
            from platform.api_key_integrations where id = ${inconsistent}
        `.execute(adminDb);
        expect(rows.rows).toEqual([{ status: "active", client_secret_ciphertext: null }]);
      } finally {
        await realm.stop();
      }
    });
  }, TEST_TIMEOUT);

  test("still leaves a pending attempt inside its grace window alone", async () => {
    if (!reachable) return;
    await withScratchDb(async ({ appDb, adminDb }) => {
      const realm = stubRealm({ roles: [READ_ROLE] });
      try {
        // A create that is in flight right now. Widening the reconciler's
        // query must not have widened what it acts on.
        const inFlight = await seedIntegration(adminDb, {
          displayName: "in flight", status: "pending", activated: false,
        });
        await provisionClient(realm, inFlight);

        const config = readApiKeyProvisioningConfig(realmEnv(realm))!;
        const report = await reconcileApiKeyIntegrations({
          db: appDb as never,
          admin: config.admin,
          keyring: config.keyring,
          entityRoleClientId: config.entityRoleClientId,
          actorSubject: "reconcile-suite",
        });

        expect(report).toEqual({
          sweptPending: [], sweptAbandoned: [], rebuilt: [], failed: [],
        });
        expect(realm.clients()).toEqual([`osf-int-${inFlight}`]);
      } finally {
        await realm.stop();
      }
    });
  }, TEST_TIMEOUT);
});
