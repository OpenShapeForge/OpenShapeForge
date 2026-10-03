// SPDX-License-Identifier: BUSL-1.1
/** Core owner of trusted maintenance SQL and ordinary RLS canonical execution. */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type {
  MaintenanceContext,
  MaintenanceConnection,
  MaintenanceQuery,
  RunMaintenanceSeed,
  RuntimeMaintenanceContribution,
  RuntimeOperationRequest,
} from "@openshapeforge/plugin-runtime";
import {
  assertSameDatabase,
  createDatabaseRuntime,
  readMigrateDatabaseUrl,
  type OpenShapeForgeDatabase,
} from "../db/connection.js";
import {
  withDbSession,
  withSystemSession,
  SYSTEM_BYPASS_ROLE,
} from "../db/session.js";
import {
  PLATFORM_OPERATOR_ROLE,
  systemSessionForOperator,
} from "../control/authorization.js";
import { maintenanceJob, drainMaintenanceJobs, acknowledgeMaintenanceFailure } from "./maintenance-jobs.js";
import { isControlSession } from "../control/control-session.js";
import type { SystemSessionInput } from "../db/session.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import type { ModuleRegistry } from "./registry.js";
import type { ModulePlatformServices, RuntimeModule } from "./contract.js";
import {
  assertLiveModuleOperationSession,
  assertRestrictedModuleOperationConnection,
  withModuleOperationSession,
} from "./platform.js";
import { acquireEditLeaseForEntityOperation } from "../operations/entity/index.js";
import generatedCatalog from "../generated/operations/catalog.json" with { type: "json" };

const outsideInvocation = AsyncLocalStorage.snapshot();
const scope = new AsyncLocalStorage<object>();
const storeFrame = new AsyncLocalStorage<object>();
const transactionFrame = new AsyncLocalStorage<object>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Definition = {
  id: string;
  intent: RuntimeOperationRequest["operation"]["intent"];
  roles: readonly string[];
  target?: { entityName: string; inputField?: string };
  concurrency?: { version?: { field: string }; editLease?: unknown };
};
type Catalog = {
  operations: (Omit<Definition, "id" | "roles"> & {
    key: string;
    auth?: { roles?: readonly string[] };
  })[];
  entityOperations: (Omit<Definition, "roles"> & {
    entityName: string;
    authorization?: { roles?: readonly string[] };
  })[];
};
type Owner = {
  storeDb: OpenShapeForgeDatabase;
  appDb: OpenShapeForgeDatabase;
  platform: ModulePlatformServices;
  system: SystemSessionInput;
  check(): void;
  job?: { name: string; appliedBy: string };
  operator?: { subject: string; issuer: string };
};

function queryPort(
  db: OpenShapeForgeDatabase,
  check: () => void,
  children: Promise<unknown>[],
): MaintenanceQuery {
  return Object.freeze({
    query: <Row>(
      text: string,
      parameters: readonly unknown[] = [],
    ): Promise<Row[]> => {
      check();
      const promise = db
        .executeQuery<Row>({
          sql: text,
          parameters,
          query: { kind: "RawNode", sqlFragments: [text], parameters: [] },
          queryId: { queryId: "maintenance" },
        })
        .then((result) => result.rows);
      children.push(promise);
      void promise.catch(() => {});
      return promise;
    },
  });
}

/** Registration is trusted code, copied to prevent later mutation broadening it. */
function contributionCopy(
  owner: RuntimeModule,
  name: string,
): RuntimeMaintenanceContribution {
  const matches = (owner.maintenance ?? []).filter(
    (entry) => entry.name === name,
  );
  if (matches.length !== 1)
    throw new Error(
      "Maintenance contribution is not registered by this module.",
    );
  const value = matches[0]!;
  if (
    value.storeConnection !== undefined &&
    value.storeConnection !== "application"
  )
    throw new Error("Invalid maintenance store connection.");
  if (
    !UUID.test(value.actorId) ||
    !value.name ||
    new Set(value.operations).size !== value.operations.length
  )
    throw new Error("Invalid maintenance contribution.");
  return Object.freeze({
    ...value,
    operations: Object.freeze([...value.operations]),
    ...(value.actingRelation
      ? { actingRelation: Object.freeze({ ...value.actingRelation }) }
      : {}),
  });
}

