// SPDX-License-Identifier: BUSL-1.1
/**
 * The cursor round trip against a real PostgreSQL: every cursor one of these
 * listings ISSUES is one it takes back, whatever the session's date settings
 * are and whatever Unicode the customer named their integration.
 *
 * Both of these are properties of the SQL and of the data, so neither can be
 * shown with a fake connection:
 *
 *   - `(expr)::text` renders a timestamptz under the session's `DateStyle` and
 *     `TimeZone`. Under `German, DMY` the same row reads
 *     `28.10.2026 07:34:35.96 UTC`, in Amsterdam it reads `+01`. The cursor the
 *     page handed out therefore depended on settings this code neither sets nor
 *     owns, and the next page refused it — a listing that cannot be paged past
 *     its first page, for a database that is configured, not broken. The
 *     projection now renders the value itself (`catalog-page.ts`,
 *     `renderSortValue`), so the walks below run under four different
 *     DateStyle/TimeZone pairs and produce the identical cursor each time.
 *   - a display name of 200 emoji is 200 characters to the input schema that
 *     accepted it, 400 UTF-16 units to JavaScript and 800 bytes to UTF-8. Its
 *     cursor is some 1.1 kB of base64, so a fixed 512-character ceiling refused
 *     it before parsing and a 200-unit value bound refused it after — for a
 *     name the contract permits and the database holds. The bounds are now
 *     derived from the service's own display-name bound, and the walk below
 *     pages a set of such names one row at a time.
 *
 * Nothing here is doubled except the clock: the paging functions, the session
 * layer and the restricted app role are the shipped ones, in a scratch database
 * this file creates and drops. The realm is never reached — listing touches
 * neither the keyring nor Keycloak.
 *
 * Skips wholesale when no PostgreSQL is reachable, so it never fails for the
 * wrong reason; point `SCRATCH_ADMIN_DATABASE_URL` at an isolated server.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Kysely } from "kysely";
import { API_KEY_MANAGE_ROLE } from "../auth/api-key/ceiling.js";
import { mintApiKey } from "../auth/api-key/format.js";
import {
  pageIntegrations,
  pageKeys,
  MAX_DISPLAY_NAME_LENGTH,
  type ApiKeyServiceDeps,
  type CredentialSortField,
  type IntegrationSortField,
  type ProvisioningSession,
} from "../auth/api-key/service.js";
import { UNDECLARED_CREDENTIAL_LIFETIME_POLICY } from "../auth/api-key/lifetime.js";
import { createDatabaseRuntime } from "../db/connection.js";
import { runMigrationChain } from "../db/migration-chain.js";
import { APP_ROLE } from "../db/migrations/app-role.js";
import {
  cursorSpread,
  decodeCursor,
  encodeCursor,
  fingerprint,
  isCursorTimestamp,
} from "./api-key-cursor.js";
import type { DB } from "../generated/db/types.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const APP_ROLE_PASSWORD = "openshapeforge_app";
const TEST_TIMEOUT = 180_000;

const TENANT = randomUUID();
const USER = randomUUID();
const READ_ROLE = "Relations.All.Read";

/**
 * Session settings a deployment can really be in. The driver sends
 * `DateStyle: ISO, MDY` in its startup packet today, which is what kept the
 * `::text` projection working — an undocumented property of a dependency, not
 * of this contract. A pooler that hands back a session with a `SET` on it, or
 * a driver that stops sending it, is all it takes.
 */
const SESSIONS = [
  { datestyle: "ISO, MDY", timezone: "UTC" },
  { datestyle: "German, DMY", timezone: "Europe/Amsterdam" },
  { datestyle: "SQL, DMY", timezone: "America/New_York" },
  // A half-hour zone, which is where a whole-hour assumption would show.
  { datestyle: "Postgres, YMD", timezone: "Asia/Kolkata" },
] as const;

function databaseUrl(name: string, app = false): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  if (app) {
    url.username = APP_ROLE;
    url.password = APP_ROLE_PASSWORD;
  }
  return url.toString();
}

async function serverReachable(): Promise<boolean> {
  const probe = new SQL(ADMIN_URL, { max: 1 });
  try {
    await probe.unsafe("select 1");
    return true;
  } catch {
    return false;
  } finally {
    await probe.close();
  }
}

type Scratch = { appDb: Kysely<DB>; adminDb: Kysely<DB> };

/**
 * A scratch database with the app session held to ONE connection, so a `set`
 * on it is the session every statement under test runs in. A pool would hand
 * out a different backend and the setting would be a coin toss.
 */
