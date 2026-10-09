// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import type {
  MaintenanceContext,
  MaintenanceConnection,
  MaintenanceQuery,
  RunMaintenanceSeed,
} from "@openshapeforge/plugin-runtime";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import { controlSessionFor } from "../control/control-session.js";
import {
  createDatabaseRuntime,
  type DatabaseRuntime,
} from "../db/connection.js";
import { runMigrationChain } from "../db/migration-chain.js";
import { withDbSession } from "../db/session.js";
import {
  bindOperationHandlers,
  invokeOperation,
  runtimeStaticOperationRegistrations,
  type OperationContract,
} from "../operations/runtime.js";
import type { RuntimeModule } from "./contract.js";
import {
  loadRuntimeModules,
  initRuntimeModules,
  closeRuntimeModules,
} from "./registry.js";
import { ModulePlatformRuntime } from "./platform.js";
import { createRuntimeHostOperationExecutor } from "../mcp/runtime-executors.js";
import { runMaintenanceCommand, runRegisteredSeedJob } from "./maintenance.js";

const adminUrl =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const name = `maintenance_${randomUUID().replaceAll("-", "")}`;
const url = (app = false) => {
  const value = new URL(adminUrl);
  value.pathname = `/${name}`;
  if (app) {
    value.username = "openshapeforge_app";
    value.password = "openshapeforge_app";
  }
  return value.toString();
};
const oldEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  OPENSHAPEFORGE_MIGRATE_DATABASE_URL:
    process.env.OPENSHAPEFORGE_MIGRATE_DATABASE_URL,
};
let server: SQL;
let privileged: DatabaseRuntime;
let app: DatabaseRuntime;
let platform: ModulePlatformRuntime;
let modules: RuntimeModule[];
const tenantId = randomUUID(),
  foreignTenantId = randomUUID(),
  actorId = randomUUID(),
  relationId = randomUUID(),
  foreignRelationId = randomUUID();
const slug = `fixture-${tenantId.slice(0, 8)}`;
const contribution = {
  name: "example-maintenance",
  actorId,
  operations: ["Relation.get", "Relation.update"],
  actingRelation: { sourceAuthority: "example-seed" },
};
const seed = {
  name: "example-seed",
  maintenanceOptIn: () => true,
  apply: async () => ({ present: true, skipped: false, rows: 0 }),
};
let work: (runner: RunMaintenanceSeed | undefined) => Promise<void>;
const owner: RuntimeModule = {
  name: "example-maintenance-owner",
  maintenance: [contribution],
  seeds: [seed],
  operationHandlers: {
    run: async (_input, context) => {
      await work(context.runSeed);
      return { ok: true, status: 200, value: { done: true } };
    },
  },
};
const operation: OperationContract = {
  key: "example.maintain",
  plugin: owner.name,
  handler: "run",
  title: "Maintain fixture",
  description: "Exercise the registered Control boundary.",
  inputSchema: { type: "object", additionalProperties: false },
  outputSchema: {
    type: "object",
    properties: { done: { const: true } },
    required: ["done"],
    additionalProperties: false,
  },
  errors: [],
  auth: { mode: "control", roles: ["platform-operator"] },
  tenancy: { mode: "none" },
  idempotency: { mode: "intrinsic" },
  effects: { data: "write", external: "none" },
  transports: {
    rest: {
      method: "POST",
      path: "/api/control/example",
      response: { kind: "json" },
    },
    mcp: { enabled: false, reason: "Fixture" },
    graphql: { enabled: false, reason: "Fixture" },
    typescript: { enabled: false, reason: "Fixture" },
  },
};
const operator = (
  roles = ["platform-operator"],
  expiresAtMs: number | null = Date.now() + 60_000,
) =>
  controlSessionFor(
    {
      subject: "fixture-operator",
      issuer: "https://issuer.example/realms/control",
      username: "operator",
      name: null,
      email: null,
      authorizedParty: "fixture-client",
      expiresAtMs,
    },
    roles,
  );
