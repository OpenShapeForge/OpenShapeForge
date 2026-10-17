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

  test("never falls back on a shared action verb alone, and pages the fallback by rank then id", () => {
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

  test("filters before paging; a multi-hit set pages summaries even at limit 1, an exact id answers its contract", () => {
    const definitions = [
      definition("demo.alpha", {
        concurrency: {
          version: { mode: "required", field: "updatedAt" },
          editLease: { mode: "required", expiresAfterInactivity: "PT7M" },
        },
        errors: [{ status: 409, code: "CONFLICT", description: "Already running." }],
        effects: { data: "write", external: "none" },
      }),
      definition("demo.bravo"),
      definition("secret.hidden"),
    ];
    const allowedIds = new Set(["demo.alpha", "demo.bravo"]);
    const search = (args: Record<string, unknown>) =>
      searchOperationDefinitions({ definitions, allowedIds, arguments: args, locale });
    const first = search({ query: "demo", limit: 1 });
    expect(first.operations).toHaveLength(1);
    expect(first.operations[0]).toEqual({
      operation: { id: "demo.alpha", intent: "invoke" },
      key: "alpha",
      name: "Operation demo.alpha",
      description: "Description for demo.alpha",
      effects: { data: "write", external: "none" },
      reliability: { idempotency: { mode: "natural" } },
    });
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = search({ query: "demo", cursor: first.nextCursor, limit: 20 });
    expect(second.operations.map((entry) => entry.operation)).toEqual([{ id: "demo.bravo", intent: "invoke" }]);
    expect(second.nextCursor).toBeUndefined();
    expect(JSON.stringify([...first.operations, ...second.operations])).not.toContain("secret.hidden");

    const exact = search({ query: "demo.alpha" });
    expect(exact).toEqual({ operations: [expect.objectContaining({
      operation: { id: "demo.alpha", intent: "invoke" },
      inputSchema: definitions[0]!.input.schema,
      outputSchema: definitions[0]!.output.schema,
      concurrency: definitions[0]!.concurrency,
      errors: [{ status: 409, code: "CONFLICT", description: "Already running." }],
      effects: { data: "write", external: "none" },
    })] });
    // An exact-looking id this session cannot use answers nothing about it.
    expect(search({ query: "secret.hidden" })).toEqual({ operations: [] });
  });

  test("an exact id wins over everything it resembles", () => {
    const definitions = ["Block.update", "Template.get", "Template.list", "TemplateVersion.get"].map((id) =>
      definition(id, { name: { en: `Template ${id}` } }));
    const found = searchOperationDefinitions({
      definitions, allowedIds: new Set(definitions.map((d) => d.id)), arguments: { query: "Template.get" }, locale,
    }).operations;
    expect(found.map((entry) => (entry.operation as { id: string }).id)).toEqual(["Template.get"]);
    expect(found[0]).toHaveProperty("inputSchema");
  });

  test("a generated name resolves only to an available id, and a shared or unknown name to none", () => {
    const definitions = [definition("Relation.list", { name: { en: "List relations" } }), definition("Relation.get"), definition("Hidden.list")];
    const allowedIds = new Set(["Relation.list", "Relation.get"]);
    const names = new Map([["relation_list", "Relation.list"], ["hidden_list", "Hidden.list"]]);
    const search = (query: string) => searchOperationDefinitions({
      definitions, allowedIds, arguments: { query }, locale, resolveName: (name) => names.get(name),
    });
    const generated = search("relation_list").operations;
    expect(generated.map((entry) => (entry.operation as { id: string }).id)).toEqual(["Relation.list"]);
    expect(generated[0]).toHaveProperty("inputSchema");
    expect(JSON.stringify(search("hidden_list"))).not.toContain("Hidden");
    expect(search("osf_list").operations).toEqual([]);
  });

  test("an identity is looked up, never searched: an unavailable one answers nothing, not its neighbour", () => {
    const definitions = ["Template.get", "TemplateVersion.get", "TemplateVersion.list", "workflow.instance.start"].map((id) =>
      definition(id, { name: { en: `Read ${id}` } }));
    // Template.get exists in the catalogue but this session may not use it.
    const allowedIds = new Set(["TemplateVersion.get", "TemplateVersion.list", "workflow.instance.start"]);
    const names = new Map([["template_get", "Template.get"], ["template_version_get", "TemplateVersion.get"]]);
    const search = (query: string, extra: Record<string, unknown> = {}) => searchOperationDefinitions({
      definitions, allowedIds, arguments: { query, ...extra }, locale, resolveName: (name) => names.get(name),
    });
    const ids = (query: string) => search(query).operations.map((entry) => (entry.operation as { id: string }).id);
    expect(search("Template.get")).toEqual({ operations: [] });
    expect(search("template_get")).toEqual({ operations: [] });
    expect(search("Template.missing")).toEqual({ operations: [] });
    expect(search("no_such_tool")).toEqual({ operations: [] });
    expect(search("workflow.instance")).toEqual({ operations: [] });
    expect(ids("template_version_get")).toEqual(["TemplateVersion.get"]);
    expect(ids("templateversion.get")).toEqual(["TemplateVersion.get"]);
    expect(search("TemplateVersion.get").operations[0]).toHaveProperty("inputSchema");
    expect(() => search("TemplateVersion.get", { cursor: "x" })).toThrow(/cursor is invalid/i);
    // Words remain words: a space or a trailing separator searches.
    expect(ids("template get")).toEqual(["TemplateVersion.get"]);
    expect(ids("workflow.instance.")).toEqual(["workflow.instance.start"]);
  });

  test("ranks naming over description and splits camel case", () => {
    const definitions = [
      definition("Adapter.publish", { name: { en: "Publish adapter" }, description: { en: "Publishes article content of an adapter." } }),
      definition("KnowledgeItem.list", { name: { en: "List knowledge items" }, description: { en: "Returns article subjects; content lives in documents." } }),
      definition("Template.list", { name: { en: "List templates" } }),
      definition("TemplateVariant.list", { name: { en: "List template variants" } }),
    ];
    const ids = (query: string) => searchOperationDefinitions({
      definitions, allowedIds: new Set(definitions.map((d) => d.id)), arguments: { query }, locale,
    }).operations.map((entry) => (entry.operation as { id: string }).id);
    expect(ids("knowledge article content")[0]).toBe("KnowledgeItem.list");
    expect(ids("TemplateVariant")).toEqual(["TemplateVariant.list"]);
    expect(ids("template variant")).toEqual(["TemplateVariant.list"]);
    expect(ids("template")).toEqual(["Template.list", "TemplateVariant.list"]);
  });

  test("a query that is exactly an entity's name ranks that entity first", () => {
    const definitions = ["CaseStepTemplate.get", "CaseTemplate.get", "Template.get", "Template.list", "TemplateVariant.get"].map((id) =>
      definition(id, { entityName: id.split(".")[0]!, name: { en: id.split(".")[1]! } }));
    const ids = (query: string) => searchOperationDefinitions({
      definitions, allowedIds: new Set(definitions.map((d) => d.id)), arguments: { query }, locale,
    }).operations.map((entry) => (entry.operation as { id: string }).id);
    expect(ids("Template")).toEqual(["Template.get", "Template.list", "CaseStepTemplate.get", "CaseTemplate.get", "TemplateVariant.get"]);
    expect(ids("TemplateVariant")[0]).toBe("TemplateVariant.get");
  });

  test("an entity's authored label in any language finds its Operations", () => {
    const definitions = [definition("KnowledgeItem.list", { entityName: "KnowledgeItem", name: { en: "list", nl: "Tonen" } }), definition("Relation.list", { entityName: "Relation" })];
    const search = (query: string, labels?: Map<string, Record<string, string>>) => searchOperationDefinitions({
      definitions, allowedIds: new Set(definitions.map((d) => d.id)), arguments: { query }, locale,
      ...(labels ? { entityLabels: labels } : {}),
    }).operations.map((entry) => (entry.operation as { id: string }).id);
    expect(search("kennis")).toEqual([]);
    expect(search("kennis", new Map([["KnowledgeItem", { en: "Knowledge item", nl: "Kennisitem" }]]))).toEqual(["KnowledgeItem.list"]);
  });

  test("cursors are bound to their query and refuse tampering", () => {
    const definitions = ["demo.a", "demo.b", "demo.c"].map((id) => definition(id));
    const search = (args: Record<string, unknown>) => searchOperationDefinitions({
      definitions, allowedIds: new Set(definitions.map((d) => d.id)), arguments: args, locale,
    });
    const first = search({ query: "demo", limit: 1 });
    expect(() => search({ query: "operation", cursor: first.nextCursor })).toThrow(/different query/i);
    expect(() => search({ query: "demo", cursor: "demo.a" })).toThrow(/cursor is invalid/i);
    const forged = Buffer.from(JSON.stringify({ v: 1, q: "x", s: -1, id: "demo.a" })).toString("base64url");
    expect(() => search({ query: "demo", cursor: forged })).toThrow(/cursor is invalid/i);
    // The same words in another spelling are the same query.
    expect(search({ query: "Demo", cursor: first.nextCursor }).operations).toHaveLength(2);
  });

  test("a ranked walk with ties reaches every match once, in rank then id order", () => {
    const definitions = Array.from({ length: 37 }, (_, index) => definition(`area${index % 3}.op${String(index).padStart(2, "0")}`, {
      name: { en: index % 4 === 0 ? "Invoice reminder" : "Send reminder" },
      description: { en: index % 5 === 0 ? "About an invoice." : "Something else." },
    }));
    const allowedIds = new Set(definitions.map((d) => d.id));
    for (const limit of [1, 4, 20]) {
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = searchOperationDefinitions({ definitions, allowedIds, arguments: { query: "invoice reminder", limit, ...(cursor ? { cursor } : {}) }, locale });
        seen.push(...page.operations.map((entry) => (entry.operation as { id: string }).id));
        cursor = page.nextCursor;
      } while (cursor);
      // "reminder" names all 37; "invoice" names some and describes others, so
      // the any-word tier is not used and nothing without invoice is listed.
      const expected = definitions
        .map((d, index) => ({ id: d.id, score: 4 + (index % 4 === 0 ? 4 : index % 5 === 0 ? 2 : 0) }))
        .filter(({ score }) => score > 4)
        .sort((left, right) => right.score - left.score || (left.id < right.id ? -1 : 1))
        .map(({ id }) => id);
      expect(seen).toEqual(expected);
    }
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

  test("without a full match, any longer word still finds candidates, best fit first", () => {
    expect(ids("invite user with finance viewer role")).toEqual(["accounts.invite-member", "accounts.list-roles"]);
  });

  test("a single unmatched word finds nothing rather than everything", () => {
    expect(ids("payroll")).toEqual([]);
  });
});
