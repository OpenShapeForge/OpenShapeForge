// SPDX-License-Identifier: BUSL-1.1
/**
 * What the searchable executor hands a model: the same result in the same
 * shape, without what every row repeats. Pure: no server.
 */
import { describe, expect, test } from "bun:test";
import { Ajv } from "ajv";
import { fittingRecordPage, isRecordPage, modelRecord, modelRecordPage, modelSchema, recordFieldSelection, summaryDescription } from "../model-view.js";

const concurrency = { version: { mode: "required", field: "updatedAt" }, editLease: { mode: "required", expiresAfterInactivity: "PT15M" } };
const bound = (id: string, input: Record<string, unknown> = { id }) =>
  ({ target: { entityId: "cpqCatalog.Deal", id, version: "2026-01-01T00:00:00.000Z" }, input });
const offers = (id: string, open = true) => [
  { operation: { id: "Deal.get", intent: "get" }, available: true },
  { operation: { id: "Deal.update", intent: "update" }, available: true, concurrency, binding: bound(id) },
  { operation: { id: "quotes.create", intent: "invoke" }, available: true, binding: bound(id, { dealId: id }) },
  open
    ? { operation: { id: "Deal.lose", intent: "invoke" }, available: true, binding: bound(id) }
    : { operation: { id: "Deal.lose", intent: "invoke" }, available: false,
        error: { code: "INVALID_STATE", message: "Deal is lost.", retryable: false, data: { localized: { nl: "Deal is verloren." } } } },
];
const page = () => ({
  data: {
    items: [
      { data: { id: "a", name: "First", lostReason: null, status: "open" }, operations: offers("a") },
      { data: { id: "b", name: "Second", lostReason: "Price", status: "lost" }, operations: offers("b", false) },
    ],
    totalCount: 2,
    nextCursor: null,
  },
  operations: [{ operation: { id: "Deal.create", intent: "create" }, available: true }],
});

/** The canonical page and offer envelopes, allowing a projected record inside each result. */
const listOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["data", "operations"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: ["items", "totalCount", "nextCursor"],
      properties: {
        items: { type: "array", items: {
          type: "object", additionalProperties: false, required: ["data", "operations"],
          properties: { data: { type: "object", additionalProperties: true }, operations: { type: "array", items: { $ref: "#/$defs/OperationOffer" } } },
        } },
        totalCount: { type: "integer" },
        nextCursor: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
    },
    operations: { type: "array", items: { $ref: "#/$defs/OperationOffer" } },
  },
  $defs: {
    OperationReference: { type: "object", additionalProperties: false, required: ["id", "intent"], properties: { id: { type: "string" }, intent: { type: "string" } } },
    OperationError: { type: "object", additionalProperties: false, required: ["code", "message", "retryable"],
      properties: { code: { type: "string" }, message: { type: "string" }, retryable: { type: "boolean" }, data: { type: "object", additionalProperties: true } } },
    OperationOffer: { oneOf: [
      { type: "object", additionalProperties: false, required: ["operation", "available"],
        properties: { operation: { $ref: "#/$defs/OperationReference" }, available: { const: true }, concurrency: { type: "object" },
          binding: { type: "object", additionalProperties: false, required: ["target", "input"], properties: { target: { type: "object" }, input: { type: "object" } } } } },
      { type: "object", additionalProperties: false, required: ["operation", "available", "error"],
        properties: { operation: { $ref: "#/$defs/OperationReference" }, available: { const: false }, error: { $ref: "#/$defs/OperationError" } } },
    ] },
  },
};

describe("a list page for a model", () => {
  test("keeps on a row the offers that are about that row, and no field without a value", () => {
    const payload = page();
    expect(isRecordPage(payload)).toBe(true);
    const view = modelRecordPage(payload) as { data: Record<string, unknown>; operations: unknown };
    expect(view.data.items).toEqual([
      // Every offer of the open deal is available with nothing but its own id bound in.
      { data: { id: "a", name: "First", status: "open" }, operations: [] },
      // The lost deal says what cannot be done with it, and why, in one language.
      { data: { id: "b", name: "Second", lostReason: "Price", status: "lost" },
        operations: [{ operation: { id: "Deal.lose", intent: "invoke" }, available: false, error: { code: "INVALID_STATE", message: "Deal is lost.", retryable: false } }] },
    ]);
    // The page's own values and the collection offers are untouched.
    expect(view.data.totalCount).toBe(2);
    expect(view.data.nextCursor).toBeNull();
    expect(view.operations).toEqual(payload.operations);
    expect(JSON.stringify(view).length).toBeLessThan(JSON.stringify(payload).length / 2);
  });

  test("keeps the canonical page and offer envelopes when record fields are projected", () => {
    const validate = new Ajv({ strict: false }).compile(listOutputSchema);
    expect(validate(page())).toBe(true);
    expect(validate(modelRecordPage(page()))).toBe(true);
    expect(validate(modelRecordPage(page(), ["status"]))).toBe(true);
  });

  test("returns only the named fields, always with the id", () => {
    const view = modelRecordPage(page(), ["status"]) as { data: { items: unknown[] } };
    expect(view.data.items[0]).toEqual({ data: { id: "a", status: "open" }, operations: [] });
  });

  test("keeps an offer on its row when it binds more than the record's id", () => {
    const payload = page();
    const assign = { operation: { id: "Deal.assign", intent: "invoke" }, available: true, binding: bound("a", { id: "a", stageId: "s" }) };
    payload.data.items[0]!.operations.push(assign as never);
    const view = modelRecordPage(payload) as { data: { items: Array<{ operations: unknown[] }> } };
    expect(view.data.items[0]!.operations).toEqual([assign]);
  });

  test("is not taken for anything but a page of records", () => {
    expect(isRecordPage({ data: { id: "a" }, operations: [] })).toBe(false);
    expect(isRecordPage({ data: { items: ["a"] }, operations: [] })).toBe(false);
  });
});

