// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { compactRecordOffers, expandCompactRecordOffers } from "./compact-offers.js";
import type { OperationError, OperationOffer } from "./contract.js";

const concurrency = {
  version: { mode: "required", field: "updatedAt" },
  editLease: { mode: "required", expiresAfterInactivity: "PT15M" },
} as const;
const write = (intent: "update" | "delete", id: string, version?: string): OperationOffer => ({
  operation: { id: `Deal.${intent}`, intent },
  available: true,
  concurrency,
  binding: { target: { entityId: "cpq.Deal", id, ...(version ? { version } : {}) }, input: { id } },
});
const get: OperationOffer = { operation: { id: "Deal.get", intent: "get" }, available: true };
const action = (id: string, stage: unknown, version?: string): OperationOffer => ({
  operation: { id: "cpq.dealAdvance", intent: "invoke" },
  available: true,
  binding: { target: { entityId: "cpq.Deal", id, ...(version ? { version } : {}) }, input: { dealId: id, stage } },
});
const locked = (operationId: string, intent: string): OperationOffer => ({
  operation: { id: operationId, intent },
  available: false,
  error: { code: "LOCKED", message: "Being edited by someone else.", retryable: true, retryAt: "2026-11-20T10:00:00.000Z" },
});

const page = {
  items: [
    { data: { id: "a", name: "A" }, operations: [write("delete", "a", "v1"), get, write("update", "a", "v1"), action("a", "won", "v1")] },
    { data: { id: "b", name: "B" }, operations: [write("delete", "b"), get, locked("Deal.update", "update"), action("b", null)] },
    { data: { id: "c", name: "C" }, operations: [locked("Deal.delete", "delete"), get] },
    { data: { id: "d", name: "D" }, operations: [] },
  ],
  totalCount: 4,
  nextCursor: null,
};

test("a compact page expands to exactly the offers it was made from", () => {
  const compact = compactRecordOffers(page.items);
  const wire = { ...page, items: compact.items, offerFormat: "compact" as const, offerTemplates: compact.offerTemplates };
  // The wire form is what a client parses; expansion must not depend on shared references.
  const expanded = expandCompactRecordOffers(JSON.parse(JSON.stringify(wire)));
  expect(JSON.stringify(expanded)).toBe(JSON.stringify(page));
  expect(compact.items[0]).toEqual({
    data: { id: "a", name: "A" },
    target: { id: "a", version: "v1" },
    offers: [{ id: "Deal.delete" }, { id: "Deal.get" }, { id: "Deal.update" }, { id: "cpq.dealAdvance", input: { stage: "won" } }],
  });
  expect(compact.items[2]).toEqual({ data: { id: "c", name: "C" }, offers: [{ id: "Deal.delete", error: (locked("Deal.delete", "delete") as { error: OperationError }).error }, { id: "Deal.get" }] });
  expect(compact.offerTemplates.find((template) => template.operation.id === "Deal.update")).toEqual({
    operation: { id: "Deal.update", intent: "update" },
    concurrency,
    binding: { entityId: "cpq.Deal", idInput: "id" },
  });
  expect(JSON.stringify(wire).length).toBeLessThan(JSON.stringify(page).length);
});

test("an offer its template cannot express travels whole and still round-trips", () => {
  const odd: OperationOffer[] = [
    // An interaction is per offer.
    { operation: { id: "Deal.configure", intent: "invoke" }, available: true, interaction: { kind: "userInput", offerId: "o1", expiresAt: "2026-11-20T10:00:00Z", bindTo: { operation: { id: "Deal.configure", intent: "invoke" } } as never, choices: [] } },
    // An input-only binding names no record.
    { operation: { id: "Deal.import", intent: "invoke" }, available: true, binding: { input: { source: "csv" } } },
    // Bound to a record other than the row's.
    { operation: { id: "Deal.merge", intent: "invoke" }, available: true, binding: { target: { entityId: "cpq.Deal", id: "x" }, input: { dealId: "x" } } },
    { operation: { id: "Deal.split", intent: "invoke" }, available: true, binding: { target: { entityId: "cpq.Deal", id: "y" }, input: { dealId: "y" } } },
  ];
  const items = [
    { data: { id: "a" }, operations: [write("update", "a"), ...odd] },
    // The same Operation with other controls than its template.
    { data: { id: "b" }, operations: [{ ...write("update", "b"), concurrency: { version: { mode: "required", field: "revision" } } } as unknown as OperationOffer] },
  ];
  const compact = compactRecordOffers(items);
  const expanded = expandCompactRecordOffers({ items: compact.items, offerFormat: "compact", offerTemplates: compact.offerTemplates });
  expect(JSON.stringify(expanded.items)).toBe(JSON.stringify(items));
  expect(compact.items[0]!.offers.slice(1).every((entry) => "offer" in entry)).toBe(true);
  expect("offer" in compact.items[1]!.offers[0]!).toBe(true);
});

test("a default page passes through unchanged", () => {
  expect(expandCompactRecordOffers(page)).toBe(page);
});
