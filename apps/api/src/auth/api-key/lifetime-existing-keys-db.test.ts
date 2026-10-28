// SPDX-License-Identifier: BUSL-1.1
/**
 * What a deployment's lifetime rule does to credentials that already exist:
 * nothing.
 *
 * The rule is read at MINT time and written into one `expires_at`. Nothing
 * revisits a row afterwards, so the question that matters for adopting a
 * policy is whether a key minted under the old rule still authenticates
 * under the new one — in particular a non-expiring key, the exact shape a
 * declared maximum stops anyone from asking for.
 *
 * That answer belongs to the database and to `store.ts`, not to a handler:
 * the expiry decision is made against the instant on the row, under the
 * restricted app role and its tenant policy. So this runs against a scratch
 * PostgreSQL this file creates and drops. Skips wholesale when none is
 * reachable; point `SCRATCH_ADMIN_DATABASE_URL` at an isolated server.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Kysely } from "kysely";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import { createDatabaseRuntime } from "../../db/connection.js";
import { runMigrationChain } from "../../db/migration-chain.js";
import { APP_ROLE } from "../../db/migrations/app-role.js";
import type { DB } from "../../generated/db/types.js";
import { mintApiKey, parseApiKey } from "./format.js";
import {
  readCredentialLifetimePolicy,
  resolveCredentialExpiry,
  UNDECLARED_CREDENTIAL_LIFETIME_POLICY,
} from "./lifetime.js";
import { resolveApiKey } from "./store.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const APP_ROLE_PASSWORD = "openshapeforge_app";
const TEST_TIMEOUT = 180_000;

const TENANT = randomUUID();
const USER = randomUUID();
const READ_ROLE = "Relations.All.Read";
const NOW = new Date();

function databaseUrl(name: string, app = false): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  if (app) {
    url.username = APP_ROLE;
    url.password = APP_ROLE_PASSWORD;
  }
  return url.toString();
}

type Scratch = { appDb: OpenShapeForgeDatabase; adminDb: Kysely<DB>; close: () => Promise<void> };

let scratch: Scratch | null = null;
let server: SQL | null = null;
let databaseName = "";
/** The tokens seeded below, by the lifetime they were minted with. */
const tokens: Record<"nonExpiring" | "longLived" | "expired", string> = {
  nonExpiring: "", longLived: "", expired: "",
};

/** One integration's worth of state, written as the owner. */
async function seed(adminDb: Kysely<DB>): Promise<void> {
  const integrationId = randomUUID();
  await sql`
    insert into platform.tenants (id, slug, name, status, keycloak_realm)
    values (${TENANT}, 'existing-keys', 'Existing Keys', 'active', 'openshapeforge')
  `.execute(adminDb);
  await sql`
    insert into platform.api_key_integrations
      (id, tenant_id, display_name, keycloak_client_id, status, granted_roles,
       client_secret_ciphertext, client_secret_key_id, client_secret_algorithm,
       created_by, created_at, updated_at)
    values
      (${integrationId}, ${TENANT}, 'Long-standing automation', ${`osf-int-${integrationId}`},
       'active', cast(${[READ_ROLE]} as jsonb), 'ciphertext', 'k1', 'aes-256-gcm',
       ${USER}, ${NOW}, ${NOW})
  `.execute(adminDb);

  const lifetimes: Record<keyof typeof tokens, Date | null> = {
    // Minted before any maximum was declared, when `null` was on offer.
    nonExpiring: null,
    // Minted with a lifetime no declared maximum would permit today.
    longLived: new Date(NOW.getTime() + 3650 * 24 * 60 * 60 * 1000),
    expired: new Date(NOW.getTime() - 24 * 60 * 60 * 1000),
  };
  for (const [name, expiresAt] of Object.entries(lifetimes) as [keyof typeof tokens, Date | null][]) {
    const minted = mintApiKey();
    tokens[name] = minted.token;
    await sql`
      insert into platform.api_keys
        (id, tenant_id, integration_id, lookup_id, secret_hash, display_name,
         created_by, created_at, expires_at)
      values
        (${randomUUID()}, ${TENANT}, ${integrationId}, ${minted.lookupId},
         ${minted.secretHash}, ${name}, ${USER}, ${NOW}, ${expiresAt})
    `.execute(adminDb);
  }
}

