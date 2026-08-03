// SPDX-License-Identifier: BUSL-1.1
/**
 * The timer node's full lifecycle: park, stay parked, be claimed, continue.
 *
 * Two things are being pinned, and only one of them is the sweep.
 *
 * **The sweep reads across tenants.** `workflow.waits` carries the worker axis,
 * so a session presenting `app.worker_role` may claim due rows in any tenant.
 * Two tenants are seeded because one proves nothing: a sweep that had somehow
 * acquired a tenant scope would still pass a single-tenant test. Connecting as
 * the restricted, non-superuser `openshapeforge_app` role is what makes the
 * policy the real gate — as a superuser this passes with the axis removed.
 *
 * **The deadline is computed once.** The runtime re-executes a parked node on
 * every resume, so a bridge that recomputed its own deadline would slide it
 * forward by its own length each time and never fire. That is the failure this
 * file is really guarding, and it is invisible to a test that only runs the
 * bridge once.
 *
 * Run (cwd apps/api):
 *   set -o pipefail; bun test src/db/__tests__/workflow-timer-waits.test.ts 2>&1
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Kysely } from "kysely";
import type { DB } from "../../generated/db/types.js";
import { createDatabaseRuntime, type OpenShapeForgeDatabase } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import { APP_ROLE } from "../migrations/app-role.js";
import { loadRuntimeModules } from "../../modules/registry.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";

const APP_ROLE_PASSWORD = "openshapeforge_app";
const TEST_TIMEOUT = 90_000;

/**
 * `apps/api/tsconfig.json` roots its program at `src`, so plugin runtime code
 * cannot be imported statically from here. Resolved at run time, as the plugin
 * loader and the other plugin-reaching tests do.
 */
const TIMER_WAITS_MODULE = new URL(
  "../../../../../examples/plugins/workflow/runtime/timer-waits.js",
  import.meta.url,
).href;
const TIMER_BRIDGE_MODULE = new URL(
  "../../../../../examples/plugins/workflow/runtime/timer-bridge.js",
  import.meta.url,
).href;

type TimerWaitsModule = {
  processDueWorkflowTimerWaits: (
    db: OpenShapeForgeDatabase,
  ) => Promise<{ fired: number }>;
};
type BridgeOutput = {
  outputHandle: string;
  payload: Record<string, unknown>;
  wait?: { waitToken: string; waitKind: string };
};
/**
 * The handler itself, not the registry.
 *
 * `bun test` shares module state across files, and bridge registration is
 * one-shot and throws on a duplicate — so a test that registers into the global
 * registry leaves the next file's module init in whatever state it happened to
 * produce. Calling the exported handler keeps this file's subject to itself.
 */
