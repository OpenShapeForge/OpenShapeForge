// SPDX-License-Identifier: BUSL-1.1
/**
 * The schedule worker firing a due schedule, end to end (#220).
 *
 * `processWorkflowScheduleBatch` had never been executed by anything — no role
 * starts it and no test drove it — so the fact that it inserts two columns
 * `workflow.schedule_fires` does not declare went unnoticed. It throws on the
 * first due row, which means no schedule could ever fire.
 *
 * This drives the real path: publish a version carrying a `triggerSchedule`
 * node, sync the schedule through the shipped helper, then run one batch with
 * `now` past the boundary. Against a table missing `version_id`/`command_id` it
 * fails with `column "version_id" of relation "schedule_fires" does not exist`
 * (SQLSTATE 42703) rather than merely asserting less.
 *
 * The fire is a ledger entry, so what it records is asserted, not just that it
 * exists: the version it ran and the command it enqueued.
 *
 * Run (cwd apps/api):
 *   set -o pipefail; bun test src/db/__tests__/workflow-schedule-worker.test.ts 2>&1
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Kysely } from "kysely";
import type { DB } from "../../generated/db/types.js";
import { createDatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import { loadRuntimeModules } from "../../modules/registry.js";
import type { OpenShapeForgeDatabase } from "../connection.js";

/**
 * `apps/api/tsconfig.json` roots its program at `src`, so the worker cannot be
 * statically imported from here. The plugin loader has the same constraint and
 * answers it the same way — resolve the specifier at run time. Mirrors
 * `db/__tests__/worker-role-rls.test.ts`.
 */
const SCHEDULE_WORKER_MODULE = new URL(
  "../../../../../examples/plugins/workflow/runtime/schedule-worker.js",
  import.meta.url,
).href;

type ScheduleWorkerModule = {
  syncWorkflowDefinitionSchedule: (
    db: OpenShapeForgeDatabase,
    tenantId: string,
    definitionId: string,
    options?: { now?: Date },
  ) => Promise<{ status: "active" | "inactive"; nextFireAt?: Date }>;
  processWorkflowScheduleBatch: (
    db: OpenShapeForgeDatabase,
    options?: { now?: Date; workerId?: string; batchSize?: number },
  ) => Promise<{ processed: number; started: number; skipped: number }>;
};

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";

const TEST_TIMEOUT = 90_000;

/** Every day at 09:00. Concrete so the boundary below is unambiguous. */
const CRON = "0 9 * * *";
const TIMEZONE = "UTC";

function scratchUrl(name: string): string {
  const url = new URL(ADMIN_URL);
  if (url.pathname === "/openshapeforge_dev") {
    throw new Error("admin URL must not point at openshapeforge_dev");
  }
  url.pathname = `/${name}`;
  return url.toString();
}

async function withScratchDb<T>(fn: (name: string) => Promise<T>): Promise<T> {
  const name = `workflow_schedule_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
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

describe("the workflow schedule worker", () => {
  test(
    "records a fire naming the version it ran and the command it enqueued",
    async () => {
      const tenant = randomUUID();
      const author = randomUUID();

      await withScratchDb(async (name) => {
        await withDb(scratchUrl(name), async (db) => {
          const modules = await loadRuntimeModules();
          expect(modules.failures).toEqual([]);
          const moduleSeeds = modules.loaded.flatMap((module) => module.seeds ?? []);
          await db.connection().execute((conn) => runMigrationChain(conn, { moduleSeeds }));

          const seeded = await db.connection().execute(async (conn) => {
            const definition = await sql<{ id: string }>`
              insert into workflow.definitions (tenant_id, name, is_active)
              values (${tenant}::uuid, ${"nightly"}, true)
              returning id::text
            `.execute(conn);
            const definitionId = definition.rows[0]!.id;

            const graph = {
              nodes: [
                {
                  id: "trigger-1",
                  type: "triggerSchedule",
                  config: { cron: CRON, timezone: TIMEZONE },
                },
                { id: "end-1", type: "end", config: {} },
              ],
              edges: [{ source: "trigger-1", target: "end-1" }],
            };

            const version = await sql<{ id: string }>`
              insert into workflow.definition_versions (
                tenant_id, definition_id, version, definition, published_at, published_by
              )
              values (
                ${tenant}::uuid, ${definitionId}::uuid, 1,
                ${sql.lit(JSON.stringify(graph))}::jsonb, now(), ${author}::uuid
              )
              returning id::text
            `.execute(conn);

            return { definitionId, versionId: version.rows[0]!.id };
          });

          const { syncWorkflowDefinitionSchedule, processWorkflowScheduleBatch } = (await import(
            SCHEDULE_WORKER_MODULE
          )) as ScheduleWorkerModule;

          // 08:00 UTC — before the 09:00 fire, so the schedule is armed for today.
          const armedAt = new Date("2026-03-02T08:00:00.000Z");
          const synced = await syncWorkflowDefinitionSchedule(db, tenant, seeded.definitionId, {
            now: armedAt,
          });
          expect(synced.status).toBe("active");
          expect(synced.nextFireAt?.toISOString()).toBe("2026-03-02T09:00:00.000Z");

          // 09:05 UTC — past the boundary, so exactly one occurrence is due.
          const batch = await processWorkflowScheduleBatch(db, {
            now: new Date("2026-03-02T09:05:00.000Z"),
          });
          expect(batch).toEqual({ processed: 1, started: 1, skipped: 0 });

          await db.connection().execute(async (conn) => {
            const fires = await sql<{
              version_id: string | null;
              command_id: string | null;
              workflow_instance_id: string | null;
              occurrence: number;
              status: string;
              scheduled_at: Date;
            }>`
              select
                version_id::text,
                command_id::text,
                workflow_instance_id::text,
                occurrence,
                status,
                scheduled_at
              from workflow.schedule_fires
              where tenant_id = ${tenant}::uuid
            `.execute(conn);

            expect(fires.rows).toHaveLength(1);
            const fire = fires.rows[0]!;

            // The ledger says which published graph ran...
            expect(fire.version_id).toBe(seeded.versionId);
            // ...and which start it enqueued.
            expect(fire.command_id).not.toBeNull();
            expect(fire.workflow_instance_id).not.toBeNull();
            expect(fire.status).toBe("started");
            expect(fire.occurrence).toBe(1);
            expect(new Date(fire.scheduled_at).toISOString()).toBe("2026-03-02T09:00:00.000Z");

            // The command the fire points at is a real queued start for this run.
            const command = await sql<{
              command_type: string;
              status: string;
              workflow_instance_id: string | null;
            }>`
              select command_type, status, workflow_instance_id::text
              from workflow.control_commands
              where id = ${fire.command_id}::uuid
            `.execute(conn);

            expect(command.rows).toHaveLength(1);
            expect(command.rows[0]!.command_type).toBe("workflow.instance.start");
            expect(command.rows[0]!.workflow_instance_id).toBe(fire.workflow_instance_id);
          });
        });
      });
    },
    TEST_TIMEOUT,
  );
});
