// SPDX-License-Identifier: BUSL-1.1
/**
 * The publish path must not widen the session it was handed (#224).
 *
 * `syncWorkflowDefinitionScheduleInTransaction` and
 * `deactivateWorkflowDefinitionScheduleInTransaction` exist to be called from a
 * publish resolver, inside the request's own `withDbSession` transaction. They
 * used to set `app.roles`, `app.worker_role` and `app.tenant_id` on it.
 *
 * `set_config(..., true)` is transaction-LOCAL, not statement-local. So for the
 * remainder of the caller's transaction the request presented the worker role —
 * and `workflow.control_commands`, `workflow.schedules` and
 * `workflow.schedule_fires` carry `workerAccess`, so their policies admit
 * exactly that. A publish would have been able to read every tenant's queue.
 *
 * That is the boundary the worker axis rests on: the API's request path never
 * presents the worker role, a worker's boot path does. These two helpers were
 * the one way it stopped being true.
 *
 * Connects as the restricted, non-superuser `openshapeforge_app` role, so the
 * RLS policy is the real gate rather than a formality — a superuser would pass
 * this test with the defect still present.
 *
 * Run (cwd apps/api):
 *   set -o pipefail; bun test src/db/__tests__/workflow-schedule-sync-session.test.ts 2>&1
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Kysely } from "kysely";
import type { DB } from "../../generated/db/types.js";
import { createDatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import { APP_ROLE } from "../migrations/app-role.js";
import { withDbSession } from "../session.js";
import { loadRuntimeModules } from "../../modules/registry.js";
import {
  deactivateWorkflowDefinitionScheduleInTransaction,
  syncWorkflowDefinitionScheduleInTransaction,
} from "../../../../../examples/plugins/workflow/runtime/schedule-worker.js";

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
  const name = `workflow_sync_session_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
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

describe("the workflow schedule publish helpers", () => {
  test(
    "leave the caller's session unwidened, so a publish cannot read another tenant's queue",
    async () => {
      const ourTenant = randomUUID();
      const otherTenant = randomUUID();
      const actor = randomUUID();

      await withScratchDb(async (name) => {
        // Seed as the privileged role: two tenants, and a command belonging to
        // the tenant our session is NOT scoped to.
        const seeded = await withDb(scratchUrl(name, false), async (db) => {
          const modules = await loadRuntimeModules();
          expect(modules.failures).toEqual([]);
          const moduleSeeds = modules.loaded.flatMap((module) => module.seeds ?? []);
          await db.connection().execute((conn) => runMigrationChain(conn, { moduleSeeds }));

          return db.connection().execute(async (conn) => {
            const ourDefinition = await sql<{ id: string }>`
              insert into workflow.definitions (tenant_id, name, is_active)
              values (${ourTenant}::uuid, ${"ours"}, true)
              returning id::text
            `.execute(conn);

            const otherDefinition = await sql<{ id: string }>`
              insert into workflow.definitions (tenant_id, name, is_active)
              values (${otherTenant}::uuid, ${"theirs"}, true)
              returning id::text
            `.execute(conn);
            const otherInstance = await sql<{ id: string }>`
              insert into workflow.instances (tenant_id, definition_id, status)
              values (${otherTenant}::uuid, ${otherDefinition.rows[0]!.id}::uuid, ${"running"})
              returning id::text
            `.execute(conn);
            await sql`
              insert into workflow.control_commands (
                tenant_id, command_type, workflow_instance_id, payload
              )
              values (
                ${otherTenant}::uuid, ${"workflow.instance.cancel"},
                ${otherInstance.rows[0]!.id}::uuid, ${sql.lit("{}")}::jsonb
              )
            `.execute(conn);

            return { ourDefinitionId: ourDefinition.rows[0]!.id };
          });
        });

        // Now act as a request would: restricted role, ordinary session scoped
        // to our tenant, with roles that are emphatically not the worker's.
        await withDb(scratchUrl(name, true), async (db) => {
          await withDbSession(
            db,
            { tenantId: ourTenant, userId: actor, roles: ["Workflow.Author"] },
            async (trx) => {
              const before = await sql<{ count: string }>`
                select count(*)::text as count from workflow.control_commands
              `.execute(trx);
              expect(before.rows[0]!.count).toBe("0");

              // The publish path. No published version exists, so this takes the
              // deactivate branch — which is the shared helper, and was the other
              // caller that set a worker session on someone else's transaction.
              const synced = await syncWorkflowDefinitionScheduleInTransaction(
                trx,
                ourTenant,
                seeded.ourDefinitionId,
              );
              expect(synced.status).toBe("inactive");

              await deactivateWorkflowDefinitionScheduleInTransaction(
                trx,
                ourTenant,
                seeded.ourDefinitionId,
                "published_draft_withdrawn",
              );

              // The whole point: still zero. With the helpers setting
              // `app.worker_role`, this reads the other tenant's command.
              const after = await sql<{ count: string }>`
                select count(*)::text as count from workflow.control_commands
              `.execute(trx);
              expect(after.rows[0]!.count).toBe("0");

              // And the session itself is intact — the caller's roles were not
              // replaced, and the worker role was never presented.
              const guc = await sql<{
                roles: string | null;
                worker_role: string | null;
                tenant_id: string | null;
              }>`
                select
                  nullif(current_setting('app.roles', true), '') as roles,
                  nullif(current_setting('app.worker_role', true), '') as worker_role,
                  nullif(current_setting('app.tenant_id', true), '') as tenant_id
              `.execute(trx);

              expect(guc.rows[0]!.worker_role).toBeNull();
              expect(guc.rows[0]!.roles).toBe("Workflow.Author");
              expect(guc.rows[0]!.tenant_id).toBe(ourTenant);
            },
          );
        });
      });
    },
    TEST_TIMEOUT,
  );
});
