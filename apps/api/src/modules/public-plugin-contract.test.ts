// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import type { RuntimeModule as PublicRuntimeModule } from "@openshapeforge/plugin-runtime";
import type { RuntimeModule } from "./contract.js";

function acceptsRuntimeModule(module: RuntimeModule): string {
  return module.name;
}

test("the public runtime plugin contract loads as a core runtime module", () => {
  const plugin = {
    name: "example",
    operationHandlers: {
      run: async () => ({ value: { ok: true } }),
    },
  } satisfies PublicRuntimeModule;

  expect(acceptsRuntimeModule(plugin)).toBe("example");
});
