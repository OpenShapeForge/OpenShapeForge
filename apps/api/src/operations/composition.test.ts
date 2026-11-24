// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { bindOperationHandlers, runtimeStaticOperationRegistrations } from "./composition.js";
import { entityPluginOperationContracts } from "./runtime.js";

test("canonical execution does not load its composition or transport adapters", async () => {
  const source = await Bun.file(new URL("./runtime.ts", import.meta.url)).text();
  const imports = new Bun.Transpiler({ loader: "ts" }).scanImports(source);
  const reverseDependencies = imports.map(({ path }) => path).filter(
    (path) => path === "./composition.js" || path.startsWith("./billing/") ||
      path === "fastify" || path === "graphql" || path === "../rest/operation-routes.js" ||
      path === "../graphql/operation-contribution.js",
  );
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
