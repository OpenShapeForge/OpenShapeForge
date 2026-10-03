// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { getGeneratedCrudTables, requireEntityOperation } from "./entity/catalog.js";
import { listReadableEntityTypes } from "./entity-type-list.js";

const table = getGeneratedCrudTables().find((item) => item.source?.authoringEntityName && item.source.authorization?.roles.read.length)!;
const session = { tenantId: "tenant", userId: "user", roles: table.source!.authorization!.roles.read };

test("entity type catalog fails closed without read roles", () => {
  expect(listReadableEntityTypes({ ...session, roles: [] }, {}).items).toEqual([]);
});

test("every returned entity passes the canonical read gate", () => {
  const result = listReadableEntityTypes(session, { first: 100 });
  expect(result.items.length).toBeGreaterThan(0);
  for (const item of result.items) {
    const candidate = getGeneratedCrudTables().find((entry) => entry.source?.authoringEntityName === item.value)!;
    expect(() => requireEntityOperation(candidate, candidate.source?.crud?.operations.list === false ? "get" : "list", session)).not.toThrow();
  }
});

test("search is case insensitive and cursor paging does not duplicate items", () => {
  const all = listReadableEntityTypes(session, { first: 100 });
  const search = listReadableEntityTypes(session, { search: all.items[0]!.label.toUpperCase() });
  expect(search.items.some((item) => item.value === all.items[0]!.value)).toBe(true);
  expect(listReadableEntityTypes(session, { search: "not-an-entity-927349" }).items).toEqual([]);
  const first = listReadableEntityTypes(session, { first: 1 });
  const next = listReadableEntityTypes(session, { first: 100, after: first.pageInfo.endCursor! });
  expect([ ...first.items, ...next.items ]).toEqual(all.items);
});

test("page size is bounded", () => {
  for (const first of [0, 101, -1, 1.5]) expect(() => listReadableEntityTypes(session, { first })).toThrow();
});

test("localized labels are searchable without changing stored entity identity", () => {
  const name = table.source!.authoringEntityName!;
  const result = listReadableEntityTypes(session, { locale: "nl", search: "Voorbeeldkeuze" }, {
    [name]: { en: "Example choice", nl: "Voorbeeldkeuze" },
  });
  expect(result.items).toEqual([{ value: name, label: "Voorbeeldkeuze" }]);
});
