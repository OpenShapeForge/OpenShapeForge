// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { getGeneratedCrudTables } from "./catalog.js";
import {
  entityOperationRef,
  getEntityOperationContracts,
  getEntityOperationOffers,
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

  test("omits unauthorized operations from a request-bound offer", () => {
    const contracts = getEntityOperationContracts().filter(
      (operation) => operation.entityName === "Relation",
    );
    const readRole = contracts.find((operation) => operation.intent === "get")!
      .authorization.roles[0]!;

    expect(
      getEntityOperationOffers(
        "Relation",
        { roles: [readRole] },
        ["get", "update", "delete"],
      ).map((offer) => offer.operation.id),
    ).toEqual(["Relation.get"]);
  });

  test("keeps an authorized temporary refusal visible with retryAt", () => {
    const update = getEntityOperationContracts().find(
      (operation) => operation.id === "Relation.update",
    )!;
    const retryAt = "2026-09-11T15:15:00.000Z";
    expect(
      getEntityOperationOffers(
        "Relation",
        { roles: [update.authorization.roles[0]!] },
        ["update"],
        {
          "Relation.update": {
            code: "LOCKED",
            message: "This relation is currently being edited.",
            detail: "The edit lease expires in 15 minutes.",
            retryable: true,
            retryAt,
          },
        },
      ),
    ).toEqual([
      {
        operation: { id: "Relation.update", intent: "update" },
        available: false,
        error: {
          code: "LOCKED",
          message: "This relation is currently being edited.",
          detail: "The edit lease expires in 15 minutes.",
          retryable: true,
          retryAt,
        },
      },
    ]);
  });
});
