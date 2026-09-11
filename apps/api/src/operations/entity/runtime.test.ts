// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { getGeneratedCrudTables } from "./catalog.js";
import {
  entityOperationRef,
  getEntityOperationContracts,
  getEntityOperationOffers,
  mutationConcurrencyGuard,
  requireCreateOperationConfirmation,
  requireOperationAcknowledgement,
  restEditLeaseOperationIdsForSession,
  tableForEntityOperation,
} from "./runtime.js";

const relation = getGeneratedCrudTables().find(
  (table) => table.source?.authoringEntityName === "Relation",
)!;

describe("entity operation runtime", () => {
  test("uses stable interface-neutral identities for the operations authored by Relation v2", () => {
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
      interaction: { confirmation: { mode: "none" } },
    });
  });

  test("loads Relation's version, central lease and confirmation requirements", () => {
    expect(
      getEntityOperationContracts().find(({ id }) => id === "Relation.update"),
    ).toMatchObject({
      concurrency: {
        version: { mode: "required", field: "updatedAt" },
        editLease: { mode: "required", expiresAfterInactivity: "PT15M" },
      },
    });
    expect(
      getEntityOperationContracts().find(({ id }) => id === "Relation.delete"),
    ).toMatchObject({
      concurrency: { version: { mode: "required", field: "updatedAt" } },
      interaction: { confirmation: { mode: "challenge" } },
    });
  });

  test("keeps version-only update and delete preconditions independent from leases", () => {
    const contracts = getEntityOperationContracts();
    const expectedVersion = "2026-09-11T15:15:00.000Z";
    for (const intent of ["update", "delete"] as const) {
      const operation = contracts.find(
        (candidate) => candidate.entityName === "Relation" && candidate.intent === intent,
      )!;
      const versionOnly = {
        ...operation,
        concurrency: {
          version: { mode: "required" as const, field: "updatedAt" },
        },
      };
      const guard = mutationConcurrencyGuard(versionOnly, { expectedVersion });
      expect(guard?.operation.id).toBe(versionOnly.id);
      expect(guard?.operation.intent).toBe(intent);
      expect(guard?.expectedVersion).toBe(expectedVersion);
      expect(guard?.leaseToken).toBeUndefined();
      expect(() => mutationConcurrencyGuard(versionOnly, {})).toThrow(
        /requires expectedVersion/,
      );
      for (const invalidVersion of [
        "geen-datum",
        "2026-99-99 99:99:99+00",
        "2026-02-30T12:00:00+00:00",
        "2026-02-29T00:00:00Z",
        "0000-01-01T00:00:00Z",
        "2026-01-01T00:00:00+23:59",
      ]) {
        expect(() =>
          mutationConcurrencyGuard(versionOnly, { expectedVersion: invalidVersion }),
        ).toThrow("The supplied record version is not valid.");
      }
      try {
        mutationConcurrencyGuard(versionOnly, { expectedVersion: "geen-datum" });
      } catch (error) {
        expect(error).toMatchObject({
          operationError: {
            code: "VALIDATION",
            retryable: false,
            violations: [
              {
                field: "expectedVersion",
                code: "INVALID_DATETIME",
              },
            ],
          },
        });
      }
    }
  });

  test("enforces acknowledgement as a lightweight same-request confirmation", () => {
    const update = getEntityOperationContracts().find(
      ({ id }) => id === "Relation.update",
    )!;
    const acknowledged = {
      ...update,
      interaction: { confirmation: { mode: "acknowledgement" as const } },
    };

    expect(() => requireOperationAcknowledgement(acknowledged, {})).toThrow(
      "Confirm Relation.update before continuing.",
    );
    expect(() =>
      requireOperationAcknowledgement(acknowledged, { confirmed: true }),
    ).not.toThrow();
  });

  test("accepts real PostgreSQL-representable version timestamp boundaries", () => {
    const operation = getEntityOperationContracts().find(
      ({ id }) => id === "Relation.update",
    )!;
    for (const expectedVersion of [
      "2024-02-29T00:00:00Z",
      "2026-01-01T00:00:00+15:59",
    ]) {
      expect(
        mutationConcurrencyGuard(operation, {
          expectedVersion,
          leaseToken: "lease",
        })?.expectedVersion,
      ).toBeString();
    }
  });

  test("fails closed when a current-record challenge is placed on create", () => {
    const create = getEntityOperationContracts().find(
      ({ id }) => id === "Relation.create",
    )!;
    const challenged = {
      ...create,
      interaction: {
        confirmation: {
          mode: "challenge" as const,
          challenge: {
            kind: "type-current-field" as const,
            field: "displayName",
            issuedBy: "server" as const,
            bindTo: [
              "subject",
              "tenant",
              "operation",
              "target.id",
              "target.version",
            ] as const,
            expiresAfter: "PT5M",
            singleUse: true as const,
          },
        },
      },
    };

    expect(() => requireCreateOperationConfirmation(challenged, {})).toThrow(
      "A current-record challenge cannot protect a create operation.",
    );
  });

  test("derives REST lease operations from both projection and session roles", () => {
    const update = getEntityOperationContracts().find(
      ({ id }) => id === "Relation.update",
    )!;
    expect(restEditLeaseOperationIdsForSession({ roles: [] })).toEqual([]);
    expect(
      restEditLeaseOperationIdsForSession({
        roles: [update.authorization.roles[0]!],
      }),
    ).toEqual(["Relation.delete", "Relation.update"]);
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
      (operation) => operation.intent === "update",
    )!;
    const retryAt = "2026-09-11T15:15:00.000Z";
    expect(
      getEntityOperationOffers(
        update.entityName,
        { roles: [update.authorization.roles[0]!] },
        ["update"],
        {
          [update.id]: {
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
        operation: { id: update.id, intent: "update" },
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
