// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import { buildMcp, buildMcpSection, deriveToolPrefix } from "./mcp.js";
import type { CoreEntity, McpConfig } from "../types.js";

const contactDetail = (entity = "ContactDetail"): CoreEntity =>
  ({
    schemaVersion: 3,
    kind: "coreEntity",
    module: "core",
    entity,
    title: "Contact Detail",
    language: "en",
    fields: [
      { key: "value", osfType: "string", baseType: "string" },
      { key: "version", osfType: "integer", baseType: "integer" },
    ],
  }) as CoreEntity;
/** A resolved MCP configuration compiled for the fixture entity; `undefined` is no interface. */
const mcpSection = (mcp: McpConfig | undefined, entity?: string) => buildMcpSection(contactDetail(entity), mcp);

const v2Relation = (tools?: "dedicated" | "generic"): CoreEntity => {
  const actions = ["list", "get", "create", "update", "delete"] as const;
  return {
    schemaVersion: 2,
    kind: "coreEntity",
    module: "core",
    entity: "Relation",
    title: "Relation",
    language: "en",
    fields: [{ key: "displayName", osfType: "string", baseType: "string" }],
    operations: Object.fromEntries(
      actions.map((action) => [
        action,
        {
          name: action,
          description: `${action} relations`,
          implementation: { type: "entity", action },
          effects: {
            data:
              action === "list" || action === "get"
                ? "read"
                : action === "delete"
                  ? "delete"
                  : "write",
            external: "none",
          },
          reliability: { idempotency: { mode: "natural" } },
          confirmation: { mode: "none" },
        },
      ]),
    ),
    interfaces: {
      mcp: {
        ...(tools ? { tools } : {}),
      },
    },
  } as CoreEntity;
};

describe("deriveToolPrefix", () => {
  it("snake_cases the entity name and stays singular", () => {
    expect(deriveToolPrefix("ContactDetail")).toBe("contact_detail");
    expect(deriveToolPrefix("Relation")).toBe("relation");
    expect(deriveToolPrefix("RelationGroup")).toBe("relation_group");
  });
});

