// SPDX-License-Identifier: BUSL-1.1
/**
 * The named-action axis of the record ACL, against a migrated scratch database
 * and through the RESTRICTED app role — the role the API actually connects as,
 * NOSUPERUSER and NOBYPASSRLS.
 *
 * What these tests are for, in order of how badly each would hurt:
 *
 *   1. the lookup answers one boolean about one record and discloses nothing
 *      else — not the row, not the ACL column, not another tenant's record,
 *      and not an entity or action the compiler did not authorize;
 *   2. its definer role cannot be reached, assumed, or used to write;
 *   3. a subject kind is matched against the session's VERIFIED principal
 *      class, so the same role held by a person, an API-key application and a
 *      bearer service account does not resolve to the same rights;
 *   4. the single lock ordering holds under both concurrent interleavings of
 *      a policy change and a check, proven with pg_blocking_pids rather than
 *      with sleeps;
 *   5. none of it changes what an existing human session sees.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Kysely, type Transaction } from "kysely";
import type { DB } from "../../generated/db/types.js";
import { createDatabaseRuntime, type DatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import { APP_ROLE } from "../migrations/app-role.js";
import {
  applyRecordActionsMigration,
  recordActionEntities,
  type RecordActionEntity,
} from "../migrations/record-actions.js";
import { databaseRole } from "../database-roles.js";
import { withDbSession, type DbSessionInput } from "../session.js";
import { mintApiKey } from "../../auth/api-key/format.js";
import { resolveApiKeySession } from "../../auth/api-key/resolve.js";
import { encryptSecret, type SecretKeyring } from "../../platform/secrets.js";

const ADMIN_URL = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const APP_ROLE_PASSWORD = process.env.SCRATCH_APP_ROLE_PASSWORD ?? "openshapeforge_app";
const RESOLVER_ROLE = databaseRole("recordActionResolver").name;
const TEST_TIMEOUT = 180_000;
const scratch = `record_actions_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

const tenantA = randomUUID();
const tenantB = randomUUID();
const person = randomUUID();
const otherPerson = randomUUID();
const relationGroup = randomUUID();
const integration = randomUUID();
const otherIntegration = randomUUID();
/**
 * The credential row id a resolved session carries beside its integration.
 * `app.record_action_allows` never reads it — the credential fence is its own
 * function, proven against real key rows in
 * `record-action-credential-fence-db.test.ts` — so a synthetic value is the
 * honest fixture for the ACL questions this file asks.
 */
const credential = randomUUID();
const SHARED_ROLE = "Runs.All.Operate";
/**
 * A SECOND role that inherits the resolver — the shape the role contract gives
 * the migrate role, held by a role that owns nothing. Cluster-wide, so it is
 * created after the chain has run and dropped in afterAll.
 */
const MEMBER_ROLE = `osf_resolver_member_${randomUUID().replaceAll("-", "").slice(0, 10)}`;

/** Four entities, so nothing can pass by being the only branch in the case. */
const RUN = "ActionRun";
const DOC = "ActionDoc";
/**
 * The third carries the OTHER generated row policy: plain tenant isolation,
 * with no `view` gate. That distinction decides what a DELETE by the resolver
 * reaches — on a view-gated table the generated policy already hides the row
 * from a session with no `view` grant, so the delete tests have to run here or
 * they pass for the wrong reason.
 */
const TICKET = "ActionTicket";
/**
 * The lock-mode entity. Its ACL is `empty: public` for the three human
 * permissions and it names no view subject, so the row IS readable by the
 * acting session — the shape an entity takes when it holds its own
 * application grants beside ordinary human access. That is what makes an
 * effect's `for update` on the same row possible, and therefore what makes
 * the lock-upgrade question real rather than hypothetical.
 */
const JOB = "ActionJob";
const runRow = randomUUID();
const runRowTenantB = randomUUID();
const docRow = randomUUID();
const ticketRow = randomUUID();
const ticketRowTenantB = randomUUID();
/** One record per concurrent interleaving, so neither disturbs the other. */
const lockRowCheckFirst = randomUUID();
const lockRowRevokeFirst = randomUUID();
/** The record the projection is read from while a revocation contends. */
const lockRowRead = randomUUID();
/** One record per parallel-holder pairing, for the same reason. */
const jobRowShared = randomUUID();
const jobRowExclusive = randomUUID();
const jobRowSharedFence = randomUUID();

const entities: RecordActionEntity[] = [
  {
    entity: RUN, schema: "erp", table: "action_runs",
    keyColumn: "id", keyIsUuid: true, aclColumn: "acl",
    actions: ["follow", "start"],
    // `start` needs the definition to run; `follow` declares nothing, so it
    // authorizes an effect and discloses nothing. `secret` is declared by
    // neither and is what the tests watch for.
    reads: {
      start: [
        { field: "definition", column: "definition" },
        { field: "status", column: "status" },
      ],
    },
    // `start` writes the record it is authorized on, so it takes the
    // self-exclusive lock; `follow` only reads, and declares the shared one.
    // Both are exercised below, including the deadlock `shared` admits.
    locks: { follow: "shared", start: "exclusive" },
  },
  {
    entity: DOC, schema: "erp", table: "action_docs",
    keyColumn: "id", keyIsUuid: true, aclColumn: "acl",
    actions: ["publish"], reads: {}, locks: { publish: "exclusive" },
  },
  {
    entity: JOB, schema: "erp", table: "action_jobs",
    keyColumn: "id", keyIsUuid: true, aclColumn: "acl",
    // The same question twice, once per lock mode, so the pairing below
    // differs in nothing but the mode the action declared.
    actions: ["claimExclusive", "claimShared"], reads: {},
    locks: { claimExclusive: "exclusive", claimShared: "shared" },
  },
  {
    entity: TICKET, schema: "erp", table: "action_tickets",
    keyColumn: "id", keyIsUuid: true, aclColumn: "acl",
    actions: ["close"], reads: {}, locks: { close: "exclusive" },
  },
];

function url(name: string, app = false): string {
  const parsed = new URL(ADMIN_URL);
  parsed.pathname = `/${name}`;
  if (app) {
    parsed.username = APP_ROLE;
    parsed.password = APP_ROLE_PASSWORD;
  }
  return parsed.toString();
}

/** A session as the server would have classified it, never as a caller asks. */
function session(overrides: Partial<DbSessionInput> = {}): DbSessionInput {
  return {
    tenantId: tenantA, userId: person, roles: [], groups: [],
    relationGroupIds: [], scope: "self", ...overrides,
  };
}

/**
 * A verified identity ↔ Relation link naming a PERSON party.
 *
 * Read back from `platform.identity_relations` under RLS, so nobody asserted
 * it — and still not evidence of a human login: `link_identity` admits any
 * identity against any Relation the tenant holds, and a service account's own
 * link is recorded on its first session. The class comes from the carrier's
 * signed kind instead (db/session.ts, `resolvePrincipalClass`).
 */
function linkedPerson(userId: string, relationId = randomUUID()) {
  return {
    relation: {
      identityId: randomUUID(), issuer: "https://identity.example/realms/test",
      subject: userId, status: "linked", relationId, relationType: "person",
    },
  } as Partial<DbSessionInput>;
}

let server: SQL;
let admin: DatabaseRuntime;
let app: DatabaseRuntime;

async function allows(
  db: Kysely<DB>,
  input: DbSessionInput,
  entity: string,
  recordKey: string,
  action: string,
): Promise<boolean> {
  return withDbSession(db, input, async (trx) => {
    const result = await sql<{ allowed: boolean | null }>`
      select app.record_action_allows(${entity}, ${recordKey}, ${action}) as allowed
    `.execute(trx);
    return result.rows[0]?.allowed === true;
  });
}

