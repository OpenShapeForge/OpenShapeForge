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
        errors: [{ status: 409, code: "CONFLICT", description: "Already running." }],
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
      errors: [{ status: 409, code: "CONFLICT", description: "Already running." }],
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

  /**
   * A catalogue the shape of a real deployment: entity-prefixed ids that start
   * with a capital (`CpqQuoteDocument.approve`, `TemplateVersion.renderSnapshot`),
   * dotted namespaces in lower case (`core.Deal.relationId.create-constrained-reference`,
   * `cpq-catalog.deal.win`), and kebab-case ids (`work-items.list`). ICU
   * collation interleaves the capitalised ids between `core.*` and `cpq.*`;
   * a cursor advanced with `>` over that order looped and reached 70 of 160.
   */
  function deploymentLikeIds(): string[] {
    const ids = [
      "CpqQuoteDocument.approve", "CpqQuoteDocument.publish", "CpqQuoteDocument.revise",
      "CpqQuoteDocument.submit", "DocumentVariant.insertBlock", "DocumentVariant.moveBlock",
      "QuotePricing.materialize", "QuoteScope.materialize", "Template.insertVariant",
      "Template.publish", "TemplateBlock.materialize", "TemplateVersion.createDocument",
      "TemplateVersion.materialize", "TemplateVersion.renderSnapshot", "TextBlock.materialize",
      "core.Deal.relationId.create-constrained-reference", "cpq-catalog.deal.win",
      "cpq-catalog.deal.compose-offer", "cpq-catalog.pricing.maintain",
      "cpq.approval-policy-versions.get", "documents.create", "document-versions.send",
      "work-items.get", "work-items.list", "workflow.definition.archive",
      "workflow.definition.publish", "workflow.instance.start", "entityTypes.list",
      "notifications.markRead", "notifications.summary",
    ];
    for (let index = 0; ids.length < 160; index += 1) {
      const entity = ["Assessment", "Finding", "Relation", "Deal", "Quote"][index % 5]!;
      const namespace = ["core", "cpq-catalog", "documents", "workflow", "approval-requests"][index % 5]!;
      ids.push(index % 2 === 0
        ? `${entity}.operation${index}`
        : `${namespace}.operation-${index}`);
    }
    return ids;
  }

  test("a full walk terminates and reaches every operation at every page size", () => {
    const ids = deploymentLikeIds();
    expect(ids).toHaveLength(160);
    expect(new Set(ids).size).toBe(160);
    const definitions = ids.map((id) => definition(id));
    const allowedIds = new Set(ids);
    for (const limit of [undefined, 1, 7, 10, 20]) {
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = searchOperationDefinitions({
          definitions,
          allowedIds,
          arguments: { ...(cursor ? { cursor } : {}), ...(limit ? { limit } : {}) },
          locale,
        });
        pages += 1;
        expect(pages).toBeLessThanOrEqual(Math.ceil(160 / (limit ?? 10)) + 1);
        seen.push(...page.operations.map((entry) => (entry.operation as { id: string }).id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen).toHaveLength(160);
      expect(new Set(seen).size).toBe(160);
      expect(new Set(seen)).toEqual(new Set(ids));
      // Every page ordered by the same total order the cursor compares with.
      expect(seen).toEqual([...seen].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)));
    }
  });
});
