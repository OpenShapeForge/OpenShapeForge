// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadOperationCatalogs } from "./authoring/operation-catalog.js";
import { collectAuthoredModulePluginOperations } from "./generate-operations.js";
import { buildMcpCatalog } from "./generate-mcp.js";

const authoringDir = join(import.meta.dir, "../config/authoring");
const context = { repoRoot: join(import.meta.dir, "../../.."), authoringDir, webPresent: false };
const roleCatalog = () => loadOperationCatalogs(authoringDir)
  .find(({ document }) => document.operations.listRoles?.id === "accounts.list-roles")!.document;

describe("shipped organization role catalog MCP projection", () => {
  test("projects only the role list, keeping role reads and permission writes off MCP", () => {
    const operations = collectAuthoredModulePluginOperations([roleCatalog()], context);
    const catalog = buildMcpCatalog([], "test", {}, operations);
    expect(catalog.operationTools.map(({ key, name }) => ({ key, name }))).toEqual([
      { key: "accounts.list-roles", name: "list_account_roles" },
    ]);
    expect(catalog.operationTools[0]!.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true,
    });
    for (const operation of operations.filter(({ key }) => key !== "accounts.list-roles")) {
      expect(operation.transports.mcp.enabled).toBe(false);
    }
    expect(operations).toHaveLength(6);
  });

  test("retains the canonical REST contract and organization authorization unchanged", () => {
    const authored = roleCatalog();
    const restOnly = structuredClone(authored);
    delete restOnly.interfaces.mcp;
    const projected = collectAuthoredModulePluginOperations([authored], context);
    const previous = collectAuthoredModulePluginOperations([restOnly], context);
    const withoutMcp = (operations: typeof projected) => operations.map(({ transports, ...operation }) => {
      const { mcp: _mcp, ...otherTransports } = transports;
      return { ...operation, transports: otherTransports };
    });
    expect(withoutMcp(projected)).toEqual(withoutMcp(previous));
    const list = projected.find(({ key }) => key === "accounts.list-roles")!;
    expect(list.auth).toEqual({ mode: "session", roles: ["Organization.Access.Manage", "Organization.Accounts.Manage"] });
    expect(list.tenancy).toEqual({ mode: "required" });
    expect(list.effects).toEqual({ data: "read", external: "none" });
    expect(list.confirmation).toEqual({ mode: "none" });
    expect(list.inputSchema).toMatchObject({ type: "object", additionalProperties: false, properties: {} });
    expect(list.transports.rest).toEqual({ method: "POST", path: "/api/accounts/list-roles", response: { status: 200, kind: "json" } });
  });
});
