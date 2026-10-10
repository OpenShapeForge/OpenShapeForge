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

  test("matches the canonical text in every language behind a replaced one", () => {
    const shown = definition("Relation.create", { name: "Create relation", description: "Creates one relation." });
    const search = (query: string, canonicalText?: Map<string, Pick<RuntimeOperationDefinition, "name" | "description">>) =>
      searchOperationDefinitions({
        definitions: [shown],
        allowedIds: new Set([shown.id]),
        arguments: { query },
        locale,
        ...(canonicalText ? { canonicalText } : {}),
      }).operations;
    const canonical = new Map([[shown.id, {
      name: { en: "Create relation", nl: "Relatie aanmaken" },
      description: { en: "Creates one relation.", nl: "Maakt één relatie aan." },
    }]]);
    expect(search("aanmaken")).toEqual([]);
    const found = search("aanmaken", canonical);
    expect(found).toHaveLength(1);
    // What the result shows stays the replaced, session-language text.
    expect(found[0]!.name).toBe("Create relation");
    expect(found[0]!.description).toBe("Creates one relation.");
  });

  test("matches plurals to singulars without matching short common words", () => {
    const definitions = [
      definition("access.role.assign", { name: { en: "Assign a role" }, description: { en: "Use this to give a user one role." } }),
      definition("notes.list", { name: { en: "List notes" }, description: { en: "Use this to read notes." } }),
    ];
    const ids = (query: string) => searchOperationDefinitions({
      definitions, allowedIds: new Set(definitions.map((d) => d.id)), arguments: { query }, locale,
    }).operations.map((entry) => (entry.operation as { id: string }).id);
    expect(ids("roles")).toEqual(["access.role.assign"]);
    expect(ids("users")).toEqual(["access.role.assign"]);
    // "use" is in both descriptions; a longer query word never shrinks to it.
    expect(ids("useful")).toEqual([]);
    expect(ids("x")).toEqual([]);
  });

  test("never falls back on a shared action verb alone, and pages the fallback by id", () => {
    const definitions = ["a.create", "b.create", "c.create", "payroll.run"].map((id) =>
      definition(id, { name: { en: id.endsWith("create") ? "Create record" : "Run payroll" }, description: { en: "Does it." } }));
    const allowedIds = new Set(definitions.map((d) => d.id));
    const search = (query: string, extra: Record<string, unknown> = {}) => searchOperationDefinitions({
      definitions, allowedIds, arguments: { query, ...extra }, locale,
    });
    expect(search("create invoice").operations).toEqual([]);
    expect(search("create payroll").operations.map((entry) => (entry.operation as { id: string }).id)).toEqual(["payroll.run"]);
    const first = search("record payroll", { limit: 2 });
    const second = search("record payroll", { limit: 2, cursor: first.nextCursor });
    expect([...first.operations, ...second.operations].map((entry) => (entry.operation as { id: string }).id))
      .toEqual(["a.create", "b.create", "c.create", "payroll.run"]);
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

describe("operation search matches the model's own words", () => {
  const all = [
    definition("accounts.invite-member", { name: { en: "Invite employee", nl: "Medewerker uitnodigen" }, description: { en: "Invite a person to this organization.", nl: "Nodig iemand uit voor deze organisatie." } }),
    definition("accounts.list-roles", { name: { en: "List roles", nl: "Rollen tonen" }, description: { en: "List roles within the current organization." } }),
    definition("Relation.create", { name: { en: "Create relation", nl: "Relatie aanmaken" } }),
  ];
  const ids = (query: string, locale_ = locale) =>
    searchOperationDefinitions({ definitions: all, allowedIds: new Set(all.map((d) => d.id)), arguments: { query }, locale: locale_ })
      .operations.map((operation) => (operation.operation as { id: string }).id);

  test("every word may appear anywhere, in any authored language", () => {
    expect(ids("invite employee")).toEqual(["accounts.invite-member"]);
    expect(ids("medewerker uitnodigen", { ...locale, tag: "en" })).toEqual(["accounts.invite-member"]);
    expect(ids("organization invite")).toEqual(["accounts.invite-member"]);
  });

  test("light stemming finds inflected forms", () => {
    expect(ids("invitation")).toEqual(["accounts.invite-member"]);
    expect(ids("uitnodiging")).toEqual(["accounts.invite-member"]);
  });

  test("without a full match, any longer word still finds candidates, in id order", () => {
    expect(ids("invite user with finance viewer role")).toEqual(["accounts.invite-member", "accounts.list-roles"]);
  });

  test("a single unmatched word finds nothing rather than everything", () => {
    expect(ids("payroll")).toEqual([]);
  });
});
