// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import type {
  CompilerPlugin,
  PluginOperationContract,
} from "./index.js";

test("the package root exposes the compiler plugin contract", () => {
  const operation = {
    key: "example.record.publish",
    title: "Publish record",
    description: "Publishes one record.",
    handler: "publishRecord",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    errors: [],
    auth: { mode: "session", roles: ["record:publish"] },
    tenancy: { mode: "required" },
    idempotency: { mode: "none" },
    transports: {
      rest: { method: "POST", path: "/records/:id/publish", response: { kind: "json" } },
      mcp: { enabled: false, reason: "Not part of this example." },
      graphql: { enabled: false, reason: "Not part of this example." },
      typescript: { enabled: false, reason: "Not part of this example." },
    },
  } satisfies PluginOperationContract;
  const plugin = { name: "example", operations: [operation] } satisfies CompilerPlugin;

  expect(plugin.name).toBe("example");
});
