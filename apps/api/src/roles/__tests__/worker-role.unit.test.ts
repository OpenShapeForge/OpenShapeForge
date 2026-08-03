// SPDX-License-Identifier: BUSL-1.1
/**
 * The worker role's boot contract.
 *
 * Where the API role degrades, this one fails closed — a worker that starts,
 * looks healthy and drains nothing is the worst of the available outcomes, so
 * every path that would produce one has to be an error instead. These tests
 * pin the failures, not the happy path; the happy path is proved end-to-end in
 * `graphql/__tests__/workflow-worker-role.e2e.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import type {
  ModuleWorkerContext,
  ModuleWorkerHandle,
  ModuleWorkerLogger,
  RuntimeModule,
} from "../../modules/contract.js";
import type { ModuleRegistry } from "../../modules/registry.js";
import { indexModuleWorkers, startWorkerRole } from "../worker.js";

const silentLog: ModuleWorkerLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function moduleWith(name: string, roles: string[]): RuntimeModule {
  return {
    name,
    workers: Object.fromEntries(
      roles.map((role) => [role, { start: () => ({ stop: async () => {} }) }]),
    ),
  };
}

function registry(modules: RuntimeModule[], failures: ModuleRegistry["failures"] = []): ModuleRegistry {
  return { loaded: modules, failures };
}

describe("indexModuleWorkers", () => {
  test("indexes every contributed role by name", () => {
    const index = indexModuleWorkers(
      registry([moduleWith("workflow", ["workflow-worker"]), moduleWith("billing", ["invoicer"])]),
    );

    expect([...index.keys()].sort()).toEqual(["invoicer", "workflow-worker"]);
    expect(index.get("workflow-worker")?.module).toBe("workflow");
  });

  test("refuses a role name claimed by two modules", () => {
    // Picking either would mean OPENSHAPEFORGE_ROLE silently starts something
    // other than what the operator named.
    expect(() =>
      indexModuleWorkers(
        registry([moduleWith("workflow", ["drainer"]), moduleWith("billing", ["drainer"])]),
      ),
    ).toThrow(/contributed by both "workflow" and "billing"/);
  });

  test("a module contributing no workers is not an error", () => {
    expect(indexModuleWorkers(registry([{ name: "entity-docs" }])).size).toBe(0);
  });
});

describe("startWorkerRole", () => {
  // Deliberately unreachable. Nothing below issues a query — the stub workers
  // do no work — and `createDatabaseRuntime` opens no connection until one is
  // needed, so these stay in CI's no-database job. A URL that happened to be
  // reachable locally would hide the day that stops being true.
  const databaseUrl = "postgres://unused:unused@127.0.0.1:1/no-connection-is-opened";

  test("refuses to start without a database", async () => {
    // The API answers DATABASE_NOT_CONFIGURED and keeps serving; a worker with
    // no database has nothing to do, so idling would be the wrong outcome.
    await expect(
      startWorkerRole("workflow-worker", {
        databaseUrl: "",
        modules: registry([moduleWith("workflow", ["workflow-worker"])]),
        log: silentLog,
      }),
    ).rejects.toThrow(/requires DATABASE_URL/);
  });

  test("names the contributed roles when asked for one that does not exist", async () => {
    await expect(
      startWorkerRole("typo-worker", {
        databaseUrl,
        modules: registry([moduleWith("workflow", ["workflow-worker"])]),
        log: silentLog,
      }),
    ).rejects.toThrow(/Unknown worker role "typo-worker". Contributed roles: workflow-worker./);
  });

  test("reports the load failure when the module owning the role did not load", async () => {
    // "Unknown role" would send an operator hunting a typo. The module failing
    // to load IS the reason, and it is already recorded.
    await expect(
      startWorkerRole("workflow", {
        databaseUrl,
        modules: registry(
          [],
          [
            {
              name: "workflow",
              specifier: "./examples/plugins/workflow/runtime.ts",
              reason: "module_missing",
              message: "boom",
            },
          ],
        ),
        log: silentLog,
      }),
    ).rejects.toThrow(/module "workflow" was not loaded \(module_missing — boom\)/);
  });

  test("runs init before starting, and stops the worker before closing the pool", async () => {
    const order: string[] = [];
    let started: ModuleWorkerContext | null = null;

    const handle = await startWorkerRole("probe", {
      databaseUrl,
      log: silentLog,
      modules: registry([
        {
          name: "probe-module",
          init: async () => void order.push("init"),
          workers: {
            probe: {
              start: (context): ModuleWorkerHandle => {
                order.push("start");
                started = context;
                return { stop: async () => void order.push("stop") };
              },
            },
          },
        },
      ]),
    });

    // init first: the workflow module hydrates its node catalog there, and a
    // worker that claimed commands before it would fail every one with
    // NO_BRIDGE — spending the retry bound on a configuration problem.
    expect(order).toEqual(["init", "start"]);
    expect(started).not.toBeNull();
    expect(handle).toMatchObject({ role: "probe", module: "probe-module" });

    await handle.stop();
    expect(order).toEqual(["init", "start", "stop"]);
  });

  test("a module whose init throws does not contribute its role", async () => {
    // initRuntimeModules drops it, so the role it owns is genuinely absent
    // rather than present-but-broken.
    await expect(
      startWorkerRole("probe", {
        databaseUrl,
        log: silentLog,
        modules: registry([
          {
            name: "probe-module",
            init: async () => {
              throw new Error("catalog unavailable");
            },
            workers: { probe: { start: () => ({ stop: async () => {} }) } },
          },
        ]),
      }),
    ).rejects.toThrow(/Unknown worker role "probe". Contributed roles: \(none\)./);
  });
});
