// SPDX-License-Identifier: BUSL-1.1
/**
 * Runtime function-level + field-level authorization (issues #94, #96, #101).
 *
 * Pure-logic tests for the enforcement engine that consumes the compiled
 * per-operation roles and per-column classification now carried in the runtime
 * manifest. No DB — the e2e suite proves the wired resolver path against
 * Postgres; here we lock the fail-closed semantics of the primitives.
 */
import { describe, expect, it } from "bun:test";
import { GraphQLError } from "graphql";
import {
  assertOperationAllowed,
  assertClassifiedQueryFieldsAllowed,
  canReadClassifiedColumns,
  redactRow,
} from "./generated-authz.js";
import type { GeneratedCrudAuthorization } from "./generated-crud.js";

const authorization: GeneratedCrudAuthorization = {
  roles: {
    read: ["Relaties.All.Read", "Relaties.All.ReadWrite"],
    create: ["Relaties.All.ReadWrite"],
    update: ["Relaties.All.ReadWrite"],
    delete: ["Relaties.All.ReadWrite"],
  },
};

const readOnly = { roles: ["Relaties.All.Read"] };
const readWrite = { roles: ["Relaties.All.ReadWrite"] };
const noRoles = { roles: [] as string[] };

function forbiddenCode(fn: () => void): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof GraphQLError) {
      return error.extensions?.code as string | undefined;
    }
    throw error;
  }
  return undefined;
}

describe("assertOperationAllowed — function-level authorization (#94)", () => {
  it("allows read for a read-only role", () => {
    expect(() =>
      assertOperationAllowed(authorization, readOnly, "read", "Relation"),
    ).not.toThrow();
  });

  it("rejects create/update/delete for a read-only role with FORBIDDEN", () => {
    for (const op of ["create", "update", "delete"] as const) {
      expect(forbiddenCode(() => assertOperationAllowed(authorization, readOnly, op, "Relation"))).toBe(
        "FORBIDDEN",
      );
    }
  });

  it("allows every operation for a ReadWrite role", () => {
    for (const op of ["read", "create", "update", "delete"] as const) {
      expect(() =>
        assertOperationAllowed(authorization, readWrite, op, "Relation"),
      ).not.toThrow();
    }
  });

  it("rejects a role-less session on every operation", () => {
    for (const op of ["read", "create", "update", "delete"] as const) {
      expect(forbiddenCode(() => assertOperationAllowed(authorization, noRoles, op, "Relation"))).toBe(
        "FORBIDDEN",
      );
    }
  });

  it("fails closed when the entity carries no authorization metadata", () => {
    expect(forbiddenCode(() => assertOperationAllowed(undefined, readWrite, "read", "Relation"))).toBe(
      "FORBIDDEN",
    );
  });

  it("fails closed on a null session", () => {
    expect(forbiddenCode(() => assertOperationAllowed(authorization, null, "read", "Relation"))).toBe(
      "FORBIDDEN",
    );
  });
});

describe("field-level data protection (#96/#101)", () => {
  const columns = [
    { name: "id" },
    { name: "label" },
    { name: "secret_note", classification: "confidential" as const },
    { name: "personal_email", classification: "pii" as const },
  ];
  const row = {
    id: "abc",
    label: "visible",
    secret_note: "top-secret",
    personal_email: "jane@example.com",
  };

  it("a write grant may read classified columns", () => {
    expect(canReadClassifiedColumns(authorization, readWrite)).toBe(true);
  });

  it("a read-only grant may not read classified columns", () => {
    expect(canReadClassifiedColumns(authorization, readOnly)).toBe(false);
  });

  it("redacts classified columns for a read-only reader, leaving others intact", () => {
    const redacted = redactRow(row, columns, authorization, readOnly);
    expect(redacted.secret_note).toBeNull();
    expect(redacted.personal_email).toBeNull();
    expect(redacted.id).toBe("abc");
    expect(redacted.label).toBe("visible");
    // Original row is untouched (no mutation).
    expect(row.secret_note).toBe("top-secret");
  });

  it("leaves classified columns intact for a write-grant reader", () => {
    const kept = redactRow(row, columns, authorization, readWrite);
    expect(kept.secret_note).toBe("top-secret");
    expect(kept.personal_email).toBe("jane@example.com");
  });

  it("returns the same row object when the entity has no classified columns", () => {
    const plainColumns = [{ name: "id" }, { name: "label" }];
    const result = redactRow(row, plainColumns, authorization, readOnly);
    expect(result).toBe(row);
  });

  describe("query-field protection", () => {
    const queryColumns = [
      { name: "id", sourceField: "id" },
      { name: "public_label", sourceField: "publicLabel" },
      { name: "secret_note", classification: "confidential" as const },
      { name: "personal_email", sourceField: "emailAddress", classification: "pii" as const },
      { name: "is_opted_in", sourceField: "isOptedIn", classification: "pii" as const },
    ];

    const forbiddenQueries = [
      ["a normal classified filter", { emailAddress: "jane@example.com" }, undefined],
      ["a generated FieldIn classified filter", { emailAddressIn: ["jane@example.com"] }, undefined],
      ["a classified sort", undefined, { field: "emailAddress", direction: "asc" }],
      ["a snake-case mapped classified filter", { secretNote: "top-secret" }, undefined],
      ["an In-suffix classified filter", { isOptedInIn: [true] }, undefined],
      ["an In-suffix classified sort", undefined, { field: "isOptedIn", direction: "asc" }],
    ] as const;

    for (const [label, filter, sort] of forbiddenQueries) {
      it(`rejects ${label} for a read-only reader`, () => {
        expect(forbiddenCode(() =>
          assertClassifiedQueryFieldsAllowed(
            queryColumns,
            authorization,
            readOnly,
            "ContactDetail",
            filter,
            sort,
          ),
        )).toBe("FORBIDDEN");
      });
    }

    it("allows classified filters and sorting for a ReadWrite reader", () => {
      expect(() =>
        assertClassifiedQueryFieldsAllowed(
          queryColumns,
          authorization,
          readWrite,
          "ContactDetail",
          { emailAddressIn: ["jane@example.com"] },
          { field: "emailAddress", direction: "desc" },
        ),
      ).not.toThrow();
    });

    it("leaves unknown fields for generated CRUD to reject as BAD_USER_INPUT", () => {
      expect(() =>
        assertClassifiedQueryFieldsAllowed(
          queryColumns,
          authorization,
          readOnly,
          "ContactDetail",
          { unknownField: "value" },
          { field: "unknownSortField", direction: "asc" },
        ),
      ).not.toThrow();
    });

    it("ignores empty classified filters because they add no predicate", () => {
      for (const filter of [
        { emailAddress: null },
        { emailAddress: "" },
        { emailAddressIn: [] },
      ]) {
        expect(() =>
          assertClassifiedQueryFieldsAllowed(
            queryColumns,
            authorization,
            readOnly,
            "ContactDetail",
            filter,
          ),
        ).not.toThrow();
      }
    });
  });
});