async function lifecycle<T>(
  owner: Owner,
  contribution: RuntimeMaintenanceContribution,
  tenantSlug: string,
  reason: string,
  work: (context: MaintenanceContext) => Promise<T>,
): Promise<T> {
  owner.check();
  if (!/^[a-z][a-z0-9-]*$/.test(tenantSlug) || !reason.trim())
    throw new Error("Maintenance needs a valid tenant slug and audit reason.");
  const token = Object.freeze({});
  let active = true;
  let accepting = true;
  const pending = new Set<Promise<unknown>>();
  const check = () => {
    if (!active || scope.getStore() !== token)
      throw new Error(
        "Maintenance context is no longer active or belongs to another invocation.",
      );
    owner.check();
  };
  const tracked = <R>(call: () => Promise<R>): Promise<R> => {
    check();
    if (!accepting) throw new Error("Maintenance callback has finished.");
    const promise = call().catch((error) => {
      failed = true;
      throw error;
    });
    pending.add(promise);
    void promise.finally(() => pending.delete(promise)).catch(() => {});
    return promise;
  };
  let failed = false;
  const invocationId = randomUUID();
  const system = {
    ...owner.system,
    reason: `${owner.system.reason}: ${contribution.name} ${tenantSlug}: ${reason}`,
  };
  const tenantId = await withSystemSession(
    owner.storeDb,
    system,
    async (trx) => {
      const rows = await sql<{
        id: string;
      }>`select id::text from platform.tenants where slug = ${tenantSlug} and status = 'active'`.execute(
        trx,
      );
      if (rows.rows.length !== 1)
        throw new Error("Maintenance tenant is absent or inactive.");
      return rows.rows[0]!.id;
    },
  );
  const session: TrustedSessionContext = {
    tenantId,
    userId: contribution.actorId,
    roles: [],
    groups: [],
    relationGroupIds: [],
    scope: "tenant",
    credential: "trusted-context",
  };
  const catalog = generatedCatalog as unknown as Catalog;
  const definitions = new Map<string, Definition>([
    ...catalog.operations.map(
      (value) =>
        [
          value.key,
          { ...value, id: value.key, roles: value.auth?.roles ?? [] },
        ] as [string, Definition],
    ),
    ...catalog.entityOperations.map(
      (value) =>
        [
          value.id,
          {
            ...value,
            roles: value.authorization?.roles ?? [],
            target: { entityName: value.entityName, inputField: "id" },
          },
        ] as [string, Definition],
    ),
  ]);
  const allowed = new Set(contribution.operations);
  for (const id of allowed)
    if (!definitions.has(id))
      throw new Error(
        `Maintenance Operation ${id} is not in the canonical catalog.`,
      );
  session.roles = [
    ...new Set(
      contribution.operations.flatMap((id) => definitions.get(id)!.roles),
    ),
  ];
  const connection = (db: OpenShapeForgeDatabase): MaintenanceConnection => {
    const assertAcquisition = () => {
      if (storeFrame.getStore() === token)
        throw new Error(
          "Nested maintenance store acquisition must use its pinned connection or transaction query.",
        );
    };
    const transaction = <R>(
      callback: (query: MaintenanceQuery) => Promise<R>,
    ): Promise<R> => {
      assertAcquisition();
      return tracked(() =>
        withSystemSession(db, { ...system, tenantId }, async (trx) => {
          let open = true;
          const children: Promise<unknown>[] = [];
          const port = queryPort(
            trx,
            () => {
              check();
              if (!open) throw new Error("Maintenance transaction is closed.");
            },
            children,
          );
          try {
            const result = await storeFrame.run(token, () =>
              transactionFrame.run(token, () => callback(port)),
            );
            open = false;
            await Promise.all(children);
            return result;
          } finally {
            open = false;
            await Promise.allSettled(children);
          }
        }),
      );
    };
    return Object.freeze({
      transaction,
      query: <Row>(text: string, params?: readonly unknown[]) =>
        transaction((port) => port.query<Row>(text, params)),
    });
  };
  const storeDb =
    contribution.storeConnection === "application"
      ? owner.appDb
      : owner.storeDb;
  const base = connection(storeDb);
  const store = Object.freeze({
    ...base,
    pinned: <R>(callback: (port: MaintenanceConnection) => Promise<R>) => {
      if (storeFrame.getStore() === token)
        throw new Error("Nested maintenance pinned acquisition is forbidden.");
      return tracked(() =>
        storeDb.connection().execute(async (db) => {
          let open = true;
          const children: Promise<unknown>[] = [];
          const basePinned = connection(db);
          const assertPinned = () => {
            check();
            if (transactionFrame.getStore() === token)
              throw new Error(
                "Nested maintenance transaction acquisition is forbidden; use the transaction query.",
              );
            if (!open) throw new Error("Maintenance connection is closed.");
          };
          const pinned = Object.freeze({
            query: <Row>(text: string, params?: readonly unknown[]) => {
              assertPinned();
              const child = storeFrame.run(undefined as unknown as object, () =>
                basePinned.query<Row>(text, params),
              );
              children.push(child);
              return child;
            },
            transaction: <V>(fn: (query: MaintenanceQuery) => Promise<V>) => {
              assertPinned();
              const child = storeFrame.run(undefined as unknown as object, () =>
                basePinned.transaction(fn),
              );
              children.push(child);
              return child;
            },
          });
          try {
            const result = await storeFrame.run(token, () => callback(pinned));
            open = false;
            await Promise.all(children);
            return result;
          } finally {
            open = false;
            await Promise.allSettled(children);
          }
        }),
      );
    },
  });
  const execute = (
    id: string,
    values: Record<string, unknown>,
    options?: { actingRelationId?: string },
  ) =>
    tracked(async () => {
      if (!allowed.has(id))
        throw new Error(
          `Maintenance Operation ${id} is not registered for this contribution.`,
        );
      const definition = definitions.get(id)!;
      const activeSession = { ...session, roles: [...session.roles] };
      if (options?.actingRelationId) {
        if (
          !contribution.actingRelation ||
          !UUID.test(options.actingRelationId)
        )
          throw new Error(
            "Acting Relation is not configured for this contribution.",
          );
        const rows = await outsideInvocation(() =>
          withDbSession(
            owner.appDb,
            session,
            async (trx) =>
              (
                await sql<{
                  id: string;
                  display_name: string;
                }>`select id::text, display_name from erp.relations where id = ${options.actingRelationId}::uuid and tenant_id = ${tenantId}::uuid and source_authority = ${contribution.actingRelation!.sourceAuthority} and relation_type = 'person' and status = 'active'`.execute(
                  trx,
                )
              ).rows,
          ),
        );
        if (rows.length !== 1)
          throw new Error(
            "Acting Relation is not an active seed-owned person of this tenant.",
          );
        activeSession.relation = {
          identityId: contribution.actorId,
          issuer: "maintenance",
          subject: contribution.actorId,
          status: "linked",
          relationId: rows[0]!.id,
          displayName: rows[0]!.display_name,
          relationType: "person",
          candidateRelationId: null,
          linkedBy: contribution.name,
          needsRoleAssignment: false,
          roles: [],
        };
      }
      return outsideInvocation(() =>
        withModuleOperationSession(
          owner.platform,
          activeSession,
          async (verified) => {
            if (!active) throw new Error("Maintenance invocation is closed.");
            if (!verified)
              throw new Error("Maintenance session could not be activated.");
            const input = structuredClone(values);
            const targetId = definition.target?.inputField
              ? input[definition.target.inputField]
              : undefined;
            if (definition.concurrency?.editLease) {
              if (typeof targetId !== "string")
                throw new Error("Maintenance Operation needs its target id.");
              const lease = await acquireEditLeaseForEntityOperation(
                owner.appDb,
                verified,
                { operationId: id, targetId },
              );
              input.leaseToken = lease.leaseToken;
              input.expectedVersion = lease.targetVersion;
            } else if (definition.concurrency?.version) {
              const getId = `${definition.target?.entityName}.get`;
              const get = definitions.get(getId);
              if (!get || typeof targetId !== "string")
                throw new Error("Maintenance versioned target cannot be read.");
              const current = await owner.platform.operations.execute(
                verified,
                {
                  operation: { id: getId, intent: get.intent },
                  input: { id: targetId },
                },
              );
              if ("error" in current) {
                failed = true;
                return current;
              }
              input.expectedVersion = (current.data as Record<string, unknown>)[
                definition.concurrency.version.field
              ];
            }
            const result = await owner.platform.operations.execute(verified, {
              operation: { id, intent: definition.intent },
              input,
            });
            if ("error" in result) failed = true;
            return result;
          },
        ),
      );
    });
  const context = Object.freeze({
    provenance: Object.freeze({
      tenantId,
      tenantSlug,
      contribution: contribution.name,
      invocationId,
      ...(owner.operator
        ? { operator: Object.freeze({ ...owner.operator }) }
        : {}),
      ...(owner.job ? { job: Object.freeze({ ...owner.job }) } : {}),
    }),
    store,
    operations: Object.freeze({ execute }),
  });
  try {
    const result = await scope.run(token, () => work(context));
    accepting = false;
    while (pending.size) await Promise.all([...pending]);
    if (failed) throw new Error("Maintenance canonical Operation was refused.");
    await withSystemSession(
      owner.storeDb,
      { ...system, tenantId },
      async () => undefined,
    );
    return result;
  } catch (error) {
    accepting = false;
    while (pending.size) await Promise.allSettled([...pending]);
    try {
      await withSystemSession(
        owner.storeDb,
        { ...system, tenantId },
        async () => {
          throw error;
        },
      );
    } catch {
      /* audit preserved by session owner */
    }
    throw error;
  } finally {
    active = false;
  }
}

