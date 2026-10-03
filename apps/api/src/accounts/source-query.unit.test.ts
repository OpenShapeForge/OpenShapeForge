// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { sourceQuery } from "./source-query.js";
const fields = ["id", "label", "email", "relationId"];
const id = "11111111-1111-4111-8111-111111111111";
test("query bounds and the identifier whitelist reject unadvertised query powers", () => {
  expect(sourceQuery({}, fields, "tenant", "Account")).toMatchObject({ first: 50, sortField: "label", direction: "asc" });
  for (const input of [{ first: 0 }, { first: 201 }, { first: 1.5 }, { sortField: "label); drop table accounts" }, { tenantId: "other" }, { sortDirection: "sideways" }, { email: 1 }]) {
    expect(() => sourceQuery(input, fields, "tenant", "Account")).toThrow();
  }
});
test("cursors bind to the tenant, entity, filter and ordering, but not page size", () => {
  const query = sourceQuery({ email: "test" }, fields, "one", "Account");
  const after = Buffer.from(JSON.stringify({ scope: query.scope, value: "last name", id })).toString("base64url");
  expect(sourceQuery({ email: "test", after, first: 100 }, fields, "one", "Account").cursor!.id).toBe(id);
  for (const [input, tenant, entity] of [[{ email: "test", after }, "two", "Account"], [{ email: "changed", after }, "one", "Account"], [{ email: "test", after, sortDirection: "desc" }, "one", "Account"], [{ email: "test", after }, "one", "Invitation"]] as const) {
    expect(() => sourceQuery(input, fields, tenant, entity)).toThrow("cursor does not match");
  }
});