beforeAll(async () => {
  if (!/^[a-z0-9_]+$/.test(scratch)) throw new Error("unsafe scratch database name");
  server = new SQL(ADMIN_URL, { max: 1 });
  await server.unsafe(`create database "${scratch}"`);
  admin = createDatabaseRuntime({ databaseUrl: url(scratch), maxConnections: 4 });
  await admin.db.connection().execute((conn) => runMigrationChain(conn));

  await admin.db.connection().execute(async (conn) => {
    for (const entity of entities) {
      const table = sql.id(entity.schema, entity.table);
      // The shape the compiler emits for an ACL-bearing entity, including the
      // unchanged view-gated row policy. `action_docs` keeps empty=public, the
      // default a human ACL ships with, so the tests can show it still works.
      const emptyIsPublic = entity.entity === DOC || entity.entity === JOB;
      await sql`
        create table ${table} (
          id uuid primary key,
          tenant_id uuid not null,
          secret text not null,
          definition text not null default 'graph',
          status text not null default 'ready',
          acl jsonb not null default '{}'::jsonb
        )
      `.execute(conn);
      await sql`alter table ${table} enable row level security`.execute(conn);
      await sql`alter table ${table} force row level security`.execute(conn);
      if (entity.entity === TICKET) {
        // The other generated shape: `<table>_tenant_isolation`, no view gate.
        await sql`
          create policy ${sql.id(`${entity.table}_tenant_isolation`)} on ${table}
          using (app.bypass_rls() or tenant_id = app.current_tenant())
          with check (app.bypass_rls() or tenant_id = app.current_tenant())
        `.execute(conn);
      } else {
        await sql`
          create policy ${sql.id(`${entity.table}_row_scope`)} on ${table}
          using (
            app.bypass_rls() or (
              tenant_id = app.current_tenant()
              and app.record_permission_allows("acl", 'view', ${sql.lit(emptyIsPublic)})
            )
          )
          with check (app.bypass_rls() or tenant_id = app.current_tenant())
        `.execute(conn);
      }
      await sql.raw(
        `grant select, insert, update, delete on ${entity.schema}.${entity.table} to ${APP_ROLE}`,
      ).execute(conn);
    }

    const grantToIntegration = (id: string) =>
      JSON.stringify({
        view: { users: [otherPerson] },
        edit: { users: [otherPerson] },
        actions: { start: { integrations: [id] }, follow: { integrations: [id] } },
      });
    await sql`
      insert into erp.action_runs (id, tenant_id, secret, definition, status, acl) values
        (${runRow}::uuid, ${tenantA}::uuid, 'run-a-secret', 'graph-a', 'ready', ${sql.raw(`'${grantToIntegration(integration)}'::jsonb`)}),
        (${runRowTenantB}::uuid, ${tenantB}::uuid, 'run-b-secret', 'graph-b', 'ready', ${sql.raw(`'${grantToIntegration(integration)}'::jsonb`)}),
        (${lockRowCheckFirst}::uuid, ${tenantA}::uuid, 'lock-1', 'graph-1', 'ready', ${sql.raw(`'${grantToIntegration(integration)}'::jsonb`)}),
        (${lockRowRevokeFirst}::uuid, ${tenantA}::uuid, 'lock-2', 'graph-2', 'ready', ${sql.raw(`'${grantToIntegration(integration)}'::jsonb`)}),
        (${lockRowRead}::uuid, ${tenantA}::uuid, 'lock-3', 'graph-3', 'ready', ${sql.raw(`'${grantToIntegration(integration)}'::jsonb`)})
    `.execute(conn);
    // A person-only action grant that names a ROLE, beside an integration
    // grant for a different integration. Nothing here grants view.
    await sql`
      insert into erp.action_docs (id, tenant_id, secret, acl) values
        (${docRow}::uuid, ${tenantA}::uuid, 'doc-secret', ${sql.raw(`'${JSON.stringify({
          actions: {
            publish: {
              roles: [SHARED_ROLE], users: [person], groups: [relationGroup],
              integrations: [otherIntegration],
            },
          },
        })}'::jsonb`)})
    `.execute(conn);
    await sql`
      insert into erp.action_tickets (id, tenant_id, secret, acl) values
        (${ticketRow}::uuid, ${tenantA}::uuid, 'ticket-a-secret', ${sql.raw(`'${JSON.stringify({
          actions: { close: { integrations: [integration] } },
        })}'::jsonb`)}),
        (${ticketRowTenantB}::uuid, ${tenantB}::uuid, 'ticket-b-secret', ${sql.raw(`'${JSON.stringify({
          actions: { close: { integrations: [integration] } },
        })}'::jsonb`)})
    `.execute(conn);
    // The lock-mode rows: both claims granted to the integration, and no view
    // subject at all, which under `empty: public` leaves the row readable.
    await sql`
      insert into erp.action_jobs (id, tenant_id, secret, acl) values
        (${jobRowShared}::uuid, ${tenantA}::uuid, 'job-shared', ${sql.raw(`'${JSON.stringify({
          actions: {
            claimShared: { integrations: [integration] },
            claimExclusive: { integrations: [integration] },
          },
        })}'::jsonb`)}),
        (${jobRowExclusive}::uuid, ${tenantA}::uuid, 'job-exclusive', ${sql.raw(`'${JSON.stringify({
          actions: {
            claimShared: { integrations: [integration] },
            claimExclusive: { integrations: [integration] },
          },
        })}'::jsonb`)}),
        (${jobRowSharedFence}::uuid, ${tenantA}::uuid, 'job-fence', ${sql.raw(`'${JSON.stringify({
          view: { users: [otherPerson] },
          edit: { users: [otherPerson] },
          actions: { claimShared: { integrations: [integration] } },
        })}'::jsonb`)})
    `.execute(conn);
    await applyRecordActionsMigration(conn, entities);
  });
  // The second member of the resolver, granted the way the role contract
  // grants the migrate role: INHERIT, so it holds the resolver's column
  // grants outright. It owns nothing, which is the whole point.
  if (!/^[a-z0-9_]+$/.test(MEMBER_ROLE)) throw new Error("unsafe member role name");
  await server.unsafe(
    `create role ${MEMBER_ROLE} nologin nosuperuser nobypassrls nocreatedb nocreaterole`,
  );
  await server.unsafe(`grant ${RESOLVER_ROLE} to ${MEMBER_ROLE} with inherit true, set true`);
  app = createDatabaseRuntime({ databaseUrl: url(scratch, true), maxConnections: 4 });
}, TEST_TIMEOUT);

afterAll(async () => {
  await app?.close();
  await admin?.close();
  await server?.unsafe(`drop database if exists "${scratch}" with (force)`);
  // Roles are cluster-wide: this one must not outlive the test, or the role
  // contract it deliberately violates would fail every later migration.
  await server?.unsafe(`drop role if exists ${MEMBER_ROLE}`);
  await server?.close();
});

describe("record action lookup under the restricted app role", () => {
  test("answers for a verified application without making the record readable", async () => {
    const machine = session({
      userId: randomUUID(), principalKind: "service",
      appPrincipal: { integrationId: integration, credentialId: credential },
      roles: [SHARED_ROLE],
    });
    expect(await allows(app.db, machine, RUN, runRow, "start")).toBe(true);
    expect(await allows(app.db, machine, RUN, runRow, "follow")).toBe(true);
    // The whole point: authorized to act, still blind to the record.
    const visible = await withDbSession(app.db, machine, async (trx) =>
      (await sql<{ count: number }>`select count(*)::int as count from erp.action_runs`
        .execute(trx)).rows[0]!.count);
    expect(visible).toBe(0);
  }, TEST_TIMEOUT);

  test("denies across tenants, outside the registry and outside the declared actions", async () => {
    const machine = session({
      userId: randomUUID(), principalKind: "service",
      appPrincipal: { integrationId: integration, credentialId: credential },
    });
    // The row exists and names this integration — in the OTHER tenant.
    expect(await allows(app.db, machine, RUN, runRowTenantB, "start")).toBe(false);
    expect(await allows(app.db, { ...machine, tenantId: tenantB }, RUN, runRow, "start")).toBe(false);
    // An entity the compiler never put in the case.
    expect(await allows(app.db, machine, "Tenant", runRow, "start")).toBe(false);
    expect(await allows(app.db, machine, "erp.action_runs", runRow, "start")).toBe(false);
    // An action this entity does not declare, and the permissions it may
    // never restate.
    expect(await allows(app.db, machine, RUN, runRow, "publish")).toBe(false);
    for (const permission of ["view", "edit", "delete"]) {
      expect(await allows(app.db, machine, RUN, runRow, permission)).toBe(false);
    }
    // A record of a registry entity that does not exist.
    expect(await allows(app.db, machine, RUN, randomUUID(), "start")).toBe(false);
    // Malformed keys and names fail closed rather than erroring.
    for (const key of ["", "not-a-uuid", "' or true--"]) {
      expect(await allows(app.db, machine, RUN, key, "start")).toBe(false);
    }
    for (const action of ["", "Start", "start; drop table erp.action_runs", "*"]) {
      expect(await allows(app.db, machine, RUN, runRow, action)).toBe(false);
    }
  }, TEST_TIMEOUT);

  test("an application holds only the grants that name it", async () => {
    const machine = session({
      userId: randomUUID(), principalKind: "service",
      appPrincipal: { integrationId: otherIntegration, credentialId: credential },
    });
    // Named for publish on the doc, named nowhere on the run.
    expect(await allows(app.db, machine, DOC, docRow, "publish")).toBe(true);
    expect(await allows(app.db, machine, RUN, runRow, "start")).toBe(false);
    expect(await allows(app.db, machine, RUN, runRow, "follow")).toBe(false);
  }, TEST_TIMEOUT);
});

describe("verified principal class decides which subjects apply", () => {
  // One ACL entry, one role, six carriers. Only a verified person may use it.
  test("the same role resolves differently for a person, an application and a service", async () => {
    const roles = [SHARED_ROLE];
    const asPerson = session({ userId: person, roles, principalKind: "person" });
    // The same signed person, now also linked. The link neither grants the
    // action nor takes it away.
    const asLinkedPerson = session({
      userId: person, roles, principalKind: "person", ...linkedPerson(person),
    });
    // And the same link with NO signed kind: the payload-v2 trusted-context
    // bundle. `app.current_principal_class()` reads `unknown` for it, so the
    // database's own mirror of this axis refuses it as well.
    const asLinkedUnclassified = session({ userId: person, roles, ...linkedPerson(person) });
    const asServiceBearer = session({
      userId: randomUUID(), roles, principalKind: "service",
    });
    const asApplication = session({
      userId: randomUUID(), roles, principalKind: "service",
      appPrincipal: { integrationId: integration, credentialId: credential },
    });
    const unclassified = session({ userId: randomUUID(), roles });

    expect(await allows(app.db, asPerson, DOC, docRow, "publish")).toBe(true);
    expect(await allows(app.db, asLinkedPerson, DOC, docRow, "publish")).toBe(true);
    // A link naming a person party is not a verified human login, so the ACL
    // entry that names this very user and this very role holds nothing for
    // it. This is the escalation being closed.
    expect(await allows(app.db, asLinkedUnclassified, DOC, docRow, "publish")).toBe(false);
    // A verified client-credentials principal holding the SAME role gets
    // nothing from a person subject either.
    expect(await allows(app.db, asServiceBearer, DOC, docRow, "publish")).toBe(false);
    // Nor does one whose link names a person party — a service account an
    // administrator linked to a Relation stays a service.
    expect(await allows(
      app.db,
      session({ userId: person, roles, principalKind: "service", ...linkedPerson(person) }),
      DOC, docRow, "publish",
    )).toBe(false);
    // An application is matched only against `integrations`, never a role it
    // happens to carry — even though this ACL does name another integration.
    expect(await allows(app.db, asApplication, DOC, docRow, "publish")).toBe(false);
    // Nothing states a kind and no link exists: no class, no action.
    expect(await allows(app.db, unclassified, DOC, docRow, "publish")).toBe(false);
  }, TEST_TIMEOUT);

  test("a person matches by user id and by server-derived RelationGroup, never by Keycloak group", async () => {
    const byUser = session({ userId: person, principalKind: "person" });
    const byGroup = session({
      userId: otherPerson, principalKind: "person", relationGroupIds: [relationGroup],
    });
    const byKeycloakGroup = session({
      userId: otherPerson, principalKind: "person", groups: [relationGroup],
    });
    expect(await allows(app.db, byUser, DOC, docRow, "publish")).toBe(true);
    expect(await allows(app.db, byGroup, DOC, docRow, "publish")).toBe(true);
    expect(await allows(app.db, byKeycloakGroup, DOC, docRow, "publish")).toBe(false);
  }, TEST_TIMEOUT);

  test("an absent application principal denies and does not carry into the next session", async () => {
    const withoutPrincipal = session({ userId: randomUUID(), principalKind: "service" });
    expect(await allows(app.db, withoutPrincipal, RUN, runRow, "start")).toBe(false);

    // These settings are transaction-local, and a pooled connection serves one
    // request after another. Forge both, let the transaction end, and the next
    // session must start from what the server decided — applyDbSession writes
    // them unconditionally, empty included, so there is nothing to inherit.
    //
    // Within ONE transaction they are forgeable by anything running as the app
    // role, exactly as `app.roles` and `app.user_id` already are: they are the
    // authorization input this server writes, not a boundary against its own
    // SQL. What makes them trustworthy is that no request reaches set_config.
    await withDbSession(app.db, withoutPrincipal, async (trx) => {
      await sql`select set_config('app.app_principal_id', ${integration}, true),
        set_config('app.principal_class', 'application', true)`.execute(trx);
      expect(await allows(app.db, withoutPrincipal, RUN, runRow, "start")).toBe(true);
    });
    const next = await withDbSession(app.db, withoutPrincipal, async (trx) =>
      (await sql<{ class: string; principal: string | null }>`
        select app.current_principal_class() as class,
               app.current_app_principal()::text as principal
      `.execute(trx)).rows[0]!);
    expect(next).toEqual({ class: "service", principal: null });
    expect(await allows(app.db, withoutPrincipal, RUN, runRow, "start")).toBe(false);
  }, TEST_TIMEOUT);
});


/**
 * The application principal through the REAL credential path.
 *
 * The integration rows, the key rows, the secret comparison, the role
 * intersection and the session assembly are all the shipped code; only the
 * token exchange and the JWKS verification are stubbed, because a realm is
 * not what is under test. This is what says the `integrations` subject of an
 * ACL is matched against a value that came out of `platform.api_keys`, and not
 * out of anything a holder presented.
 */
describe("an API-key credential resolves to the integration it names", () => {
  const keyring: SecretKeyring = {
    activeKeyId: "k1", keys: new Map([["k1", Buffer.alloc(32, 7)]]),
  };
  const serviceAccountUserId = randomUUID();

  async function provisionIntegration(integrationId: string, grantedRoles: string[] = [SHARED_ROLE]): Promise<void> {
    const secret = encryptSecret(keyring, integrationId, "clientSecret", "client-secret");
    await admin.db.connection().execute(async (conn) => {
      await sql`insert into platform.api_key_integrations
          (id, tenant_id, display_name, keycloak_client_id, status, granted_roles,
           client_secret_ciphertext, client_secret_key_id, client_secret_algorithm, created_by)
        values (${integrationId}::uuid, ${tenantA}::uuid, 'Partner robot',
          ${`osf-int-${integrationId}`}, 'active', ${JSON.stringify(grantedRoles)}::text::jsonb,
          ${secret.ciphertext}, ${secret.keyId}, ${secret.algorithm}, ${randomUUID()}::uuid)
      `.execute(conn);
    });
  }

  /** The credential, and the row id the resolved session must report. */
  async function issueKey(
    integrationId: string,
  ): Promise<{ token: string; keyId: string }> {
    const minted = mintApiKey();
    const keyId = randomUUID();
    await admin.db.connection().execute(async (conn) => {
      await sql`insert into platform.api_keys
          (id, tenant_id, integration_id, lookup_id, secret_hash, display_name, created_by)
        values (${keyId}::uuid, ${tenantA}::uuid, ${integrationId}::uuid,
          ${minted.lookupId}, ${minted.secretHash}, 'key', ${randomUUID()}::uuid)
      `.execute(conn);
    });
    return { token: minted.token, keyId };
  }

  async function resolve(token: string) {
    return resolveApiKeySession({
      db: app.db,
      keyring,
      issuer: "https://identity.example/realms/test",
      verifyToken: async () => ({
        tenantId: tenantA, userId: serviceAccountUserId, roles: [SHARED_ROLE], groups: [],
      }),
      resolveScope: () => "tenant",
      fetch: (async () => new Response(
        JSON.stringify({ access_token: "token", expires_in: 60 }), { status: 200 },
      )) as unknown as typeof fetch,
    }, token);
  }

  test("the session names the integration and the record action then applies", async () => {
    await provisionIntegration(integration);
    const issued = await issueKey(integration);
    const session = await resolve(issued.token);
    expect(session).toBeDefined();
    expect(session!.credential).toBe("api-key");
    expect(session!.principalKind).toBe("service");
    // Both halves come out of the store: the integration a policy names, and
    // the credential row the fence re-reads.
    expect(session!.appPrincipal).toEqual({
      integrationId: integration, credentialId: issued.keyId,
    });
    // The grant in the fixture names this integration, and here it is being
    // matched against a value the store produced.
    expect(await allows(app.db, session as DbSessionInput, RUN, runRow, "start")).toBe(true);
    // The same session holds SHARED_ROLE, which the doc's person-only
    // `publish` entry names. An application still gets nothing from it.
    expect(session!.roles).toContain(SHARED_ROLE);
    expect(await allows(app.db, session as DbSessionInput, DOC, docRow, "publish")).toBe(false);
  }, TEST_TIMEOUT);

  test("a role-free integration does not inherit the service token role", async () => {
    const roleFree = randomUUID();
    await provisionIntegration(roleFree, []);
    const issued = await issueKey(roleFree);
    const resolved = await resolve(issued.token);
    expect(resolved!.roles).toEqual([]);
    expect(await allows(app.db, resolved as DbSessionInput, DOC, docRow, "publish")).toBe(false);
  }, TEST_TIMEOUT);

  test("a second credential of the same integration is the same principal", async () => {
    const issued = await issueKey(integration);
    const rotated = await resolve(issued.token);
    // Same application, different credential: the principal a grant names is
    // stable across rotation, the credential identity is not.
    expect(rotated!.appPrincipal).toEqual({
      integrationId: integration, credentialId: issued.keyId,
    });
    expect(await allows(app.db, rotated as DbSessionInput, RUN, runRow, "start")).toBe(true);
  }, TEST_TIMEOUT);

  test("a different integration is a different principal and holds nothing", async () => {
    const stranger = randomUUID();
    await provisionIntegration(stranger);
    const issued = await issueKey(stranger);
    const session = await resolve(issued.token);
    expect(session!.appPrincipal).toEqual({
      integrationId: stranger, credentialId: issued.keyId,
    });
    expect(await allows(app.db, session as DbSessionInput, RUN, runRow, "start")).toBe(false);
  }, TEST_TIMEOUT);

  test("an unknown credential resolves to no session, so to no principal", async () => {
    expect(await resolve(mintApiKey().token)).toBeUndefined();
    expect(await resolve("osf_live_not_a_key")).toBeUndefined();
  }, TEST_TIMEOUT);
});

describe("the bounded execution capability", () => {
  const machine = (id = integration) => session({
    userId: randomUUID(), principalKind: "service",
    appPrincipal: { integrationId: id, credentialId: credential },
  });
  async function read(
    input: DbSessionInput, entity: string, recordKey: string, action: string,
  ): Promise<Record<string, unknown> | null> {
    return withDbSession(app.db, input, async (trx) =>
      (await sql<{ payload: Record<string, unknown> | null }>`
        select app.record_action_read(${entity}, ${recordKey}, ${action}) as payload
      `.execute(trx)).rows[0]?.payload ?? null);
  }

  test("a start-only application reads exactly the declared fields", async () => {
    expect(await read(machine(), RUN, runRow, "start")).toEqual({
      definition: "graph-a", status: "ready",
    });
  }, TEST_TIMEOUT);

  test("it carries neither the ACL, nor the tenant, nor an undeclared column", async () => {
    const payload = (await read(machine(), RUN, runRow, "start"))!;
    expect(Object.keys(payload).sort()).toEqual(["definition", "status"]);
    for (const leaked of ["acl", "secret", "tenant_id", "id"]) {
      expect(payload).not.toHaveProperty(leaked);
    }
    expect(JSON.stringify(payload)).not.toContain("run-a-secret");
    expect(JSON.stringify(payload)).not.toContain(integration);
  }, TEST_TIMEOUT);

  test("an action that declares no projection discloses nothing", async () => {
    // `follow` is granted to this application and still reads nothing.
    expect(await allows(app.db, machine(), RUN, runRow, "follow")).toBe(true);
    expect(await read(machine(), RUN, runRow, "follow")).toBeNull();
    expect(await read(machine(otherIntegration), DOC, docRow, "publish")).toBeNull();
  }, TEST_TIMEOUT);

  test("it refuses for every reason the check refuses, as one answer", async () => {
    // Not granted this action.
    expect(await read(machine(otherIntegration), RUN, runRow, "start")).toBeNull();
    // Another tenant's record, and this session in another tenant.
    expect(await read(machine(), RUN, runRowTenantB, "start")).toBeNull();
    expect(await read({ ...machine(), tenantId: tenantB }, RUN, runRow, "start")).toBeNull();
    // Outside the registry, outside the declared actions, and absent rows.
    expect(await read(machine(), "Tenant", runRow, "start")).toBeNull();
    expect(await read(machine(), RUN, runRow, "view")).toBeNull();
    expect(await read(machine(), RUN, randomUUID(), "start")).toBeNull();
    expect(await read(machine(), RUN, "not-a-uuid", "start")).toBeNull();
    // A person who holds no action on this record gets nothing either; the
    // projection is the action's, not the carrier's.
    expect(await read(session({ userId: otherPerson, principalKind: "person" }), RUN, runRow, "start"))
      .toBeNull();
  }, TEST_TIMEOUT);

  test("reading still does not make the record readable", async () => {
    const input = machine();
    expect(await read(input, RUN, runRow, "start")).not.toBeNull();
    const visible = await withDbSession(app.db, input, async (trx) =>
      (await sql<{ count: number }>`select count(*)::int as count from erp.action_runs`
        .execute(trx)).rows[0]!.count);
    expect(visible).toBe(0);
  }, TEST_TIMEOUT);
});

describe("the definer role is bounded", () => {
  test("the app role can neither assume it nor read what it reads", async () => {
    await admin.db.connection().execute(async (conn) => {
      const member = await sql<{ member: boolean }>`
        select pg_has_role(${APP_ROLE}, ${RESOLVER_ROLE}, 'USAGE') as member
      `.execute(conn);
      expect(member.rows[0]!.member).toBe(false);
      const login = await sql<{ can_login: boolean }>`
        select rolcanlogin as can_login from pg_roles where rolname = ${RESOLVER_ROLE}
      `.execute(conn);
      expect(login.rows[0]!.can_login).toBe(false);
      const bypass = await sql<{ bypass: boolean }>`
        select rolbypassrls as bypass from pg_roles where rolname = ${RESOLVER_ROLE}
      `.execute(conn);
      expect(bypass.rows[0]!.bypass).toBe(false);
      // Exactly the three columns the one question needs, and no more.
      const columns = await sql<{ column_name: string; privilege_type: string }>`
        select column_name, privilege_type
          from information_schema.column_privileges
         where grantee = ${RESOLVER_ROLE} and table_name = 'action_runs'
         order by privilege_type, column_name
      `.execute(conn);
      expect(columns.rows).toEqual([
        { column_name: "acl", privilege_type: "SELECT" },
        { column_name: "definition", privilege_type: "SELECT" },
        { column_name: "id", privilege_type: "SELECT" },
        { column_name: "status", privilege_type: "SELECT" },
        { column_name: "tenant_id", privilege_type: "SELECT" },
        { column_name: "acl", privilege_type: "UPDATE" },
      ]);
      // `secret` is declared by no action, so the resolver cannot read it at
      // all — the projection is bounded by a privilege, not only by SQL.
      expect(columns.rows.map((row) => row.column_name)).not.toContain("secret");
      // The lock privilege exists so FOR SHARE is legal; the policies are what
      // make a write impossible.
      const policies = await sql<{
        policyname: string; cmd: string; permissive: string;
        qual: string | null; withcheck: string | null;
      }>`
        select policyname, cmd, permissive, qual, with_check as withcheck
          from pg_policies
         where schemaname = 'erp' and tablename = 'action_runs'
           and ${RESOLVER_ROLE} = any(roles)
         order by policyname
      `.execute(conn);
      expect(policies.rows.map((row) => [row.policyname, row.cmd, row.permissive])).toEqual([
        ["action_runs_record_action_delete_fence", "DELETE", "RESTRICTIVE"],
        ["action_runs_record_action_fence", "ALL", "RESTRICTIVE"],
        ["action_runs_record_action_lock", "UPDATE", "PERMISSIVE"],
        ["action_runs_record_action_read", "SELECT", "PERMISSIVE"],
      ]);
      // The two permissive policies are tenant-fenced rather than `true`:
      // being OR-ed with the generated row policy, `true` admitted every
      // tenant's rows to every statement running as the resolver.
      const [deleteFence, fence, lock, read] = policies.rows;
      expect(read!.qual).toContain("app.current_tenant()");
      expect(lock!.qual).toContain("app.current_tenant()");
      expect(lock!.withcheck).toBe("false");
      // And the write is refused by a RESTRICTIVE check, which is AND-ed and
      // therefore cannot be widened by a permissive policy. Its exemption is
      // the table OWNER's privileges, not a role name: `current_user <>
      // '<resolver>'` was true for every member of the resolver, and a second
      // member then held `update (acl)` with nothing refusing it.
      expect(fence!.withcheck).toContain("pg_has_role(CURRENT_USER, c.relowner");
      expect(fence!.withcheck).not.toContain("CURRENT_USER <>");
      expect(fence!.qual).toContain("app.current_tenant()");
      expect(fence!.qual).toContain("pg_has_role(CURRENT_USER, c.relowner");
      // DELETE is bounded by USING, which the `for all` fence has to leave
      // true for the tenant's own rows so FOR SHARE keeps working. So it gets
      // its own restrictive policy, with no tenant disjunct at all.
      expect(deleteFence!.qual).toContain("pg_has_role(CURRENT_USER, c.relowner");
      expect(deleteFence!.qual).not.toContain("app.current_tenant()");
      expect(deleteFence!.withcheck).toBeNull();
    });
    await expect(
      app.db.connection().execute((conn) => sql.raw(`set role ${RESOLVER_ROLE}`).execute(conn)),
    ).rejects.toThrow(/permission denied to set role/i);
  }, TEST_TIMEOUT);

  test("EXECUTE is not public and the worker is not granted it", async () => {
    await admin.db.connection().execute(async (conn) => {
      const grants = await sql<{ grantee: string }>`
        select grantee from information_schema.routine_privileges
         where routine_schema = 'app' and routine_name = 'record_action_allows'
           and privilege_type = 'EXECUTE'
         order by grantee
      `.execute(conn);
      const grantees = grants.rows.map((row) => row.grantee).filter((name) => name !== "PUBLIC");
      expect(grantees).toContain(APP_ROLE);
      expect(grantees).not.toContain(databaseRole("worker").name);
      expect(grants.rows.map((row) => row.grantee)).not.toContain("PUBLIC");
    });
  }, TEST_TIMEOUT);

  /**
   * The privileges, exercised AS the resolver rather than inferred from
   * catalog rows. `set local role` is the only way to reach that role at all —
   * it is NOLOGIN, the app role cannot assume it (asserted above), and only a
   * member may — so these run on the admin connection and roll back.
   *
   * What they are for: PostgreSQL combines PERMISSIVE policies with OR, and
   * `erp.action_runs` carries the generated `action_runs_row_scope` policy,
   * which names no role and whose write check is satisfied by any row of the
   * session's own tenant. A role-targeted `with check (false)` is OR-ed with
   * that and refuses nothing.
   */
  describe("and its privileges are bounded by a RESTRICTIVE policy, not an OR-ed one", () => {
    const REWRITTEN = JSON.stringify({ actions: { start: { integrations: [randomUUID()] } } });

    /**
     * One connection, current_user = the resolver or another role that
     * INHERITS it, always rolled back.
     *
     * `grant` admits the privileges a later migration or a careless operator
     * might add, so a policy that only looks like a bound can be told apart
     * from one that is a bound. `dropPolicy` removes a bound inside the same
     * rolled-back transaction, which is how each test shows that the policy —
     * and not an absent privilege — is what refuses.
     */
    async function asResolver<T>(
      work: (conn: Kysely<DB>) => Promise<T>,
      options: {
        tenant?: string;
        role?: string;
        /** The fixture table `grant` and `dropPolicy` apply to. */
        table?: string;
        grant?: string;
        /** A record-action policy suffix to drop, e.g. "fence". */
        dropPolicy?: string;
      } = {},
    ): Promise<T> {
      return admin.db.connection().execute(async (conn) => {
        await sql`begin`.execute(conn);
        try {
          const table = options.table ?? "action_runs";
          if (options.dropPolicy) {
            await sql.raw(
              `drop policy ${table}_record_action_${options.dropPolicy} on erp.${table}`,
            ).execute(conn);
          }
          if (options.grant) {
            await sql.raw(
              `grant ${options.grant} on erp.${table} to ${RESOLVER_ROLE}`,
            ).execute(conn);
          }
          await sql.raw(`set local role ${options.role ?? RESOLVER_ROLE}`).execute(conn);
          await sql`select set_config('app.tenant_id', ${options.tenant ?? tenantA}, true)`
            .execute(conn);
          return await work(conn);
        } finally {
          await sql`rollback`.execute(conn);
        }
      });
    }

    const countRows = async (conn: Kysely<DB>) =>
      (await sql<{ count: number }>`select count(*)::int as count from erp.action_runs`
        .execute(conn)).rows[0]!.count;
    const deleteRow = (conn: Kysely<DB>) =>
      sql`delete from erp.action_runs where id = ${runRow}::uuid`.execute(conn);
    /**
     * The delete attempts run against the TENANT-ISOLATION table. On the
     * view-gated `action_runs` the generated row policy already hides the row
     * from a resolver session that holds no `view` grant, so a delete there
     * returns zero rows whether a fence exists or not — it would pass for the
     * wrong reason.
     */
    const deleteTicket = async (conn: Kysely<DB>) =>
      Number((await sql`delete from erp.action_tickets where id = ${ticketRow}::uuid`
        .execute(conn)).numAffectedRows ?? 0);
    const ticketsPresent = async () =>
      admin.db.connection().execute(async (conn) =>
        (await sql<{ count: number }>`
          select count(*)::int as count from erp.action_tickets where id = ${ticketRow}::uuid
        `.execute(conn)).rows[0]!.count);

    const rewriteAcl = (conn: Kysely<DB>) =>
      sql`update erp.action_runs set acl = ${sql.raw(`'${REWRITTEN}'::jsonb`)}
        where id = ${runRow}::uuid`.execute(conn);

    test("the ACL column grant cannot be used to write", async () => {
      await expect(asResolver(rewriteAcl)).rejects.toThrow(
        /violates row-level security policy "action_runs_record_action_fence"/,
      );
      // Unchanged, and the grant that was there is still there.
      const acl = await admin.db.connection().execute(async (conn) =>
        (await sql<{ acl: Record<string, unknown> }>`
          select acl from erp.action_runs where id = ${runRow}::uuid
        `.execute(conn)).rows[0]!.acl);
      expect(acl).toHaveProperty("actions.start.integrations", [integration]);
    });

    test("and the fence is what refuses it: without it, the row policy admits the write", async () => {
      // The finding this closes, demonstrated rather than argued. Everything
      // here is rolled back, so the fixture is untouched.
      const written = await asResolver(
        async (conn) => Number((await rewriteAcl(conn)).numAffectedRows ?? 0),
        { dropPolicy: "fence" },
      );
      expect(written).toBe(1);
    });

    test("the read grant reaches one tenant, not every tenant", async () => {
      const tenants = await asResolver(async (conn) =>
        (await sql<{ tenant: string }>`
          select distinct tenant_id::text as tenant from erp.action_runs
        `.execute(conn)).rows.map((row) => row.tenant));
      expect(tenants).toEqual([tenantA]);
      // The same row, from the other tenant's session: not visible either.
      const other = await asResolver(async (conn) =>
        (await sql<{ count: number }>`
          select count(*)::int as count from erp.action_runs where id = ${runRow}::uuid
        `.execute(conn)).rows[0]!.count, { tenant: tenantB });
      expect(other).toBe(0);
    });

    // Both declared modes, because the fence's `with check (false)` and the
    // restrictive `using` have to admit a LOCK while refusing a write, and
    // `for no key update` — the default mode, and the stronger one — is the
    // clause most of the rendered branches actually carry.
    for (const clause of ["for share", "for no key update"]) {
      test(`the ${clause} lock the lookup takes is still legal under all four policies`, async () => {
        const locked = await asResolver(async (conn) =>
          (await sql<{ acl: unknown }>`
            select acl from erp.action_runs
             where id = ${runRow}::uuid and tenant_id = app.current_tenant()
             ${sql.raw(clause)}
          `.execute(conn)).rows.length);
        expect(locked).toBe(1);
      });
    }

    test("it can neither insert nor delete, by privilege and by policy", async () => {
      await expect(asResolver((conn) =>
        sql`insert into erp.action_runs (id, tenant_id, secret, acl)
          values (${randomUUID()}::uuid, ${tenantA}::uuid, 'forged', '{}'::jsonb)`.execute(conn),
      )).rejects.toThrow(/permission denied for table action_runs/);
      await expect(asResolver(deleteRow)).rejects.toThrow(
        /permission denied for table action_runs/,
      );
    });

    /**
     * The privilege is the first bound and the policy is the second. These add
     * the privilege the migration does not grant — INSERT, DELETE — inside the
     * rolled-back transaction, so what is being tested is the policy alone:
     * what happens if a later migration, a default privilege or an operator
     * hands the resolver one of them.
     */
    test("a DELETE privilege does not become a delete: the restrictive delete fence refuses", async () => {
      const deleted = await asResolver(deleteTicket, {
        table: "action_tickets", grant: "delete",
      });
      expect(deleted).toBe(0);
      // Still there, counted outside the rolled-back transaction.
      expect(await ticketsPresent()).toBe(1);
    });

    test("and the delete fence is what refuses it: with only the FOR ALL fence, the row goes", async () => {
      // The finding, demonstrated. A `for all` policy's WITH CHECK is applied
      // to INSERT and UPDATE only; DELETE is bounded by USING, and the FOR ALL
      // fence's USING has to admit the tenant's own rows or FOR SHARE breaks.
      const deleted = await asResolver(deleteTicket, {
        table: "action_tickets", grant: "delete", dropPolicy: "delete_fence",
      });
      expect(deleted).toBe(1);
      expect(await ticketsPresent()).toBe(1);
    });

    test("an INSERT privilege does not become an insert", async () => {
      await expect(asResolver((conn) =>
        sql`insert into erp.action_runs (id, tenant_id, secret, acl)
          values (${randomUUID()}::uuid, ${tenantA}::uuid, 'forged', '{}'::jsonb)`.execute(conn),
        { grant: "insert" },
      )).rejects.toThrow(
        /violates row-level security policy "action_runs_record_action_fence"/,
      );
    });

    /**
     * A SECOND role that inherits the resolver.
     *
     * The role contract makes the migrate role a member of every definer role,
     * and RLS resolves a policy's TO list with has_privs_of_role — so a
     * `to <resolver>` policy applies to every member, and every member
     * inherits `update (acl)`. The fence's exemption used to be `current_user
     * <> '<resolver>'`, which is TRUE for all of them: verified on PostgreSQL
     * 17.11, a second member rewrote the current tenant's ACL document. The
     * exemption is now the table OWNER's privileges, which this role does not
     * hold.
     */
    test("a second role inheriting the resolver holds the grants and still cannot write", async () => {
      const inherited = await admin.db.connection().execute(async (conn) =>
        (await sql<{ member: boolean; update: boolean; select: boolean; owner: boolean }>`
          select pg_has_role(${MEMBER_ROLE}, ${RESOLVER_ROLE}, 'USAGE') as member,
            has_column_privilege(${MEMBER_ROLE}, 'erp.action_runs', 'acl', 'UPDATE') as "update",
            has_column_privilege(${MEMBER_ROLE}, 'erp.action_runs', 'acl', 'SELECT') as "select",
            pg_has_role(${MEMBER_ROLE},
              (select relowner from pg_class where oid = 'erp.action_runs'::regclass),
              'USAGE') as owner
        `.execute(conn)).rows[0]!);
      // It really does hold the grants — this is not a test of a missing one.
      expect(inherited).toEqual({ member: true, update: true, select: true, owner: false });

      await expect(asResolver(rewriteAcl, { role: MEMBER_ROLE })).rejects.toThrow(
        /violates row-level security policy "action_runs_record_action_fence"/,
      );
      const acl = await admin.db.connection().execute(async (conn) =>
        (await sql<{ acl: Record<string, unknown> }>`
          select acl from erp.action_runs where id = ${runRow}::uuid
        `.execute(conn)).rows[0]!.acl);
      expect(acl).toHaveProperty("actions.start.integrations", [integration]);
    });

    test("a second role inheriting the resolver cannot delete either", async () => {
      const deleted = await asResolver(deleteTicket, {
        role: MEMBER_ROLE, table: "action_tickets", grant: "delete",
      });
      expect(deleted).toBe(0);
      expect(await ticketsPresent()).toBe(1);
    });

    test("a second role inheriting the resolver reaches one tenant, not every tenant", async () => {
      expect(await asResolver(countRows, { role: MEMBER_ROLE })).toBe(4);
      expect(await asResolver(countRows, { role: MEMBER_ROLE, tenant: tenantB })).toBe(1);
      const other = await asResolver(async (conn) =>
        (await sql<{ count: number }>`
          select count(*)::int as count from erp.action_runs where id = ${runRowTenantB}::uuid
        `.execute(conn)).rows[0]!.count, { role: MEMBER_ROLE });
      expect(other).toBe(0);
    });

    test("the write bound would be gone if the exemption were a role name", async () => {
      // The same statement, against the fence as 346629c9 wrote it. This is
      // the regression the owner-privilege exemption closes, pinned so a
      // future simplification back to a name fails here.
      const written = await admin.db.connection().execute(async (conn) => {
        await sql`begin`.execute(conn);
        try {
          await sql`drop policy action_runs_record_action_fence on erp.action_runs`.execute(conn);
          await sql.raw(`
            create policy action_runs_record_action_fence on erp.action_runs
              as restrictive for all to ${RESOLVER_ROLE}
              using (current_user <> '${RESOLVER_ROLE}'
                or tenant_id = app.current_tenant())
              with check (current_user <> '${RESOLVER_ROLE}')
          `).execute(conn);
          await sql.raw(`set local role ${MEMBER_ROLE}`).execute(conn);
          await sql`select set_config('app.tenant_id', ${tenantA}, true)`.execute(conn);
          return Number((await rewriteAcl(conn)).numAffectedRows ?? 0);
        } finally {
          await sql`rollback`.execute(conn);
        }
      });
      expect(written).toBe(1);
    });
  });

  test("the composed test manifest declares exactly its record-action entities", () => {
    // The opt-in test layer adds two unrelated examples to the notebook
    // plugin. Pin all actions, readable fields and locks so the resolver's
    // reachable surface cannot widen silently.
    expect(recordActionEntities()).toEqual([
      { entity: "ExternalProcessRun", schema: "erp", table: "external_process_runs", keyColumn: "id", keyIsUuid: true, aclColumn: "authorization",
        actions: ["follow", "start"], reads: { start: [{ field: "definition", column: "definition" }, { field: "status", column: "status" }] },
        locks: { follow: "exclusive", start: "exclusive" } },
      { entity: "MeterConnection", schema: "erp", table: "meter_connections", keyColumn: "id", keyIsUuid: true, aclColumn: "authorization",
        actions: ["submitReading"], reads: { submitReading: [{ field: "meterKey", column: "meter_key" }] }, locks: { submitReading: "exclusive" } },
      { entity: "Notebook", schema: "notebook", table: "notebooks", keyColumn: "id", keyIsUuid: true, aclColumn: "permissions",
        actions: ["deliver"], reads: { deliver: [{ field: "name", column: "name" }] }, locks: { deliver: "exclusive" } },
    ]);
  });
});


