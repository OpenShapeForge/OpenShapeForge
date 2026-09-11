// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { getGeneratedCrudTables } from "./catalog.js";
import {
  entityOperationRef,
  getEntityOperationContracts,
  tableForEntityOperation,
} from "./runtime.js";

const relation = getGeneratedCrudTables().find(
  (table) => table.source?.authoringEntityName === "Relation",
)!;

describe("entity operation runtime", () => {
  test("uses stable interface-neutral operation identities", () => {
    expect(entityOperationRef(relation, "list")).toEqual({
      id: "Relation.list",
      intent: "list",
    });
    expect(entityOperationRef(relation, "get")).toEqual({
      id: "Relation.get",
      intent: "get",
    });
    expect(entityOperationRef(relation, "create")).toEqual({
      id: "Relation.create",
      intent: "create",
    });
    expect(entityOperationRef(relation, "update")).toEqual({
      id: "Relation.update",
      intent: "update",
    });
    expect(entityOperationRef(relation, "delete")).toEqual({
      id: "Relation.delete",
      intent: "delete",
    });
  });

  test("resolves an operation to its generated entity contract", () => {
    expect(tableForEntityOperation({ id: "Relation.list", intent: "list" })).toBe(relation);
  });

  test("loads rights, input, output and interaction from the generated catalog", () => {
    expect(
      getEntityOperationContracts().find(({ id }) => id === "Relation.list"),
    ).toMatchObject({
      entityName: "Relation",
      authorization: { action: "read" },
      input: { kind: "collection-query" },
      output: { kind: "entity-connection" },
      interaction: { confirmation: "none" },
    });
  });

  test("rejects mismatched and unavailable operation identities", () => {
    expect(() =>
      tableForEntityOperation({ id: "Relation.get", intent: "list" }),
    ).toThrow(/does not match intent/);
    expect(() =>
      tableForEntityOperation({ id: "MissingEntity.list", intent: "list" }),
    ).toThrow(/is not available/);
  });
});
