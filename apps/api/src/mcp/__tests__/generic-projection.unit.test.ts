// SPDX-License-Identifier: BUSL-1.1
/**
 * The two-step projection of the shared `osf_*` tools, on the real compiled
 * catalogue and manifest: the listing carries the entity enum and the shared
 * properties, `osf_describe` carries the exact per-entity schema, and both
 * are bounded to what the session may address. Runs without a database.
 */
import { describe, expect, it } from "bun:test";
import { getGeneratedCrudTables } from "../../operations/entity/index.js";
import rawCatalog from "../../generated/mcp/tools.json" with { type: "json" };
import {
  __crudToolsForSessionForTests as crudToolsForSession,
  __describeGenericEntityForTests as describeGenericEntity,
  __describeGenericEntriesForTests as describeGenericEntries,
  __toolsForSessionForTests as toolsForSession,
} from "../generated-mcp-server.js";

const catalog = rawCatalog as unknown as {
  tools: {
    name: string;
    entity: string;
    operation: string;
    inputSchema: Record<string, unknown>;
    errors: { status: number; code: string; description: string }[];
  }[];
  entities: { entity: string; tools?: string; labels?: Record<string, string> }[];
};

const tables = new Map(getGeneratedCrudTables().map((table) => [table.name, table]));
const english = { tag: "en", name: "English", englishName: "English", source: "user" as const };
const dutch = { tag: "nl", name: "Nederlands", englishName: "Dutch", source: "user" as const };

const session = (...roles: string[]) =>
  ({
    tenantId: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    roles,
    groups: [],
    scope: "self",
  }) as never;

// A role that reaches the generic Address entity and nothing else generic.
const RELATIONS = "Relations.All.ReadWrite";
const compiledErrors = (name: string) =>
  catalog.tools.find((tool) => tool.name === name && tool.entity === "Address")!.errors;

