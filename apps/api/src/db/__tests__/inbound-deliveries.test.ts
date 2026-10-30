// SPDX-License-Identifier: BUSL-1.1
/**
 * The authenticated inbound tables against a real, migrated scratch database.
 *
 * What only Postgres can answer, and what the unit suites around this one
 * therefore do not try to:
 *
 *  - the pre-authentication read: `app.inbound_endpoint_tenant` answers ONE
 *    tenant for ONE endpoint id, with no tenant session set, and nothing else
 *    about the registration leaves it;
 *  - the privilege model behind both point lookups: SECURITY DEFINER, owned by
 *    the non-login registry resolver, bounded to three columns of the
 *    registration table, with the liveness boolean granted to the worker and
 *    the tenant lookup not;
 *  - the tenant fence on both tables under the restricted app role;
 *  - atomicity: the receipt row and the platform.jobs row that dispatches it
 *    exist together, under one delivery key, and a second delivery of the same
 *    event adds neither;
 *  - the bounded vocabularies, as CHECK constraints — a row naming `md5`, or a
 *    body ceiling above the host's, is refused by the database itself;
 *  - the claim fence on the durable work resolver: work is resolvable only
 *    while the owning job is running at that exact attempt with a live lease
 *    AND its registration is still active in its own tenant — and, in both
 *    directions, where that stops: a revocation before the dispatch mark
 *    prevents it, one after it retracts nothing;
 *  - the serialization point between the two, with real overlapping
 *    transactions on two connections and in both orders: a revocation that wins
 *    the gate refuses the mark that overlapped it, a mark that wins keeps its
 *    attempt and makes the revocation wait, and the gate is scoped to one
 *    (tenant, endpoint) pair rather than to the host;
 *  - the retained payload: encrypted at rest, unreadable to a plain database
 *    read, removed on a bounded schedule once the delivery has settled, and —
 *    while it has NOT settled — kept however old it is and reported overdue,
 *    because the 2xx the provider got accepted work these bytes are the only
 *    remaining copy of.
 *
 * Run (cwd apps/api):
 *   set -o pipefail; bun test src/db/__tests__/inbound-deliveries.test.ts 2>&1
 */
import { expect, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Kysely } from "kysely";
import type {
  RuntimeInboundSignatureScheme, RuntimeOperationDefinition,
} from "@openshapeforge/plugin-runtime";
import type { DB } from "../../generated/db/types.js";
import { createDatabaseRuntime } from "../connection.js";
import { databaseRole } from "../database-roles.js";
import { runMigrationChain } from "../migration-chain.js";
import { APP_ROLE } from "../migrations/app-role.js";
import { DEV_WORKER_ROLE_PASSWORD_DEFAULT, WORKER_ROLE } from "../migrations/worker-role.js";
import { withDbSession } from "../session.js";
import { claimJobs } from "../../jobs/store.js";
import { withJobWorkerSession } from "../../jobs/worker.js";
import { INBOUND_DISPATCH_KIND } from "../../jobs/inbound/kind.js";
import {
  markInboundDispatchInTransaction, markInboundOperationDispatch, pinInboundOperationContract,
  resolveInboundOperationWork,
} from "../../jobs/inbound/work.js";
import { createInboundAdmission } from "../../modules/inbound-admission.js";
import {
  createInboundAdmissionStore, inboundEndpointWriter, revokeInboundEndpoint,
  findInboundConnectionEndpoint, findInboundRegistration, insertInboundEndpoint, revokeInboundConnectionEndpoint,
} from "../../modules/inbound-store.js";
import { createInboundEndpointServices } from "../../modules/inbound-endpoints.js";
import {
  overdueInboundDeliveryBodies, purgeInboundDeliveryBodies,
} from "../../jobs/inbound/retention.js";
import { CONNECTOR_ADMIN_ROLE } from "../../connectors/authorization.js";
import { keyringFromEnv } from "../../platform/secrets.js";
import type { TrustedSessionContext } from "../../auth/trusted-context.js";

const ADMIN_URL = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const APP_ROLE_PASSWORD = "openshapeforge_app";
const TEST_TIMEOUT = 120_000;

const keyring = keyringFromEnv(`inbound-test:${Buffer.alloc(32, 11).toString("base64")}`)!;
const SECRET = "synthetic-scratch-fixture-inbound-secret-012345";
const SERVICE_IDENTITY = "fixture-service-identity";
const OPERATION = "integrations.jira.receiveAdminEvent";
const KEY = "jira-admin";
const jira: RuntimeInboundSignatureScheme = {
  header: "x-hub-signature", algorithm: "sha256", encoding: "hex", prefix: "sha256=",
};

function url(name: string, as?: { user: string; password: string }): string {
  const target = new URL(ADMIN_URL);
  if (target.pathname === "/openshapeforge_dev") throw new Error("admin URL must not point at openshapeforge_dev");
  target.pathname = `/${name}`;
  if (as) { target.username = as.user; target.password = as.password; }
  return target.toString();
}

async function withDb<T>(connection: string, fn: (db: Kysely<DB>) => Promise<T>): Promise<T> {
  const runtime = createDatabaseRuntime({ databaseUrl: connection, maxConnections: 4 });
  try {
    return await fn(runtime.db);
  } finally {
    await runtime.close();
  }
}

type Scratch = {
  admin: Kysely<DB>;
  app: Kysely<DB>;
  worker: Kysely<DB>;
  tenantA: string;
  tenantB: string;
  userA: string;
};

