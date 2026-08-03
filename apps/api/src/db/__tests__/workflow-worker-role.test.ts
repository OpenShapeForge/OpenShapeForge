// SPDX-License-Identifier: BUSL-1.1
/**
 * The `workflow-worker` role, started the way production starts it (#218 phase 4).
 *
 * Nothing is stubbed: the module registry is the generated one, the role is
 * resolved out of whatever the workflow plugin contributes, and the process
 * connects as the restricted, non-superuser `openshapeforge_app` role — so the
 * RLS policy is the real gate, not a formality. What this proves that the unit
 * tests cannot is the whole chain holding at once:
 *
 *   registry -> module init -> worker role -> RLS policy -> claim -> dispatch
 *
 * The command is a cancel because it is the shortest command that does real
 * work. The claim is cross-tenant (the worker sets `app.worker_role`); the work
 * itself opens `withDbSession` on the command's own tenant, which is the split
 * the whole design rests on — the cross-tenant surface is the queue, not the
 * work.
 *
 * Run (cwd apps/api):
 *   set -o pipefail; bun test src/db/__tests__/workflow-worker-role.test.ts 2>&1
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
import { startWorkerRole } from "../../roles/worker.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";

const APP_ROLE_PASSWORD = "openshapeforge_app";
const TEST_TIMEOUT = 90_000;
const WORKER_ROLE = "workflow-worker";

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
  const name = `workflow_worker_role_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
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

/** Poll rather than sleep: the worker's tick is a poll loop, not a promise. */
async function until<T>(
  label: string,
  read: () => Promise<T | null>,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("the workflow-worker role", () => {
  test(
    "drains a control command it claimed across tenants, as the restricted app role",
    async () => {
      const tenant = randomUUID();
      const actor = randomUUID();

      await withScratchDb(async (name) => {
        const seeded = await withDb(scratchUrl(name, false), async (db) => {
          const modules = await loadRuntimeModules();
          expect(modules.failures).toEqual([]);
          const moduleSeeds = modules.loaded.flatMap((module) => module.seeds ?? []);
          await db.connection().execute((conn) => runMigrationChain(conn, { moduleSeeds }));

          return db.connection().execute(async (conn) => {
            const definition = await sql<{ id: string }>`
              insert into workflow.definitions (tenant_id, name)
              values (${tenant}::uuid, ${"worker role probe"})
              returning id::text
            `.execute(conn);
            const instance = await sql<{ id: string }>`
              insert into workflow.instances (tenant_id, definition_id, status)
              values (${tenant}::uuid, ${definition.rows[0]!.id}::uuid, ${"running"})
              returning id::text
            `.execute(conn);
            const command = await sql<{ id: string }>`
              insert into workflow.control_commands (
                tenant_id, command_type, workflow_instance_id, payload
              )
              values (
                ${tenant}::uuid, ${"workflow.instance.cancel"},
                ${instance.rows[0]!.id}::uuid,
                ${sql.lit(JSON.stringify({ cancelledBy: actor, reason: "worker role probe" }))}::jsonb
              )
              returning id::text
            `.execute(conn);

            return { instanceId: instance.rows[0]!.id, commandId: command.rows[0]!.id };
          });
        });

        // Exactly what `OPENSHAPEFORGE_ROLE=workflow-worker bun src/index.ts`
        // does, minus the signal wait — including connecting as the restricted
        // role, which is what makes the RLS policy load-bearing here.
        const handle = await startWorkerRole(WORKER_ROLE, {
          databaseUrl: scratchUrl(name, true),
          log: { info: () => {}, warn: () => {}, error: () => {} },
        });

        // The role name is the plugin's, not this file's: `apps/api` contributes
        // no workers of its own.
        expect(handle.module).toBe("workflow");

        try {
          await withDb(scratchUrl(name, false), async (db) => {
            const command = await until("the command to be consumed and completed", async () => {
              const rows = await sql<{ status: string; attempts: number; locked_by: string | null }>`
                select status, attempts, locked_by
                from workflow.control_commands
                where id = ${seeded.commandId}::uuid
              `.execute(db);
              const row = rows.rows[0];
              return row && row.status === "completed" ? row : null;
            });

            // Claimed once, by this worker, and completed — not abandoned to the
            // visibility timeout and not retried.
            expect(command.attempts).toBe(1);
            expect(command.locked_by).toBeNull();

            // ...and the work actually happened, in a session scoped to the
            // command's own tenant.
            const instance = await sql<{ status: string }>`
              select status from workflow.instances where id = ${seeded.instanceId}::uuid
            `.execute(db);
            expect(instance.rows[0]?.status).toBe("cancelled");
          });
        } finally {
          await handle.stop();
        }
      });
    },
    TEST_TIMEOUT,
  );
});
