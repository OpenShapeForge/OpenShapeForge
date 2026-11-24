// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import type { RuntimeOperationDefinition } from "@openshapeforge/plugin-runtime";
import { searchableOperationToolDefinitions } from "@openshapeforge/operations";
import {
  isRecordsOnlySearch,
  parseOperationSearchArguments,
  searchOperationDefinitions,
} from "../operation-search.js";
import { staticToolCall } from "../dispatch-static-tools.js";
import { searchRecords } from "../record-search.js";

const locale = { tag: "en", name: "English", englishName: "English", source: "user" as const };
const readDefinition = {
  id: "Slot.find",
  intent: "invoke",
  name: { en: "Find slots" },
  description: { en: "Find available slots" },
  input: { kind: "json-schema", schema: { type: "object", properties: {}, additionalProperties: false } },
  output: { kind: "json-schema", schema: { type: "object" } },
} as unknown as RuntimeOperationDefinition;

function run(data: unknown, options: { allowed?: boolean; fail?: boolean; records?: { query: string; entity?: string; cursor?: string } } = {}) {
  const calls: Record<string, unknown>[] = [];
  const result = searchRecords({
    records: options.records ?? { query: "Customer Success" },
    eligible: async () => options.allowed !== false,
    assertRequestActive: () => {},
    locale: { tag: "en" },
    execute: async (request) => {
      calls.push(request.input);
      if (options.fail) throw new Error("db password leaked");
      return { data };
    },
  });
  return { result, calls };
}

describe("records search arguments", () => {
  test("legacy shapes parse unchanged and carry no records", () => {
    expect(parseOperationSearchArguments({ query: " teams " })).toEqual({ query: "teams", limit: 10 });
    expect(parseOperationSearchArguments({})).toEqual({ limit: 10 });
    expect(parseOperationSearchArguments({ operationId: " a.b " })).toEqual({ operationId: "a.b" });
  });

  test("parses combined and records-only requests", () => {
    const combined = parseOperationSearchArguments({ query: "slots", records: { query: " Customer Success ", entity: "Team" } });
    expect(combined).toEqual({ query: "slots", limit: 10, records: { query: "Customer Success", entity: "Team" } });
    expect(isRecordsOnlySearch(combined)).toBe(false);
    const only = parseOperationSearchArguments({ records: { query: "x", entity: "Team", cursor: "c" } });
    expect(isRecordsOnlySearch(only)).toBe(true);
  });

  test("rejects blank phrases, orphan cursors, unknown keys and mixed operationId", () => {
    for (const records of [{ query: "  " }, {}, { query: "x", cursor: "c" }, { query: "x", extra: 1 }, "x"]) {
      expect(() => parseOperationSearchArguments({ records })).toThrow();
    }
    expect(() => parseOperationSearchArguments({ operationId: "a.b", records: { query: "x" } })).toThrow();
  });

  test("records-only skips ranking and returns no operations", () => {
    const found = searchOperationDefinitions({
      definitions: [readDefinition], allowedIds: new Set([readDefinition.id]),
      arguments: { records: { query: "x" } }, locale,
      canonicalText: new Map(), entityLabels: new Map(), entityFields: new Map(), resolveName: () => undefined,
    });
    expect(found).toEqual({ operations: [] });
  });

  test("the tool schema advertises records and keeps operationId exclusive", () => {
    const [search] = searchableOperationToolDefinitions({ search: "s", execute: "e" });
    const schema = search!.inputSchema as { properties: Record<string, unknown>; not: { anyOf: unknown[] } };
    expect(schema.properties.records).toBeDefined();
    expect(schema.not.anyOf).toContainEqual({ required: ["operationId", "records"] });
    expect((search!.outputSchema as { properties: Record<string, unknown> }).properties.records).toBeDefined();
  });
});