async function withScratchDb<T>(
  session: { datestyle: string; timezone: string },
  work: (scratch: Scratch) => Promise<T>,
): Promise<T> {
  const name = `api_key_cursor_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const server = new SQL(ADMIN_URL, { max: 1 });
  try {
    await server.unsafe(`create database "${name}"`);
    const admin = createDatabaseRuntime({ databaseUrl: databaseUrl(name), maxConnections: 4 });
    try {
      await admin.db.connection().execute((trx) => runMigrationChain(trx));
      const app = createDatabaseRuntime({
        databaseUrl: databaseUrl(name, true),
        maxConnections: 1,
      });
      try {
        await sql`set datestyle = ${sql.lit(session.datestyle)}`.execute(app.db);
        await sql`set timezone = ${sql.lit(session.timezone)}`.execute(app.db);
        // Asserted rather than assumed: the whole point of these runs is that
        // the session really is in the state the name says.
        const active = await sql<{ DateStyle: string; TimeZone: string }>`
          select current_setting('DateStyle') as "DateStyle",
                 current_setting('TimeZone') as "TimeZone"
        `.execute(app.db);
        expect(active.rows[0]).toEqual({
          DateStyle: session.datestyle,
          TimeZone: session.timezone,
        });
        return await work({ appDb: app.db, adminDb: admin.db });
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

async function seedTenant(adminDb: Kysely<DB>) {
  await sql`
    insert into platform.tenants (id, slug, name, status, keycloak_realm)
    values (${TENANT}, 'cursor', 'Cursor', 'active', 'openshapeforge')
  `.execute(adminDb);
}

async function seedIntegration(adminDb: Kysely<DB>, input: {
  displayName: string;
  createdAt: Date;
}): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into platform.api_key_integrations
      (id, tenant_id, display_name, keycloak_client_id, status, granted_roles,
       client_secret_ciphertext, client_secret_key_id, client_secret_algorithm,
       created_by, created_at, updated_at)
    values
      (${id}, ${TENANT}, ${input.displayName}, ${`osf-int-${id}`}, 'active',
       cast(${[READ_ROLE]} as jsonb), 'ciphertext', 'k1', 'aes-256-gcm', ${USER},
       ${input.createdAt}, ${input.createdAt})
  `.execute(adminDb);
  return id;
}

async function seedKey(adminDb: Kysely<DB>, input: {
  integrationId: string;
  displayName: string;
  createdAt: Date;
  expiresAt?: Date | null;
  lastUsedAt?: Date | null;
}): Promise<string> {
  const id = randomUUID();
  const minted = mintApiKey();
  await sql`
    insert into platform.api_keys
      (id, tenant_id, integration_id, lookup_id, secret_hash, display_name,
       created_by, created_at, expires_at, last_used_at)
    values
      (${id}, ${TENANT}, ${input.integrationId}, ${minted.lookupId}, ${minted.secretHash},
       ${input.displayName}, ${USER}, ${input.createdAt}, ${input.expiresAt ?? null},
       ${input.lastUsedAt ?? null})
  `.execute(adminDb);
  return id;
}

function manager(): ProvisioningSession {
  return {
    tenantId: TENANT,
    userId: USER,
    roles: [API_KEY_MANAGE_ROLE, READ_ROLE],
    groups: [],
    credential: "bearer",
    principalKind: "person",
  };
}

function serviceDeps(appDb: Kysely<DB>): ApiKeyServiceDeps {
  return {
    db: appDb as never,
    keyring: undefined as never,
    admin: undefined as never,
    entityRoleClientId: "erp-provider",
    lifetime: UNDECLARED_CREDENTIAL_LIFETIME_POLICY,
  };
}

/** Realistic names that are long, and long in code points rather than bytes. */
const UNICODE_NAMES = [
  // The contract's limit in emoji: 200 code points, 400 UTF-16 units, 800 bytes.
  "🎉".repeat(MAX_DISPLAY_NAME_LENGTH),
  // The same length in a non-Latin script, which is three bytes per character.
  "回".repeat(MAX_DISPLAY_NAME_LENGTH),
  // A name whose lowercase mapping is the interesting one, padded to the limit.
  `İstanbul ${"Ş".repeat(MAX_DISPLAY_NAME_LENGTH - 9)}`,
  // Combining marks, which are their own code points.
  "é".repeat(MAX_DISPLAY_NAME_LENGTH),
  "Ordinary partner",
];