describe("one record for a model", () => {
  test("keeps every offer and drops the binding that only repeats the record's own id", () => {
    const view = modelRecord({ data: { id: "a", name: "First", lostReason: null }, operations: offers("a") }) as { data: unknown; operations: unknown[] };
    // A single record keeps its empty fields: an update needs to see what exists.
    expect(view.data).toEqual({ id: "a", name: "First", lostReason: null });
    expect(view.operations).toEqual([
      { operation: { id: "Deal.get", intent: "get" }, available: true },
      { operation: { id: "Deal.update", intent: "update" }, available: true, concurrency },
      { operation: { id: "quotes.create", intent: "invoke" }, available: true },
      { operation: { id: "Deal.lose", intent: "invoke" }, available: true },
    ]);
  });

  test("leaves anything that is not a record envelope as it is", () => {
    const other = { data: { accepted: true }, operations: [] };
    expect(modelRecord(other)).toBe(other);
  });
});

describe("a schema and a summary for a model", () => {
  test("keeps what the executor validates and drops what a form needs", () => {
    expect(modelSchema<unknown>({
      type: "object",
      properties: {
        status: { type: "string", title: "Status", enum: ["open", "lost"], description: "Lifecycle status.",
          "x-osf-type": "string", "x-osf-presentation": { component: "Input" }, "x-osf-i18n": { title: { nl: "Status" } } },
      },
      required: ["status"],
    })).toEqual({
      type: "object",
      properties: { status: { type: "string", enum: ["open", "lost"], description: "Lifecycle status." } },
      required: ["status"],
    });
  });

  test("preserves property and definition names and object-valued validation keywords", () => {
    const literal = { title: "literal", "x-osf-value": "required" };
    const schema = {
      type: "object",
      properties: { title: { title: "Title", type: "string" }, payload: { const: literal } },
      required: ["title"],
      $defs: { title: { title: "Title", type: "string" } },
    };
    expect(modelSchema<unknown>(schema)).toEqual({
      ...schema,
      properties: { title: { type: "string" }, payload: { const: literal } },
      $defs: { title: { type: "string" } },
    });
  });

  test("shortens a long description at a sentence, and leaves a short one whole", () => {
    expect(summaryDescription("Returns a page of relations.")).toBe("Returns a page of relations.");
    const long = `${"Composes an offer from the deal. ".repeat(4)}${"It also reads the catalogue and every price rule that applies. ".repeat(6)}`;
    const short = summaryDescription(long);
    expect(short.length).toBeLessThan(260);
    expect(short.endsWith(". …")).toBe(true);
  });
});

describe("a page that stays readable", () => {
  const rows = (count: number) => ({
    data: {
      items: Array.from({ length: count }, (_, index) => ({ data: { id: `r${index}`, name: "x".repeat(80) }, operations: [] })),
      totalCount: 500,
      nextCursor: String(count),
    },
    operations: [],
  });

  test("is answered as it is when it fits", async () => {
    let refetched = false;
    const view = await fittingRecordPage(rows(5), { limit: 10_000, refetch: async () => { refetched = true; return rows(1); } });
    expect(refetched).toBe(false);
    expect((view.data as { items: unknown[] }).items).toHaveLength(5);
  });

  test("is requested again with as many records as fit, and continues from there", async () => {
    const asked: number[] = [];
    const view = await fittingRecordPage(rows(100), { limit: 3_000, refetch: async (first) => { asked.push(first); return rows(first); } });
    const data = view.data as { items: unknown[]; nextCursor: string };
    expect(asked).toHaveLength(1);
    expect(asked[0]).toBeLessThan(100);
    expect(data.items).toHaveLength(asked[0]!);
    // The cursor is the one the smaller request answered with.
    expect(data.nextCursor).toBe(String(asked[0]));
    expect(JSON.stringify(view).length).toBeLessThan(3_000);
  });
});

describe("the field selection of a record read", () => {
  const relation = { fields: ["id", "displayName", "location"], read: true };

  test("is taken from input when a model put it there", () => {
    expect(recordFieldSelection({ input: { filter: { location: "Utrecht" }, fields: ["displayName"] } }, relation))
      .toEqual({ input: { filter: { location: "Utrecht" } }, fields: ["displayName"] });
    // Not on a write, where input is the record's own values.
    expect(recordFieldSelection({ input: { fields: ["displayName"] } }, { ...relation, read: false }))
      .toEqual({ input: { fields: ["displayName"] } });
  });

  test("is not applied when it names a field the record does not have: the records come whole", () => {
    expect(recordFieldSelection({ input: {}, fields: ["location"] }, relation)).toEqual({ input: {}, fields: ["location"] });
    expect(recordFieldSelection({ input: {}, fields: ["name", "location"] }, relation)).toEqual({ input: {} });
    expect(recordFieldSelection({ input: { fields: ["name"] } }, relation)).toEqual({ input: {} });
  });
});
