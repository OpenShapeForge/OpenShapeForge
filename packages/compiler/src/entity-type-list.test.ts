// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { collectAuthoredEntityPluginOperations, assertOperationRuntimeModules } from "./generate-operations.js";
import type { CompiledEntityInfo } from "./plugins.js";

const context = { repoRoot: ".", authoringDir: ".", webPresent: true };
test("entity type discovery is a trusted canonical native read operation with authored labels", () => {
  const entities = [{ contract: {
    entity: { name: "Example", title: "Example", labels: { en: "Example", nl: "Voorbeeld" } },
    authorization: { roles: { read: ["Example.Read"] } },
    model: { fields: [{ options: { type: "dynamic", source: "entityTypes.list" } }] },
  } }] as unknown as Pick<CompiledEntityInfo, "contract">[];
  const operations = collectAuthoredEntityPluginOperations(entities, context);
  expect(operations).toHaveLength(1);
  expect(operations[0]).toMatchObject({ key: "entityTypes.list", auth: { mode: "session", roles: ["Example.Read"] }, effects: { data: "read", external: "none" }, implementation: { type: "entity-type-list", labels: { Example: { nl: "Voorbeeld" } } } });
  expect(() => assertOperationRuntimeModules(operations, [])).not.toThrow();
  expect(() => assertOperationRuntimeModules([{ ...operations[0]! }], [])).toThrow("unverified");
});