/**
 * Walk one listing to its end THROUGH the cursor, one row per page: the page's
 * `nextCursor` is encoded exactly as a handler encodes it and decoded exactly
 * as a handler decodes it, so a cursor this listing cannot take back stops the
 * walk here as it would stop a caller.
 *
 * `first: 1` is deliberate: it maximises the number of round trips, so there
 * is a cursor per row rather than a cursor per page of twenty.
 */
async function walkIntegrations(
  appDb: Kysely<DB>,
  sortField: IntegrationSortField,
  direction: "asc" | "desc",
): Promise<{ ids: string[]; values: (string | null)[] }> {
  const identity = { f: sortField, d: direction };
  const query = fingerprint(["integrations", undefined, undefined]);
  const ids: string[] = [];
  const values: (string | null)[] = [];
  let after: string | undefined;
  for (let page = 0; page < 200; page += 1) {
    const result = await pageIntegrations(serviceDeps(appDb), manager(), {
      sortField,
      sortDirection: direction,
      first: 1,
      ...cursorSpread(decodeCursor(after, identity, query)),
    });
    for (const row of result.rows) {
      ids.push(row.id);
      values.push(row.cursorValue);
    }
    const next = encodeCursor(result.nextCursor, identity, query);
    if (!next) return { ids, values };
    after = next;
  }
  throw new Error("The integration walk did not terminate.");
}

async function walkCredentials(
  appDb: Kysely<DB>,
  integrationId: string,
  sortField: CredentialSortField,
  direction: "asc" | "desc",
): Promise<{ ids: string[]; values: (string | null)[] }> {
  const identity = { f: sortField, d: direction };
  const query = fingerprint(["credentials", integrationId, undefined, undefined]);
  const ids: string[] = [];
  const values: (string | null)[] = [];
  let after: string | undefined;
  for (let page = 0; page < 200; page += 1) {
    const result = await pageKeys(serviceDeps(appDb), manager(), { integrationId }, {
      sortField,
      sortDirection: direction,
      first: 1,
      ...cursorSpread(decodeCursor(after, identity, query)),
    });
    for (const row of result.rows) {
      ids.push(row.id);
      values.push(row.cursorValue);
    }
    const next = encodeCursor(result.nextCursor, identity, query);
    if (!next) return { ids, values };
    after = next;
  }
  throw new Error("The credential walk did not terminate.");
}

const INTEGRATION_SORTS: IntegrationSortField[] =
  ["displayName", "status", "createdAt", "updatedAt"];
const CREDENTIAL_SORTS: CredentialSortField[] =
  ["displayName", "status", "createdAt", "expiresAt", "lastUsedAt"];
const TIMESTAMP_SORTS = new Set(["createdAt", "updatedAt", "expiresAt", "lastUsedAt"]);

/** Seed one tenant's catalog: long Unicode names, ties, and absent values. */
async function seedCatalog(adminDb: Kysely<DB>): Promise<{
  integrationIds: string[];
  parent: string;
  keyIds: string[];
}> {
  await seedTenant(adminDb);
  // Two integrations share a `created_at` to the microsecond, so the tie-break
  // half of the keyset is exercised inside the walk as well.
  const tie = new Date("2026-05-05T05:05:05.123456Z");
  const integrationIds: string[] = [];
  for (const [index, displayName] of UNICODE_NAMES.entries()) {
    integrationIds.push(await seedIntegration(adminDb, {
      displayName,
      createdAt: index < 2 ? tie : new Date(Date.UTC(2026, 0, 1 + index)),
    }));
  }
  const parent = integrationIds[0]!;
  const keyIds: string[] = [];
  for (const [index, displayName] of UNICODE_NAMES.entries()) {
    keyIds.push(await seedKey(adminDb, {
      integrationId: parent,
      displayName,
      createdAt: index < 2 ? tie : new Date(Date.UTC(2026, 1, 1 + index)),
      // Half of them never expire and half were never used, which puts both
      // nullable sorts' NULL block inside every walk.
      expiresAt: index % 2 === 0 ? null : new Date(Date.UTC(2027, 0, 1 + index)),
      lastUsedAt: index % 2 === 1 ? null : new Date(Date.UTC(2026, 6, 1 + index)),
    }));
  }
  return { integrationIds, parent, keyIds };
}

