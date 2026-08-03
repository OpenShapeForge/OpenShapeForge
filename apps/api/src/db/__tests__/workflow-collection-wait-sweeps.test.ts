// SPDX-License-Identifier: BUSL-1.1
/**
 * The collection-wait sweeps actually reading rows (#221).
 *
 * The sweeps set `app.worker_role` and scan without a tenant. Before
 * `workflow.collection_waits` and `workflow.waits` carried the worker axis, no
 * policy read `app.current_worker_role()` for those tables, so the predicate
 * collapsed to `tenant_id = app.current_tenant()` with the tenant unset — NULL,
 * and every scan returned zero rows. No wait was ever replayed or timed out,
 * silently: the failure looked like an empty queue.
 *
 * Two tenants, because one tenant proves nothing here — a sweep that had somehow
 * picked up a tenant scope would still pass a single-tenant test. Seeing both
 * tenants' waits in one sweep is the assertion.
 *
 * Connects as the restricted, non-superuser `openshapeforge_app` role, so the
 * policy is the real gate. As a superuser this test passes with the defect
 * present, which is the trap that made the original failure invisible.
 *
 * Run (cwd apps/api):
 *   set -o pipefail; bun test src/db/__tests__/workflow-collection-wait-sweeps.test.ts 2>&1
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Kysely } from "kysely";
import type { DB } from "../../generated/db/types.js";
import { createDatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import { APP_ROLE } from "../migrations/app-role.js";
import { loadRuntimeModules } from "../../modules/registry.js";
import { processPendingWorkflowCollectionWaits } from "../../../../../examples/plugins/workflow/runtime/collection-waits.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";

const APP_ROLE_PASSWORD = "openshapeforge_app";
const TEST_TIMEOUT = 90_000;

function scratchUrl(name: string, asAppRole: boolean): string {
  const url = new URL(ADMIN_URL);
  if (url.pathname === "/openshapeforge_dev") {
    throw new Error("admin URL must not point at openshapeforge_dev");
  }
  if (asAppRole) {
    url.username = APP_ROLE;
    url.password = APP_ROLE_PASSWORD;
  }
  url.pathname = `/${name}`;
  return url.toString();
}

async function withScratchDb<T>(fn: (name: string) => Promise<T>): Promise<T> {
  const name = `workflow_cw_sweep_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
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
  const runtime = createDatabaseRuntime({ databaseUrl: url, maxConnections: 4 });
  try {
    return await fn(runtime.db);
  } finally {
    await runtime.close();
  }
}

/** One running instance carrying one expired wait and one live pending wait. */
async function seedTenant(conn: Kysely<DB>, tenantId: string, label: string) {
  const definition = await sql<{ id: string }>`
    insert into workflow.definitions (tenant_id, name, is_active)
    values (${tenantId}::uuid, ${label}, true)
    returning id::text
  `.execute(conn);
  const instance = await sql<{ id: string }>`
    insert into workflow.instances (tenant_id, definition_id, status)
    values (${tenantId}::uuid, ${definition.rows[0]!.id}::uuid, ${"running"})
    returning id::text
  `.execute(conn);
  const instanceId = instance.rows[0]!.id;

  // Expired: timeout_at in the past, so the timeout sweep must claim it.
  await sql`
    insert into workflow.collection_waits (
      tenant_id, instance_id, node_id, wait_token,
      entity_type, event_type, filter_hash, timeout_at
    )
    values (
      ${tenantId}::uuid, ${instanceId}::uuid, ${"collect-1"}, ${`${label}-expired`},
      ${"relations"}, ${"created"}, ${"h1"}, now() - interval '1 minute'
    )
  `.execute(conn);

  // Live: no timeout, so the replay scan must group it.
  await sql`
    insert into workflow.collection_waits (
      tenant_id, instance_id, node_id, wait_token,
      entity_type, event_type, filter_hash
    )
    values (
      ${tenantId}::uuid, ${instanceId}::uuid, ${"collect-2"}, ${`${label}-pending`},
      ${"relations"}, ${"updated"}, ${"h2"}
    )
  `.execute(conn);

  return { instanceId };
}

describe("the collection-wait sweeps", () => {
  test(
    "see every tenant's waits, and time out the expired ones",
    async () => {
      const tenantA = randomUUID();
      const tenantB = randomUUID();

      await withScratchDb(async (name) => {
        await withDb(scratchUrl(name, false), async (db) => {
          const modules = await loadRuntimeModules();
          expect(modules.failures).toEqual([]);
          const moduleSeeds = modules.loaded.flatMap((module) => module.seeds ?? []);
          await db.connection().execute((conn) => runMigrationChain(conn, { moduleSeeds }));
          await db.connection().execute(async (conn) => {
            await seedTenant(conn as unknown as Kysely<DB>, tenantA, "tenant-a");
            await seedTenant(conn as unknown as Kysely<DB>, tenantB, "tenant-b");
          });
        });

        // The sweep, as a worker runs it: restricted role, no tenant scope.
        const result = await withDb(scratchUrl(name, true), async (db) =>
          processPendingWorkflowCollectionWaits(db),
        );

        // One replay group per (tenant, entity_type, event_type). The replay scan
        // runs before the timeout sweep, so all four waits are still 'pending'
        // when it groups: two tenants x {relations/created, relations/updated}.
        // Zero before the worker axis reached these tables.
        expect(result.groups).toBe(4);
        // Both tenants' expired waits, claimed in one cross-tenant sweep.
        expect(result.timedOut).toBe(2);
        // Nothing sets requiresContinuationRouting, so this stays zero — but it
        // now runs its two-pass form without joining instances cross-tenant.
        expect(result.stalledContinuationRouting).toBe(0);

        // ...and it really happened, in both tenants, to the right rows.
        await withDb(scratchUrl(name, false), async (db) => {
          const rows = await sql<{ wait_token: string; status: string }>`
            select wait_token, status
            from workflow.collection_waits
            order by wait_token
          `.execute(db);

          expect(rows.rows).toEqual([
            { wait_token: "tenant-a-expired", status: "timed_out" },
            { wait_token: "tenant-a-pending", status: "pending" },
            { wait_token: "tenant-b-expired", status: "timed_out" },
            { wait_token: "tenant-b-pending", status: "pending" },
          ]);

          // Each timed-out wait enqueued a resume for its own tenant — the work
          // half, which happens in a session scoped to that wait's tenant.
          const commands = await sql<{ tenant_id: string; command_type: string }>`
            select tenant_id::text, command_type
            from workflow.control_commands
            order by tenant_id
          `.execute(db);
          expect(commands.rows).toHaveLength(2);
          expect(commands.rows.every((r) => r.command_type === "workflow.instance.resume")).toBe(
            true,
          );
          expect(new Set(commands.rows.map((r) => r.tenant_id))).toEqual(
            new Set([tenantA, tenantB]),
          );
        });
      });
    },
    TEST_TIMEOUT,
  );
});