type TimerBridgeModule = {
  timerNodeBridge: (context: Record<string, unknown>) => Promise<BridgeOutput>;
};

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
  const name = `workflow_timer_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
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

async function migrate(name: string): Promise<void> {
  await withDb(scratchUrl(name, false), async (db) => {
    const modules = await loadRuntimeModules();
    expect(modules.failures).toEqual([]);
    const moduleSeeds = modules.loaded.flatMap((module) => module.seeds ?? []);
    await db.connection().execute((conn) => runMigrationChain(conn, { moduleSeeds }));
  });
}

/** One running instance, returned with the tenant it belongs to. */
async function seedInstance(conn: Kysely<DB>, tenantId: string, label: string) {
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
  return instance.rows[0]!.id;
}

describe("the workflow timer", () => {
  test(
    "sweeps due waits across tenants and leaves everything else alone",
    async () => {
      const tenantA = randomUUID();
      const tenantB = randomUUID();

      await withScratchDb(async (name) => {
        await migrate(name);

        await withDb(scratchUrl(name, false), async (db) => {
          await db.connection().execute(async (conn) => {
            const typed = conn as unknown as Kysely<DB>;
            for (const [tenant, label] of [
              [tenantA, "tenant-a"],
              [tenantB, "tenant-b"],
            ] as const) {
              const instanceId = await seedInstance(typed, tenant, label);
              // Due.
              await sql`
                insert into workflow.waits (
                  tenant_id, instance_id, node_id, wait_token, wait_kind, resume_at
                ) values (
                  ${tenant}::uuid, ${instanceId}::uuid, ${"wait-1"}, ${`${label}-due`},
                  ${"timer"}, now() - interval '1 minute'
                )
              `.execute(typed);
              // Not yet due.
              await sql`
                insert into workflow.waits (
                  tenant_id, instance_id, node_id, wait_token, wait_kind, resume_at
                ) values (
                  ${tenant}::uuid, ${instanceId}::uuid, ${"wait-2"}, ${`${label}-later`},
                  ${"timer"}, now() + interval '1 hour'
                )
              `.execute(typed);
              // A different wait kind, with no deadline at all: the sweep must
              // not touch waits it does not own.
              await sql`
                insert into workflow.waits (
                  tenant_id, instance_id, node_id, wait_token, wait_kind
                ) values (
                  ${tenant}::uuid, ${instanceId}::uuid, ${"wait-3"}, ${`${label}-other`},
                  ${"collection_entity"}
                )
              `.execute(typed);
            }
          });
        });

        const { processDueWorkflowTimerWaits } = (await import(
          TIMER_WAITS_MODULE
        )) as TimerWaitsModule;

        // As a worker runs it: restricted role, no tenant scope.
        const result = await withDb(scratchUrl(name, true), async (db) =>
          processDueWorkflowTimerWaits(db),
        );
        expect(result.fired).toBe(2);

        await withDb(scratchUrl(name, false), async (db) => {
          const rows = await sql<{ wait_token: string; claimed: boolean }>`
            select wait_token, (resumed_at is not null) as claimed
            from workflow.waits
            order by wait_token
          `.execute(db);
          expect(rows.rows).toEqual([
            { wait_token: "tenant-a-due", claimed: true },
            { wait_token: "tenant-a-later", claimed: false },
            { wait_token: "tenant-a-other", claimed: false },
            { wait_token: "tenant-b-due", claimed: true },
            { wait_token: "tenant-b-later", claimed: false },
            { wait_token: "tenant-b-other", claimed: false },
          ]);

          // Each claim enqueued a resume for its own tenant — the work half,
          // which runs in a session scoped to that wait's tenant because
          // `workflow.instances` deliberately has no worker axis.
          const commands = await sql<{ tenant_id: string; command_type: string }>`
            select tenant_id::text, command_type from workflow.control_commands
          `.execute(db);
          expect(commands.rows).toHaveLength(2);
          expect(commands.rows.every((r) => r.command_type === "workflow.instance.resume")).toBe(
            true,
          );
          expect(new Set(commands.rows.map((r) => r.tenant_id))).toEqual(
            new Set([tenantA, tenantB]),
          );
        });

        // A second sweep finds nothing: the claim retires the row, so a poll
        // loop does not re-enqueue the same resume every tick forever.
        const again = await withDb(scratchUrl(name, true), async (db) =>
          processDueWorkflowTimerWaits(db),
        );
        expect(again.fired).toBe(0);
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "parks once, keeps its deadline across replays, and continues after the sweep",
    async () => {
      const tenant = randomUUID();

      await withScratchDb(async (name) => {
        await migrate(name);

        const { timerNodeBridge: bridge } = (await import(
          TIMER_BRIDGE_MODULE
        )) as TimerBridgeModule;

        await withDb(scratchUrl(name, false), async (db) => {
          const instanceId = await db
            .connection()
            .execute(async (conn) =>
              seedInstance(conn as unknown as Kysely<DB>, tenant, "timer run"),
            );

          const context = {
            db,
            tenantId: tenant,
            instanceId,
            nodeId: "timer-1",
            workflowDefinitionId: randomUUID(),
            // What the runtime injects, and what keeps the token stable across
            // the park and the replay.
            resolvedConfig: {
              mode: "duration",
              durationAmount: 2,
              durationUnit: "hours",
              idempotencyKey: `${instanceId}:timer-1`,
            },
          };

          // First pass: parks.
          const first = await bridge(context);
          expect(first.wait).toEqual({
            waitToken: `timer:${instanceId}:timer-1`,
            waitKind: "timer",
          });
          expect(first.payload.waiting).toBe(true);

          const parked = await sql<{ resume_at: string; wait_kind: string }>`
            select resume_at::text, wait_kind from workflow.waits
            where tenant_id = ${tenant}::uuid
          `.execute(db);
          expect(parked.rows).toHaveLength(1);
          const firstDeadline = parked.rows[0]!.resume_at;
          expect(parked.rows[0]!.wait_kind).toBe("timer");

          // Second pass, as a spurious resume would produce: still parked, and
          // — the assertion this file exists for — the SAME deadline. A bridge
          // that recomputed here would push the deadline out by two more hours
          // on every resume and never fire.
          const second = await bridge(context);
          expect(second.wait).toBeTruthy();
          const stillParked = await sql<{ resume_at: string }>`
            select resume_at::text from workflow.waits where tenant_id = ${tenant}::uuid
          `.execute(db);
          expect(stillParked.rows).toHaveLength(1);
          expect(stillParked.rows[0]!.resume_at).toBe(firstDeadline);

          // Make it due and sweep it, exactly as the worker would.
          await sql`
            update workflow.waits set resume_at = now() - interval '1 second'
            where tenant_id = ${tenant}::uuid
          `.execute(db);

          const { processDueWorkflowTimerWaits } = (await import(
            TIMER_WAITS_MODULE
          )) as TimerWaitsModule;
          expect((await processDueWorkflowTimerWaits(db)).fired).toBe(1);

          // The replay the resume triggers: no wait, so the runtime completes
          // the node and walks on.
          const third = await bridge(context);
          expect(third.wait).toBeUndefined();
          expect(third.outputHandle).toBe("default");
          expect(third.payload.waited).toBe(true);
        });
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "a deadline already in the past never parks at all",
    async () => {
      const tenant = randomUUID();

      await withScratchDb(async (name) => {
        await migrate(name);

        const { timerNodeBridge: bridge } = (await import(
          TIMER_BRIDGE_MODULE
        )) as TimerBridgeModule;

        await withDb(scratchUrl(name, false), async (db) => {
          const instanceId = await db
            .connection()
            .execute(async (conn) =>
              seedInstance(conn as unknown as Kysely<DB>, tenant, "past timer"),
            );

          // `until` a moment that has passed. Parking for a whole sweep
          // interval to answer a question already settled would be wrong.
          const output = await bridge({
            db,
            tenantId: tenant,
            instanceId,
            nodeId: "timer-1",
            workflowDefinitionId: randomUUID(),
            resolvedConfig: {
              mode: "until",
              untilAt: "2020-01-01T00:00:00.000Z",
              idempotencyKey: `${instanceId}:timer-1`,
            },
          });

          expect(output.wait).toBeUndefined();
          expect(output.payload.waited).toBe(true);
        });
      });
    },
    TEST_TIMEOUT,
  );
});
