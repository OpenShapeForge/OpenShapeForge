// SPDX-License-Identifier: BUSL-1.1
/**
 * The host's required execution policy owners, at both bootstraps.
 *
 * A module object only exists once its runtime entry point imported and
 * constructed. Every way that can fail — an import that throws, a factory that
 * throws, an export that is not a runtime module, a name that disagrees with
 * the registration — leaves `modules/registry.ts` with a failure record and no
 * object, so core cannot read whether the thing that vanished owned the
 * tenant's execution policy. The surviving modules keep working, the core job
 * worker still drains, and a frozen tenant would be free to change anything.
 *
 * So the host states its required owners as server configuration, and these
 * tests drive the REAL loader with a failing import to produce the real
 * failure records, then boot the real API and worker roles on them.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { FastifyInstance } from "fastify";
import type { ModuleExecutionPolicy, RuntimeModule } from "../../modules/contract.js";
import { loadRuntimeModules, type ModuleRegistry } from "../../modules/registry.js";
import {
  readRequiredExecutionPolicyModules,
  REQUIRED_EXECUTION_POLICY_MODULES_ENV,
} from "../../operations/execution-policy.js";
import { createApiApp } from "../api.js";
import { startWorkerRole } from "../worker.js";

/**
 * The policy-owning plugin of this test, named after a module the generated
 * registry actually registers — so the real loader resolves and classifies it.
 */
const OWNER = "core-versioning";
const admitting: ModuleExecutionPolicy = { name: "tenant-write-deadline", evaluate: () => ({ admitted: true }) };

// Deliberately unreachable: nothing below issues a query. The API runs with no
// operation catalog and the worker's stub does no work, so neither opens a
// connection (as roles/__tests__/worker-role.unit.test.ts relies on too).
const databaseUrl = "postgres://unused:unused@127.0.0.1:1/no-connection-is-opened";
const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

type Outcome = "throw" | "factory-throws" | "not-a-module" | "wrong-name" | "policy-owner" | "plain";

/** Drive the real loader: it resolves the generated registry, we decide what each import does. */
function loadWith(outcomes: Partial<Record<string, Outcome>>): Promise<ModuleRegistry> {
  const named = (specifier: string): string =>
    specifier.includes("versioning") ? "core-versioning"
      : specifier.includes("documents") ? "documents"
        : "notebook";
  return loadRuntimeModules({
    importModule: async (specifier) => {
      const name = named(specifier);
      switch (outcomes[name] ?? "plain") {
        case "throw":
          throw new Error("its runtime entry point could not be imported");
        case "factory-throws":
          // A default-exported factory is invoked by the loader; one that
          // throws leaves no object either.
          return { default: () => { throw new Error("its factory refused to construct"); } };
        case "not-a-module":
          return { default: "not a runtime module" };
        case "wrong-name":
          return { default: { name: `${name}-renamed` } satisfies RuntimeModule };
        case "policy-owner":
          return { default: { name, executionPolicies: [admitting] } satisfies RuntimeModule };
        default:
          return { default: { name } satisfies RuntimeModule };
      }
    },
  });
}

function apiApp(modules: ModuleRegistry, required: readonly string[]): FastifyInstance {
  return createApiApp({
    cors: false,
    databaseUrl,
    modules,
    // Isolate the rule under test: with no operation catalog, the canonical
    // binding invariant cannot be what refuses this boot.
    operationContracts: [],
    requiredExecutionPolicyModules: required,
  });
}

function workerRole(modules: ModuleRegistry, required?: string) {
  return startWorkerRole("job-worker", {
    databaseUrl,
    modules,
    log: silentLog,
    env: {
      NODE_ENV: "development",
      OPENSHAPEFORGE_MAIL_PROVIDER: "null",
      ...(required ? { [REQUIRED_EXECUTION_POLICY_MODULES_ENV]: required } : {}),
    },
  });
}

