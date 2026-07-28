// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import { buildMcp, deriveToolPrefix } from "./mcp.js";
import type { CoreEntity } from "../types.js";

const entityWithMcp = (mcp: CoreEntity["mcp"], entity = "ContactDetail"): CoreEntity =>
  ({
    schemaVersion: 1,
    kind: "coreEntity",
    module: "core",
    entity,
    title: "Contact Detail",
    language: "en",
    fields: [{ key: "value", valueType: "string" }],
    ...(mcp === undefined ? {} : { mcp }),
  }) as CoreEntity;

describe("deriveToolPrefix", () => {
  it("snake_cases the entity name and stays singular", () => {
    expect(deriveToolPrefix("ContactDetail")).toBe("contact_detail");
    expect(deriveToolPrefix("Relation")).toBe("relation");
    expect(deriveToolPrefix("RelationGroup")).toBe("relation_group");
  });
});

describe("buildMcp", () => {
  it("returns undefined when the entity has no mcp block (fail closed)", () => {
    expect(buildMcp(entityWithMcp(undefined))).toBeUndefined();
  });

  it("returns undefined for mcp: false and mcp: { enabled: false }", () => {
    expect(buildMcp(entityWithMcp(false))).toBeUndefined();
    expect(buildMcp(entityWithMcp({ enabled: false }))).toBeUndefined();
  });

  it("mcp: true enables every operation under a derived snake_case prefix", () => {
    expect(buildMcp(entityWithMcp(true))).toEqual({
      toolPrefix: "contact_detail",
      tools: "dedicated",
      operations: { list: true, get: true, create: true, update: true, delete: true },
    });
  });

  it("an empty object block behaves like mcp: true", () => {
    expect(buildMcp(entityWithMcp({}))).toEqual(buildMcp(entityWithMcp(true)));
  });

  it("honours an explicit toolPrefix override", () => {
    expect(buildMcp(entityWithMcp({ toolPrefix: "contact" }))?.toolPrefix).toBe("contact");
  });

  it("defaults to the dedicated tool style and honours generic", () => {
    expect(buildMcp(entityWithMcp(true))?.tools).toBe("dedicated");
    expect(buildMcp(entityWithMcp({ tools: "generic" }))?.tools).toBe("generic");
  });

  it("per-operation flags default to true and can be disabled individually", () => {
    const section = buildMcp(entityWithMcp({ operations: { delete: false, create: false } }));
    expect(section?.operations).toEqual({
      list: true,
      get: true,
      create: false,
      update: true,
      delete: false,
    });
  });

  it("rejects a toolPrefix that could break out of a tool-name position", () => {
    for (const hostile of ["a-b", "Upper", "with space", "quote\"y", "{id}", "1leading"]) {
      expect(() => buildMcp(entityWithMcp({ toolPrefix: hostile }))).toThrow(
        /Unsafe mcp toolPrefix/,
      );
    }
  });
});
