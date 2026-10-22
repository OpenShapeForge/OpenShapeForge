// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { auditContext, withAuditContext } from "./audit-context.js";

test("verified bearer principal kind distinguishes integration writes and nested Operations retain correlation", async () => {
  await withAuditContext("outer", "bearer", async () => {
    const outer = auditContext()!;
    expect(outer.actorKind).toBe("integration");
    await withAuditContext("inner", "bearer", async () => {
      expect(auditContext()!.correlationId).toBe(outer.correlationId);
      expect(auditContext()!.actorKind).toBe("integration");
      expect(auditContext()!.operationId).toBe("inner");
    }, "service");
  }, "service");
  withAuditContext("person", "bearer", () => expect(auditContext()!.actorKind).toBe("person"), "person");
  withAuditContext("maintenance", undefined, () => expect(auditContext()!.actorKind).toBe("system"));
  expect(auditContext()).toBeUndefined();
});
