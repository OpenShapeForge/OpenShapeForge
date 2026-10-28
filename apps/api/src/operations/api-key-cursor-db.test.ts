// SPDX-License-Identifier: BUSL-1.1
/**
 * The cursor round trip against a real PostgreSQL: every cursor one of these
 * listings ISSUES is one it takes back, whatever the session's date settings
 * are, whatever Unicode the customer named their integration, and however long
 * that name is.
 *
 * All three are properties of the SQL and of the data, so none can be shown
 * with a fake connection:
 *
 *   - `(expr)::text` renders a timestamptz under the session's `DateStyle` and
 *     `TimeZone`. Under `German, DMY` the same row reads
 *     `28.10.2026 07:34:35.96 UTC`, in Amsterdam it reads `+01`. The resume
 *     value is rendered by one statement and cast back by the next, so that
 *     spelling depended on settings this code neither sets nor owns and the
 *     cast then answered with an error instead of a page — a listing that
 *     cannot be paged past its first page, for a database that is configured,
 *     not broken. The projection renders the value itself (`catalog-page.ts`,
 *     `renderSortValue`), so the walks below run under four different
 *     DateStyle/TimeZone pairs and produce the identical value each time.
 *   - a cursor that CARRIED that value was as long as the value. A display
 *     name of 200 emoji is 400 UTF-16 units and 800 bytes, so its cursor was
 *     some 1.1 kB of base64 — past the ceiling that refused it, for a name the
 *     Operations permit. Deriving the ceiling from the name's own bound fixed
 *     that case and not the general one: `display_name` is `text`, and the
 *     REST and GraphQL mounts have accepted a name of ANY length since before
 *     these listings existed, so rows exist that no such ceiling admits. The
 *     cursor now names the row by id, which is one length for every row, and
 *     the walks below page a catalog seeded with names of 200, 1,000 and
 *     20,000 code points through exactly the bound a handler applies.
 *   - an anchor is RESOLVED against the row it names, under the tenant and the
 *     subject binding. So an id this set has no row for is a declared client
 *     error rather than a guessed resume point — proven here for a forged id,
 *     for another tenant's real id, and for a row deleted mid-walk.
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
  ApiKeyValidationError,
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
  MAX_CURSOR_LENGTH,
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

/**
 * Names rows really hold, and long in code points rather than bytes.
 *
 * The first four are at the Operations' own `maxLength`, in code points that
 * are not one UTF-16 unit each. The last two are what the REST and GraphQL
 * mounts accept and have been storing: nothing bounds `display_name`, so these
 * are not hypothetical rows but the ones a cursor ceiling derived from the
 * Operations' bound would have put out of reach.
 */
const UNICODE_NAMES = [
  // The Operations' limit in emoji: 200 code points, 400 UTF-16 units, 800 bytes.
  "🎉".repeat(MAX_DISPLAY_NAME_LENGTH),
  // The same length in a non-Latin script, which is three bytes per character.
  "回".repeat(MAX_DISPLAY_NAME_LENGTH),
  // A name whose lowercase mapping is the interesting one, padded to the limit.
  `İstanbul ${"Ş".repeat(MAX_DISPLAY_NAME_LENGTH - 9)}`,
  // Combining marks, which are their own code points.
  "é".repeat(MAX_DISPLAY_NAME_LENGTH),
  // Five times the Operations' bound, through the older surfaces.
  "🎉".repeat(MAX_DISPLAY_NAME_LENGTH * 5),
  // A hundred times it: 20,000 code points, 80 kB of UTF-8, which as a carried
  // cursor value would have been some 107 kB of base64 — past the authored
  // `after` bound as well as the decoder's.
  `legacy ${"回".repeat(MAX_DISPLAY_NAME_LENGTH * 100)}`,
  "Ordinary partner",
];

/** The rows a walk reached, and every cursor it was handed on the way. */
type Walk = { ids: string[]; cursors: string[] };

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
): Promise<Walk> {
  const identity = { f: sortField, d: direction };
  const query = fingerprint(["integrations", undefined, undefined]);
  const ids: string[] = [];
  const cursors: string[] = [];
  let after: string | undefined;
  for (let page = 0; page < 400; page += 1) {
    const result = await pageIntegrations(serviceDeps(appDb), manager(), {
      sortField,
      sortDirection: direction,
      first: 1,
      ...cursorSpread(decodeCursor(after, identity, query)),
    });
    for (const row of result.rows) ids.push(row.id);
    const next = encodeCursor(result.nextCursor, identity, query);
    if (!next) return { ids, cursors };
    cursors.push(next);
    after = next;
  }
  throw new Error("The integration walk did not terminate.");
}