async function withScratch<T>(fn: (scratch: Scratch) => Promise<T>): Promise<T> {
  const name = `inbound_deliveries_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`unsafe scratch database name: ${name}`);
  const server = new SQL(ADMIN_URL, { max: 1 });
  try {
    await server.unsafe(`create database "${name}"`);
    try {
      return await withDb(url(name), async (admin) => {
        await admin.connection().execute((trx) => runMigrationChain(trx));
        const tenantA = randomUUID();
        const tenantB = randomUUID();
        const userA = randomUUID();
        for (const tenant of [tenantA, tenantB]) {
          await sql`
            insert into platform.tenants (id, slug, name, status)
            values (${tenant}::uuid, ${`t-${tenant.slice(0, 8)}`}, ${`T ${tenant.slice(0, 8)}`}, 'active')
          `.execute(admin);
        }
        return withDb(url(name, { user: APP_ROLE, password: APP_ROLE_PASSWORD }), (app) =>
          withDb(url(name, { user: WORKER_ROLE, password: DEV_WORKER_ROLE_PASSWORD_DEFAULT }), (worker) =>
            fn({ admin, app, worker, tenantA, tenantB, userA })));
      });
    } finally {
      await server.unsafe(`drop database if exists "${name}" with (force)`);
    }
  } finally {
    await server.close();
  }
}

/**
 * What production hands the registration surface: a verified person holding
 * the canonical integration-administration role. Spelled out here rather than
 * stubbed away, so this suite registers through the real authorization.
 */
function tenantSession(tenantId: string, userId: string): TrustedSessionContext {
  return {
    tenantId, userId, credential: "bearer", principalKind: "person",
    roles: [CONNECTOR_ADMIN_ROLE], groups: [], relationGroupIds: [], scope: "tenant",
  } as unknown as TrustedSessionContext;
}

/** Keyed, as the durable broker requires of any inbound dispatch target. */
const operation = {
  id: OPERATION, intent: "receiveAdminEvent", name: "Receive", description: "",
  input: {}, output: {},
  effects: { data: "write", external: "none" },
  reliability: { idempotency: { mode: "keyed", inputField: "idempotencyKey" } },
} as unknown as RuntimeOperationDefinition;

/** The registration surface, with the live-capability fence open for the test. */
function registrar(app: Kysely<DB>) {
  return createInboundEndpointServices({
    acceptsSession: () => true,
    serviceIdentity: () => SERVICE_IDENTITY,
    // Core's catalog is not booted here; the Operation binding itself is proved
    // in modules/inbound-endpoints.test.ts.
    resolveOperation: async (_session, operationId) =>
      (operationId === OPERATION ? operation : undefined),
    keyring,
    store: inboundEndpointWriter(app),
  });
}

function admitter(app: Kysely<DB>) {
  return createInboundAdmission({
    store: createInboundAdmissionStore(app), keyring: () => keyring,
  });
}

const BODY = Buffer.from('{ "webhookEvent": "user_created", "user": { "accountId": "a1" } }');

function delivery(bytes: Uint8Array = BODY, deliveryId: string | undefined = "atl-1") {
  const headers: Record<string, string | undefined> = {
    "x-hub-signature": `sha256=${createHmac("sha256", SECRET).update(bytes).digest("hex")}`,
    "x-atlassian-webhook-identifier": deliveryId,
  };
  return { header: (name: string) => headers[name], body: bytes };
}

async function register(app: Kysely<DB>, tenantId: string, userId: string) {
  return registrar(app).register(tenantSession(tenantId, userId), {
    endpointKey: KEY, signature: jira, secret: SECRET,
    identity: { source: "body-digest", eventTypePath: "webhookEvent" },
    unsignedHeaders: {
      deliveryId: "x-atlassian-webhook-identifier",
      eventType: "x-atlassian-webhook-event",
    },
    dispatch: { operationId: OPERATION, inputField: "delivery" },
  });
}

/**
 * Wait, bounded, until two DIFFERENT backends contend on the SAME advisory key
 * in this database: one holding it, one queued behind it.
 *
 * This is the dispatch gate observed from outside, and it is what makes the
 * overlap in the two tests below an overlap rather than a hope about timing.
 * Observed rather than assumed: the second statement is provably waiting for
 * the first transaction to commit, so the order of the two decisions is the
 * order the test arranged. The deadline is well under the 5s either side waits
 * for the gate, so a gate that never contends fails the test instead of hanging
 * it.
 */
async function awaitGateContention(admin: Kysely<DB>, deadlineMs = 3_000): Promise<void> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const seen = await sql<{ contended: boolean }>`
      select exists (
        select 1
          from pg_locks waiting
          join pg_locks held
            on held.locktype = 'advisory' and held.granted
           and held.database = waiting.database and held.classid = waiting.classid
           and held.objid = waiting.objid and held.objsubid = waiting.objsubid
           and held.pid <> waiting.pid
         where waiting.locktype = 'advisory' and not waiting.granted
           and waiting.database = (select oid from pg_database where datname = current_database())
      ) as contended
    `.execute(admin);
    if (seen.rows[0]?.contended) return;
    if (Date.now() > until) throw new Error("the inbound dispatch gate was never contended");
    await new Promise((settle) => setTimeout(settle, 10));
  }
}

async function count(db: Kysely<DB>, table: string, where: string, value: string): Promise<number> {
  const result = await sql<{ n: string }>`
    select count(*)::text as n from ${sql.table(table)} where ${sql.ref(where)} = ${value}
  `.execute(db);
  return Number(result.rows[0]?.n ?? "0");
}

test("the pre-authentication lookup answers one tenant for one endpoint, and nothing more", async () => {
  await withScratch(async ({ app, tenantA, tenantB, userA }) => {
    const endpoint = await register(app, tenantA, userA);
    const other = await register(app, tenantB, randomUUID());

    // No tenant GUC is set on this connection: this is exactly the state
    // admission is in when a delivery arrives.
    const found = await sql<{ tenant: string | null }>`
      select app.inbound_endpoint_tenant(${endpoint.id}::uuid) as tenant
    `.execute(app);
    expect(found.rows[0]?.tenant).toBe(tenantA);
    const second = await sql<{ tenant: string | null }>`
      select app.inbound_endpoint_tenant(${other.id}::uuid) as tenant
    `.execute(app);
    expect(second.rows[0]?.tenant).toBe(tenantB);
    const unknown = await sql<{ tenant: string | null }>`
      select app.inbound_endpoint_tenant(${randomUUID()}::uuid) as tenant
    `.execute(app);
    expect(unknown.rows[0]?.tenant).toBeNull();

    // A plain select without a tenant session still sees nothing: the lookup
    // is a definer point function, so the CALLER never gains the reach.
    const leaked = await sql<{ n: string }>`select count(*)::text as n from platform.inbound_endpoints`.execute(app);
    expect(Number(leaked.rows[0]?.n)).toBe(0);

    // And it raises no bypass setting for the rest of the caller's
    // transaction — the property migrations/identity-link.ts states and
    // __tests__/managed-identity-lookups.test.ts proves for its own lookups. A
    // transaction, because `set_config(…, true)` would be undone by the
    // statement boundary otherwise and the assertion would prove nothing.
    const bypass = await app.transaction().execute(async (trx) => {
      await sql`select app.inbound_endpoint_tenant(${endpoint.id}::uuid)`.execute(trx);
      const seen = await sql<{ bypass: string }>`
        select coalesce(current_setting('app.bypass_rls', true), '') as bypass
      `.execute(trx);
      return seen.rows[0]?.bypass;
    });
    expect(bypass).toBe("");
  });
}, TEST_TIMEOUT);

test("the two point lookups are definer-owned, column-bounded and separately granted", async () => {
  await withScratch(async ({ admin }) => {
    const resolver = databaseRole("identityResolver").name;
    const functions = await sql<{
      name: string; definer: boolean; owner: string; config: string[] | null; publicExecute: boolean;
      worker: boolean; app: boolean;
    }>`
      select p.proname as name, p.prosecdef as definer, owner.rolname as owner,
             p.proconfig as config,
             -- A NULL proacl is not "no grants": it means the DEFAULT acl,
             -- which hands EXECUTE to PUBLIC. acldefault() is what makes the
             -- two cases one question.
             coalesce((
               select bool_or(a.grantee = 0)
                 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                where a.privilege_type = 'EXECUTE'
             ), false) as "publicExecute",
             has_function_privilege(${WORKER_ROLE}::name, p.oid, 'execute') as worker,
             has_function_privilege(${APP_ROLE}::name, p.oid, 'execute') as app
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        join pg_roles owner on owner.oid = p.proowner
       where n.nspname = 'app'
         and p.proname in ('inbound_endpoint_tenant', 'inbound_endpoint_active')
       order by p.proname
    `.execute(admin);
    expect(functions.rows.map((row) => row.name))
      .toEqual(["inbound_endpoint_active", "inbound_endpoint_tenant"]);
    for (const row of functions.rows) {
      // SECURITY DEFINER with a pinned search_path, owned by the non-login
      // registry resolver — not by the migrate role, which owns every table.
      expect(row.definer).toBe(true);
      expect(row.owner).toBe(resolver);
      // The pinned path, read back as Postgres stored it rather than as it was
      // authored: what matters is that one is set and that it resolves no
      // schema a caller could plant a function in.
      const searchPath = (row.config ?? []).find((entry) => entry.startsWith("search_path="));
      expect(searchPath).toContain("pg_catalog");
      expect(searchPath).not.toContain("public");
      // `create function` hands EXECUTE to PUBLIC by default; both revoke it.
      expect(row.publicExecute).toBe(false);
      expect(row.app).toBe(true);
    }
    // The worker gets the tenant-paired liveness boolean and nothing beside
    // it, AFTER the sweep that grants EXECUTE on every function in `app`.
    const byName = new Map(functions.rows.map((row) => [row.name, row]));
    expect(byName.get("inbound_endpoint_active")?.worker).toBe(true);
    expect(byName.get("inbound_endpoint_tenant")?.worker).toBe(false);

    // The definer's own reach: three columns, read-only. The sealed secret is
    // outside the grant, so it is unreachable THROUGH the definer rather than
    // merely unselected by its current body.
    const columns = await sql<{ column_name: string; privilege_type: string }>`
      select column_name, privilege_type
        from information_schema.role_column_grants
       where grantee = ${resolver}
         and table_schema = 'platform' and table_name = 'inbound_endpoints'
       order by column_name, privilege_type
    `.execute(admin);
    expect(columns.rows).toEqual([
      { column_name: "id", privilege_type: "SELECT" },
      { column_name: "status", privilege_type: "SELECT" },
      { column_name: "tenant_id", privilege_type: "SELECT" },
    ]);

    // And the worker holds nothing on the registration table at all — neither
    // a table grant nor a column of one.
    const workerReach = await sql<{ n: string }>`
      select count(*)::text as n from (
        select 1 from information_schema.role_table_grants
         where grantee = ${WORKER_ROLE}
           and table_schema = 'platform' and table_name = 'inbound_endpoints'
        union all
        select 1 from information_schema.role_column_grants
         where grantee = ${WORKER_ROLE}
           and table_schema = 'platform' and table_name = 'inbound_endpoints'
      ) reach
    `.execute(admin);
    expect(Number(workerReach.rows[0]?.n)).toBe(0);
  });
}, TEST_TIMEOUT);

test("registrations and receipts are fenced to their own tenant under the app role", async () => {
  await withScratch(async ({ app, tenantA, tenantB, userA }) => {
    const endpoint = await register(app, tenantA, userA);
    await register(app, tenantB, randomUUID());
    expect((await admitter(app)({ endpointKey: KEY, endpointId: endpoint.id, ...delivery() })).outcome)
      .toBe("accepted");

    const asA = await withDbSession(app, tenantSession(tenantA, userA), async (trx) => ({
      endpoints: await sql<{ n: string }>`select count(*)::text as n from platform.inbound_endpoints`.execute(trx),
      deliveries: await sql<{ n: string }>`select count(*)::text as n from platform.inbound_deliveries`.execute(trx),
    }));
    expect(Number(asA.endpoints.rows[0]?.n)).toBe(1);
    expect(Number(asA.deliveries.rows[0]?.n)).toBe(1);

    const asB = await withDbSession(app, tenantSession(tenantB, randomUUID()), async (trx) => ({
      endpoints: await sql<{ n: string }>`select count(*)::text as n from platform.inbound_endpoints`.execute(trx),
      deliveries: await sql<{ n: string }>`select count(*)::text as n from platform.inbound_deliveries`.execute(trx),
    }));
    // B sees its own registration and none of A's, and no receipt at all.
    expect(Number(asB.endpoints.rows[0]?.n)).toBe(1);
    expect(Number(asB.deliveries.rows[0]?.n)).toBe(0);
  });
}, TEST_TIMEOUT);

test("an accepted delivery commits its receipt and its dispatch job together", async () => {
  await withScratch(async ({ admin, app, tenantA, userA }) => {
    const endpoint = await register(app, tenantA, userA);
    const accepted = await admitter(app)({ endpointKey: KEY, endpointId: endpoint.id, ...delivery() });
    expect(accepted.outcome).toBe("accepted");

    const rows = await sql<{
      id: string; status: string; idempotency_key: string; dispatch_job_id: string | null;
      unsigned_provider_delivery_id: string | null; event_type: string | null;
      body_ciphertext: string | null; body_bytes: number; body_purged_at: string | null;
      service_identity_id: string; operation_id: string; operation_input_field: string;
      dispatch_state: string;
    }>`select * from platform.inbound_deliveries`.execute(admin);
    const row = rows.rows[0]!;
    expect(rows.rows).toHaveLength(1);
    expect(row.status).toBe("pending");
    expect(row.dispatch_state).toBe("none");
    expect(row.unsigned_provider_delivery_id).toBe("atl-1");
    // Read from inside the signature, not from the header beside it.
    expect(row.event_type).toBe("user_created");
    expect(row.service_identity_id).toBe(SERVICE_IDENTITY);
    expect(row.operation_id).toBe(OPERATION);
    expect(row.operation_input_field).toBe("delivery");
    // The payload is at rest as ciphertext: a privileged database read — the
    // most privileged one there is, the admin connection — recovers nothing.
    expect(row.body_purged_at).toBeNull();
    expect(row.body_bytes).toBe(BODY.byteLength);
    expect(row.body_ciphertext).not.toContain(BODY.toString("base64"));
    expect(Buffer.from(row.body_ciphertext!, "base64").includes("accountId")).toBe(false);

    const jobs = await sql<{ id: string; kind: string; delivery_key: string; status: string; actor_id: string; subject_id: string | null }>`
      select id, kind, delivery_key, status, actor_id, subject_id from platform.jobs
    `.execute(admin);
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]?.kind).toBe(INBOUND_DISPATCH_KIND);
    // One key at both levels: the receipt's and the queue's.
    expect(jobs.rows[0]?.delivery_key).toBe(row.idempotency_key);
    expect(jobs.rows[0]?.subject_id).toBe(row.id);
    expect(row.dispatch_job_id).toBe(jobs.rows[0]!.id);
    // The queue's actor is the registering user — bookkeeping, not authority.
    expect(jobs.rows[0]?.actor_id).toBe(userA);
  });
}, TEST_TIMEOUT);

test("a repeated delivery adds no second receipt and no second dispatch", async () => {
  await withScratch(async ({ admin, app, tenantA, userA }) => {
    const endpoint = await register(app, tenantA, userA);
    const admit = admitter(app);
    const first = await admit({ endpointKey: KEY, endpointId: endpoint.id, ...delivery() });
    const second = await admit({ endpointKey: KEY, endpointId: endpoint.id, ...delivery() });
    expect(first.outcome).toBe("accepted");
    expect(second).toEqual({ outcome: "duplicate", deliveryId: (first as { deliveryId: string }).deliveryId });
    expect(await count(admin, "platform.inbound_deliveries", "endpoint_id", endpoint.id)).toBe(1);
    expect(await count(admin, "platform.jobs", "kind", INBOUND_DISPATCH_KIND)).toBe(1);

    // A genuinely different event on the same endpoint is not a duplicate.
    const other = Buffer.from('{ "webhookEvent": "user_deleted" }');
    expect((await admit({ endpointKey: KEY, endpointId: endpoint.id, ...delivery(other, "atl-2") })).outcome)
      .toBe("accepted");
    expect(await count(admin, "platform.inbound_deliveries", "endpoint_id", endpoint.id)).toBe(2);
  });
}, TEST_TIMEOUT);

test("a forged signature and a revoked registration both keep the tables empty", async () => {
  await withScratch(async ({ admin, app, tenantA, userA }) => {
    const endpoint = await register(app, tenantA, userA);
    const admit = admitter(app);
    const forged = { header: () => `sha256=${"0".repeat(64)}`, body: BODY };
    expect(await admit({ endpointKey: KEY, endpointId: endpoint.id, ...forged })).toEqual({ outcome: "rejected" });
    const unsigned = { header: () => undefined, body: BODY };
    expect(await admit({ endpointKey: KEY, endpointId: endpoint.id, ...unsigned })).toEqual({ outcome: "rejected" });
    expect(await count(admin, "platform.inbound_deliveries", "endpoint_id", endpoint.id)).toBe(0);

    await registrar(app).revoke(tenantSession(tenantA, userA), { id: endpoint.id, reason: "subscription removed" });
    expect(await admit({ endpointKey: KEY, endpointId: endpoint.id, ...delivery() }))
      .toEqual({ outcome: "rejected" });
    expect(await count(admin, "platform.inbound_deliveries", "endpoint_id", endpoint.id)).toBe(0);
    // Revocation is recorded, not deleted: the registration's history stays.
    const revoked = await sql<{ status: string; revoked_at: string | null }>`
      select status, revoked_at from platform.inbound_endpoints where id = ${endpoint.id}::uuid
    `.execute(admin);
    expect(revoked.rows[0]?.status).toBe("revoked");
    expect(revoked.rows[0]?.revoked_at).not.toBeNull();
  });
}, TEST_TIMEOUT);

test("the database refuses a registration outside the admitted vocabularies", async () => {
  await withScratch(async ({ admin, tenantA, userA }) => {
    const insert = (columns: Record<string, string | number | null>) => {
      const base: Record<string, string | number | null> = {
        id: randomUUID(), tenant_id: tenantA, endpoint_key: KEY,
        signature_header: "x-hub-signature", signature_algorithm: "sha256",
        signature_encoding: "hex", signature_prefix: "sha256=",
        identity_source: "body-digest", identity_fields: null, identity_event_type_path: null,
        unsigned_delivery_id_header: null, unsigned_event_type_header: null,
        max_body_bytes: 262144,
        secret_ciphertext: "x", secret_key_id: "k", secret_algorithm: "aes-256-gcm",
        service_identity_id: SERVICE_IDENTITY, operation_id: OPERATION,
        operation_input_field: "delivery", created_by: userA, ...columns,
      };
      const keys = Object.keys(base);
      return sql`
        insert into platform.inbound_endpoints (${sql.join(keys.map((key) => sql.ref(key)))})
        values (${sql.join(keys.map((key) => sql`${base[key]}`))})
      `.execute(admin);
    };
    // A sound registration still inserts, so the refusals below are the
    // constraints and not a mistake in this fixture.
    await insert({});
    // The one that matters: createHmac would honour md5 without complaint.
    await expect(insert({ signature_algorithm: "md5" })).rejects.toThrow();
    await expect(insert({ signature_algorithm: "sha1" })).rejects.toThrow();
    await expect(insert({ signature_encoding: "base32" })).rejects.toThrow();
    // A registration cannot raise the host's body ceiling by storing a bigger one.
    await expect(insert({ max_body_bytes: 262145 })).rejects.toThrow();
    await expect(insert({ max_body_bytes: 0 })).rejects.toThrow();
    await expect(insert({ endpoint_key: "Jira-Admin" })).rejects.toThrow();
    await expect(insert({ signature_header: "X-Hub-Signature" })).rejects.toThrow();
    await expect(insert({ operation_input_field: "not a field" })).rejects.toThrow();
    await expect(insert({ status: "active", revoked_at: "2026-10-30T00:00:00Z" })).rejects.toThrow();
    // The identity vocabulary. A row naming a header source is refused by the
    // database as well as by the registration path, so the one failure this
    // feature must never have cannot be reintroduced by a hand-written row.
    await expect(insert({ identity_source: "header" })).rejects.toThrow();
    await expect(insert({ identity_source: "delivery-id-header" })).rejects.toThrow();
    // Source and fields must agree in both directions. The null case is the
    // one a CHECK quietly admits if the constraint leaves it to the regex:
    // `null ~ '…'` is UNKNOWN and a CHECK admits UNKNOWN, so a `body-field`
    // profile with no paths at all would be stored and then refused only by
    // the application that was never meant to be the last line.
    await expect(insert({ identity_source: "body-field", identity_fields: null })).rejects.toThrow();
    await expect(insert({ identity_source: "body-field", identity_fields: "" })).rejects.toThrow();
    await expect(insert({ identity_source: "body-field", identity_fields: "a," })).rejects.toThrow();
    await expect(insert({ identity_source: "body-digest", identity_fields: "issue.id" }))
      .rejects.toThrow();
    await expect(insert({ identity_source: "body-field", identity_fields: "issue id" }))
      .rejects.toThrow();
    // Shape only, deliberately: `__proto__` is a well-formed path to Postgres
    // and is refused where it matters — `storedInboundIdentity` answers no
    // usable profile, so admission refuses the row rather than walking it.
    await expect(insert({ identity_source: "body-field", identity_fields: "__proto__,a" }))
      .resolves.toBeDefined();
    await expect(insert({ identity_event_type_path: "not a path" })).rejects.toThrow();
    // A sound body-field registration still inserts.
    await expect(insert({
      identity_source: "body-field", identity_fields: "webhookEvent,issue.id",
      identity_event_type_path: "webhookEvent",
    })).resolves.toBeDefined();
  });
}, TEST_TIMEOUT);

test("a receipt cannot point at another tenant's registration", async () => {
  await withScratch(async ({ admin, app, tenantA, tenantB, userA }) => {
    const endpoint = await register(app, tenantA, userA);
    // The tenant-paired reference is what refuses this, structurally, rather
    // than any application check.
    await expect(sql`
      insert into platform.inbound_deliveries (
        tenant_id, endpoint_id, endpoint_key, service_identity_id, operation_id,
        operation_input_field, idempotency_key, body_sha256, body_bytes,
        body_ciphertext, body_key_id, body_algorithm
      ) values (
        ${tenantB}::uuid, ${endpoint.id}::uuid, ${KEY}, ${SERVICE_IDENTITY}, ${OPERATION},
        'delivery', ${`inbound.${endpoint.id}.${"a".repeat(64)}`}, ${"b".repeat(64)}, 4,
        'e30=', 'inbound-test', 'aes-256-gcm'
      )
    `.execute(admin)).rejects.toThrow();
  });
}, TEST_TIMEOUT);

test("durable work resolves only under the live claim, and its contract pins once", async () => {
  await withScratch(async ({ admin, app, worker, tenantA, userA }) => {
    const endpoint = await register(app, tenantA, userA);
    const accepted = await admitter(app)({ endpointKey: KEY, endpointId: endpoint.id, ...delivery() });
    const deliveryId = (accepted as { deliveryId: string }).deliveryId;
    const resolve = resolveInboundOperationWork(worker, () => keyring);
    const pin = pinInboundOperationContract(worker);
    const mark = markInboundOperationDispatch(worker);
    const workerId = randomUUID();

    // Unclaimed: the job is queued, so there is no work to authorize.
    expect(await resolve({ workId: deliveryId, attempt: 1, workerId })).toBeUndefined();

    const claimed = await withJobWorkerSession(worker, (trx) =>
      claimJobs(trx, { limit: 5, leaseSeconds: 120, kinds: [INBOUND_DISPATCH_KIND] }));
    expect(claimed).toHaveLength(1);
    const reference = { workId: deliveryId, attempt: claimed[0]!.attempts, workerId };

    const work = await resolve(reference);
    expect(work?.tenantId).toBe(tenantA);
    expect(work?.serviceIdentityId).toBe(SERVICE_IDENTITY);
    expect(work?.operation.id).toBe(OPERATION);
    expect(work?.operation.idempotencyKey).toMatch(/^inbound\.[0-9a-f-]{36}\.[0-9a-f]{64}$/);
    // Dispatch facts are tracked, and no attempt has started one yet — so a
    // later attempt is not treated as an uncertain repeat.
    expect(work?.dispatch).toEqual({ tracked: true });
    const envelope = work?.operation.input?.delivery as {
      body: string; endpointKey: string; eventType: string | null;
      unsigned: { providerDeliveryId: string | null; eventType: string | null };
    };
    expect(envelope.endpointKey).toBe(KEY);
    // Signed and unsigned reach the Operation separately, and only the signed
    // event name is presented as one.
    expect(envelope.eventType).toBe("user_created");
    expect(envelope.unsigned.providerDeliveryId).toBe("atl-1");
    // The worker opened the sealed payload under the row's own scope, so the
    // Operation receives the exact bytes the provider signed.
    expect(Buffer.from(envelope.body, "base64").equals(BODY)).toBe(true);
    // The envelope carries no secret and no registration internals.
    expect(JSON.stringify(envelope)).not.toContain(SECRET);

    // Another attempt number is another claim: refused.
    expect(await resolve({ ...reference, attempt: reference.attempt + 1 })).toBeUndefined();

    const fingerprint = `sha256:${"c".repeat(64)}`;
    await pin(reference, fingerprint);
    expect((await resolve(reference))?.operationContractFingerprint).toBe(fingerprint);
    // Pinning the SAME contract again is the idempotent case; a different one
    // is refused, so a reclaim cannot replace what an attempt was authorized
    // against.
    await pin(reference, fingerprint);
    await expect(pin(reference, `sha256:${"d".repeat(64)}`)).rejects.toThrow();

    await mark(reference, "started");
    expect((await resolve(reference))?.dispatch).toEqual({ tracked: true, attempt: reference.attempt });
    // Proof that nothing reached the Operation clears the uncertainty again.
    await mark(reference, "not-dispatched");
    expect((await resolve(reference))?.dispatch).toEqual({ tracked: true });

    // A lease that has expired is no claim: resolve, pin and mark all refuse.
    await sql`update platform.jobs set lease_until = now() - interval '1 minute' where id = ${claimed[0]!.id}::uuid`
      .execute(admin);
    expect(await resolve(reference)).toBeUndefined();
    await expect(pin(reference, fingerprint)).rejects.toThrow();
    await expect(mark(reference, "started")).rejects.toThrow();
  });
}, TEST_TIMEOUT);

test("a revocation that commits before dispatch stops the queued dispatch", async () => {
  await withScratch(async ({ admin, app, worker, tenantA, userA }) => {
    const endpoint = await register(app, tenantA, userA);
    const accepted = await admitter(app)({ endpointKey: KEY, endpointId: endpoint.id, ...delivery() });
    const deliveryId = (accepted as { deliveryId: string }).deliveryId;
    const resolve = resolveInboundOperationWork(worker, () => keyring);
    const mark = markInboundOperationDispatch(worker);

    const claimed = await withJobWorkerSession(worker, (trx) =>
      claimJobs(trx, { limit: 5, leaseSeconds: 120, kinds: [INBOUND_DISPATCH_KIND] }));
    const reference = { workId: deliveryId, attempt: claimed[0]!.attempts, workerId: randomUUID() };
    // The job is live and the work resolves — this is the window a pending
    // dispatch sits in.
    expect(await resolve(reference)).toBeDefined();

    // The tenant stops the subscription. The job is untouched: still running,
    // still at this attempt, still leased. Only the registration changed.
    await registrar(app).revoke(tenantSession(tenantA, userA), { id: endpoint.id });
    const stillClaimed = await sql<{ status: string; attempts: number }>`
      select status, attempts from platform.jobs where id = ${claimed[0]!.id}::uuid
    `.execute(admin);
    expect(stillClaimed.rows[0]?.status).toBe("running");
    expect(stillClaimed.rows[0]?.attempts).toBe(reference.attempt);

    // The broker re-resolves immediately before dispatch, and this is what it
    // now sees: nothing. Nothing is launched.
    expect(await resolve(reference)).toBeUndefined();
    // And the mark that commits BEFORE a request leaves refuses too, so a
    // revocation landing inside that step also prevents the dispatch.
    await expect(mark(reference, "started")).rejects.toThrow();
    const row = await sql<{ status: string; dispatch_state: string }>`
      select status, dispatch_state from platform.inbound_deliveries where id = ${deliveryId}::uuid
    `.execute(admin);
    // The receipt itself is not withdrawn, and nothing claims a dispatch
    // started: `none` is the record that one provably did not.
    expect(row.rows[0]?.status).toBe("pending");
    expect(row.rows[0]?.dispatch_state).toBe("none");
  });
}, TEST_TIMEOUT);

test("a revocation after a recorded dispatch retracts nothing, and says so on the row", async () => {
  await withScratch(async ({ admin, app, worker, tenantA, userA }) => {
    const endpoint = await register(app, tenantA, userA);
    const accepted = await admitter(app)({ endpointKey: KEY, endpointId: endpoint.id, ...delivery() });
    const deliveryId = (accepted as { deliveryId: string }).deliveryId;
    const resolve = resolveInboundOperationWork(worker, () => keyring);
    const mark = markInboundOperationDispatch(worker);

    const claimed = await withJobWorkerSession(worker, (trx) =>
      claimJobs(trx, { limit: 5, leaseSeconds: 120, kinds: [INBOUND_DISPATCH_KIND] }));
    const reference = { workId: deliveryId, attempt: claimed[0]!.attempts, workerId: randomUUID() };

    // The dispatch mark commits while the registration is still live, which is
    // the window a request actually leaves in. The revocation lands after it —
    // one step too late, which is the limit this feature claims rather than
    // hides.
    await mark(reference, "started");
    await registrar(app).revoke(tenantSession(tenantA, userA), { id: endpoint.id });

    // The guarantee is about what the next STEP sees, not about the request
    // already in flight: further work on this claim is refused...
    expect(await resolve(reference)).toBeUndefined();
    await expect(mark(reference, "not-dispatched")).rejects.toThrow();
    // ...and the record of the started attempt stands, because retracting it
    // would claim knowledge of a request this host cannot recall. The row says
    // which case it was, which is what an operator needs.
    const row = await sql<{ status: string; dispatch_state: string; dispatch_attempt: number | null }>`
      select status, dispatch_state, dispatch_attempt from platform.inbound_deliveries
       where id = ${deliveryId}::uuid
    `.execute(admin);
    expect(row.rows[0]).toEqual({
      status: "dispatching", dispatch_state: "started", dispatch_attempt: reference.attempt,
    });
  });
}, TEST_TIMEOUT);

test("a revocation that wins the gate refuses the dispatch mark that overlapped it", async () => {
  await withScratch(async ({ admin, app, worker, tenantA, tenantB, userA }) => {
    const endpoint = await register(app, tenantA, userA);
    const accepted = await admitter(app)({ endpointKey: KEY, endpointId: endpoint.id, ...delivery() });
    const deliveryId = (accepted as { deliveryId: string }).deliveryId;
    // Tenant B keeps its own registration and its own queued delivery, both
    // live throughout, so the gate's scope is testable rather than assumed.
    const otherEndpoint = await register(app, tenantB, randomUUID());
    const otherAccepted = await admitter(app)({
      endpointKey: KEY, endpointId: otherEndpoint.id, ...delivery(),
    });
    const otherDeliveryId = (otherAccepted as { deliveryId: string }).deliveryId;

    const resolve = resolveInboundOperationWork(worker, () => keyring);
    const mark = markInboundOperationDispatch(worker);
    const claimed = await withJobWorkerSession(worker, (trx) =>
      claimJobs(trx, { limit: 5, leaseSeconds: 120, kinds: [INBOUND_DISPATCH_KIND] }));
    const claimOf = (id: string) => claimed.find((job) => job.subject?.id === id)!;
    const reference = {
      workId: deliveryId, attempt: claimOf(deliveryId).attempts, workerId: randomUUID(),
    };
    const otherReference = {
      workId: otherDeliveryId, attempt: claimOf(otherDeliveryId).attempts, workerId: randomUUID(),
    };
    // The window a pending dispatch sits in: the work resolves.
    expect(await resolve(reference)).toBeDefined();

    const overlap = await withDbSession(app, tenantSession(tenantA, userA), async (trx) => {
      // The real revocation, inside a transaction this test holds OPEN: it has
      // taken the gate and written the status, and has not committed.
      const revoked = await revokeInboundEndpoint(trx, { id: endpoint.id, reason: "subscription removed" });
      expect(revoked?.status).toBe("revoked");

      // The dispatch mark the broker runs next, on the worker connection. It
      // cannot see the uncommitted revocation, which is exactly the race: on a
      // snapshot of its own it would still read the endpoint as active and
      // commit a started dispatch under a registration being revoked. Instead
      // it queues on the gate — proved below, not assumed.
      const overlapped = mark(reference, "started")
        .then(() => "marked" as const, (error: unknown) => String((error as Error).message));
      await awaitGateContention(admin);

      // The gate is one (tenant, endpoint) pair and not a host-wide one:
      // tenant B's dispatch is decided WHILE A's revocation holds its own gate,
      // without waiting for it.
      const crossTenant = mark(otherReference, "started")
        .then(() => "marked" as const, () => "refused" as const);
      expect(await crossTenant).toBe("marked");
      return { overlapped };
    });

    // The revocation committed first, so the mark that waited for it loses: the
    // gate made the mark's predicate decide on a snapshot taken after that
    // commit. Nothing was launched. The refusal is the claim-lost one, which is
    // what says the mark reached its UPDATE and SAW the revocation — not that it
    // gave up waiting for the lock, which would prove nothing about the order.
    expect(await overlap.overlapped).toContain("claim was lost while recording its dispatch");
    const row = await sql<{ status: string; dispatch_state: string; dispatch_attempt: number | null }>`
      select status, dispatch_state, dispatch_attempt from platform.inbound_deliveries
       where id = ${deliveryId}::uuid
    `.execute(admin);
    // `none` is the record that a dispatch provably did not start.
    expect(row.rows[0]).toEqual({ status: "pending", dispatch_state: "none", dispatch_attempt: null });
    // And nothing is authorized afterwards either.
    expect(await resolve(reference)).toBeUndefined();
    await expect(mark(reference, "started")).rejects.toThrow();

    // Tenant B's attempt stands, untouched by A's revocation.
    const otherRow = await sql<{ dispatch_state: string; dispatch_attempt: number | null }>`
      select dispatch_state, dispatch_attempt from platform.inbound_deliveries
       where id = ${otherDeliveryId}::uuid
    `.execute(admin);
    expect(otherRow.rows[0])
      .toEqual({ dispatch_state: "started", dispatch_attempt: otherReference.attempt });

    // And the gate's own statement reaches no further than the tenant policy
    // does: another tenant asking to revoke this registration takes no lock on
    // it and sees no row, which is the same refusal as before.
    expect(await withDbSession(app, tenantSession(tenantB, randomUUID()), (trx) =>
      revokeInboundEndpoint(trx, { id: endpoint.id, reason: null }))).toBeUndefined();
  });
}, TEST_TIMEOUT);

test("a dispatch mark that wins the gate keeps its attempt and makes the revocation wait", async () => {
  await withScratch(async ({ admin, app, worker, tenantA, userA }) => {
    const endpoint = await register(app, tenantA, userA);
    const accepted = await admitter(app)({ endpointKey: KEY, endpointId: endpoint.id, ...delivery() });
    const deliveryId = (accepted as { deliveryId: string }).deliveryId;
    const resolve = resolveInboundOperationWork(worker, () => keyring);
    const mark = markInboundOperationDispatch(worker);
    const claimed = await withJobWorkerSession(worker, (trx) =>
      claimJobs(trx, { limit: 5, leaseSeconds: 120, kinds: [INBOUND_DISPATCH_KIND] }));
    const reference = { workId: deliveryId, attempt: claimed[0]!.attempts, workerId: randomUUID() };

    const overlap = await withJobWorkerSession(worker, async (trx) => {
      // The real mark, inside a transaction this test holds OPEN. That it runs
      // at all on this connection is the privilege statement: the `job-worker`
      // role takes the gate for a registration it may not read, because an
      // advisory key is not a catalog object and no grant was widened for it.
      await markInboundDispatchInTransaction(trx, reference, "started");
      // The revocation the tenant issues through the real service while that
      // attempt is uncommitted. It queues on the gate rather than committing
      // underneath the mark.
      const revocation = registrar(app).revoke(tenantSession(tenantA, userA), { id: endpoint.id })
        .then((revoked) => revoked.status, () => "refused" as const);
      await awaitGateContention(admin);
      return { revocation };
    });

    // The mark committed first, so the revocation applies afterwards — it waits
    // for one single-row UPDATE, not for a dispatch.
    expect(await overlap.revocation).toBe("revoked");
    const row = await sql<{ status: string; dispatch_state: string; dispatch_attempt: number | null }>`
      select status, dispatch_state, dispatch_attempt from platform.inbound_deliveries
       where id = ${deliveryId}::uuid
    `.execute(admin);
    // That attempt is explicitly in flight and is not retracted: revocation has
    // never claimed to recall a request this host can no longer reach.
    expect(row.rows[0]).toEqual({
      status: "dispatching", dispatch_state: "started", dispatch_attempt: reference.attempt,
    });
    // Nothing FURTHER is authorized under the now-revoked registration.
    expect(await resolve(reference)).toBeUndefined();
    await expect(mark(reference, "not-dispatched")).rejects.toThrow();

    // And taking the gate gave the worker no reach into the registration: still
    // no read of the table that holds the sealed provider secret.
    const reach = await withJobWorkerSession(worker, (trx) =>
      sql`select count(*) from platform.inbound_endpoints`.execute(trx)
        .then(() => "permitted", () => "denied"));
    expect(reach).toBe("denied");
  });
}, TEST_TIMEOUT);

test("an active endpoint of another tenant cannot clear a delivery for dispatch", async () => {
  await withScratch(async ({ admin, app, worker, tenantA, tenantB, userA }) => {
    const endpoint = await register(app, tenantA, userA);
    // B keeps its own registration active throughout.
    const other = await register(app, tenantB, randomUUID());
    const accepted = await admitter(app)({ endpointKey: KEY, endpointId: endpoint.id, ...delivery() });
    const deliveryId = (accepted as { deliveryId: string }).deliveryId;
    const resolve = resolveInboundOperationWork(worker, () => keyring);

    const claimed = await withJobWorkerSession(worker, (trx) =>
      claimJobs(trx, { limit: 5, leaseSeconds: 120, kinds: [INBOUND_DISPATCH_KIND] }));
    const reference = { workId: deliveryId, attempt: claimed[0]!.attempts, workerId: randomUUID() };
    await registrar(app).revoke(tenantSession(tenantA, userA), { id: endpoint.id });
    expect(await resolve(reference)).toBeUndefined();

    // The predicate answers per (endpoint, tenant) PAIR, so B's live
    // registration is no answer for A's delivery — and A's revoked one is no
    // answer under B's tenant either.
    // All four cases the predicate has to answer, in one statement: a live
    // registration under its own tenant, a revoked one, an endpoint id that
    // does not exist at all, and a live one asked about under the wrong
    // tenant. Only the first is true, and a missing endpoint is a plain false
    // rather than an error the caller could tell apart.
    const pairs = await sql<{
      a_own: boolean; b_own: boolean; crossed: boolean; missing: boolean;
    }>`
      select app.inbound_endpoint_active(${endpoint.id}::uuid, ${tenantA}::uuid) as a_own,
             app.inbound_endpoint_active(${other.id}::uuid, ${tenantB}::uuid) as b_own,
             app.inbound_endpoint_active(${other.id}::uuid, ${tenantA}::uuid) as crossed,
             app.inbound_endpoint_active(${randomUUID()}::uuid, ${tenantA}::uuid) as missing
    `.execute(admin);
    expect(pairs.rows[0]).toEqual({ a_own: false, b_own: true, crossed: false, missing: false });
  });
}, TEST_TIMEOUT);

test("the worker role can test a registration's liveness without reading the registration", async () => {
  await withScratch(async ({ app, worker, tenantA, tenantB, userA }) => {
    const endpoint = await register(app, tenantA, userA);
    // The whole point of the function: the worker needs one bit, and the row
    // it would otherwise have to read holds the sealed provider secret. Asked
    // under its own tenant it is true; asked under another tenant's it is
    // false, from the same connection in the same session.
    const live = await withJobWorkerSession(worker, (trx) => sql<{ live: boolean; crossed: boolean }>`
      select app.inbound_endpoint_active(${endpoint.id}::uuid, ${tenantA}::uuid) as live,
             app.inbound_endpoint_active(${endpoint.id}::uuid, ${tenantB}::uuid) as crossed
    `.execute(trx));
    expect(live.rows[0]).toEqual({ live: true, crossed: false });
    // And it still cannot see the registration itself, before or after.
    const visible = await withJobWorkerSession(worker, (trx) => sql<{ n: string }>`
      select count(*)::text as n from platform.inbound_endpoints
    `.execute(trx).catch(() => ({ rows: [{ n: "denied" }] })));
    expect(visible.rows[0]?.n).not.toBe("1");
    // Nor may it ask which tenant owns an endpoint id: EXECUTE on the tenant
    // lookup is revoked from this role after the grant sweeps, so the refusal
    // is the database's and not a convention in the TypeScript above.
    const tenantLookup = await withJobWorkerSession(worker, (trx) => sql<{ tenant: string | null }>`
      select app.inbound_endpoint_tenant(${endpoint.id}::uuid) as tenant
    `.execute(trx).then(() => "permitted", () => "denied"));
    expect(tenantLookup).toBe("denied");
  });
}, TEST_TIMEOUT);

test("a settled payload is removed on a bounded schedule; an unsettled one is kept and reported overdue", async () => {
  await withScratch(async ({ admin, app, worker, tenantA, userA }) => {
    const endpoint = await register(app, tenantA, userA);
    const admit = admitter(app);
    const settled = await admit({ endpointKey: KEY, endpointId: endpoint.id, ...delivery() });
    const stuck = await admit({
      endpointKey: KEY, endpointId: endpoint.id,
      ...delivery(Buffer.from('{ "webhookEvent": "user_deleted" }'), "atl-2"),
    });
    const settledId = (settled as { deliveryId: string }).deliveryId;
    const stuckId = (stuck as { deliveryId: string }).deliveryId;

    // One delivery settled ten days ago; the other never settled and arrived
    // sixty days ago — the shape a dead job or a removed Operation leaves.
    await sql`
      update platform.inbound_deliveries
         set status = 'delivered', completed_at = now() - interval '10 days'
       where id = ${settledId}::uuid
    `.execute(admin);
    await sql`
      update platform.inbound_deliveries set received_at = now() - interval '60 days'
       where id = ${stuckId}::uuid
    `.execute(admin);

    const body = (id: string) => sql<{
      body_ciphertext: string | null; body_key_id: string | null;
      body_algorithm: string | null; body_purged_at: string | null;
      body_sha256: string; body_bytes: number; status: string;
    }>`select * from platform.inbound_deliveries where id = ${id}::uuid`
      .execute(admin).then((result) => result.rows[0]!);

    // Inside both windows: nothing is removed, so an operator can still
    // inspect what a recent failure actually received, and nothing is overdue.
    expect(await withJobWorkerSession(worker, (trx) =>
      purgeInboundDeliveryBodies(trx, { retentionDays: 30, maxAgeDays: 90 }))).toBe(0);
    expect(await withJobWorkerSession(worker, (trx) =>
      overdueInboundDeliveryBodies(trx, { retentionDays: 30, maxAgeDays: 90 })))
      .toEqual({ count: 0, oldestReceivedAt: null });

    // Past retention for the settled one and past the outer bound for both:
    // ONLY the settled payload goes. The other delivery's 2xx was a durable
    // acceptance of work still to be done, and these are the only bytes of it
    // left — age does not make them disposable.
    expect(await withJobWorkerSession(worker, (trx) =>
      purgeInboundDeliveryBodies(trx, { retentionDays: 7, maxAgeDays: 30 }))).toBe(1);

    const purged = await body(settledId);
    expect(purged.body_ciphertext).toBeNull();
    expect(purged.body_key_id).toBeNull();
    expect(purged.body_algorithm).toBeNull();
    expect(purged.body_purged_at).not.toBeNull();
    // What survives is the evidence: which bytes were accepted, how large, and
    // that the payload was removed rather than never kept.
    expect(purged.body_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(purged.body_bytes).toBeGreaterThan(0);

    // The stale pending one is untouched — still sealed, still replayable, and
    // never marked as if it had been dealt with.
    const retained = await body(stuckId);
    expect(retained.body_ciphertext).not.toBeNull();
    expect(retained.body_key_id).not.toBeNull();
    expect(retained.body_algorithm).not.toBeNull();
    expect(retained.body_purged_at).toBeNull();
    expect(retained.status).toBe("pending");

    // Instead it is surfaced: a count and how long this has been true, which
    // is what an operator acts on. Nothing here fails or hides the delivery.
    const overdue = await withJobWorkerSession(worker, (trx) =>
      overdueInboundDeliveryBodies(trx, { retentionDays: 7, maxAgeDays: 30 }));
    expect(overdue.count).toBe(1);
    expect(overdue.oldestReceivedAt?.getTime())
      .toBeLessThan(Date.now() - 59 * 24 * 60 * 60 * 1_000);

    // Idempotent, and still not reached by the shortest bound there is.
    expect(await withJobWorkerSession(worker, (trx) =>
      purgeInboundDeliveryBodies(trx, { retentionDays: 0, maxAgeDays: 1 }))).toBe(0);
    expect((await body(stuckId)).body_ciphertext).not.toBeNull();

    // And because its payload is still there, the open delivery still resolves
    // into dispatchable work rather than a terminal "removed" refusal.
    const claimed = await withJobWorkerSession(worker, (trx) =>
      claimJobs(trx, { limit: 5, leaseSeconds: 120, kinds: [INBOUND_DISPATCH_KIND] }));
    const claim = claimed.find((job) => job.subject?.id === stuckId) ?? claimed[0]!;
    const resolve = resolveInboundOperationWork(worker, () => keyring);
    const work = await resolve({ workId: stuckId, attempt: claim.attempts, workerId: randomUUID() });
    expect(work?.tenantId).toBe(tenantA);
    expect(work?.operation.id).toBe(OPERATION);
  });
}, TEST_TIMEOUT);


test("managed Connection registration commits with its caller or rolls back together", async () => {
  await withScratch(async ({ admin, app, tenantA, userA }) => {
    const connectionId = randomUUID();
    const service = { ...tenantSession(tenantA, userA), principalKind: "service", credential: "bearer",
      organizationServiceIdentityId: SERVICE_IDENTITY, roles: ["Platform.InboundEndpointManage"] } as TrustedSessionContext;
    const request = { connectionId, secretField: "webhookSigningSecret", endpointKey: KEY, signature: jira,
      identity: { source: "body-digest" as const }, dispatch: { operationId: OPERATION, inputField: "delivery" },
      idempotencyKey: "reconcile-one", expect: { endpointStatus: "inactive", endpointId: null } };
    const run = async (fail: boolean) => withDbSession(app, service, async trx => {
      const api = createInboundEndpointServices({ acceptsSession: candidate => candidate === service,
        serviceIdentity: () => SERVICE_IDENTITY, resolveOperation: async () => ({ id: OPERATION,
          reliability: { idempotency: { mode: "keyed", inputField: "key" } } } as unknown as RuntimeOperationDefinition),
        store: inboundEndpointWriter(app), keyring,
        managed: { activeTransaction: candidate => candidate === service,
          connection: async () => ({ ok: true, connection: { connectionId, connectionKey: "fixture", adapterKey: KEY,
            transport: "rest", connectionScope: "tenant", ownerUserId: null,
            values: { webhookSigningSecret: SECRET }, secretKeys: ["webhookSigningSecret"], egressGrant: {} as never } }),
          find: async (_session, key) => findInboundRegistration(trx, key),
          findConnection: async (_session, input) => findInboundConnectionEndpoint(trx, input),
          insert: async (_session, input) => insertInboundEndpoint(trx, input),
          revoke: async (_session, input) => revokeInboundConnectionEndpoint(trx, input),
        } });
      const endpoint = await api.registerForConnection(service, request);
      if (fail) throw new Error("subscription update failed");
      return endpoint;
    });
    await expect(run(true)).rejects.toThrow("subscription update failed");
    const count = async () => (await sql<{ count: string }>`select count(*)::text as count from platform.inbound_endpoints where tenant_id = ${tenantA}::uuid`.execute(admin)).rows[0]!.count;
    expect(await count()).toBe("0");
    const first = await run(false);
    const second = await run(false);
    expect(first.id).toBe(second.id);
    expect(await count()).toBe("1");
  });
}, TEST_TIMEOUT);
