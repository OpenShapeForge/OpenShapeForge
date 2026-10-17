// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { catalog } from "../catalog.js";
import { resolveNativeCrudTool } from "../generic-tool-projection.js";
import { generatedCrudTools, matchNativeCrudTool } from "../native-crud-tool.js";

const named = (name: string) => generatedCrudTools.filter((tool) => tool.name === name);
const dedicated = generatedCrudTools.find((tool) => named(tool.name).length === 1)!;
const shared = generatedCrudTools.find((tool) => named(tool.name).length > 1)!;

describe("the native reference to a generated entity Operation", () => {
  test("reads the same generated catalogue native execution reads", () => {
    expect(generatedCrudTools).toBe(catalog.tools);
    expect(dedicated).toBeDefined();
    expect(shared).toBeDefined();
  });

  test("matches a canonical id, then a dedicated tool name, to the same tool", () => {
    expect(matchNativeCrudTool(generatedCrudTools, dedicated.operationId)).toEqual({ kind: "tool", tool: dedicated });
    expect(matchNativeCrudTool(generatedCrudTools, dedicated.name)).toEqual({ kind: "tool", tool: dedicated });
    expect(resolveNativeCrudTool(dedicated.name, {})).toBe(dedicated as never);
    expect(resolveNativeCrudTool(dedicated.operationId, {})).toBe(dedicated as never);
  });

  test("resolves a shared name only with the entity it means, and refuses it otherwise", () => {
    expect(matchNativeCrudTool(generatedCrudTools, shared.name).kind).toBe("shared-name");
    expect(matchNativeCrudTool(generatedCrudTools, shared.name, shared.entity)).toEqual({ kind: "tool", tool: shared });
    expect(resolveNativeCrudTool(shared.name, { entity: shared.entity })).toBe(shared as never);
    expect(() => resolveNativeCrudTool(shared.name, {})).toThrow(/shared by the entities/);
  });

  test("leaves an unknown reference to the plugin Operations", () => {
    expect(matchNativeCrudTool(generatedCrudTools, "no_such_generated_tool")).toEqual({ kind: "none" });
    expect(resolveNativeCrudTool("example.plugin.run", {})).toBeUndefined();
  });
});