/** Only the canonical handler wrapper calls this; no host-owned identity mint. */
export function liveMaintenanceRunner(
  module: RuntimeModule,
  platform: ModulePlatformServices | undefined,
  session: TrustedSessionContext | undefined,
): RunMaintenanceSeed | undefined {
  if (!module.maintenance?.length || !platform || !isControlSession(session))
    return undefined;
  const administrator = Object.freeze({ ...session.administrator });
  const registeredOwner = {
    ...module,
    maintenance: Object.freeze(
      module.maintenance.map((value) => contributionCopy(module, value.name)),
    ),
  };
  const check = () => {
    assertLiveModuleOperationSession(platform, session);
    if (
      !session.roles.includes(PLATFORM_OPERATOR_ROLE) ||
      (administrator.expiresAtMs !== null &&
        administrator.expiresAtMs <= Date.now())
    )
      throw new Error(
        "Maintenance requires an authorized unexpired Control operator.",
      );
  };
  return async (request, work) => {
    const selection = { ...request };
    check();
    await assertRestrictedModuleOperationConnection(platform);
    check();
    const contribution = contributionCopy(
      registeredOwner,
      selection.contribution,
    );
    const database = createDatabaseRuntime({
      databaseUrl: readMigrateDatabaseUrl(),
      maxConnections: 1,
    });
    const app = createDatabaseRuntime();
    try {
      await assertSameDatabase(database.db, app.db);
      await assertRestrictedModuleOperationConnection(platform, app.db);
      check();
      return await lifecycle(
        {
          storeDb: database.db,
          appDb: app.db,
          platform,
          system: systemSessionForOperator(administrator, "maintenance"),
          check,
          operator: {
            subject: administrator.subject,
            issuer: administrator.issuer,
          },
        },
        contribution,
        selection.tenantSlug,
        selection.reason,
        work,
      );
    } finally {
      await Promise.all([database.close(), app.close()]);
    }
  };
}