describe("buildMcp", () => {
  it("returns undefined when the entity has no mcp interface (fail closed)", () => {
    expect(mcpSection(undefined)).toBeUndefined();
    expect(buildMcp(contactDetail())).toBeUndefined();
  });

  it("returns undefined for { enabled: false }", () => {
    expect(mcpSection({ enabled: false })).toBeUndefined();
  });

  it("an empty configuration enables every operation under a derived snake_case prefix", () => {
    expect(mcpSection({})).toEqual({
      toolPrefix: "contact_detail",
      tools: "dedicated",
      operations: { list: true, get: true, create: true, update: true, delete: true },
    });
  });

  it("honours an explicit toolPrefix override", () => {
    expect(mcpSection({ toolPrefix: "contact" })?.toolPrefix).toBe("contact");
  });

  it("defaults to the dedicated tool style and honours generic", () => {
    expect(mcpSection({})?.tools).toBe("dedicated");
    expect(mcpSection({ tools: "generic" })?.tools).toBe("generic");
  });

  it("lowers strict v2 MCP tools while keeping an omitted Relation setting dedicated", () => {
    expect(buildMcp(v2Relation())).toMatchObject({
      toolPrefix: "relation",
      tools: "dedicated",
      operations: { list: true, get: true, create: true, update: true, delete: true },
    });
    expect(buildMcp(v2Relation("generic"))?.tools).toBe("generic");
  });

  it("temporarily lowers canonical secure input into the existing MCP handoff metadata", () => {
    const entity = v2Relation();
    entity.fields = [
      { key: "adapterId", osfType: "string", baseType: "string" },
      { key: "configurationValues", osfType: "object", baseType: "object" },
    ];
    entity.operations!.create!.interaction = {
      type: "secureInput",
      sourceField: "adapterId",
      sourceEntity: "Adapter",
      definitionsField: "configurationFields",
      into: "configurationValues",
      message: "Enter the values securely.",
    };

    expect(buildMcp(entity)?.elicitOnCreate).toEqual({
      sourceField: "adapterId",
      sourceEntity: "Adapter",
      definitionsField: "configurationFields",
      into: "configurationValues",
      message: "Enter the values securely.",
    });
  });

  it("per-operation flags default to true and can be disabled individually", () => {
    const section = mcpSection({ operations: { delete: false, create: false } });
    expect(section?.operations).toEqual({
      list: true,
      get: true,
      create: false,
      update: true,
      delete: false,
    });
  });

  it("object-form operations carry enabled plus name overrides", () => {
    const section = mcpSection({
        operations: {
          list: false,
          get: { name: "read_contact_detail" },
          update: { name: "edit_contact_detail" },
          delete: { enabled: false },
        },
      });
    expect(section?.operations).toEqual({
      list: false,
      get: true,
      create: true,
      update: true,
      delete: false,
    });
    expect(section?.toolOverrides).toEqual({
      get: { name: "read_contact_detail" },
      update: { name: "edit_contact_detail" },
    });
  });

  it("omits toolOverrides when object-form operations only toggle enabled", () => {
    const section = mcpSection({ operations: { delete: { enabled: false } } });
    expect(section?.toolOverrides).toBeUndefined();
  });

  it("rejects name overrides on the generic tool style", () => {
    expect(() =>
      mcpSection({ tools: "generic", operations: { get: { name: "read_contact" } } }),
    ).toThrow(/generic tool style/);
  });

  it("rejects an override name that could break out of a tool-name position", () => {
    for (const hostile of ["a-b", "Upper", "with space", "{id}", "1leading"]) {
      expect(() =>
        mcpSection({ operations: { get: { name: hostile } } }),
      ).toThrow(/Unsafe mcp tool name/);
    }
  });

  it("carries a validated resource block through to the section", () => {
    const resource = {
      uri: "app://things",
      name: "Things",
      description: "Read the things.",
    };
    expect(mcpSection({ resource })?.resource).toEqual(resource);
    expect(mcpSection({})?.resource).toBeUndefined();
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
      expect(() => mcpSection({ resource: { uri: hostile } })).toThrow(
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
      outputFieldsField: "value",
    };
    expect(mcpSection({ derivedTools })?.derivedTools).toEqual(derivedTools);
  });

  it("rejects derivedTools with an empty audience or unknown fields", () => {
    expect(() =>
      mcpSection({
          derivedTools: { roles: [], keyField: "value", descriptionField: "value", inputFieldsField: "value" },
        }),
    ).toThrow(/non-empty roles list/);
    expect(() =>
      mcpSection({
          derivedTools: { roles: ["viewer"], keyField: "missing", descriptionField: "value", inputFieldsField: "value" },
        }),
    ).toThrow(/does not name an authored field/);
    expect(() =>
      mcpSection({
          derivedTools: {
            roles: ["viewer"],
            keyField: "value",
            descriptionField: "value",
            inputFieldsField: "value",
            outputFieldsField: "missing",
          },
        }),
    ).toThrow(/outputFieldsField.*does not name an authored field/);
  });

  it("carries a validated elicitOnCreate block through to the section", () => {
    const elicitOnCreate = {
      sourceField: "value",
      sourceEntity: "Widget",
      definitionsField: "configFields",
      into: "value",
    };
    expect(mcpSection({ elicitOnCreate })?.elicitOnCreate).toEqual(elicitOnCreate);
  });

  it("rejects elicitOnCreate naming unknown local fields", () => {
    expect(() =>
      mcpSection({
          elicitOnCreate: {
            sourceField: "missing",
            sourceEntity: "Widget",
            definitionsField: "x",
            into: "value",
          },
        }),
    ).toThrow(/does not name an authored field/);
  });

  it("rejects a toolPrefix that could break out of a tool-name position", () => {
    for (const hostile of ["a-b", "Upper", "with space", "quote\"y", "{id}", "1leading"]) {
      expect(() => mcpSection({ toolPrefix: hostile })).toThrow(
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
      mcpSection({ elicitOnCreate, test: { name: "test_connection" } })?.test,
    ).toEqual({ name: "test_connection" });
  });

  it("rejects a test tool without elicitOnCreate, and unsafe test names", () => {
    expect(() => mcpSection({ test: { name: "test_connection" } })).toThrow(
      /requires an elicitOnCreate block/,
    );
    expect(() =>
      mcpSection({
          elicitOnCreate: {
            sourceField: "value",
            sourceEntity: "Widget",
            definitionsField: "x",
            into: "value",
          },
          test: { name: "Bad Name" },
        }),
    ).toThrow(/Unsafe mcp test name/);
  });

  it("passes dryRun through with execution and refuses it without", () => {
    const derivedTools = {
      roles: ["viewer"],
      keyField: "value",
      descriptionField: "value",
      inputFieldsField: "value",
      versionField: "version",
      execution: {
        bindingsField: "value",
        operationRef: "a",
        operationEntity: "B",
        providerRef: "c",
        providerEntity: "D",
        connectionEntity: "E",
        connectionProviderRef: "f",
        connectionValuesField: "g",
      },
      dryRun: { name: "dry_run_widget", roles: ["author"] },
    };
    expect(mcpSection({ derivedTools })?.derivedTools?.dryRun).toEqual({
      name: "dry_run_widget",
      roles: ["author"],
    });
    const { execution: _execution, ...withoutExecution } = derivedTools;
    expect(() => mcpSection({ derivedTools: withoutExecution })).toThrow(
      /requires an execution block/,
    );
    expect(() =>
      mcpSection({
          derivedTools: { ...derivedTools, dryRun: { name: "dry_run_widget", roles: [] } },
        }),
    ).toThrow(/non-empty roles list/);
    expect(() =>
      mcpSection({
          derivedTools: { ...derivedTools, dryRun: { name: "Bad Name", roles: ["author"] } },
        }),
    ).toThrow(/Unsafe mcp derivedTools.dryRun name/);
  });

  it("requires an integer version field for every executable definition", () => {
    const execution = {
      bindingsField: "value",
      operationRef: "a",
      operationEntity: "B",
      providerRef: "c",
      providerEntity: "D",
      connectionEntity: "E",
      connectionProviderRef: "f",
      connectionValuesField: "g",
    };
    const base = {
      roles: ["viewer"],
      keyField: "value",
      descriptionField: "value",
      inputFieldsField: "value",
      execution,
    };
    expect(() => mcpSection({ derivedTools: base })).toThrow(
      /versionField.*single-value integer/,
    );
    expect(() =>
      mcpSection({
          derivedTools: { ...base, versionField: "value" },
        }),
    ).toThrow(/versionField.*single-value integer/);
    expect(
      mcpSection({
          derivedTools: { ...base, versionField: "version" },
        })?.derivedTools?.versionField,
    ).toBe("version");
  });

  it("keeps declarative URL selection on the fixed authored row vocabulary", () => {
    const derivedTools = {
      roles: ["viewer"],
      keyField: "value",
      descriptionField: "value",
      inputFieldsField: "value",
      versionField: "version",
      execution: {
        bindingsField: "value",
        operationRef: "a",
        operationEntity: "B",
        providerRef: "c",
        providerEntity: "D",
        connectionEntity: "E",
        connectionProviderRef: "f",
        connectionValuesField: "g",
        baseUrlKeyField: "callerChoice",
      },
    };
    expect(() =>
      mcpSection({ derivedTools } as McpConfig),
    ).toThrow(/unknown option.*baseUrlKeyField.*caller-controlled fields/);
  });

  it("keeps declarative header names on the fixed authored row vocabulary", () => {
    const derivedTools = {
      roles: ["viewer"],
      keyField: "value",
      descriptionField: "value",
      inputFieldsField: "value",
      versionField: "version",
      execution: {
        bindingsField: "value",
        operationRef: "a",
        operationEntity: "B",
        providerRef: "c",
        providerEntity: "D",
        connectionEntity: "E",
        connectionProviderRef: "f",
        connectionValuesField: "g",
        requestHeaderNameField: "callerChoice",
      },
    };
    expect(() =>
      mcpSection({ derivedTools } as McpConfig),
    ).toThrow(/unknown option.*requestHeaderNameField.*caller-controlled fields/);
  });
});
