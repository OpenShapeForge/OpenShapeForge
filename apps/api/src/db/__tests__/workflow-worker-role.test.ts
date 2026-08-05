// SPDX-License-Identifier: BUSL-1.1
/**
 * The `workflow-worker` role, started the way production starts it (#218 phase 4).
 *
 * Nothing is stubbed: the module registry is the generated one, the role is
 * resolved out of whatever the workflow plugin contributes, and the process
 * connects as the restricted, non-superuser `openshapeforge_worker` role
 * through OPENSHAPEFORGE_WORKER_DATABASE_URL — so the RLS policy is the real
 * gate, not a formality, and so are the worker role's enumerated grants. What
 * this proves that the unit tests cannot is the whole chain holding at once:
 *
 *   registry -> module init -> worker connection string -> worker role
 *            -> RLS policy -> claim -> dispatch
 *
 * The command is a cancel because it is the shortest command that does real
 * work. The claim is cross-tenant (connected as the worker role, presenting
 * `app.worker_role`); the work itself opens `withDbSession` on the command's
 * own tenant, which is the split the whole design rests on — the cross-tenant
 * surface is the queue, not the work. Since #223 that second half also proves
 * the grant: the tenant-scoped session reaches `workflow.instances` because
 * that table declares `workerDml`, not because the role holds a schema sweep.
 *
 * The later tests pin the *other* poll loops the role owns, and they name none
 * of them on purpose: they seed a due schedule or an expired wait, start the
 * role, and wait for the effect. A loop the role stops starting fails them —
 * which is exactly what #235 was, a pair of collection-wait sweeps with no call
 * site outside their own file: correct, and never run.
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
import {
  DEV_WORKER_ROLE_PASSWORD_DEFAULT,
  WORKER_ROLE as WORKER_DB_ROLE,
} from "../migrations/worker-role.js";
import { loadRuntimeModules } from "../../modules/registry.js";
import { startWorkerRole } from "../../roles/worker.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";

const TEST_TIMEOUT = 90_000;
const WORKER_ROLE = "workflow-worker";

/**
 * `asWorkerRole` connects as `openshapeforge_worker` — since #223 the role the
 * queue policies compare `current_user` against, and the one a worker process
 * gets from OPENSHAPEFORGE_WORKER_DATABASE_URL. Everything else connects as the
 * privileged role, which seeds and asserts.
 */