async function walkCredentials(
  appDb: Kysely<DB>,
  integrationId: string,
  sortField: CredentialSortField,
  direction: "asc" | "desc",
): Promise<Walk> {
  const identity = { f: sortField, d: direction };
  const query = fingerprint(["credentials", integrationId, undefined, undefined]);
  const ids: string[] = [];
  const cursors: string[] = [];
  let after: string | undefined;
  for (let page = 0; page < 400; page += 1) {
    const result = await pageKeys(serviceDeps(appDb), manager(), { integrationId }, {
      sortField,
      sortDirection: direction,
      first: 1,
      ...cursorSpread(decodeCursor(after, identity, query)),
    });
    for (const row of result.rows) ids.push(row.id);
    const next = encodeCursor(result.nextCursor, identity, query);
    if (!next) return { ids, cursors };
    cursors.push(next);
    after = next;
  }
  throw new Error("The credential walk did not terminate.");
}

/**
 * Every cursor the walk was handed fits the bound the decoder applies — which
 * is the property the old value-carrying cursor could not have for the names
 * seeded here, and the reason the bound is no longer a bound on a name.
 */
function expectBoundedCursors(walk: Walk, sortField: string, direction: string): void {
  for (const cursor of walk.cursors) {
    expect({ sortField, direction, within: cursor.length <= MAX_CURSOR_LENGTH })
      .toEqual({ sortField, direction, within: true });
  }
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
              expectBoundedCursors(walk, sortField, direction);
            }
          }

          for (const sortField of CREDENTIAL_SORTS) {
            for (const direction of ["asc", "desc"] as const) {
              const walk = await walkCredentials(appDb, parent, sortField, direction);
              expect({ sortField, direction, rows: walk.ids.length })
                .toEqual({ sortField, direction, rows: keyIds.length });
              expect([...walk.ids].sort()).toEqual([...keyIds].sort());
              expectBoundedCursors(walk, sortField, direction);
            }
          }
        });
      },
      TEST_TIMEOUT,
    );
  }

  test("renders one instant as one value, whatever the session is set to", async () => {
    if (!(await serverReachable())) return;
    // The anchor lookup renders the resume value and the predicate casts it
    // back, two statements in one transaction and one session. Under `German,
    // DMY` an `(expr)::text` rendering would come back `28.10.2026 ...` and the
    // cast would answer with an error rather than a page, so the projection is
    // the property every walk above rests on — stated here on its own.
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
        // Cast back to the same INSTANT, which is what the resume predicate's
        // equality compares on — and to the microsecond, which a `Date` bound
        // through the driver would have rounded away.
        expect(row.rows[0]!.same).toBe(true);
        rendered.add(row.rows[0]!.value);
      });
    }
    expect([...rendered]).toEqual(["2026-10-28 02:01:45.123456+00"]);
  }, TEST_TIMEOUT);
});

