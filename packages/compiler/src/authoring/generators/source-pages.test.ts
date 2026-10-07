// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadEntity } from "../loader.js";
import { compile } from "../compiler/index.js";
import { generateViewPages } from "./pages.js";
import type { CompiledEntityContract, ViewDefinition } from "../types.js";

const authoringDir = join(import.meta.dir, "../../../config/authoring");

function account(): CompiledEntityContract {
  return compile(loadEntity(authoringDir, "account"));
}

function pages(contract: CompiledEntityContract) {
  const view: ViewDefinition = {
    schemaVersion: 1,
    kind: "view",
    entity: "account",
    sources: [{ entity: "account" }],
    routes: contract.views.core!.routes,
    presentations: {},
  };
  return generateViewPages(view, contract, [{ key: "core", label: { en: "Core", nl: "Kern" } }]);
}

describe("generated pages for an Operation-backed source", () => {
  test("read through the source's list/get Operation GraphQL fields", () => {
    const result = pages(account());
    const list = result.pageConfigBundle.listConfigs.core as Record<string, unknown>;
    const detail = result.pageConfigBundle.detailConfigs.core as Record<string, any>;
    expect(list.query).toBe("query ListAccount($input: JSON!) { accountList(input: $input) }");
    expect(list.queryName).toBe("accountList");
    expect(list.deleteMutationName).toBeUndefined();
    expect(new Set(Object.values(detail.queriesByGroup))).toEqual(
      new Set(["query GetAccount($input: JSON!) { accountGet(input: $input) }"]),
    );
    expect(detail.queryName).toBe("accountGet");
    expect(detail.deleteMutationName).toBeUndefined();
    expect(result.pageConfigBundle.createFormConfigs).toEqual({});
    expect(result.pageConfigBundle.editFormConfigs).toEqual({});
    expect(result.manifestEntry.readOnly).toBe(true);
  });

  test("emit read-only actions that bind the Operation input and its declared query capabilities", () => {
    const actions = pages(account()).files.get("actions/generated/account.ts")!;
    expect(actions).toContain("export async function getAccount(");
    expect(actions).toContain("export async function listAccounts(");
    expect(actions).toContain("variables: { input: { id } }");
    expect(actions).toContain('const SORT_FIELDS = new Set<string>(["id","label","email","status","issuer","relationId"]);');
    expect(actions).not.toMatch(/createAccount|updateAccount|deleteAccount/);
    // A record outside the caller's organization reads as missing, not as a transport failure.
    expect(actions).toContain('entry.extensions?.code === "NOT_FOUND"');
    expect(actions).toContain("if (isRecordNotFound(error)) return null;");
  });

  test("refuse list presentations the source list Operation cannot answer", () => {
    const unsortable = account();
    unsortable.views.core!.list!.defaultSort = { key: "linkedAt", direction: "desc" };
    expect(() => pages(unsortable)).toThrow('default sort "linkedAt" is not a source query sort field');

    const facet = account();
    facet.views.core!.list!.filterBar = { filters: [{ key: "status", type: "select" }] } as never;
    expect(() => pages(facet)).toThrow('list filter "status" must be a text filter on a source query filter field');

    const unsearchable = account();
    unsearchable.source = { kind: "operations", query: { filterFields: ["email"], sortFields: ["label"] } };
    expect(() => pages(unsearchable)).toThrow('list search field "label" is not a source query filter field');
  });

  test("require the list/get Operations to project to GraphQL", () => {
    const hidden = account();
    hidden.pluginOperations!.find((operation) => operation.key === "get")!.interfaces.graphql = false;
    expect(() => pages(hidden)).toThrow("Account.get: generated web pages read an Operation-backed source over GraphQL");
  });
});