describe("searchRecords", () => {
  const groups = [
    { entity: "Team", items: [{ id: "t1", label: "Customer Success" }], nextCursor: "next-team" },
    { entity: "RelationGroup", items: [{ id: "g1", label: "Customer Success Board" }], nextCursor: null },
  ];

  test("maps to canonical application.search and keeps order and cursors", async () => {
    const { result, calls } = run({ entities: [], groups, incomplete: false });
    expect(await result).toEqual({
      status: "ok",
      groups: [
        { entity: "Team", items: [{ id: "t1", label: "Customer Success" }], nextCursor: "next-team" },
        { entity: "RelationGroup", items: [{ id: "g1", label: "Customer Success Board" }] },
      ],
    });
    expect(calls).toEqual([{ query: "Customer Success", locale: "en", first: 5 }]);
  });

  test("continuation maps entity and cursor to canonical entity and after", async () => {
    const { result, calls } = run({ groups: [], incomplete: false }, { records: { query: "q", entity: "Team", cursor: "c1" } });
    await result;
    expect(calls).toEqual([{ query: "q", locale: "en", entity: "Team", after: "c1", first: 10 }]);
  });

  test("canonical incomplete is carried even when results exist", async () => {
    expect((await run({ groups, incomplete: true }).result).status).toBe("incomplete");
  });

  test("the total budget drops whole groups, reports incomplete and names them", async () => {
    const many = (entity: string, count: number) => ({
      entity, nextCursor: `${entity}-next`, items: Array.from({ length: count }, (_, i) => ({ id: `${entity}${i}`, label: `L${i}` })),
    });
    const result = await run({ groups: [many("A", 12), many("B", 12), many("C", 5)], incomplete: false }).result;
    expect(result.status).toBe("incomplete");
    expect(result.groups.map((group) => group.entity)).toEqual(["A", "C"]);
    expect(result.truncated).toEqual(["B"]);
    expect(result.groups.find((group) => group.entity === "A")!.nextCursor).toBe("A-next");
  });

  test("an ineligible session is unavailable without calling the operation", async () => {
    const { result, calls } = run({ groups }, { allowed: false });
    expect(await result).toEqual({ status: "unavailable", groups: [] });
    expect(calls).toEqual([]);
  });

  test("a failing dependency is unavailable and exposes no detail", async () => {
    const result = await run({ groups }, { fail: true }).result;
    expect(result).toEqual({ status: "unavailable", groups: [] });
    expect(JSON.stringify(result)).not.toContain("password");
  });

  test("a malformed canonical response is unavailable", async () => {
    expect((await run("nope").result).status).toBe("unavailable");
  });
});

describe("search dispatch", () => {
  const operation = { id: "application.search", intent: "invoke" };
  const page = { groups: [{ entity: "Team", items: [{ id: "t1", label: "Customer Success" }] }] };
  const records = { query: "Customer Success", entity: "Team" };

  function dispatch(args: Record<string, unknown>, options: { cancelBefore?: boolean; cancelDuring?: boolean; eligible?: boolean } = {}) {
    const controller = new AbortController();
    const session = { tenantId: "tenant-1" };
    const calls: unknown[] = [];
    let snapshots = 0;
    let lookups = 0;
    if (options.cancelBefore) controller.abort();
    const result = staticToolCall({
      name: "search",
      request: { params: { arguments: args } },
      operationToolProjection: { mode: "searchable" },
      searchableOperationToolNames: { search: "search" },
      searchableStaticOperationIds: new Set(["application.search", "Slot.find"]),
      locale,
      session: { roles: [], groups: [] },
      moduleSession: session,
      tables: new Map(),
      signal: controller.signal,
      modulePlatform: {
        listOperationSnapshot: async () => {
          snapshots++;
          return { definitions: [operation, readDefinition], providerIds: new Set() };
        },
        services: { operations: {
          get: async (actual: unknown, id: string) => {
            lookups++;
            expect(actual).toBe(session);
            expect(id).toBe(operation.id);
            return options.eligible === false ? undefined : operation;
          },
          execute: async (actual: unknown, request: unknown) => {
            expect(actual).toBe(session);
            calls.push(request);
            if (options.cancelDuring) controller.abort();
            return { data: page };
          },
        } },
      },
    } as unknown as Parameters<typeof staticToolCall>[0]);
    return { result, calls, counts: () => ({ snapshots, lookups }) };
  }

  test("combines the executable operation and canonical results under the same session", async () => {
    const { result, calls, counts } = dispatch({ query: "find slots", records });
    expect((await result)?.structuredContent).toMatchObject({
      operations: [{ operation: { id: "Slot.find" }, inputSchema: { type: "object", properties: {}, additionalProperties: false } }],
      records: { status: "ok", groups: page.groups },
    });
    expect(calls).toEqual([{ operation, input: { ...records, locale: "en", first: 10 } }]);
    expect(counts()).toEqual({ snapshots: 1, lookups: 0 });
  });

  test("checks record-search eligibility without enumerating the operation catalogue", async () => {
    const { result, calls, counts } = dispatch({ records }, { eligible: false });
    expect((await result)?.structuredContent).toEqual({ operations: [], records: { status: "unavailable", groups: [] } });
    expect(calls).toEqual([]);
    expect(counts()).toEqual({ snapshots: 0, lookups: 1 });
  });

  test("discards the result on cancellation and skips work when already cancelled", async () => {
    for (const options of [{ cancelBefore: true }, { cancelDuring: true }]) {
      const { result, calls } = dispatch({ records }, options);
      const response = await result;
      expect(response?.isError).toBe(true);
      expect(response?.structuredContent).toMatchObject({ error: { code: "REQUEST_CANCELLED" } });
      expect(calls).toHaveLength(options.cancelBefore ? 0 : 1);
    }
  });
});