describe("the generic osf_* listing", () => {
  const generic = catalog.entities.filter((entity) => entity.tools === "generic");
  it.skipIf(generic.length === 0)("carries the entity enum, the shared properties and no per-entity branches", () => {
    const tools = crudToolsForSession(session(RELATIONS), tables as never, english);
    const create = tools.find((tool) => tool.name === "osf_create")!;
    expect(create).toBeDefined();
    const schema = create.inputSchema as Record<string, any>;
    expect(schema.anyOf).toBeUndefined();
    expect(schema.properties.entity.enum).toEqual(["Address"]);
    expect(create.description).toContain('osf_describe { entity, operation: "create" }');
    // Bounded: a single-entity session sees one entity, and the whole
    // generic surface stays small however many entities the catalogue has.
    const bytes = tools
      .filter((tool) => tool.name.startsWith("osf_"))
      .reduce((sum, tool) => sum + JSON.stringify(tool).length, 0);
    expect(bytes).toBeLessThan(64 * 1024);
  });

  it.skipIf(generic.length === 0)("lists osf_describe exactly when the session can address a generic entity", () => {
    const withGeneric = crudToolsForSession(session(RELATIONS), tables as never, english);
    const describe = withGeneric.find((tool) => tool.name === "osf_describe")!;
    expect((describe.inputSchema as any).properties.entity.enum).toEqual(["Address"]);
    const without = crudToolsForSession(session("Nobody.Role"), tables as never, english);
    expect(without.find((tool) => tool.name === "osf_describe")).toBeUndefined();
  });

  it.skipIf(generic.length === 0)("osf_describe answers the exact per-entity schema of the operations the session may perform", () => {
    const described = describeGenericEntity("Address", undefined, session(RELATIONS), tables as never, english) as any;
    expect(Object.keys(described.operations).sort()).toEqual(["create", "delete", "get", "list", "update"]);
    expect(described.resource).toBe("osf://schema/entities/address");
    const compiled = catalog.tools.find((tool) => tool.name === "osf_create" && tool.entity === "Address")!;
    // Every authored property of the compiled schema is in the answer; the
    // listing's compact create schema carried only the shared ones.
    const answered = Object.keys(described.operations.create.inputSchema.properties);
    for (const key of Object.keys(compiled.inputSchema.properties as Record<string, unknown>)) {
      expect(answered).toContain(key);
    }
    const one = describeGenericEntity("Address", "list", session(RELATIONS), tables as never, english) as any;
    expect(Object.keys(one.operations)).toEqual(["list"]);
    // The declared refusals travel with the exact contract, not with the listing.
    expect(one.operations.list.errors).toEqual(
      compiledErrors("osf_list").map(({ status, code, description }) => ({ status, code, description })),
    );
    expect(one.operations.list.errors.map((error: any) => error.code)).toContain("FORBIDDEN");
    const listed = crudToolsForSession(session(RELATIONS), tables as never, english).find((tool) => tool.name === "osf_list")!;
    expect(listed).not.toHaveProperty("errors");
  });

  it.skipIf(generic.length === 0)("refuses an entity the session cannot address, naming only what it can", () => {
    expect(() => describeGenericEntity("Quote", undefined, session(RELATIONS), tables as never, english))
      .toThrow(/"Quote" is not one of the entities .* Address\./);
    expect(() => describeGenericEntity(undefined, undefined, session(RELATIONS), tables as never, english))
      .toThrow(/needs an "entity" argument/);
    expect(() => describeGenericEntity("Address", "purge", session(RELATIONS), tables as never, english))
      .toThrow(/"operation" must be one of the operations this session may perform on Address: list, get, create, update, delete\./);
  });

  it.skipIf(generic.length === 0)("bounds the operations to what the session may perform: a read-only session is not told about delete", () => {
    const readOnly = session("Relations.All.Read");
    const describe = crudToolsForSession(readOnly, tables as never, english).find((tool) => tool.name === "osf_describe")!;
    expect((describe.inputSchema as any).properties.operation.enum).toEqual(["list", "get"]);
    const all = describeGenericEntity("Address", undefined, readOnly, tables as never, english) as any;
    expect(Object.keys(all.operations)).toEqual(["list", "get"]);
    expect(() => describeGenericEntity("Address", "delete", readOnly, tables as never, english))
      .toThrow(/must be one of the operations this session may perform on Address: list, get\./);
    const writer = crudToolsForSession(session(RELATIONS), tables as never, english).find((tool) => tool.name === "osf_describe")!;
    expect((writer.inputSchema as any).properties.operation.enum).toEqual(["list", "get", "create", "update", "delete"]);
  });

  it.skipIf(generic.length === 0)("withholds a classified field from the describe answer of a read-only session", () => {
    // No generic entity of the reference catalogue classifies a field, so
    // the case describes copies of Address's entries with `street`
    // classified; the imported catalogue is not touched. The withholding
    // rule is the dedicated tools' (describeTool).
    const stamped = (roles: string[]) =>
      toolsForSession(session(...roles), tables as never)
        .filter(({ tool }) => tool.entity === "Address")
        .map(({ tool, entity }) => ({
          tool,
          entity: entity ? { ...entity, classifiedFields: [...entity.classifiedFields, "street"] } : entity,
        }));
    const readOnly = describeGenericEntries(stamped(["Relations.All.Read"]), "Address", "list", session("Relations.All.Read"), tables as never, english) as any;
    expect(Object.keys(readOnly.operations)).toEqual(["list"]);
    expect(readOnly.operations.list.inputSchema.properties.filter.properties).not.toHaveProperty("street");
    expect(readOnly.operations.list.inputSchema.properties.filter.properties).toHaveProperty("city");
    const writer = describeGenericEntries(stamped([RELATIONS]), "Address", "list", session(RELATIONS), tables as never, english) as any;
    expect(writer.operations.list.inputSchema.properties.filter.properties).toHaveProperty("street");
  });

  it.skipIf(generic.length === 0)("names entities in the session's language", () => {
    const address = generic.find((entity) => entity.entity === "Address");
    if (!address?.labels?.nl) return;
    const tools = crudToolsForSession(session(RELATIONS), tables as never, dutch);
    expect(tools.find((tool) => tool.name === "osf_list")!.description).toContain(`Address (${address.labels.nl})`);
    const described = describeGenericEntity("Address", "list", session(RELATIONS), tables as never, dutch) as any;
    expect(described.title).toBe(address.labels.nl);
  });
});

describe("dedicated entity tools in the session's language", () => {
  const relation = catalog.tools.find((tool) => tool.name === "relation_list");
  it.skipIf(!relation)("uses the canonical operation's localized name and keeps the compiled advice", () => {
    const en = crudToolsForSession(session(RELATIONS), tables as never, english)
      .find((tool) => tool.name === "relation_list")!;
    const nl = crudToolsForSession(session(RELATIONS), tables as never, dutch)
      .find((tool) => tool.name === "relation_list")!;
    expect(en.title).toBe("List relations");
    expect(nl.title).toBe("Relaties tonen");
    expect(nl.description).toStartWith("Geeft een gefilterde en gesorteerde pagina met relaties terug.");
    // The compiled advice after the canonical sentence is the same in both.
    const advice = (text: string | undefined) => text!.slice(text!.indexOf("."));
    expect(advice(nl.description)).toBe(advice(en.description));
    expect(nl.annotations?.title).toBe("Relaties tonen");
  });
});
