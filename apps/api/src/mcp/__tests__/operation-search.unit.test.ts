// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import type { RuntimeOperationDefinition } from "@openshapeforge/plugin-runtime";
import {
  parseOperationExecuteArguments,
  parseOperationSearchArguments,
  searchableOperationTools,
  searchOperationDefinitions,
} from "../operation-search.js";

const locale = {
  tag: "en",
  name: "English",
  englishName: "English",
  source: "user" as const,
};

function definition(
  id: string,
  overrides: Partial<RuntimeOperationDefinition> = {},
): RuntimeOperationDefinition {
  return {
    id,
    intent: "invoke",
    key: id.split(".").at(-1),
    name: { en: `Operation ${id}` },
    description: { en: `Description for ${id}` },
    input: {
      kind: "json-schema",
      schema: {
        type: "object",
        properties: { recordId: { type: "string", format: "uuid" } },
        required: ["recordId"],
        additionalProperties: false,
      },
    },
    output: {
      kind: "json-schema",
      schema: {
        type: "object",
        properties: { accepted: { type: "boolean" } },
        required: ["accepted"],
        additionalProperties: false,
      },
    },
    effects: { data: "read", external: "none" },
    reliability: { idempotency: { mode: "natural" } },
    ...overrides,
  } as RuntimeOperationDefinition;
}

describe("searchable MCP Operations", () => {
  test("advertises bounded search and canonical execution inputs", () => {
    const [search, execute] = searchableOperationTools({
      search: "osf_search_operations",
      execute: "osf_execute_operation",
    });
    expect(search?.inputSchema).toMatchObject({
      properties: { limit: { minimum: 1, maximum: 20 } },
      additionalProperties: false,
    });
    expect(execute?.inputSchema).toMatchObject({
      required: ["operationId", "input"],
      additionalProperties: false,
    });
    expect(execute?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
  });

  test("filters before paging and returns exact canonical schemas", () => {
    const definitions = [
      definition("demo.alpha", {
        concurrency: {
          version: { mode: "required", field: "updatedAt" },
          editLease: { mode: "required", expiresAfterInactivity: "PT7M" },
        },
      }),
      definition("demo.bravo"),
      definition("secret.hidden"),
    ];
    const allowedIds = new Set(["demo.alpha", "demo.bravo"]);
    const first = searchOperationDefinitions({
      definitions,
      allowedIds,
      arguments: { query: "demo", limit: 1 },
      locale,
    });
    expect(first.operations).toHaveLength(1);
    expect(first.operations[0]).toEqual(expect.objectContaining({
      operation: { id: "demo.alpha", intent: "invoke" },
      inputSchema: definitions[0]!.input.schema,
      outputSchema: definitions[0]!.output.schema,
      concurrency: definitions[0]!.concurrency,
    }));
    expect(first.nextCursor).toBe("demo.alpha");

    const second = searchOperationDefinitions({
      definitions,
      allowedIds,
      arguments: { query: "demo", cursor: first.nextCursor, limit: 20 },
      locale,
    });
    expect(second.operations.map((entry) => entry.operation)).toEqual([
      { id: "demo.bravo", intent: "invoke" },
    ]);
    expect(JSON.stringify([...first.operations, ...second.operations]))
      .not.toContain("secret.hidden");
  });

  test("validates generic arguments without accepting identity metadata", () => {
    expect(parseOperationSearchArguments({})).toEqual({ limit: 10 });
    expect(() => parseOperationSearchArguments({ limit: 21 })).toThrow(/limit/i);
    expect(() => parseOperationSearchArguments({ query: 42 })).toThrow(/query/i);
    expect(parseOperationExecuteArguments({
      operationId: "demo.alpha",
      input: {},
      idempotencyKey: "retry-one",
    })).toEqual({
      operationId: "demo.alpha",
      input: {},
      idempotencyKey: "retry-one",
    });
    expect(() => parseOperationExecuteArguments({
      operationId: "demo.alpha",
      input: {},
      tenantId: "tenant-b",
    })).toThrow(/unknown property/i);
  });
});
