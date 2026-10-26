// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { getGeneratedCrudTables, requireEntityOperation } from "./catalog.js";
import { catalog } from "../../mcp/catalog.js";
import { sessionMayInvoke } from "../../mcp/session-projection.js";
import roleComposites from "../../generated/compiler/role-composites.json" with { type: "json" };
import type { DbSessionInput } from "../../db/session.js";

const tables = getGeneratedCrudTables();
const task = tables.find(table => table.source?.authoringEntityName === "Task")!;
const reader: DbSessionInput = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002",
  roles: ["Tasks.All.Read"],
};

describe("the compiled Task read contract", () => {
  test("the targeted role admits reads without admitting Task writes", () => {
    expect(task).toBeDefined();
    for (const operation of ["list", "get"] as const) {
      expect(() => requireEntityOperation(task, operation, reader)).not.toThrow();
      expect(sessionMayInvoke(task, operation, reader)).toBe(true);
      expect(() => requireEntityOperation(task, operation, { ...reader, roles: [] })).toThrow("Not authorized");
    }
    for (const operation of ["create", "update", "delete"] as const) {
      expect(() => requireEntityOperation(task, operation, reader)).toThrow("Not authorized");
      expect(sessionMayInvoke(task, operation, reader)).toBe(false);
      expect(() => requireEntityOperation(task, operation, { ...reader, roles: ["General.All.ReadWrite"] })).not.toThrow();
    }
  });

  test("the targeted role does not grant unrelated general records", () => {
    const general = tables.filter(table => table !== task && table.source?.authorization?.roles?.read?.includes("General.All.Read"));
    expect(general.length).toBeGreaterThan(0);
    for (const table of general) {
      if (sessionMayInvoke(table, "get", { ...reader, roles: ["General.All.Read"] })) {
        expect(() => requireEntityOperation(table, "get", reader)).toThrow("Not authorized");
      }
    }
  });

  test("the shared role is unassigned until a host grants it", () => {
    expect(JSON.stringify(roleComposites)).not.toContain("Tasks.All.Read");
  });

  test("MCP exposes only the existing list and get Operations", () => {
    expect(catalog.tools.filter(tool => tool.entity === "Task").map(tool => tool.operationId).sort())
      .toEqual(["Task.get", "Task.list"]);
    expect(catalog.entities.find(entity => entity.entity === "Task")?.tools).toBe("generic");
  });
});