/**
 * ONE lock ordering, used by all three participants: the ACL row of the
 * subject record is locked first and held until commit.
 *
 *   policy change   the ordinary UPDATE of the ACL field takes the row lock
 *                   PostgreSQL gives every UPDATE;
 *   runtime check   the action's declared row lock inside
 *                   app.record_action_allows, in the caller's transaction;
 *   effect          after the check, in that same transaction, under that
 *                   same lock.
 *
 * Both interleavings are driven on two separate restricted connections and
 * asserted on pg_blocking_pids — the test fails if the contending statement is
 * never actually blocked, so nothing here rests on a sleep having been long
 * enough.
 */
describe("the lock ordering serializes a policy change against a check", () => {
  const machine = () => session({
    userId: randomUUID(), principalKind: "service",
    appPrincipal: { integrationId: integration, credentialId: credential },
  });
  // The row names otherPerson for view and edit: the realistic holder of
  // editor authority, which is what assigning or revoking an action needs.
  const editor = () => session({ userId: otherPerson, principalKind: "person" });

  async function labelled<T>(
    runtime: DatabaseRuntime,
    input: DbSessionInput,
    label: string,
    work: (trx: Transaction<DB>) => Promise<T>,
  ): Promise<T> {
    return withDbSession(runtime.db, input, async (trx) => {
      await sql`select set_config('application_name', ${label}, false)`.execute(trx);
      return work(trx);
    });
  }

  /** Waits for `label` to be genuinely blocked, and fails if it never is. */
  async function awaitBlocked(label: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const blocked = await admin.db.connection().execute(async (conn) =>
        (await sql<{ count: number }>`
          select count(*)::int as count
            from pg_stat_activity
           where application_name = ${label}
             and cardinality(pg_blocking_pids(pid)) > 0
        `.execute(conn)).rows[0]!.count);
      if (blocked > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`${label} never blocked; the ACL row was not locked.`);
  }

  function revokedAcl(): string {
    // View and edit stay, so the editor keeps the row it is changing.
    return JSON.stringify({
      view: { users: [otherPerson] }, edit: { users: [otherPerson] }, actions: {},
    });
  }

  test("check first: the revocation waits for the effect to commit", async () => {
    const checker = createDatabaseRuntime({ databaseUrl: url(scratch, true), maxConnections: 1 });
    const revoker = createDatabaseRuntime({ databaseUrl: url(scratch, true), maxConnections: 1 });
    try {
      const checked = Promise.withResolvers<void>();
      const effectDone = Promise.withResolvers<void>();
      const checking = labelled(checker, machine(), "ra-check-first", async (trx) => {
        const allowed = (await sql<{ allowed: boolean | null }>`
          select app.record_action_allows(${RUN}, ${lockRowCheckFirst}, 'start') as allowed
        `.execute(trx)).rows[0]?.allowed === true;
        checked.resolve();
        // Stand in for the effect: the lock is held for as long as the
        // Operation's transaction runs.
        await effectDone.promise;
        return allowed;
      });
      await checked.promise;
      const revoking = labelled(revoker, editor(), "ra-revoke-second", async (trx) => {
        await sql`update erp.action_runs set acl = ${sql.raw(`'${revokedAcl()}'::jsonb`)}
          where id = ${lockRowCheckFirst}::uuid`.execute(trx);
        return "revoked" as const;
      });
      await awaitBlocked("ra-revoke-second");
      effectDone.resolve();
      expect(await checking).toBe(true);
      expect(await revoking).toBe("revoked");
      // And once it has committed, the next check is a denial.
      expect(await allows(app.db, machine(), RUN, lockRowCheckFirst, "start")).toBe(false);
    } finally {
      await checker.close();
      await revoker.close();
    }
  }, TEST_TIMEOUT);

  /**
   * The projection is a SECOND statement, after the check that authorized it.
   * It holds because `record_action_read` calls `record_action_allows` first
   * and a SECURITY DEFINER call takes no subtransaction: the lock `start`
   * declared (`exclusive`, so `for no key update`) is the CALLER's, held to
   * commit, and the projection's own clause on the same primary key and tenant
   * re-locks in that same mode a row this transaction already holds. So a
   * revocation cannot commit between the two, which is what this drives.
   */
  test("the payload cannot come from a row a revocation changed mid-call", async () => {
    const reader = createDatabaseRuntime({ databaseUrl: url(scratch, true), maxConnections: 1 });
    const revoker = createDatabaseRuntime({ databaseUrl: url(scratch, true), maxConnections: 1 });
    try {
      const read = Promise.withResolvers<void>();
      const effectDone = Promise.withResolvers<void>();
      const reading = labelled(reader, machine(), "ra-read-first", async (trx) => {
        const payload = (await sql<{ payload: Record<string, unknown> | null }>`
          select app.record_action_read(${RUN}, ${lockRowRead}, 'start') as payload
        `.execute(trx)).rows[0]?.payload ?? null;
        read.resolve();
        await effectDone.promise;
        return payload;
      });
      await read.promise;
      const revoking = labelled(revoker, editor(), "ra-revoke-read", async (trx) => {
        await sql`update erp.action_runs set acl = ${sql.raw(`'${revokedAcl()}'::jsonb`)}
          where id = ${lockRowRead}::uuid`.execute(trx);
        return "revoked" as const;
      });
      // The read transaction is still open, so the revocation is waiting on
      // the lock the lookup took — not on a sleep.
      await awaitBlocked("ra-revoke-read");
      effectDone.resolve();
      expect(await reading).toEqual({ definition: "graph-3", status: "ready" });
      expect(await revoking).toBe("revoked");
      // And after it commits, the same call discloses nothing.
      expect(await allows(app.db, machine(), RUN, lockRowRead, "start")).toBe(false);
    } finally {
      await reader.close();
      await revoker.close();
    }
  }, TEST_TIMEOUT);

  test("revoke first: the check waits and then reads the revocation", async () => {
    const checker = createDatabaseRuntime({ databaseUrl: url(scratch, true), maxConnections: 1 });
    const revoker = createDatabaseRuntime({ databaseUrl: url(scratch, true), maxConnections: 1 });
    try {
      const written = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const revoking = labelled(revoker, editor(), "ra-revoke-first", async (trx) => {
        await sql`update erp.action_runs set acl = ${sql.raw(`'${revokedAcl()}'::jsonb`)}
          where id = ${lockRowRevokeFirst}::uuid`.execute(trx);
        written.resolve();
        await release.promise;
        return "revoked" as const;
      });
      await written.promise;
      const checking = labelled(checker, machine(), "ra-check-second", async (trx) =>
        (await sql<{ allowed: boolean | null }>`
          select app.record_action_allows(${RUN}, ${lockRowRevokeFirst}, 'start') as allowed
        `.execute(trx)).rows[0]?.allowed === true);
      await awaitBlocked("ra-check-second");
      release.resolve();
      expect(await revoking).toBe("revoked");
      // Not the grant that was live when the check started: the one that is
      // live now. A READ COMMITTED re-read after the lock is released is what
      // makes this the committed answer rather than a stale snapshot.
      expect(await checking).toBe(false);
    } finally {
      await checker.close();
      await revoker.close();
    }
  }, TEST_TIMEOUT);
});

