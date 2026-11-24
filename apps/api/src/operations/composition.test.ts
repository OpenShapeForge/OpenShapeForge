// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { bindOperationHandlers, runtimeStaticOperationRegistrations } from "./composition.js";
import { entityPluginOperationContracts } from "./runtime.js";

test("canonical execution does not directly import transport adapters", async () => {
  const source = await Bun.file(new URL("./runtime.ts", import.meta.url)).text();
  const imports = new Bun.Transpiler({ loader: "ts" }).scanImports(source);
  const reverseDependencies = imports.map(({ path }) => path).filter(
    (path) => path === "fastify" || path === "graphql" ||
      /^\.\.\/(rest|graphql|mcp)\//.test(path),
  );
  expect(reverseDependencies).toEqual([]);
});

test("Operation modules import the canonical refusal without going through REST", async () => {
  const sources = new Bun.Glob("**/*.ts");
  const directory = new URL("./", import.meta.url);
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const restErrorAdapter = new URL("../rest/http-error.js", directory);
  const adapterConsumers: string[] = [];
  for await (const path of sources.scan(directory.pathname)) {
    if (path.endsWith(".test.ts")) continue;
    const source = new URL(path, directory);
    const imports = transpiler.scanImports(await Bun.file(source).text());
    if (imports.some(({ path }) => path.startsWith(".") && new URL(path, source).href === restErrorAdapter.href)) {
      adapterConsumers.push(path);
    }
  }
  expect(adapterConsumers).toEqual([]);
});

test("canonical execution cannot reach billing or composition through static API imports", async () => {
  const apiSource = new URL("../", import.meta.url);
  const runtime = new URL("operations/runtime.ts", apiSource);
  const composition = new URL("operations/composition.ts", apiSource);
  const billing = new URL("operations/billing/", apiSource);
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const queued = new Map<string, URL[]>([[runtime.href, [runtime]]]);
  const reverseDependencies: string[] = [];

  for (const chain of queued.values()) {
    const source = chain[chain.length - 1]!;
    if (source.href === composition.href || source.href.startsWith(billing.href)) {
      reverseDependencies.push(chain.map((url) => url.href.slice(apiSource.href.length)).join(" -> "));
      continue;
    }
    const file = Bun.file(source);
    if (!await file.exists()) continue;
    for (const { kind, path } of transpiler.scanImports(await file.text())) {
      if (kind !== "import-statement" || !path.startsWith(".") || !path.endsWith(".js")) continue;
      const target = new URL(path.replace(/\.js$/, ".ts"), source);
      if (target.href.startsWith(apiSource.href) && !queued.has(target.href)) {
        queued.set(target.href, [...chain, target]);
      }
    }
  }

  expect(reverseDependencies).toEqual([]);
});

test("core billing binds in a process with no loaded plugins", () => {
  const registrations = runtimeStaticOperationRegistrations([], {});
  expect(registrations.some(({ definition }) => definition.id === "BillingRun.execute")).toBe(true);

  const milestone = entityPluginOperationContracts().find(
    (operation) => operation.plugin === "osf-billing" && operation.handler === "createAgreementMilestone",
  );
  expect(milestone).toBeDefined();
  expect(bindOperationHandlers([], [milestone!]).get(milestone!.key)?.handler).toBeFunction();
});