const request = {
  contribution: contribution.name,
  tenantSlug: slug,
  reason: "regression proof",
};
const dispatch = (session: TrustedSessionContext = operator()) =>
  invokeOperation(
    bindOperationHandlers([owner], [operation]).get(operation.key)!,
    {},
    {
      db: app.db,
      platform: platform.services,
      session,
      transport: "operation",
    },
  );
const audit = () =>
  sql<{
    succeeded: boolean;
    actor_subject: string;
    tenant_id: string | null;
  }>`select succeeded, actor_subject, tenant_id::text from platform.system_bypass_audit where reason like '%example-maintenance%' order by started_at desc`.execute(
    privileged.db,
  );


beforeAll(async () => {
  server = new SQL(adminUrl);
  await server.unsafe(`create database "${name}"`);
  privileged = createDatabaseRuntime({ databaseUrl: url() });
  await privileged.db
    .connection()
    .execute((connection) => runMigrationChain(connection));
  app = createDatabaseRuntime({ databaseUrl: url(true) });
  platform = new ModulePlatformRuntime(app.db);
  const context = { db: app.db, platform: platform.services };
  const registry = await initRuntimeModules(
    await loadRuntimeModules(),
    context,
  );
  expect(registry.failures).toEqual([]);
  modules = registry.loaded;
  platform.registerOperationProviders(modules);
  platform.registerHostOperationExecutor(
    createRuntimeHostOperationExecutor({
      db: app.db,
      modules,
      modulePlatform: platform,
    }),
  );
  platform.registerStaticOperations(
    runtimeStaticOperationRegistrations(modules, context),
  );
  process.env.DATABASE_URL = url(true);
  process.env.OPENSHAPEFORGE_MIGRATE_DATABASE_URL = url();
  await sql`insert into platform.tenants(id,slug,name,status) values (${tenantId}::uuid,${slug},'Example','active'),(${foreignTenantId}::uuid,${`foreign-${foreignTenantId.slice(0, 8)}`},'Foreign','active')`.execute(
    privileged.db,
  );
  await sql`insert into erp.relations(id,tenant_id,display_name,relation_type,source_authority,status) values (${relationId}::uuid,${tenantId}::uuid,'Original','person','example-seed','active'),(${foreignRelationId}::uuid,${foreignTenantId}::uuid,'Foreign','person','example-seed','active')`.execute(
    privileged.db,
  );
}, 90_000);
afterAll(async () => {
  for (const [key, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await closeRuntimeModules(modules ?? []);
  await app?.close();
  await privileged?.close();
  await server.unsafe(`drop database if exists "${name}" with (force)`);
  await server.close();
});

test("tenant credentials, missing operator role and expired Control authority cannot elevate", async () => {
  let called = false;
  work = async () => {
    called = true;
  };
  await expect(
    dispatch({
      tenantId,
      userId: actorId,
      roles: ["platform-operator"],
      groups: [],
      scope: "tenant",
      credential: "bearer",
    }),
  ).rejects.toThrow();
  await expect(dispatch(operator([]))).rejects.toThrow();
  expect(called).toBe(false);
  work = async (runner) => {
    expect(runner).toBeDefined();
    await runner!(request, async () => {
      called = true;
    });
  };
  await expect(
    dispatch(operator(["platform-operator"], Date.now() - 1)),
  ).rejects.toThrow();
  expect(called).toBe(false);
  expect((await audit()).rows).toEqual([]);
});

test("live registered owner keeps provenance immutable and store units audited, with normal RLS Operations", async () => {
  let retained: MaintenanceContext;
  let pinned: MaintenanceConnection;
  let query: MaintenanceQuery;
  work = async (runner) =>
    runner!(request, async (context) => {
      retained = context;
      expect(Object.isFrozen(context)).toBe(true);
      expect(Object.isFrozen(context.provenance)).toBe(true);
      expect(Object.isFrozen(context.provenance.operator)).toBe(true);
      expect(context.provenance).toMatchObject({
        tenantId,
        tenantSlug: slug,
        contribution: contribution.name,
        operator: {
          subject: "fixture-operator",
          issuer: "https://issuer.example/realms/control",
        },
      });
      await context.store.pinned(async (connection) => {
        pinned = connection;
        await connection.query("select pg_advisory_lock(hashtext($1))", [
          tenantId,
        ]);
        try {
          await connection.transaction(async (transaction) => {
            query = transaction;
            const rows = await transaction.query<{
              tenant: string;
              bypass: string;
            }>(
              "select current_setting('app.tenant_id') as tenant, current_setting('app.bypass_rls') as bypass",
            );
            expect(rows[0]).toEqual({ tenant: tenantId, bypass: "true" });
          });
          const read = await context.operations.execute("Relation.get", {
            id: foreignRelationId,
          });
          expect("error" in read ? read.error.code : read.data).toBe(null);
          // The acting lookup runs on a separate app connection while this migrate pool of one is pinned.
          const changed = await context.operations.execute(
            "Relation.update",
            { id: relationId, values: { displayName: "Changed" } },
            { actingRelationId: relationId },
          );
          expect(changed).toHaveProperty("data");
        } finally {
          await connection.query("select pg_advisory_unlock(hashtext($1))", [
            tenantId,
          ]);
        }
      });
    });
  await dispatch();
  expect(
    (
      await sql<{
        display_name: string;
      }>`select display_name from erp.relations where id=${relationId}::uuid`.execute(
        privileged.db,
      )
    ).rows[0]!.display_name,
  ).toBe("Changed");
  expect(() => retained!.store.query("select 1")).toThrow();
  expect(() => pinned!.query("select 1")).toThrow();
  expect(() => query!.query("select 1")).toThrow();
  expect(
    (await audit()).rows.some(
      (row) =>
        row.succeeded &&
        row.tenant_id === tenantId &&
        row.actor_subject.includes("fixture-operator"),
    ),
  ).toBe(true);
}, 30_000);

test("foreign contexts, unregistered Operations and foreign acting Relations are refused with failure audit", async () => {
  let retained: MaintenanceContext;
  work = async (runner) => {
    await runner!(request, async (context) => {
      retained = context;
    });
    await runner!(request, async () => {
      expect(() => retained!.store.query("select 1")).toThrow();
    });
    await expect(
      runner!(
        { ...request, contribution: "foreign-owner" },
        async () => undefined,
      ),
    ).rejects.toThrow("not registered");
    await expect(
      runner!(request, (context) =>
        context.operations.execute("Relation.delete", { id: relationId }),
      ),
    ).rejects.toThrow("not registered");
    await expect(
      runner!(request, (context) =>
        context.operations.execute(
          "Relation.get",
          { id: relationId },
          { actingRelationId: foreignRelationId },
        ),
      ),
    ).rejects.toThrow("seed-owned");
  };
  await dispatch();
  expect(
    (await audit()).rows.some(
      (row) => !row.succeeded && row.tenant_id === tenantId,
    ),
  ).toBe(true);
});

test("retained Control closure cannot elevate in a timer after the owning handler completes", async () => {
  let released!: () => void;
  const gate = new Promise<void>((resolve) => {
    released = resolve;
  });
  let result!: Promise<unknown>;
  work = async (runner) => {
    result = (async () => {
      await gate;
      return runner!(request, async (context) =>
        context.store.query("select 1"),
      );
    })();
  };
  await dispatch();
  released();
  await expect(result).rejects.toThrow("active verified");
});

test("canonical business refusal changes no sibling data and records a failed run", async () => {
  const before = (
    await sql`select * from erp.relations where id=${relationId}::uuid`.execute(
      privileged.db,
    )
  ).rows[0];
  work = async (runner) => {
    await runner!(request, async (context) => {
      const result = await context.operations.execute("Relation.update", {
        id: relationId,
        values: {
          createdAt: "2000-01-01T00:00:00.000Z",
          displayName: "Invalid",
        },
      });
      expect(result).toHaveProperty("error");
    });
  };
  await expect(dispatch()).rejects.toThrow("refused");
  expect(
    (
      await sql`select * from erp.relations where id=${relationId}::uuid`.execute(
        privileged.db,
      )
    ).rows[0],
  ).toEqual(before);
  expect((await audit()).rows[0]!.succeeded).toBe(false);
});

test("registered explicit jobs reuse the owner lifecycle, keep committed units after interruption and reject retained capability", async () => {
  await expect(
    runMaintenanceCommand({
      contribution: contribution.name,
      tenantSlug: slug,
      input: {},
      appliedBy: "test",
      confirmed: false,
    }),
  ).rejects.toThrow("opt-in");
  const optedOut = {
    ...owner,
    seeds: [{ ...seed, maintenanceOptIn: () => false }],
  };
  expect(() =>
    runRegisteredSeedJob(
      optedOut,
      privileged.db,
      seed.name,
      "test",
      async () => undefined,
    ),
  ).toThrow("opted-in");
  let retained: MaintenanceContext;
  await expect(
    runRegisteredSeedJob(
      owner,
      privileged.db,
      seed.name,
      "fixture-job",
      (runner) =>
        runner(request, async (context) => {
          retained = context;
          expect(context.provenance.job).toEqual({
            name: seed.name,
            appliedBy: "fixture-job",
          });
          await context.store.transaction((transaction) =>
            transaction.query(
              "update erp.relations set display_name=$1 where tenant_id=$2::uuid and id=$3::uuid",
              ["Committed unit", tenantId, relationId],
            ),
          );
          throw new Error("interrupted");
        }),
    ),
  ).rejects.toThrow("interrupted");
  expect(() => retained!.store.query("select 1")).toThrow();
  await runRegisteredSeedJob(
    owner,
    privileged.db,
    seed.name,
    "fixture-job",
    (runner) =>
      runner(request, async (context) => {
        const result = await context.operations.execute("Relation.get", {
          id: relationId,
        });
        expect(
          "data" in result &&
            (result.data as { displayName: string }).displayName,
        ).toBe("Committed unit");
      }),
  );
});

test("store-only finance contributions need no canonical roles and drain started SQL before revoking each facade", async () => {
  const finance = { name: "finance-fixture", actorId, operations: [] };
  const financeOwner: RuntimeModule = { ...owner, maintenance: [finance] };
  let retained: MaintenanceContext;
  let retainedQuery: MaintenanceQuery;
  await runRegisteredSeedJob(
    financeOwner,
    privileged.db,
    seed.name,
    "finance-job",
    async (runner) => {
      // Intentionally return before this started job settles: the core owner drains it.
      void runner(
        { ...request, contribution: finance.name },
        async (context) => {
          retained = context;
          await context.store.transaction(async (transaction) => {
            retainedQuery = transaction;
            // Intentionally leave a started query to the transaction owner.
            void transaction.query("select pg_sleep(0.02)");
            await transaction.query(
              "update erp.relations set display_name=$1 where tenant_id=$2::uuid and id=$3::uuid",
              ["Finance unit", tenantId, relationId],
            );
          });
          expect(() => retainedQuery.query("select 1")).toThrow("closed");
          expect(context.provenance.job).toEqual({
            name: seed.name,
            appliedBy: "finance-job",
          });
        },
      );
    },
  );
  expect(
    (
      await sql<{
        display_name: string;
      }>`select display_name from erp.relations where id=${relationId}::uuid`.execute(
        privileged.db,
      )
    ).rows[0]!.display_name,
  ).toBe("Finance unit");
  expect(() => retained!.store.query("select 1")).toThrow();
});

test("privileged app credentials and mutated contribution registration cannot broaden a live invocation", async () => {
  const old = process.env.DATABASE_URL;
  process.env.DATABASE_URL = url();
  await expect(
    runRegisteredSeedJob(
      owner,
      privileged.db,
      seed.name,
      "fixture-job",
      async () => undefined,
    ),
  ).rejects.toThrow("restricted application");
  process.env.DATABASE_URL = old;
  work = async (runner) => {
    contribution.operations.push("Relation.delete");
    try {
      await expect(
        runner!(request, (context) =>
          context.operations.execute("Relation.delete", { id: relationId }),
        ),
      ).rejects.toThrow("not registered");
    } finally {
      contribution.operations.pop();
    }
  };
  await dispatch();
});

test("a job owner preserves explicitly acknowledged reconciliation and the failed audit", async () => {
  const result = await runRegisteredSeedJob(
    owner,
    privileged.db,
    seed.name,
    "recovery-job",
    async (runner) => {
      const interrupted = runner(request, async () => {
        throw new Error("expected interrupted run");
      });
      try {
        await interrupted;
        throw new Error("Expected interrupted run rejection");
      } catch (error) {
        expect((error as Error).message).toBe("expected interrupted run");
      }
      const result = await runner(request, async (context) => {
        const result = await context.operations.execute("Relation.get", {
          id: relationId,
        });
        expect(result).toHaveProperty("data");
        return "recovered";
      });
      runner.acknowledgeFailure!(interrupted);
      return result;
    },
  );
  expect(result).toBe("recovered");
  const rows = (await audit()).rows;
  expect(
    rows.some(
      (row) =>
        row.actor_subject === "maintenance-job:recovery-job" && !row.succeeded,
    ),
  ).toBe(true);
  expect(
    rows.some(
      (row) =>
        row.actor_subject === "maintenance-job:recovery-job" && row.succeeded,
    ),
  ).toBe(true);
});

test("different store, app or live platform databases refuse before the callback", async () => {
  const otherName = `maintenance_${randomUUID().replaceAll("-", "")}`;
  await server.unsafe(`create database "${otherName}"`);
  const otherUrl = new URL(url());
  otherUrl.pathname = `/${otherName}`;
  const other = createDatabaseRuntime({ databaseUrl: otherUrl.toString() });
  let called = false;
  const previous = process.env.DATABASE_URL;
  try {
    await expect(
      runRegisteredSeedJob(
        owner,
        other.db,
        seed.name,
        "mismatched-job",
        async () => {
          called = true;
        },
      ),
    ).rejects.toThrow("same database");
    expect(called).toBe(false);
    const appUrl = new URL(otherUrl);
    appUrl.username = "openshapeforge_app";
    appUrl.password = "openshapeforge_app";
    process.env.DATABASE_URL = appUrl.toString();
    work = async (runner) =>
      runner!(request, async () => {
        called = true;
      });
    await expect(dispatch()).rejects.toThrow("same database");
    expect(called).toBe(false);
    // Store/app agree with each other, but differ from the verified live platform.
    const oldMigrate = process.env.OPENSHAPEFORGE_MIGRATE_DATABASE_URL;
    process.env.OPENSHAPEFORGE_MIGRATE_DATABASE_URL = otherUrl.toString();
    try {
      await expect(dispatch()).rejects.toThrow("same database");
      expect(called).toBe(false);
    } finally {
      process.env.OPENSHAPEFORGE_MIGRATE_DATABASE_URL = oldMigrate;
    }
  } finally {
    process.env.DATABASE_URL = previous;
    await other.close();
    await server.unsafe(`drop database "${otherName}" with (force)`);
  }
});

test("nested store acquisition refuses instead of deadlocking a pool of one", async () => {
  work = async (runner) => {
    await expect(
      runner!(request, (context) =>
        context.store.pinned(async (pinned) => {
          expect(() => context.store.query("select 1")).toThrow("Nested");
          expect(() =>
            context.store.transaction(async () => undefined),
          ).toThrow("Nested");
          expect(() => context.store.pinned(async () => undefined)).toThrow(
            "Nested",
          );
          await pinned.transaction(async (query) => {
            expect(() => pinned.query("select 1")).toThrow("Nested");
            expect(() => pinned.transaction(async () => undefined)).toThrow(
              "Nested",
            );
            expect(() => context.store.query("select 1")).toThrow("Nested");
            expect(await query.query("select 1 as value")).toEqual([
              { value: 1 },
            ]);
          });
        }),
      ),
    ).resolves.toBeUndefined();
  };
  await dispatch();
});
test("discarded failing headless jobs fail their owner", async () => {
  await expect(
    runRegisteredSeedJob(
      owner,
      privileged.db,
      seed.name,
      "discarded-job",
      async (runner) => {
        void runner(request, async () => {
          throw new Error("discarded failure");
        });
        return "not success";
      },
    ),
  ).rejects.toThrow("discarded failure");
});

test("borrowed initialized owner avoids duplicate init and never closes caller modules", async () => {
  let init = 0,
    close = 0;
  const borrowedOwner: RuntimeModule = {
    ...owner,
    init: async () => {
      init++;
    },
    close: async () => {
      close++;
    },
  };
  await runRegisteredSeedJob(
    borrowedOwner,
    privileged.db,
    seed.name,
    "borrowed-job",
    (runner) =>
      runner(request, async (context) => {
        expect(await context.store.query("select 1 as value")).toEqual([
          { value: 1 },
        ]);
        expect(
          await context.operations.execute("Relation.get", { id: relationId }),
        ).toHaveProperty("data");
      }),
    { platform: platform.services, modules: [...modules, borrowedOwner] },
  );
  expect(init).toBe(0);
  expect(close).toBe(0);
  await expect(
    runRegisteredSeedJob(
      borrowedOwner,
      privileged.db,
      seed.name,
      "foreign-owner",
      async () => undefined,
      { platform: platform.services, modules },
    ),
  ).rejects.toThrow("initialized module");
});

for (const inspection of ["discarded", "allSettled"] as const) test(`migration owner refuses a failed maintenance seed after ${inspection}`, async () => {
  const failedSeed = {
    ...seed,
    name: `${inspection}-migration-seed`,
    apply: async (_db: unknown, context?: { runSeed?: RunMaintenanceSeed }) => {
      const job = context!.runSeed!(request, async () => {
        throw new Error("discarded migration failure");
      });
      if (inspection === "allSettled") await Promise.allSettled([job]);
      return { present: true, skipped: false, rows: 0 };
    },
  };
  const module: RuntimeModule = { ...owner, seeds: [failedSeed] };
  await expect(
    privileged.db.connection().execute((db) =>
      runMigrationChain(db, {
        moduleSeeds: [failedSeed],
        maintenanceModules: [module],
        appliedBy: "discarded-migration",
      }),
    ),
  ).rejects.toThrow("discarded migration failure");
});

test("a constrained migrator cannot use app-only identity policies via a bypass GUC", async () => {
  const role = `maintenance_migrator_${randomUUID().replaceAll("-", "")}`;
  await server.unsafe(
    `create role "${role}" login password 'fixture-only' nosuperuser nobypassrls noinherit`,
  );
  const migrateUrl = new URL(url());
  migrateUrl.username = role;
  migrateUrl.password = "fixture-only";
  const constrained = createDatabaseRuntime({
    databaseUrl: migrateUrl.toString(),
  });
  try {
    await sql`grant usage on schema app,erp,platform to ${sql.id(role)}`.execute(
      privileged.db,
    );
    await sql`grant execute on all functions in schema app to ${sql.id(role)}`.execute(
      privileged.db,
    );
    await sql`grant all privileges on all tables in schema erp,platform to ${sql.id(role)}`.execute(
      privileged.db,
    );
    const grant = await sql<{
      super: boolean;
      bypass: boolean;
      app: boolean;
    }>`select rolsuper as super,rolbypassrls as bypass,pg_has_role(current_user,'openshapeforge_app','member') as app from pg_roles where rolname=current_user`.execute(
      constrained.db,
    );
    expect(grant.rows[0]).toEqual({ super: false, bypass: false, app: false });
    await expect(
      runRegisteredSeedJob(
        owner,
        constrained.db,
        seed.name,
        "constrained-identity-proof",
        (runner) =>
          runner(request, (context) =>
            context.store.query(
              "insert into platform.identities(id,issuer,subject,display_name) values($1::uuid,$2,$3,$4)",
              [
                randomUUID(),
                "https://issuer.example/realms/example",
                randomUUID(),
                "Fixture",
              ],
            ),
          ),
      ),
    ).rejects.toThrow("row-level security");
    const identityId = randomUUID(),
      subject = randomUUID();
    const applicationOwner: RuntimeModule = {
      ...owner,
      maintenance: [
        { ...contribution, operations: [], storeConnection: "application" },
      ],
    };
    await runRegisteredSeedJob(
      applicationOwner,
      constrained.db,
      seed.name,
      "app-identity-proof",
      (runner) =>
        runner(request, async (context) => {
          expect(context.provenance.tenantId).toBe(tenantId);
          await context.store.transaction(async (query) => {
            await query.query(
              "insert into platform.identities(id,issuer,subject,display_name) values($1::uuid,$2,$3,$4)",
              [
                identityId,
                "https://issuer.example/realms/example",
                subject,
                "Application fixture",
              ],
            );
            await query.query(
              "insert into platform.identity_relations(identity_id,tenant_id,relation_id,status,linked_at,linked_by,roles) values($1::uuid,$2::uuid,$3::uuid,'linked',now(),'fixture',array[]::text[])",
              [identityId, tenantId, relationId],
            );
            expect(
              await query.query(
                "select identity_id::text from platform.identity_relations where identity_id=$1::uuid",
                [identityId],
              ),
            ).toEqual([{ identity_id: identityId }]);
          });
        }),
    );
    const foreign = await withDbSession(
      app.db,
      {
        tenantId: foreignTenantId,
        userId: actorId,
        roles: [],
        groups: [],
        scope: "tenant",
      },
      (db) =>
        sql`select identity_id from platform.identity_relations where identity_id=${identityId}::uuid`.execute(
          db,
        ),
    );
    expect(foreign.rows).toEqual([]);
    expect(
      (await audit()).rows.some(
        (row) =>
          row.actor_subject === "maintenance-job:app-identity-proof" &&
          row.succeeded &&
          row.tenant_id === tenantId,
      ),
    ).toBe(true);
  } finally {
    await constrained.close();
    await sql`drop owned by ${sql.id(role)}`.execute(privileged.db);
    await server.unsafe(`drop role "${role}"`);
  }
});

test("maintenance forwards the declared Operation idempotency input without bypassing missing-key refusal", async () => {
  contribution.operations.push("TemplateVersion.createDocument");
  try {
    for (const includeKey of [false, true]) {
      let resultCode: string | undefined;
      work = async (runner) => runner!(request, async context => {
        const result = await context.operations.execute("TemplateVersion.createDocument", {
          templateVersionId: randomUUID(), documentId: randomUUID(), channel: "document", locale: "nl", parameters: {}, version: { versionLabel: "1.0", status: "published" },
          ...(includeKey ? { idempotencyKey: `fixture:${randomUUID()}` } : {}),
        });
        resultCode = "error" in result ? result.error.code : undefined;
      });
      await expect(dispatch()).rejects.toThrow("Maintenance canonical Operation was refused.");
      // An absent/unowned template remains protected by the canonical record guard.
      expect(resultCode).toBe(includeKey ? "FORBIDDEN" : "IDEMPOTENCY_KEY_REQUIRED");
    }
  } finally { contribution.operations.pop(); }
});

test("a seed job keeps its textual audit subject separate from the UUID store actor", async () => {
  await runRegisteredSeedJob(owner, privileged.db, seed.name, "uuid-store-proof", runner =>
    runner(request, async context => {
      expect(await context.store.query("select app.current_user_id()::text as actor_id"))
        .toEqual([{ actor_id: actorId }]);
    }));
  expect((await audit()).rows.some(row => row.actor_subject === "maintenance-job:uuid-store-proof" && row.succeeded && row.tenant_id === tenantId)).toBe(true);
});