export type InitializedMaintenanceOwner = {
  platform: ModulePlatformServices;
  modules: readonly RuntimeModule[];
};

/** Internal owner lifecycle for opted-in registered seed jobs. No platform escapes. */
async function withJobOwner<T>(
  module: RuntimeModule,
  db: OpenShapeForgeDatabase,
  name: string,
  appliedBy: string,
  work: (runner: RunMaintenanceSeed) => Promise<T>,
  initialized?: InitializedMaintenanceOwner,
  suppliedRegistry?: ModuleRegistry,
): Promise<T> {
  const { ModulePlatformRuntime } = await import("./platform.js");
  const { loadRuntimeModules, initRuntimeModules, closeRuntimeModules } =
    await import("./registry.js");
  const { createRuntimeHostOperationExecutor } =
    await import("../mcp/runtime-executors.js");
  const {
    bindOperationHandlers,
    listOperationContracts,
    entityPluginOperationContracts,
    runtimeStaticOperationRegistrations,
  } = await import("../operations/runtime.js");
  const { createEntityPluginExecutor, registerEntityPluginExecutor } =
    await import("../operations/entity/plugin-executor.js");
  if (initialized && !initialized.modules.includes(module))
    throw new Error(
      "Maintenance owner is not an initialized module of this runtime.",
    );
  const registeredOwner = {
    ...module,
    maintenance: Object.freeze(
      (module.maintenance ?? []).map((value) =>
        contributionCopy(module, value.name),
      ),
    ),
  };
  const app = createDatabaseRuntime();
  let loaded: RuntimeModule[] = [];
  try {
    // Refuse accidental privileged app credentials before any canonical read.
    const role = await sql<{
      rolbypassrls: boolean;
      rolsuper: boolean;
    }>`select rolbypassrls, rolsuper from pg_roles where rolname = current_user`.execute(
      app.db,
    );
    if (!role.rows[0] || role.rows[0].rolbypassrls || role.rows[0].rolsuper)
      throw new Error(
        "Maintenance Operations require the restricted application connection.",
      );
    await assertSameDatabase(db, app.db);
    const runtimePlatform = initialized
      ? undefined
      : new ModulePlatformRuntime(app.db);
    const platform = initialized?.platform ?? runtimePlatform!.services;
    if (initialized)
      await assertRestrictedModuleOperationConnection(platform, app.db);
    const context = { db: app.db, platform };
    const initialised = initialized
      ? { loaded: [...initialized.modules], failures: [] }
      : await initRuntimeModules(
          suppliedRegistry ?? (await loadRuntimeModules()),
          context,
        );
    loaded = initialized ? [] : initialised.loaded;
    const executionModules = initialised.loaded;
    if (initialised.failures.length)
      throw new Error(
        `Maintenance runtime modules could not initialise: ${initialised.failures.map((failure) => `${failure.name}: ${failure.reason}: ${failure.message}`).join("; ")}`,
      );
    if (runtimePlatform) {
      runtimePlatform.registerOperationProviders(executionModules);
      runtimePlatform.registerHostOperationExecutor(
        createRuntimeHostOperationExecutor({
          db: app.db,
          modules: executionModules,
          modulePlatform: runtimePlatform,
        }),
      );
      const entityContracts = entityPluginOperationContracts();
      if (entityContracts.length) {
        const bindings = bindOperationHandlers(
          executionModules,
          [...listOperationContracts(), ...entityContracts],
          { pluginOperations: "required" },
        );
        registerEntityPluginExecutor(
          app.db,
          createEntityPluginExecutor({ bindings, runtime: context }),
        );
      }
      runtimePlatform.registerStaticOperations(
        runtimeStaticOperationRegistrations(executionModules, context),
      );
    }
    let open = true;
    let accepting = true;
    const children: ReturnType<typeof maintenanceJob>[] = [];
    const check = () => {
      if (!open) throw new Error("Maintenance job is no longer active.");
    };
    const system: SystemSessionInput = {
      actorSubject: `maintenance-job:${appliedBy}`,
      roles: [SYSTEM_BYPASS_ROLE],
      reason: `maintenance job ${name}`,
      tenantId: null,
    };
    const runner: RunMaintenanceSeed = (request, callback) => {
      check();
      if (!accepting) throw new Error("Maintenance job callback has finished.");
      const contribution = contributionCopy(
        registeredOwner,
        request.contribution,
      );
      const child = lifecycle(
        {
          storeDb: db,
          appDb: app.db,
          platform,
          system,
          check,
          job: { name, appliedBy },
        },
        contribution,
        request.tenantSlug,
        request.reason,
        callback,
      );
      const job = maintenanceJob(child);
      children.push(job);
      return job.promise;
    };
    Object.defineProperty(runner, "acknowledgeFailure", { value: (job: Promise<unknown>) => {
      check();
      if (!accepting) throw new Error("Maintenance job callback has finished.");
      acknowledgeMaintenanceFailure(children, job);
    } });
    Object.freeze(runner);
    try {
      const result = await work(runner);
      accepting = false;
      await drainMaintenanceJobs(children);
      return result;
    } finally {
      accepting = false;
      await Promise.allSettled(children.map((job) => job.work));
      open = false;
    }
  } finally {
    try {
      await closeRuntimeModules(loaded);
    } finally {
      await app.close();
    }
  }
}

