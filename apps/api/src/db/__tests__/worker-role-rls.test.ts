// SPDX-License-Identifier: BUSL-1.1
/**
 * The worker axis, proved against a real database (#218).
 *
 * A workflow worker claims commands across every tenant. It used to do that by
 * setting `app.bypass_rls`, which is a single boolean honoured by all 20
 * tenant-scoped policies in the manifest — so a worker that needed 3 tables was
 * granted read AND write on every tenant's `erp.relations` too. The three queue
 * tables now declare `workerAccess: "workflow-worker"`, which puts an
 * `app.current_worker_role() = 'workflow-worker'` disjunct in THEIR policies and
 * nowhere else, and the workers set `app.worker_role` instead of the bypass.
 *
 * Everything below runs as the restricted, non-superuser `openshapeforge_app`
 * role against a throwaway scratch database, because RLS is only real for a role
 * that cannot bypass it. Every visibility assertion is a RAW `count(*)` with no
 * app-layer WHERE, so the numbers themselves are the proof.
 *
 * The negative half is the point of the change. A worker that can claim the
 * queue and still read `erp.relations` has gained nothing over the bypass.
 *
 * Run (cwd apps/api):
 *   set -o pipefail; bun test src/db/__tests__/worker-role-rls.test.ts 2>&1
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Kysely } from "kysely";
import type { DB } from "../../generated/db/types.js";
import { createDatabaseRuntime, type OpenShapeForgeDatabase } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import { APP_ROLE } from "../migrations/app-role.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";

const APP_ROLE_PASSWORD = "openshapeforge_app";
const TEST_TIMEOUT = 90_000;

/** The role name the queue policies name, and the workers present. */
const WORKER_ROLE = "workflow-worker";

/**
 * `apps/api/tsconfig.json` roots its program at `src`, so the worker cannot be
 * statically imported from here. The plugin loader has the same constraint and
 * answers it the same way — resolve the specifier at run time. Mirrors
 * `graphql/__tests__/workflow-engine.e2e.test.ts`.
 */
const WORKFLOW_RUNTIME_DIR = new URL(
  "../../../../../examples/plugins/workflow/runtime/",
  import.meta.url,
).href;

type ClaimedCommand = { id: string; tenantId: string; commandType: string };

type ControlCommandWorkerModule = {
  processWorkflowControlCommandBatch: (
    db: OpenShapeForgeDatabase,
    dispatcher: { dispatch: (command: ClaimedCommand) => Promise<void> },
    options?: { workerId?: string; batchSize?: number },
  ) => Promise<{ processed: number }>;
};

function scratchAdminUrl(name: string): string {
  const url = new URL(ADMIN_URL);
  if (url.pathname === "/openshapeforge_dev") {
    throw new Error("admin URL must not point at openshapeforge_dev");
  }
  url.pathname = `/${name}`;
  return url.toString();
}

/** Same scratch DB, but connecting AS the restricted openshapeforge_app role. */
function scratchAppUrl(name: string): string {
  const url = new URL(ADMIN_URL);
  url.username = APP_ROLE;
  url.password = APP_ROLE_PASSWORD;
  url.pathname = `/${name}`;
  return url.toString();
}

