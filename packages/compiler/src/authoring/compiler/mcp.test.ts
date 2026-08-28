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

  it("object-form operations carry enabled plus name/description overrides", () => {
    const section = buildMcp(
      entityWithMcp({
        operations: {
          list: false,
          get: { name: "read_contact_detail", description: "Read one contact detail." },
          update: { name: "edit_contact_detail" },
          delete: { enabled: false },
        },
      }),
    );
    expect(section?.operations).toEqual({
      list: false,
      get: true,
      create: true,
      update: true,
      delete: false,
    });
    expect(section?.toolOverrides).toEqual({
      get: { name: "read_contact_detail", description: "Read one contact detail." },
      update: { name: "edit_contact_detail" },
    });
  });

  it("omits toolOverrides when object-form operations only toggle enabled", () => {
    const section = buildMcp(entityWithMcp({ operations: { delete: { enabled: false } } }));
    expect(section?.toolOverrides).toBeUndefined();
  });

  it("rejects name/description overrides on the generic tool style", () => {
    expect(() =>
      buildMcp(
        entityWithMcp({ tools: "generic", operations: { get: { name: "read_contact" } } }),
      ),
    ).toThrow(/generic tool style/);
  });

  it("rejects an override name that could break out of a tool-name position", () => {
    for (const hostile of ["a-b", "Upper", "with space", "{id}", "1leading"]) {
      expect(() =>
        buildMcp(entityWithMcp({ operations: { get: { name: hostile } } })),
      ).toThrow(/Unsafe mcp tool name/);
    }
  });

  it("carries a validated resource block through to the section", () => {
    const resource = {
      uri: "app://things",
      name: "Things",
      description: "Read the things.",
    };
    expect(buildMcp(entityWithMcp({ resource }))?.resource).toEqual(resource);
    expect(buildMcp(entityWithMcp(true))?.resource).toBeUndefined();
  });

  it("rejects a resource uri that could break out of a listing position", () => {
    for (const hostile of [
      "things",
      "app://things/",
      "app://things/{id}",
      "app://",
      "App://things",
      "app://thi ngs",
    ]) {
      expect(() => buildMcp(entityWithMcp({ resource: { uri: hostile } }))).toThrow(
        /Unsafe mcp resource uri/,
      );
    }
  });

  it("carries a validated derivedTools block through to the section", () => {
    const derivedTools = {
      roles: ["viewer"],
      keyField: "value",
      descriptionField: "value",
      inputFieldsField: "value",
    };
    expect(buildMcp(entityWithMcp({ derivedTools }))?.derivedTools).toEqual(derivedTools);
  });

  it("rejects derivedTools with an empty audience or unknown fields", () => {
    expect(() =>
      buildMcp(
        entityWithMcp({
          derivedTools: { roles: [], keyField: "value", descriptionField: "value", inputFieldsField: "value" },
        }),
      ),
    ).toThrow(/non-empty roles list/);
    expect(() =>
      buildMcp(
        entityWithMcp({
          derivedTools: { roles: ["viewer"], keyField: "missing", descriptionField: "value", inputFieldsField: "value" },
        }),
      ),
    ).toThrow(/does not name an authored field/);
  });

  it("carries a validated elicitOnCreate block through to the section", () => {
    const elicitOnCreate = {
      sourceField: "value",
      sourceEntity: "Widget",
      definitionsField: "configFields",
      into: "value",
    };
    expect(buildMcp(entityWithMcp({ elicitOnCreate }))?.elicitOnCreate).toEqual(elicitOnCreate);
  });

  it("rejects elicitOnCreate naming unknown local fields", () => {
    expect(() =>
      buildMcp(
        entityWithMcp({
          elicitOnCreate: {
            sourceField: "missing",
            sourceEntity: "Widget",
            definitionsField: "x",
            into: "value",
          },
        }),
      ),
    ).toThrow(/does not name an authored field/);
  });

  it("rejects a toolPrefix that could break out of a tool-name position", () => {
    for (const hostile of ["a-b", "Upper", "with space", "quote\"y", "{id}", "1leading"]) {
      expect(() => buildMcp(entityWithMcp({ toolPrefix: hostile }))).toThrow(
        /Unsafe mcp toolPrefix/,
      );
    }
  });

  it("passes a test tool through when elicitOnCreate is present", () => {
    const elicitOnCreate = {
      sourceField: "value",
      sourceEntity: "Widget",
      definitionsField: "configFields",
      into: "value",
    };
    expect(
      buildMcp(entityWithMcp({ elicitOnCreate, test: { name: "test_connection" } }))?.test,
    ).toEqual({ name: "test_connection" });
  });

  it("rejects a test tool without elicitOnCreate, and unsafe test names", () => {
    expect(() => buildMcp(entityWithMcp({ test: { name: "test_connection" } }))).toThrow(
      /requires an elicitOnCreate block/,
    );
    expect(() =>
      buildMcp(
        entityWithMcp({
          elicitOnCreate: {
            sourceField: "value",
            sourceEntity: "Widget",
            definitionsField: "x",
            into: "value",
          },
          test: { name: "Bad Name" },
        }),
      ),
    ).toThrow(/Unsafe mcp test name/);
  });
});