describe("an anchor is resolved against a row of this very set", () => {
  test("a cursor whose row this set has no answer for is a client error", async () => {
    if (!(await serverReachable())) return;
    await withScratchDb(SESSIONS[0], async ({ appDb, adminDb }) => {
      const { keyIds } = await seedCatalog(adminDb);
      // A second tenant with its own integration, so "another tenant's real
      // id" is a real id and not merely an unknown one.
      const other = randomUUID();
      await sql`
        insert into platform.tenants (id, slug, name, status, keycloak_realm)
        values (${other}, 'cursor-other', 'Other', 'active', 'openshapeforge')
      `.execute(adminDb);
      const theirs = randomUUID();
      await sql`
        insert into platform.api_key_integrations
          (id, tenant_id, display_name, keycloak_client_id, status, granted_roles,
           created_by, created_at, updated_at)
        values
          (${theirs}, ${other}, 'Theirs', ${`osf-int-${theirs}`}, 'active',
           cast(${[READ_ROLE]} as jsonb), ${USER}, now(), now())
      `.execute(adminDb);

      const identity = { f: "createdAt" as const, d: "asc" as const };
      const query = fingerprint(["integrations", undefined, undefined]);
      const cases: Array<[string, string]> = [
        [randomUUID(), "an id no row of this deployment holds"],
        [theirs, "another tenant's real integration"],
        // A real row of the right shape in the wrong table: a credential's id
        // on the integration listing. The anchor lookup is fenced on the
        // table the page reads, so this resolves to nothing.
        [keyIds[0]!, "a credential's id, on the integration listing"],
      ];
      for (const [id, why] of cases) {
        const cursor = encodeCursor({ id }, identity, query)!;
        let refused: unknown;
        try {
          await pageIntegrations(serviceDeps(appDb), manager(), {
            sortField: identity.f,
            sortDirection: identity.d,
            first: 5,
            ...cursorSpread(decodeCursor(cursor, identity, query)),
          });
        } catch (error) {
          refused = error;
        }
        // Refused, and refused as the declared client error — never a 500 and
        // never a page resumed from a guessed point.
        expect({ why, declined: refused instanceof ApiKeyValidationError })
          .toEqual({ why, declined: true });
      }
    });
  }, TEST_TIMEOUT);

  test("a row removed mid-walk stops the walk rather than skipping a page", async () => {
    if (!(await serverReachable())) return;
    // The one behaviour an id-anchored cursor trades for being bounded. It is
    // safe to trade HERE because nothing in this catalog removes a row — an
    // integration is disabled and a credential revoked, both in place — so
    // this is reachable only by a delete from outside the contract, and the
    // answer to it is a declared client error rather than a wrong page.
    await withScratchDb(SESSIONS[0], async ({ appDb, adminDb }) => {
      const { integrationIds } = await seedCatalog(adminDb);
      const identity = { f: "displayName" as const, d: "asc" as const };
      const query = fingerprint(["integrations", undefined, undefined]);
      const first = await pageIntegrations(serviceDeps(appDb), manager(), {
        sortField: identity.f, sortDirection: identity.d, first: 1,
      });
      const anchor = first.nextCursor!.id;
      expect(integrationIds).toContain(anchor);
      await sql`delete from platform.api_key_integrations where id = ${anchor}`
        .execute(adminDb);
      const cursor = encodeCursor(first.nextCursor, identity, query)!;
      await expect(pageIntegrations(serviceDeps(appDb), manager(), {
        sortField: identity.f,
        sortDirection: identity.d,
        first: 1,
        ...cursorSpread(decodeCursor(cursor, identity, query)),
      })).rejects.toThrow(ApiKeyValidationError);
    });
  }, TEST_TIMEOUT);

  test("the cursor stays one size for a row no name bound would have admitted", async () => {
    if (!(await serverReachable())) return;
    await withScratchDb(SESSIONS[0], async ({ appDb, adminDb }) => {
      await seedCatalog(adminDb);
      // What the listing issues for the longest-named row, and what a cursor
      // that CARRIED that row's sort value would have been. The value is read
      // from the database through the page's own projection, so this is the
      // row's real resume value and not an estimate.
      const identity = { f: "displayName" as const, d: "desc" as const };
      const query = fingerprint(["integrations", undefined, undefined]);
      // Read as the migration role: a bare statement on the app connection
      // carries no tenant, which the row policy answers with nothing.
      const longest = await sql<{ id: string; sort_value: string }>`
        select id, (lower(display_name))::text as sort_value
          from platform.api_key_integrations
         where tenant_id = ${TENANT}
         order by length(display_name) desc
         limit 1
      `.execute(adminDb);
      const row = longest.rows[0]!;
      expect([...row.sort_value].length).toBeGreaterThan(MAX_DISPLAY_NAME_LENGTH * 50);

      const issued = encodeCursor({ id: row.id }, identity, query)!;
      expect(issued.length).toBeLessThanOrEqual(MAX_CURSOR_LENGTH);
      // Decoded by exactly the handler's decoder, and the page it resumes is
      // answered rather than refused.
      const resumed = await pageIntegrations(serviceDeps(appDb), manager(), {
        sortField: identity.f,
        sortDirection: identity.d,
        first: 5,
        ...cursorSpread(decodeCursor(issued, identity, query)),
      });
      expect(resumed.rows.map((listed) => listed.id)).not.toContain(row.id);

      // The same cursor with the value in it, as the listing used to emit:
      // orders of magnitude past the bound any decoder could declare, which is
      // what made this row's page unreachable.
      const carried = Buffer.from(
        JSON.stringify({ f: identity.f, d: identity.d, q: query, v: row.sort_value, i: row.id }),
        "utf8",
      ).toString("base64url");
      expect(carried.length).toBeGreaterThan(MAX_CURSOR_LENGTH * 100);
    });
  }, TEST_TIMEOUT);
});
