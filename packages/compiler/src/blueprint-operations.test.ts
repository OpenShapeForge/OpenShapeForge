// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import type { CompiledEntityInfo } from "./plugins.js";
import { collectBlueprintOperations } from "./blueprint-operations.js";

test("blueprint Operations preserve edit controls and separate publication rights", () => {
  const fixture = {
    slug: "template",
    contract: {
      entity: { id: "core.Template", name: "Template", title: "Template" },
      blueprint: { fields: ["name"], labelField: "name", operations: { list: "bp.list", status: "bp.status", reset: "bp.reset", publish: "bp.publish" } },
      authorization: { roles: { create: ["Create"], update: ["Edit"] }, rowAccess: { recordPermissions: { field: "permissions", empty: "restricted" } } },
      entityOperations: { update: { concurrency: {
        version: { mode: "required", field: "updatedAt" },
        editLease: { mode: "required", expiresAfterInactivity: "PT15M" },
      } } },
    },
  } as unknown as CompiledEntityInfo;
  const operations = collectBlueprintOperations([fixture]);
  expect(operations.find((operation) => operation.handler === "Template.list")?.auth).toEqual({ mode: "session", roles: ["Create", "Edit"] });
  const reset = operations.find((operation) => operation.handler === "Template.reset")!;
  expect(reset.concurrency).toEqual(fixture.contract.entityOperations.update!.concurrency);
  expect(reset.inputSchema.required).toEqual(["id", "expectedVersion", "blueprintVersion", "confirmed", "leaseToken"]);
  expect(reset.confirmation).toEqual({ mode: "acknowledgement" });
  expect(reset.auth).toEqual({ mode: "session", roles: ["Edit"], recordPermission: "edit" });
  const publish = operations.find((operation) => operation.handler === "Template.publish")!;
  expect(publish.auth).toEqual({ mode: "session", roles: ["platform-operator"], recordPermission: "edit" });
  expect(publish.inputSchema.required).toEqual(["id", "expectedVersion", "leaseToken"]);
});
