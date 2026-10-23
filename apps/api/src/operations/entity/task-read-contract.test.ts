// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { getGeneratedCrudTables, requireEntityOperation } from "./catalog.js";
import { catalog } from "../../mcp/catalog.js";
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
      expect(() => requireEntityOperation(task, operation, { ...reader, roles: [] })).toThrow();
    }
    for (const operation of ["create", "update", "delete"] as const) {
      expect(() => requireEntityOperation(task, operation, reader)).toThrow();
      expect(() => requireEntityOperation(task, operation, { ...reader, roles: ["General.All.ReadWrite"] })).not.toThrow();
    }
  });

  test("the targeted role does not grant unrelated general records", () => {
    const general = tables.filter(table => table !== task && table.source?.authorization?.roles?.read?.includes("General.All.Read"));
    expect(general.length).toBeGreaterThan(0);
    for (const table of general) {
      expect(() => requireEntityOperation(table, "get", reader)).toThrow();
    }
  });

  test("MCP exposes only the existing list and get Operations", () => {
    expect(catalog.tools.filter(tool => tool.entity === "Task").map(tool => tool.operationId).sort())
      .toEqual(["Task.get", "Task.list"]);
    expect(catalog.entities.find(entity => entity.entity === "Task")?.tools).toBe("generic");
  });
});