describe("a cursor this listing issued is one it takes back", () => {
  for (const session of SESSIONS) {
    test(
      `pages every sort both ways under DateStyle ${session.datestyle} in ${session.timezone}`,
      async () => {
        if (!(await serverReachable())) {
          console.log(
            `[api-key cursor] SKIPPED — no PostgreSQL at ${new URL(ADMIN_URL).host}. ` +
              "Set SCRATCH_ADMIN_DATABASE_URL to an isolated server to run this suite.",
          );
          return;
        }
        await withScratchDb(session, async ({ appDb, adminDb }) => {
          const { integrationIds, parent, keyIds } = await seedCatalog(adminDb);

          for (const sortField of INTEGRATION_SORTS) {
            for (const direction of ["asc", "desc"] as const) {
              const walk = await walkIntegrations(appDb, sortField, direction);
              // Every row, exactly once: nothing skipped and nothing repeated,
              // which is what a refused or misread cursor would show as.
              expect({ sortField, direction, rows: walk.ids.length })
                .toEqual({ sortField, direction, rows: integrationIds.length });
              expect([...walk.ids].sort()).toEqual([...integrationIds].sort());
              if (TIMESTAMP_SORTS.has(sortField)) {
                // And the value the DATABASE rendered is the one spelling the
                // decoder accepts — under this DateStyle and this zone.
                for (const value of walk.values) {
                  expect({ sortField, direction, value, canonical: true }).toEqual({
                    sortField,
                    direction,
                    value,
                    canonical: value === null || isCursorTimestamp(value),
                  });
                }
              }
            }
          }

          for (const sortField of CREDENTIAL_SORTS) {
            for (const direction of ["asc", "desc"] as const) {
              const walk = await walkCredentials(appDb, parent, sortField, direction);
              expect({ sortField, direction, rows: walk.ids.length })
                .toEqual({ sortField, direction, rows: keyIds.length });
              expect([...walk.ids].sort()).toEqual([...keyIds].sort());
              if (TIMESTAMP_SORTS.has(sortField)) {
                for (const value of walk.values) {
                  expect({ sortField, direction, value, canonical: true }).toEqual({
                    sortField,
                    direction,
                    value,
                    canonical: value === null || isCursorTimestamp(value),
                  });
                }
              }
            }
          }
        });
      },
      TEST_TIMEOUT,
    );
  }

  test("renders one instant as one cursor value, whatever the session is set to", async () => {
    if (!(await serverReachable())) return;
    // The same instant through the same projection under every session above:
    // one spelling, and it casts back to the instant it came from. This is the
    // property the walks rest on, stated on its own.
    const rendered = new Set<string>();
    for (const session of SESSIONS) {
      await withScratchDb(session, async ({ appDb }) => {
        const row = await sql<{ value: string; same: boolean }>`
          select to_char(('2026-10-28 02:01:45.123456+00'::timestamptz) at time zone 'UTC',
                         'YYYY-MM-DD HH24:MI:SS.US') || '+00' as value,
                 (to_char(('2026-10-28 02:01:45.123456+00'::timestamptz) at time zone 'UTC',
                          'YYYY-MM-DD HH24:MI:SS.US') || '+00')::timestamptz
                   = '2026-10-28 02:01:45.123456+00'::timestamptz as same
        `.execute(appDb);
        expect(row.rows[0]!.same).toBe(true);
        rendered.add(row.rows[0]!.value);
      });
    }
    expect([...rendered]).toEqual(["2026-10-28 02:01:45.123456+00"]);
    expect(isCursorTimestamp([...rendered][0]!)).toBe(true);
  }, TEST_TIMEOUT);

  test("every timestamp the decoder accepts is one the cast accepts", async () => {
    if (!(await serverReachable())) return;
    // The two bounds the regular expression cannot decide, against the
    // database that owns them: the last instant timestamptz holds casts, and
    // the first one past it is an error the decoder must never let through.
    await withScratchDb(SESSIONS[0], async ({ appDb }) => {
      const last = "294276-12-31 23:59:59.999999+00";
      expect(isCursorTimestamp(last)).toBe(true);
      const cast = await sql<{ ok: boolean }>`
        select ${last}::timestamptz = '294276-12-31 23:59:59.999999+00'::timestamptz as ok
      `.execute(appDb);
      expect(cast.rows[0]!.ok).toBe(true);

      const past = "294277-01-01 00:00:00.000000+00";
      expect(isCursorTimestamp(past)).toBe(false);
      await expect(sql`select ${past}::timestamptz`.execute(appDb)).rejects.toThrow();
    });
  }, TEST_TIMEOUT);
});
