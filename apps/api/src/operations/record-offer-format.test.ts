// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { expandCompactRecordOffers, type OperationOffer } from "@openshapeforge/operations";
import { projectRecordOfferFormat } from "../rest/operation-routes.js";

const offers = (id: string): OperationOffer[] => [
  {
    operation: { id: "Relation.delete", intent: "delete" },
    available: true,
    concurrency: { version: { mode: "required", field: "updatedAt" }, editLease: { mode: "required", expiresAfterInactivity: "PT15M" } },
    binding: { target: { entityId: "core.Relation", id, version: "2026-11-20T09:01:47.357078Z" }, input: { id } },
  },
  { operation: { id: "Relation.get", intent: "get" }, available: true },
];
const list = {
  intent: "list",
  data: { items: [{ data: { id: "a" }, operations: offers("a") }, { data: { id: "b" }, operations: offers("b") }], totalCount: 2, nextCursor: null },
  operations: [{ operation: { id: "Relation.create", intent: "create" }, available: true }],
};

test("a compact list page carries the same offers in less space", () => {
  const compact = projectRecordOfferFormat(list as never, "compact") as unknown as { data: Parameters<typeof expandCompactRecordOffers>[0]; operations: unknown };
  expect((compact.data as { offerFormat?: string }).offerFormat).toBe("compact");
  expect(compact.operations).toEqual(list.operations);
  const wire = JSON.parse(JSON.stringify(compact));
  expect(JSON.stringify({ ...wire, data: expandCompactRecordOffers(wire.data) })).toBe(JSON.stringify(list));
  expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(list).length);
});

test("without the option, and for anything but a list page, the answer is unchanged", () => {
  expect(projectRecordOfferFormat(list as never, undefined)).toBe(list as never);
  expect(projectRecordOfferFormat(list as never, "full")).toBe(list as never);
  const failure = { error: { code: "FORBIDDEN", message: "No.", retryable: false } };
  expect(projectRecordOfferFormat(failure, "compact")).toBe(failure);
  const record = { data: { id: "a" }, operations: offers("a") };
  expect(projectRecordOfferFormat(record as never, "compact")).toBe(record as never);
  const odd = { data: { items: [{ id: "a" }] }, operations: [] };
  expect(projectRecordOfferFormat(odd as never, "compact")).toBe(odd as never);
});