async function withScratchDb<T>(fn: (name: string) => Promise<T>): Promise<T> {
  const name = `worker_role_rls_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error(`unsafe scratch database name: ${name}`);
  }
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

async function withDb<T>(url: string, fn: (db: Kysely<DB>) => Promise<T>): Promise<T> {
  const runtime = createDatabaseRuntime({ databaseUrl: url, maxConnections: 2 });
  try {
    return await fn(runtime.db);
  } finally {
    await runtime.close();
  }
}

type Fixture = {
  tenantA: string;
  tenantB: string;
  relationMarker: string;
};

/**
 * Two tenants, each with a pending control command; tenant A additionally gets a
 * schedule, a schedule fire, a workflow instance and an `erp.relations` row.
 * Seeded as the privileged role, which is a superuser and therefore bypasses
 * every policy — so the fixture itself proves nothing and constrains nothing.
 */
async function seed(db: Kysely<DB>): Promise<Fixture> {
  const fixture: Fixture = {
    tenantA: randomUUID(),
    tenantB: randomUUID(),
    relationMarker: `worker-probe-${randomUUID().slice(0, 8)}`,
  };

  await db.connection().execute(async (conn) => {
    for (const tenant of [fixture.tenantA, fixture.tenantB]) {
      await sql`
        insert into workflow.control_commands (tenant_id, command_type, payload)
        values (${tenant}::uuid, ${"workflow.instance.start"}, '{}'::jsonb)
      `.execute(conn);
    }

    const definition = await sql<{ id: string }>`
      insert into workflow.definitions (tenant_id, name)
      values (${fixture.tenantA}::uuid, ${"probe"})
      returning id::text
    `.execute(conn);
    const definitionId = definition.rows[0]!.id;

    const schedule = await sql<{ id: string }>`
      insert into workflow.schedules (tenant_id, definition_id, cron, timezone)
      values (${fixture.tenantA}::uuid, ${definitionId}::uuid, ${"0 * * * *"}, ${"UTC"})
      returning id::text
    `.execute(conn);

    await sql`
      insert into workflow.schedule_fires (
        tenant_id, schedule_id, definition_id, trigger_node_id,
        scheduled_at, occurrence, idempotency_key
      )
      values (
        ${fixture.tenantA}::uuid, ${schedule.rows[0]!.id}::uuid, ${definitionId}::uuid,
        ${"trigger-1"}, now(), 1, ${`probe-${randomUUID()}`}
      )
    `.execute(conn);

    await sql`
      insert into workflow.instances (tenant_id, definition_id)
      values (${fixture.tenantA}::uuid, ${definitionId}::uuid)
    `.execute(conn);

    await sql`
      insert into erp.relations (tenant_id, display_name, relation_type)
      values (${fixture.tenantA}::uuid, ${fixture.relationMarker}, ${"person"})
    `.execute(conn);
  });

  return fixture;
}

describe("worker-role RLS axis", () => {
  test(
    "a session holding only app.worker_role claims the queue across tenants and can read nothing else",
    async () => {
      await withScratchDb(async (name) => {
        const fixture = await withDb(scratchAdminUrl(name), async (db) => {
          await db.connection().execute((conn) => runMigrationChain(conn));
          return seed(db);
        });

        const worker = (await import(
          `${WORKFLOW_RUNTIME_DIR}control-command-worker.ts`
        )) as ControlCommandWorkerModule;

        await withDb(scratchAppUrl(name), async (db) => {
          // (a) The runtime role must NOT be a superuser, or none of this means
          // anything: a superuser is exempt from RLS entirely.
          const superuser = await sql<{ is_superuser: string }>`
            select current_setting('is_superuser') as is_superuser
          `.execute(db);
          expect(superuser.rows[0]?.is_superuser).toBe("off");

          // (b) The REAL worker code path — applyWorkerSession sets
          // app.worker_role and nothing else — claims both tenants' commands.
          const claimed: ClaimedCommand[] = [];
          const result = await worker.processWorkflowControlCommandBatch(
            db,
            { dispatch: async (command) => void claimed.push(command) },
            { workerId: "worker-role-rls-test", batchSize: 10 },
          );

          expect(result.processed).toBe(2);
          expect([...new Set(claimed.map((command) => command.tenantId))].sort()).toEqual(
            [fixture.tenantA, fixture.tenantB].sort(),
          );

          // (c) The grant is exactly the three queue tables. Same GUC, RAW
          // counts, no tenant set — business data stays invisible.
          await db.connection().execute(async (conn) => {
            await sql`select set_config('app.worker_role', ${WORKER_ROLE}, false)`.execute(conn);

            const count = async (table: string) => {
              const rows = await sql<{ n: number }>`
                select count(*)::int as n from ${sql.raw(table)}
              `.execute(conn);
              return rows.rows[0]?.n ?? -1;
            };

            // Declared workerAccess → visible across tenants.
            expect(await count("workflow.control_commands")).toBe(2);
            expect(await count("workflow.schedules")).toBe(1);
            expect(await count("workflow.schedule_fires")).toBe(1);

            // NOT declared → invisible. This is the half that makes the change
            // worth making: under app.bypass_rls every one of these was 1.
            expect(await count("erp.relations")).toBe(0);
            expect(await count("workflow.instances")).toBe(0);
            expect(await count("workflow.definitions")).toBe(0);
          });
        });
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "the queue is visible because of the worker disjunct, not despite it",
    async () => {
      await withScratchDb(async (name) => {
        await withDb(scratchAdminUrl(name), async (db) => {
          await db.connection().execute((conn) => runMigrationChain(conn));
          await seed(db);
        });

        await withDb(scratchAppUrl(name), async (db) => {
          await db.connection().execute(async (conn) => {
            const commands = async () => {
              const rows = await sql<{ n: number }>`
                select count(*)::int as n from workflow.control_commands
              `.execute(conn);
              return rows.rows[0]?.n ?? -1;
            };

            // No worker role and no tenant: the policy admits nothing. Worth
            // asserting explicitly — the ported workers set a GUC no policy read,
            // and the failure mode was an empty queue rather than an error.
            await sql`select set_config('app.worker_role', '', false)`.execute(conn);
            expect(await commands()).toBe(0);

            // A DIFFERENT worker role: the policy compares the value, so another
            // plugin's worker does not inherit this one's queue.
            await sql`select set_config('app.worker_role', ${"some-other-worker"}, false)`.execute(
              conn,
            );
            expect(await commands()).toBe(0);

            // The declared role, and only then.
            await sql`select set_config('app.worker_role', ${WORKER_ROLE}, false)`.execute(conn);
            expect(await commands()).toBe(2);
          });
        });
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "the schedule worker's two-step session: the queue without a tenant, the definition with one",
    async () => {
      // The riskiest half of dropping the bypass, and the one that would fail
      // silently. `applyWorkflowScheduleSession` sets the worker role for the
      // cross-tenant claim, then sets `app.tenant_id` from the claimed row
      // before reading the definition it fires. `workflow.definitions` and
      // `workflow.definition_versions` deliberately do NOT declare workerAccess,
      // so if that second step were wrong the definition would simply read as
      // absent — and the worker would deactivate a perfectly good schedule as
      // `definition_not_schedulable` rather than raise anything.
      //
      // Asserted at the session level rather than by running the worker: the
      // schedule worker cannot complete a fire today for an unrelated reason
      // (it writes `schedule_fires.version_id` / `.command_id`, neither of which
      // the table declares — tracked separately). The GUC sequence below is
      // exactly what that worker applies.
      await withScratchDb(async (name) => {
        const fixture = await withDb(scratchAdminUrl(name), async (db) => {
          await db.connection().execute((conn) => runMigrationChain(conn));
          return seed(db);
        });

        await withDb(scratchAppUrl(name), async (db) => {
          await db.connection().execute(async (conn) => {
            const count = async (table: string) => {
              const rows = await sql<{ n: number }>`
                select count(*)::int as n from ${sql.raw(table)}
              `.execute(conn);
              return rows.rows[0]?.n ?? -1;
            };

            // Step 1 — the claim. Worker role, no tenant.
            await sql`select set_config('app.worker_role', ${WORKER_ROLE}, false)`.execute(conn);
            await sql`select set_config('app.tenant_id', '', false)`.execute(conn);
            expect(await count("workflow.schedules")).toBe(1);
            // The definition the schedule points at is NOT reachable yet, which
            // is the grant being narrow rather than an accident.
            expect(await count("workflow.definitions")).toBe(0);

            // Step 2 — the fire. Same worker role, tenant now known.
            await sql`select set_config('app.tenant_id', ${fixture.tenantA}, false)`.execute(conn);
            expect(await count("workflow.definitions")).toBe(1);
            expect(await count("workflow.schedule_fires")).toBe(1);

            // ...and it is the tenant predicate doing that work, not the worker
            // role: another tenant's definitions stay invisible throughout.
            await sql`select set_config('app.tenant_id', ${fixture.tenantB}, false)`.execute(conn);
            expect(await count("workflow.definitions")).toBe(0);
          });
        });
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "only the declared queue and wait tables carry the worker disjunct",
    async () => {
      await withScratchDb(async (name) => {
        await withDb(scratchAdminUrl(name), async (db) => {
          await db.connection().execute(async (conn) => {
            await runMigrationChain(conn);

            // Read the policies Postgres actually holds, not the SQL we emitted:
            // a policy that failed to apply would still be in the artifact.
            const policies = await sql<{ qualified: string; qual: string; withcheck: string }>`
              select
                schemaname || '.' || tablename as qualified,
                coalesce(qual, '') as qual,
                coalesce(with_check, '') as withcheck
              from pg_policies
              where qual like '%current_worker_role%'
                 or with_check like '%current_worker_role%'
              order by 1
            `.execute(conn);

            // The whole list, enumerated. Three queue tables the command and
            // schedule workers claim from, and the two wait tables the
            // collection-wait sweeps scan (#221) — that scan is their claim.
            expect(policies.rows.map((row) => row.qualified)).toEqual([
              "workflow.collection_waits",
              "workflow.control_commands",
              "workflow.schedule_fires",
              "workflow.schedules",
              "workflow.waits",
            ]);
            // USING and WITH CHECK move together, so a claim can also write back.
            for (const row of policies.rows) {
              expect(row.qual).toContain(WORKER_ROLE);
              expect(row.withcheck).toContain(WORKER_ROLE);
            }

            // Run data stays off the axis — the queue/work split the whole
            // design rests on. A worker reaches an instance only from a session
            // scoped to its tenant, which is why the stalled-wait counter in
            // `runtime/collection-waits.ts` resolves tenants first rather than
            // joining `instances` in one cross-tenant sweep.
            const runData = await sql<{ qualified: string; qual: string }>`
              select
                schemaname || '.' || tablename as qualified,
                coalesce(qual, '') as qual
              from pg_policies
              where schemaname = 'workflow'
                and tablename in ('instances', 'node_states')
            `.execute(conn);

            expect(runData.rows.length).toBe(2);
            for (const row of runData.rows) {
              expect(row.qual).not.toContain("current_worker_role");
            }

            // The other 17 policies are untouched. Spot-checked on the business
            // tables the old blanket bypass exposed.
            const untouched = await sql<{ qual: string }>`
              select coalesce(qual, '') as qual
              from pg_policies
              where schemaname = 'erp'
            `.execute(conn);

            expect(untouched.rows.length).toBeGreaterThan(0);
            for (const row of untouched.rows) {
              expect(row.qual).not.toContain("current_worker_role");
              expect(row.qual).toContain("bypass_rls");
            }
          });
        });
      });
    },
    TEST_TIMEOUT,
  );
});
