// SPDX-License-Identifier: BUSL-1.1
/**
 * Worker role: run one module-contributed background worker, and nothing else.
 *
 * A worker is its own process rather than a timer inside the API. A poll loop
 * and a request path have unrelated failure modes and unrelated scaling needs,
 * and a wedged worker must not take GraphQL down with it. It is also what keeps
 * the database sessions distinct: the workflow worker connects as
 * `openshapeforge_worker` and presents `app.worker_role`, and the queue
 * policies check both — the first is what the database can verify, the second
 * says which worker it is (see docs/api.md#the-worker-axis).
 *
 * Which worker runs is `OPENSHAPEFORGE_ROLE`. No worker is hardcoded here —
 * `apps/api` names none of them, exactly as it names none of the contributed
 * GraphQL types.
 *
 * Fail-closed where the API role degrades:
 *   - no OPENSHAPEFORGE_WORKER_DATABASE_URL is fatal, and it never falls back
 *     to DATABASE_URL. A GraphQL surface without a database can still answer
 *     DATABASE_NOT_CONFIGURED; a queue-draining worker without one has nothing
 *     to do, and a process that idles while looking healthy is the worst of the
 *     three outcomes. See {@link resolveWorkerDatabaseUrl} for why the fallback
 *     is refused rather than merely absent.
 *   - a module that failed to load or initialise is fatal IF it owns the
 *     requested role. The API tolerates a missing module because its other
 *     surfaces still work; here the module IS the process.
 */
import { createDatabaseRuntime, type DatabaseRuntime } from "../db/connection.js";
import { WORKER_ROLE } from "../db/migrations/worker-role.js";
import type { ModuleWorker, ModuleWorkerHandle, ModuleWorkerLogger } from "../modules/contract.js";
import { initRuntimeModules, loadRuntimeModules, type ModuleRegistry } from "../modules/registry.js";

export type StartWorkerRoleOptions = {
  databaseUrl?: string;
  /** Injectable for tests; production reads process.env. */
  env?: NodeJS.ProcessEnv;
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

/**
 * The worker's connection string — and the three ways it is refused.
 *
 * A worker must connect as `openshapeforge_worker`, because that is the role
 * the queue policies compare `current_user` against. `DATABASE_URL` carries the
 * API's `openshapeforge_app` credentials, so reading it here would hand the
 * worker the API's identity: the queue would read as empty, the process would
 * report healthy, and the boundary #223 bought would be gone — not because the
 * policy was wrong but because the two processes were back on one role.
 *
 * So the fallback is not merely absent, it is REFUSED, and refused in three
 * shapes because a fallback can arrive by more than one route:
 *
 *   1. unset — the operator has not provisioned a worker credential at all;
 *   2. set to the same string as DATABASE_URL — the fallback, written out by
 *      hand, which no amount of "we don't read DATABASE_URL" would catch;
 *   3. carrying a username that is not the worker role — the same mistake with
 *      a different password. Only checked when the URL names a user; a URL
 *      that leaves it to PGUSER cannot be judged here, and (2) is what covers
 *      the realistic copy-paste in that case.
 *
 * Each is fatal at boot rather than at the first empty poll, because "drained
 * nothing" and "was never allowed to drain anything" are indistinguishable from
 * the outside.
 */
export function resolveWorkerDatabaseUrl(
  role: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const workerDatabaseUrl = env.OPENSHAPEFORGE_WORKER_DATABASE_URL?.trim();

  if (!workerDatabaseUrl) {
    throw new Error(
      `Worker role "${role}" requires OPENSHAPEFORGE_WORKER_DATABASE_URL, and does not fall back to DATABASE_URL. ` +
        `A worker connects as the "${WORKER_ROLE}" database role; the queue policies check that role, so connecting ` +
        `with the API's credentials would drain nothing while reporting healthy.`,
    );
  }

  if (env.DATABASE_URL !== undefined && workerDatabaseUrl === env.DATABASE_URL.trim()) {
    throw new Error(
      `Worker role "${role}" has OPENSHAPEFORGE_WORKER_DATABASE_URL set to the same value as DATABASE_URL. ` +
        `That is the DATABASE_URL fallback written out by hand: both would connect as the API's role, and the ` +
        `queue policies would admit neither. Provision "${WORKER_ROLE}" its own credential.`,
    );
  }

  // A malformed URL is left to the driver, which reports it better than a
  // rewritten message would.
  let username: string | undefined;
  try {
    username = new URL(workerDatabaseUrl).username;
  } catch {
    return workerDatabaseUrl;
  }

  if (username && decodeURIComponent(username) !== WORKER_ROLE) {
    throw new Error(
      `Worker role "${role}" has OPENSHAPEFORGE_WORKER_DATABASE_URL connecting as "${decodeURIComponent(username)}", ` +
        `not "${WORKER_ROLE}". The queue policies compare current_user against "${WORKER_ROLE}", so any other role ` +
        `sees an empty queue rather than an error.`,
    );
  }

  return workerDatabaseUrl;
}

export async function startWorkerRole(
  role: string,
  options: StartWorkerRoleOptions = {},
): Promise<WorkerRoleHandle> {
  // An explicit override is an injection point for tests, not an env fallback:
  // it never reads DATABASE_URL, and an empty string is still refused below.
  const databaseUrl =
    options.databaseUrl === undefined
      ? resolveWorkerDatabaseUrl(role, options.env)
      : options.databaseUrl;
  if (!databaseUrl) {
    throw new Error(
      `Worker role "${role}" requires OPENSHAPEFORGE_WORKER_DATABASE_URL. A worker with no database would poll nothing while reporting healthy.`,
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
          ? `Worker role "${role}" is unavailable: its module was not loaded (${failure.reason}).`
          : `Unknown worker role "${role}". Contributed roles: ${
              available.length > 0 ? available.join(", ") : "(none)"
            }.`,
      );
    }

    // Say what did NOT load even when the requested role did. Its absence is
    // otherwise invisible until something it owns fails to happen.
    for (const failure of initialised.failures) {
      log.error(
        { module: failure.name, reason: failure.reason },
        "A runtime module was not loaded.",
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