function scratchUrl(name: string, asWorkerRole: boolean): string {
  const url = new URL(ADMIN_URL);
  if (url.pathname === "/openshapeforge_dev") {
    throw new Error("admin URL must not point at openshapeforge_dev");
  }
  if (asWorkerRole) {
    url.username = WORKER_DB_ROLE;
    url.password = DEV_WORKER_ROLE_PASSWORD_DEFAULT;
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
        // Through the environment, not an injected URL: resolving
        // OPENSHAPEFORGE_WORKER_DATABASE_URL (and refusing to fall back to
        // DATABASE_URL) is part of the chain being proved.
        const handle = await startWorkerRole(WORKER_ROLE, {
          env: { OPENSHAPEFORGE_WORKER_DATABASE_URL: scratchUrl(name, true) },
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

  test(
    "fires a due schedule, because the schedule worker runs in this role too",
    async () => {
      const tenant = randomUUID();
      const author = randomUUID();

      await withScratchDb(async (name) => {
        const seeded = await withDb(scratchUrl(name, false), async (db) => {
          const modules = await loadRuntimeModules();
          expect(modules.failures).toEqual([]);
          const moduleSeeds = modules.loaded.flatMap((module) => module.seeds ?? []);
          await db.connection().execute((conn) => runMigrationChain(conn, { moduleSeeds }));

          return db.connection().execute(async (conn) => {
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
                  config: { cron: "0 9 * * *", timezone: "UTC" },
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
            const versionId = version.rows[0]!.id;

            // The schedule row the sync helper would have written, with its
            // fire already due — the worker's job here is to notice, not to
            // wait out a cron boundary the test would have to sleep through.
            await sql`
              insert into workflow.schedules (
                tenant_id, definition_id, version_id, trigger_node_id,
                cron, timezone, started_by, status, generation,
                next_fire_at, next_occurrence
              )
              values (
                ${tenant}::uuid, ${definitionId}::uuid, ${versionId}::uuid, ${"trigger-1"},
                ${"0 9 * * *"}, ${"UTC"}, ${author}::uuid, ${"active"}, 1,
                now() - interval '1 minute', 1
              )
            `.execute(conn);

            return { definitionId, versionId };
          });
        });

        // The same single role as the test above. Nothing here names the
        // schedule worker: if it is not started by the role, nothing fires.
        // Through the environment, not an injected URL: resolving
        // OPENSHAPEFORGE_WORKER_DATABASE_URL (and refusing to fall back to
        // DATABASE_URL) is part of the chain being proved.
        const handle = await startWorkerRole(WORKER_ROLE, {
          env: { OPENSHAPEFORGE_WORKER_DATABASE_URL: scratchUrl(name, true) },
          log: { info: () => {}, warn: () => {}, error: () => {} },
        });

        try {
          await withDb(scratchUrl(name, false), async (db) => {
            const fire = await until("the due schedule to fire", async () => {
              const rows = await sql<{
                version_id: string | null;
                command_id: string | null;
                status: string;
              }>`
                select version_id::text, command_id::text, status
                from workflow.schedule_fires
                where tenant_id = ${tenant}::uuid
              `.execute(db);
              const row = rows.rows[0];
              return row && row.command_id ? row : null;
            });

            expect(fire.version_id).toBe(seeded.versionId);
            expect(fire.status).toBe("started");

            // ...and the two halves of the role met: the schedule worker
            // enqueued a start, and the control-command worker drained it. That
            // is why they share a role — either alone leaves this unfinished.
            // Wait for a TERMINAL status, not merely "no longer pending":
            // `processing` is the claim, and a row read there is in flight
            // rather than finished.
            const terminal = ["completed", "runtime_consumed", "failed"];
            const command = await until("the start command to be drained", async () => {
              const rows = await sql<{ status: string; command_type: string }>`
                select status, command_type
                from workflow.control_commands
                where id = ${fire.command_id}::uuid
              `.execute(db);
              const row = rows.rows[0];
              return row && terminal.includes(row.status) ? row : null;
            });
            expect(command.command_type).toBe("workflow.instance.start");
            expect(["completed", "runtime_consumed"]).toContain(command.status);

            // The schedule advanced rather than re-firing the same occurrence.
            const schedule = await sql<{ next_occurrence: number; locked_by: string | null }>`
              select next_occurrence, locked_by
              from workflow.schedules
              where tenant_id = ${tenant}::uuid
            `.execute(db);
            expect(schedule.rows[0]!.next_occurrence).toBe(2);
            expect(schedule.rows[0]!.locked_by).toBeNull();
          });
        } finally {
          await handle.stop();
        }
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "times out every tenant's expired collection wait, because that sweep runs in this role too",
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
            const typed = conn as unknown as Kysely<DB>;
            // Two tenants, because one proves nothing: the sweep claims without a
            // tenant scope, and a sweep that had somehow acquired one would still
            // pass a single-tenant test.
            for (const [tenant, label] of [
              [tenantA, "tenant-a"],
              [tenantB, "tenant-b"],
            ] as const) {
              const definition = await sql<{ id: string }>`
                insert into workflow.definitions (tenant_id, name, is_active)
                values (${tenant}::uuid, ${label}, true)
                returning id::text
              `.execute(typed);
              const instance = await sql<{ id: string }>`
                insert into workflow.instances (tenant_id, definition_id, status)
                values (${tenant}::uuid, ${definition.rows[0]!.id}::uuid, ${"running"})
                returning id::text
              `.execute(typed);
              // A run parked on a collection wait whose deadline has passed. The
              // event it was collecting never arrived, so the timeout is the only
              // thing that can ever move it — nothing else in the system looks at
              // this row.
              await sql`
                insert into workflow.collection_waits (
                  tenant_id, instance_id, node_id, wait_token,
                  entity_type, event_type, filter_hash, timeout_at
                )
                values (
                  ${tenant}::uuid, ${instance.rows[0]!.id}::uuid, ${"collect-1"},
                  ${`${label}-expired`}, ${"relations"}, ${"created"}, ${"h1"},
                  now() - interval '1 minute'
                )
              `.execute(typed);
            }
          });
        });

        // The same single role as the tests above, and — the point of this test
        // — nothing here names the collection-wait worker or calls its sweep. If
        // the role does not start it, both runs stay parked and this fails.
        const handle = await startWorkerRole(WORKER_ROLE, {
          databaseUrl: scratchUrl(name, true),
          log: { info: () => {}, warn: () => {}, error: () => {} },
        });

        try {
          await withDb(scratchUrl(name, false), async (db) => {
            const waits = await until("both tenants' expired waits to be timed out", async () => {
              const rows = await sql<{ wait_token: string; status: string }>`
                select wait_token, status
                from workflow.collection_waits
                order by wait_token
              `.execute(db);
              return rows.rows.length === 2 &&
                rows.rows.every((row) => row.status === "timed_out")
                ? rows.rows
                : null;
            });
            expect(waits).toEqual([
              { wait_token: "tenant-a-expired", status: "timed_out" },
              { wait_token: "tenant-b-expired", status: "timed_out" },
            ]);

            // ...and each claim enqueued a resume for its own tenant — the work
            // half, which runs in a session scoped to that wait's tenant because
            // `workflow.instances` deliberately carries no worker axis. Claiming
            // without enqueueing would be the worse failure: the row is no longer
            // 'pending', so no later sweep would ever see it again.
            const commands = await until("a resume enqueued for each tenant", async () => {
              const rows = await sql<{ tenant_id: string; command_type: string }>`
                select tenant_id::text, command_type
                from workflow.control_commands
              `.execute(db);
              return rows.rows.length === 2 ? rows.rows : null;
            });
            expect(commands.every((row) => row.command_type === "workflow.instance.resume")).toBe(
              true,
            );
            expect(new Set(commands.map((row) => row.tenant_id))).toEqual(
              new Set([tenantA, tenantB]),
            );
          });
        } finally {
          await handle.stop();
        }
      });
    },
    TEST_TIMEOUT,
  );
});
