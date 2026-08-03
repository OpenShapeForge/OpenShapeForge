// SPDX-License-Identifier: BUSL-1.1
/**
 * Worker role: run one module-contributed background worker, and nothing else.
 *
 * A worker is its own process rather than a timer inside the API. A poll loop
 * and a request path have unrelated failure modes and unrelated scaling needs,
 * and a wedged worker must not take GraphQL down with it. It is also what keeps
 * the database sessions distinct: the workflow worker presents
 * `app.worker_role`, a GUC the API's request path never sets, and that
 * separation is the only boundary standing between "a worker may drain the
 * queue" and "a request may claim to be a worker" (see
 * docs/api.md#the-worker-axis).
 *
 * Which worker runs is `OPENSHAPEFORGE_ROLE`. No worker is hardcoded here —
 * `apps/api` names none of them, exactly as it names none of the contributed
 * GraphQL types.
 *
 * Fail-closed where the API role degrades:
 *   - no DATABASE_URL is fatal. A GraphQL surface without a database can still
 *     answer DATABASE_NOT_CONFIGURED; a queue-draining worker without one has
 *     nothing to do, and a process that idles while looking healthy is the
 *     worst of the three outcomes.
 *   - a module that failed to load or initialise is fatal IF it owns the
 *     requested role. The API tolerates a missing module because its other
 *     surfaces still work; here the module IS the process.
 */
import { createDatabaseRuntime, type DatabaseRuntime } from "../db/connection.js";
import type { ModuleWorker, ModuleWorkerHandle, ModuleWorkerLogger } from "../modules/contract.js";
import { initRuntimeModules, loadRuntimeModules, type ModuleRegistry } from "../modules/registry.js";

export type StartWorkerRoleOptions = {
  databaseUrl?: string;
  /** Injectable for tests; production loads from the generated registry. */
  modules?: ModuleRegistry;
  log?: ModuleWorkerLogger;
};

export type WorkerRoleHandle = {
  /** The role that was started — the key, not the module name. */
  role: string;
  /** The module that contributed it. */
  module: string;
  /** Stops the worker, then closes the database runtime. */
  stop(): Promise<void>;
};

/** Minimal structured logger, so a worker's output is one line per event. */
function consoleLogger(): ModuleWorkerLogger {
  const emit = (level: string) => (payload: Record<string, unknown>, message: string) => {
    console.log(JSON.stringify({ level, ...payload, msg: message }));
  };
  return { info: emit("info"), warn: emit("warn"), error: emit("error") };
}

type ResolvedWorker = { role: string; module: string; worker: ModuleWorker };

/**
 * Index every contributed worker by role name.
 *
 * A collision is refused rather than resolved. Two modules claiming one role
 * name is a packaging mistake, and picking either one means the operator's
 * `OPENSHAPEFORGE_ROLE` silently starts something other than what they named —
 * the same reason `buildGraphqlSchema` refuses a duplicate field.
 */
export function indexModuleWorkers(registry: ModuleRegistry): Map<string, ResolvedWorker> {
  const byRole = new Map<string, ResolvedWorker>();
  for (const module of registry.loaded) {
    for (const [role, worker] of Object.entries(module.workers ?? {})) {
      const existing = byRole.get(role);
      if (existing) {
        throw new Error(
          `Worker role "${role}" is contributed by both "${existing.module}" and "${module.name}". Role names must be unique across modules.`,
        );
      }
      byRole.set(role, { role, module: module.name, worker });
    }
  }
  return byRole;
}

export async function startWorkerRole(
  role: string,
  options: StartWorkerRoleOptions = {},
): Promise<WorkerRoleHandle> {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      `Worker role "${role}" requires DATABASE_URL. A worker with no database would poll nothing while reporting healthy.`,
    );
  }

  const log = options.log ?? consoleLogger();
  const registry = options.modules ?? (await loadRuntimeModules());

  let databaseRuntime: DatabaseRuntime | undefined;
  try {
    databaseRuntime = createDatabaseRuntime({ databaseUrl });

    // `init` is not optional for a worker. The workflow module hydrates its node
    // catalog and registers its node bridges there; a worker that skipped it
    // would claim commands and then fail every one of them with NO_BRIDGE —
    // burning the retry bound on a configuration problem.
    const initialised = await initRuntimeModules(registry, { db: databaseRuntime.db });
    const workers = indexModuleWorkers(initialised);
    const resolved = workers.get(role);

    if (!resolved) {
      const failure = initialised.failures.find((entry) => entry.name === role);
      const available = [...workers.keys()].sort();
      throw new Error(
        failure
          ? `Worker role "${role}" is unavailable: module "${failure.name}" was not loaded (${failure.reason} — ${failure.message}).`
          : `Unknown worker role "${role}". Contributed roles: ${
              available.length > 0 ? available.join(", ") : "(none)"
            }.`,
      );
    }

    // Say what did NOT load even when the requested role did. Its absence is
    // otherwise invisible until something it owns fails to happen.
    for (const failure of initialised.failures) {
      log.error(
        { module: failure.name, specifier: failure.specifier, reason: failure.reason },
        `Runtime module "${failure.name}" was not loaded: ${failure.message}`,
      );
    }

    const handle: ModuleWorkerHandle = await resolved.worker.start({
      db: databaseRuntime.db,
      log,
    });
    log.info({ role, module: resolved.module }, `Worker role "${role}" started.`);

    const runtime = databaseRuntime;
    return {
      role,
      module: resolved.module,
      stop: async () => {
        // Worker first, connection second: stop() settles after the in-flight
        // tick, and that tick still needs the pool.
        await handle.stop();
        await runtime.close();
        log.info({ role, module: resolved.module }, `Worker role "${role}" stopped.`);
      },
    };
  } catch (error) {
    await databaseRuntime?.close();
    throw error;
  }
}

/**
 * Start a worker and hold the process open until it is asked to stop.
 *
 * SIGTERM is the one that matters: it is what a container runtime sends, and
 * draining the in-flight tick before exiting is the difference between a clean
 * redeploy and one claimed command per replica left `processing` until the
 * visibility timeout reclaims it.
 */
export async function runWorkerRole(role: string): Promise<void> {
  const handle = await startWorkerRole(role);

  await new Promise<void>((resolve) => {
    let stopping = false;
    const shutdown = (signal: NodeJS.Signals) => {
      if (stopping) return;
      stopping = true;
      void handle
        .stop()
        .catch((error: unknown) => {
          console.error(
            JSON.stringify({
              level: "error",
              role,
              signal,
              msg: `Worker role "${role}" did not stop cleanly: ${
                error instanceof Error ? error.message : String(error)
              }`,
            }),
          );
        })
        .finally(resolve);
    };

    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  });
}