beforeAll(async () => {
  const probe = new SQL(ADMIN_URL, { max: 1 });
  let reachable = true;
  try {
    await probe.unsafe("select 1");
  } catch {
    reachable = false;
  } finally {
    await probe.close();
  }
  if (!reachable) {
    console.log(
      `[api-key existing keys] SKIPPED — no PostgreSQL at ${new URL(ADMIN_URL).host}. ` +
        "Set SCRATCH_ADMIN_DATABASE_URL to an isolated server to run this suite.",
    );
    return;
  }
  databaseName = `api_key_existing_keys_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  server = new SQL(ADMIN_URL, { max: 1 });
  await server.unsafe(`create database "${databaseName}"`);
  const admin = createDatabaseRuntime({ databaseUrl: databaseUrl(databaseName), maxConnections: 4 });
  await admin.db.connection().execute((trx) => runMigrationChain(trx));
  await seed(admin.db);
  const app = createDatabaseRuntime({ databaseUrl: databaseUrl(databaseName, true), maxConnections: 4 });
  scratch = {
    appDb: app.db as unknown as OpenShapeForgeDatabase,
    adminDb: admin.db,
    close: async () => {
      await app.close();
      await admin.close();
    },
  };
}, TEST_TIMEOUT);

afterAll(async () => {
  await scratch?.close();
  if (server) {
    if (databaseName) await server.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await server.close();
  }
}, TEST_TIMEOUT);

/** Authenticate one seeded token the way the credential path does. */
async function authenticate(token: string) {
  const parsed = parseApiKey(token)!;
  return resolveApiKey(scratch!.appDb, parsed.lookupId, parsed.secret, NOW);
}

test("a declared maximum leaves every existing key exactly as it was", async () => {
  if (!scratch) return;
  // The policy a host might adopt today: 30 days, and no non-expiring
  // credential. Resolved here to show the test is about the same rule the
  // minting surfaces enforce, and that adopting it is a mint-time change.
  const declared = readCredentialLifetimePolicy({
    OPENSHAPEFORGE_API_KEY_MAX_TTL_DAYS: "30",
  })!;
  expect(declared).toEqual({ maxDays: 30, defaultDays: 30 });
  expect(resolveCredentialExpiry(null, declared, NOW)).toMatchObject({
    refused: expect.stringContaining("expire within 30 days"),
  });
  expect(resolveCredentialExpiry(3650, declared, NOW)).toMatchObject({
    refused: expect.stringContaining("at most 30 days"),
  });

  // And yet: the key minted when `null` was on offer still authenticates,
  // and so does the one minted for ten years. Neither row is revisited, and
  // nothing shortens them behind their holder's back.
  for (const name of ["nonExpiring", "longLived"] as const) {
    expect({ name, result: await authenticate(tokens[name]) })
      .toMatchObject({ name, result: { ok: true } });
  }

  // The instant on the row is still what decides: an already-expired key is
  // refused whether or not a policy is declared.
  expect(await authenticate(tokens.expired)).toMatchObject({ ok: false, reason: "expired" });
}, TEST_TIMEOUT);

test("and so does an undeclared one, which is what every deployment has today", async () => {
  if (!scratch) return;
  expect(UNDECLARED_CREDENTIAL_LIFETIME_POLICY.maxDays).toBeNull();
  for (const name of ["nonExpiring", "longLived"] as const) {
    expect({ name, result: await authenticate(tokens[name]) })
      .toMatchObject({ name, result: { ok: true } });
  }
}, TEST_TIMEOUT);