/** Called only by the migration owner for a registered seed, after explicit opt-in. */
export function runRegisteredSeedJob<T>(
  module: RuntimeModule,
  db: OpenShapeForgeDatabase,
  name: string,
  appliedBy: string,
  work: (runner: RunMaintenanceSeed) => Promise<T>,
  initialized?: InitializedMaintenanceOwner,
): Promise<T> {
  const seeds = (module.seeds ?? []).filter((seed) => seed.name === name);
  if (seeds.length !== 1 || !seeds[0]!.maintenanceOptIn?.())
    throw new Error(
      "Maintenance job is not an explicitly opted-in registered seed of this module.",
    );
  return withJobOwner(module, db, name, appliedBy, work, initialized);
}

/** CLI owner: independently loads installed contributions and selects exactly one. */
export async function runMaintenanceCommand(request: {
  contribution: string;
  tenantSlug: string;
  input: Record<string, unknown>;
  appliedBy: string;
  confirmed: boolean;
}): Promise<unknown> {
  if (!request.confirmed)
    throw new Error("Maintenance CLI requires explicit seed opt-in.");
  const { loadRuntimeModules } = await import("./registry.js");
  const registry = await loadRuntimeModules();
  if (registry.failures.length)
    throw new Error("Maintenance modules could not load.");
  const matches = registry.loaded.filter((module) =>
    module.maintenance?.some((value) => value.name === request.contribution),
  );
  if (matches.length !== 1)
    throw new Error("Maintenance CLI contribution is absent or ambiguous.");
  const module = matches[0]!;
  const contribution = contributionCopy(module, request.contribution);
  if (!contribution.run)
    throw new Error("Maintenance contribution has no registered CLI entry.");
  const database = createDatabaseRuntime({
    databaseUrl: readMigrateDatabaseUrl(),
  });
  try {
    return await withJobOwner(
      module,
      database.db,
      `cli:${contribution.name}`,
      request.appliedBy,
      (runner) =>
        runner(
          {
            contribution: contribution.name,
            tenantSlug: request.tenantSlug,
            reason: "explicit CLI maintenance",
          },
          (context) => contribution.run!(request.input, context),
        ),
      undefined,
      registry,
    );
  } finally {
    await database.close();
  }
}