/**
 * What the ACTION's declared lock mode does to two holders in parallel.
 *
 * The check and the effect are one transaction, with the check's row lock
 * taken first. If the effect then needs a stronger lock on that same row, the
 * strength the check took decides whether two parallel holders serialize or
 * deadlock:
 *
 *   shared     both pass the check holding a shared lock, both try to upgrade,
 *              and each waits for the other to let go. PostgreSQL detects the
 *              cycle and aborts one transaction (SQLSTATE 40P01).
 *   exclusive  the second holder waits at the CHECK. Only one holder is ever
 *              positioned to upgrade, so there is no cycle to detect.
 *
 * Both are driven on two separate restricted connections against real
 * transactions, and the serialization is asserted on pg_blocking_pids rather
 * than on a sleep. The deadlock case is here deliberately: it is the proof
 * that `exclusive` is load-bearing and not a precaution, and the reason it is
 * the default a silent manifest compiles to.
 */
describe("the declared lock decides what two parallel holders do", () => {
  const machine = () => session({
    userId: randomUUID(), principalKind: "service",
    appPrincipal: { integrationId: integration, credentialId: credential },
  });

  async function labelledJob<T>(
    runtime: DatabaseRuntime,
    label: string,
    work: (trx: Transaction<DB>) => Promise<T>,
  ): Promise<T> {
    return withDbSession(runtime.db, machine(), async (trx) => {
      await sql`select set_config('application_name', ${label}, false)`.execute(trx);
      // deadlock_timeout is not settable by the restricted app role, so the
      // deadlock case waits out the server default (1s) before PostgreSQL
      // looks for a cycle. That is the real deployment's behaviour too.
      return work(trx);
    });
  }

  async function blocked(label: string): Promise<boolean> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const count = await admin.db.connection().execute(async (conn) =>
        (await sql<{ count: number }>`
          select count(*)::int as count
            from pg_stat_activity
           where application_name = ${label}
             and cardinality(pg_blocking_pids(pid)) > 0
        `.execute(conn)).rows[0]!.count);
      if (count > 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  }

  /** The effect: the row-exclusive lock a handler that writes the record takes. */
  async function lockForUpdate(trx: Transaction<DB>, row: string): Promise<number> {
    const result = await sql<{ id: string }>`
      select id from erp.action_jobs where id = ${row}::uuid for update
    `.execute(trx);
    return result.rows.length;
  }

  test("shared lets both through the check and then deadlocks on the upgrade", async () => {
    const first = createDatabaseRuntime({ databaseUrl: url(scratch, true), maxConnections: 1 });
    const second = createDatabaseRuntime({ databaseUrl: url(scratch, true), maxConnections: 1 });
    try {
      const bothChecked = Promise.withResolvers<void>();
      let checked = 0;
      const holder = (runtime: DatabaseRuntime, label: string) =>
        labelledJob(runtime, label, async (trx) => {
          const allowed = (await sql<{ allowed: boolean | null }>`
            select app.record_action_allows(${JOB}, ${jobRowShared}, 'claimShared') as allowed
          `.execute(trx)).rows[0]?.allowed === true;
          expect(allowed).toBe(true);
          checked += 1;
          if (checked === 2) bothChecked.resolve();
          await bothChecked.promise;
          // Both now hold a SHARED lock on the ACL row and both want it
          // exclusively. Neither can have it.
          return lockForUpdate(trx, jobRowShared);
        });
      const outcomes = await Promise.allSettled([
        holder(first, "ra-shared-1"),
        holder(second, "ra-shared-2"),
      ]);
      // Exactly one transaction survives; the other is the deadlock victim.
      const failures = outcomes.filter((outcome) => outcome.status === "rejected");
      expect(failures).toHaveLength(1);
      expect(String((failures[0] as PromiseRejectedResult).reason)).toMatch(/deadlock/i);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    } finally {
      await first.close();
      await second.close();
    }
  }, TEST_TIMEOUT);

  test("exclusive serializes at the check, so the upgrade is safe", async () => {
    const first = createDatabaseRuntime({ databaseUrl: url(scratch, true), maxConnections: 1 });
    const second = createDatabaseRuntime({ databaseUrl: url(scratch, true), maxConnections: 1 });
    try {
      const firstChecked = Promise.withResolvers<void>();
      const firstDone = Promise.withResolvers<void>();
      const order: string[] = [];
      const leader = labelledJob(first, "ra-exclusive-1", async (trx) => {
        const allowed = (await sql<{ allowed: boolean | null }>`
          select app.record_action_allows(${JOB}, ${jobRowExclusive}, 'claimExclusive') as allowed
        `.execute(trx)).rows[0]?.allowed === true;
        expect(allowed).toBe(true);
        firstChecked.resolve();
        await firstDone.promise;
        const rows = await lockForUpdate(trx, jobRowExclusive);
        order.push("leader");
        return rows;
      });
      await firstChecked.promise;
      const follower = labelledJob(second, "ra-exclusive-2", async (trx) => {
        const allowed = (await sql<{ allowed: boolean | null }>`
          select app.record_action_allows(${JOB}, ${jobRowExclusive}, 'claimExclusive') as allowed
        `.execute(trx)).rows[0]?.allowed === true;
        expect(allowed).toBe(true);
        const rows = await lockForUpdate(trx, jobRowExclusive);
        order.push("follower");
        return rows;
      });
      // The follower is held at its CHECK — before it holds anything the
      // leader needs — which is the whole point of the mode.
      expect(await blocked("ra-exclusive-2")).toBe(true);
      firstDone.resolve();
      expect(await leader).toBe(1);
      expect(await follower).toBe(1);
      expect(order).toEqual(["leader", "follower"]);
    } finally {
      await first.close();
      await second.close();
    }
  }, TEST_TIMEOUT);

  test("the revocation fence is the same under the shared mode", async () => {
    // The weaker mode trades parallel holders for nothing else: a concurrent
    // ACL change still cannot interleave with a check in flight.
    const checker = createDatabaseRuntime({ databaseUrl: url(scratch, true), maxConnections: 1 });
    const revoker = createDatabaseRuntime({ databaseUrl: url(scratch, true), maxConnections: 1 });
    try {
      const checked = Promise.withResolvers<void>();
      const effectDone = Promise.withResolvers<void>();
      const checking = labelledJob(checker, "ra-shared-fence-check", async (trx) => {
        const allowed = (await sql<{ allowed: boolean | null }>`
          select app.record_action_allows(${JOB}, ${jobRowSharedFence}, 'claimShared') as allowed
        `.execute(trx)).rows[0]?.allowed === true;
        checked.resolve();
        await effectDone.promise;
        return allowed;
      });
      await checked.promise;
      const revoking = withDbSession(
        revoker.db,
        session({ userId: otherPerson, principalKind: "person" }),
        async (trx) => {
          await sql`select set_config('application_name', 'ra-shared-fence-revoke', false)`.execute(trx);
          await sql`update erp.action_jobs
            set acl = ${sql.raw(`'${JSON.stringify({
              view: { users: [otherPerson] }, edit: { users: [otherPerson] }, actions: {},
            })}'::jsonb`)}
            where id = ${jobRowSharedFence}::uuid`.execute(trx);
          return "revoked" as const;
        },
      );
      expect(await blocked("ra-shared-fence-revoke")).toBe(true);
      effectDone.resolve();
      expect(await checking).toBe(true);
      expect(await revoking).toBe("revoked");
      expect(await allows(app.db, machine(), JOB, jobRowSharedFence, "claimShared")).toBe(false);
    } finally {
      await checker.close();
      await revoker.close();
    }
  }, TEST_TIMEOUT);
});

describe("existing human behaviour is unchanged", () => {
  test("a default-public ACL stays readable and a view grant still gates the row", async () => {
    const viewer = session({ userId: otherPerson, principalKind: "person" });
    const stranger = session({ userId: randomUUID(), principalKind: "person" });
    const readable = async (input: DbSessionInput, table: string) =>
      withDbSession(app.db, input, async (trx) =>
        (await sql<{ count: number }>`select count(*)::int as count from ${sql.id("erp", table)}`
          .execute(trx)).rows[0]!.count);
    // action_docs is empty=public and its ACL grants no view: still public.
    expect(await readable(stranger, "action_docs")).toBe(1);
    // action_runs is empty=restricted and names otherPerson for view on all
    // four tenant-A rows; the fifth belongs to the other tenant.
    expect(await readable(viewer, "action_runs")).toBe(4);
    expect(await readable(stranger, "action_runs")).toBe(0);
    // Holding an action never adds a row to either answer.
    const machine = session({
      userId: randomUUID(), principalKind: "service",
      appPrincipal: { integrationId: integration, credentialId: credential },
    });
    expect(await readable(machine, "action_runs")).toBe(0);
    expect(await readable(machine, "action_docs")).toBe(1);
  }, TEST_TIMEOUT);
});