describe("the required execution policy owners setting", () => {
  test("is empty by default, and a list of names when the host sets one", () => {
    expect(readRequiredExecutionPolicyModules({})).toEqual([]);
    expect(readRequiredExecutionPolicyModules({ [REQUIRED_EXECUTION_POLICY_MODULES_ENV]: "  " })).toEqual([]);
    expect(readRequiredExecutionPolicyModules({
      [REQUIRED_EXECUTION_POLICY_MODULES_ENV]: " billing , tenant-policy ,billing",
    })).toEqual(["billing", "tenant-policy"]);
    expect(() => readRequiredExecutionPolicyModules({
      [REQUIRED_EXECUTION_POLICY_MODULES_ENV]: " , ",
    })).toThrow(/names no module/);
  });
});

describe("a required policy owner that never produced a module object", () => {
  const failures: readonly [Outcome, RegExp][] = [
    ["throw", /module_missing/],
    ["factory-throws", /invalid_module/],
    ["not-a-module", /invalid_module/],
    ["wrong-name", /name_mismatch/],
  ];

  test.each(failures)("refuses the API role (%s)", async (outcome, reason) => {
    const modules = await loadWith({ [OWNER]: outcome });
    // The real loader lost it, and everything else is fine: core's own
    // accounts module and the other plugins are loaded.
    expect(modules.failures.map((failure) => failure.name)).toEqual([OWNER]);
    expect(modules.loaded.map((module) => module.name)).toContain("accounts");
    expect(modules.loaded.length).toBeGreaterThan(1);

    app = apiApp(modules, [OWNER]);
    const ready = app.ready();
    await expect(ready).rejects.toThrow(reason);
    await expect(ready).rejects.toThrow(
      /requires "core-versioning" to own host execution policies here/,
    );
  });

  test("refuses the worker role, whose own requested role is available", async () => {
    const modules = await loadWith({ [OWNER]: "throw" });
    await expect(workerRole(modules, OWNER)).rejects.toThrow(
      /requires "core-versioning" to own host execution policies here[\s\S]*module_missing/,
    );
  });

  test("refuses a required module that loaded but contributes no policy", async () => {
    // Nothing failed at all; the host named an owner that does not own one.
    const modules = await loadWith({});
    expect(modules.failures).toEqual([]);
    app = apiApp(modules, [OWNER]);
    await expect(app.ready()).rejects.toThrow(/loaded but contributed no execution policy/);
  });

  test("refuses a required module this process does not register at all", async () => {
    const modules = await loadWith({ [OWNER]: "policy-owner" });
    app = apiApp(modules, [OWNER, "billing-freeze"]);
    await expect(app.ready()).rejects.toThrow(
      /"billing-freeze" is not a loaded runtime module of this process/,
    );
  });
});

/**
 * Why these read the boot error instead of a served request: the registries
 * above are stub modules, so the GraphQL schema builder refuses them on its
 * own canonical binding invariant. What matters here is that the refusal is
 * never this rule — a host with no requirement, or a satisfied one, is left
 * exactly as it was.
 */
async function bootRefusal(instance: FastifyInstance): Promise<string> {
  try {
    await instance.ready();
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("hosts that are not governed by a required owner", () => {
  test("a host that requires none is unaffected by an unrelated module missing", async () => {
    // The ordinary fail-soft load, unchanged: no requirement, no refusal.
    const modules = await loadWith({ documents: "throw" });
    expect(modules.failures.map((failure) => failure.reason)).toEqual(["module_missing"]);

    app = apiApp(modules, []);
    expect(await bootRefusal(app)).not.toMatch(/host execution policies/);

    const handle = await workerRole(modules);
    expect(handle).toMatchObject({ role: "job-worker" });
    await handle.stop();
  });

  test("a satisfied requirement leaves both roles alone", async () => {
    const modules = await loadWith({ [OWNER]: "policy-owner" });
    app = apiApp(modules, [OWNER]);
    expect(await bootRefusal(app)).not.toMatch(/host execution policies/);

    const handle = await workerRole(modules, OWNER);
    expect(handle).toMatchObject({ role: "job-worker" });
    await handle.stop();
  });
});
