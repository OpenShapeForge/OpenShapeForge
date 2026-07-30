// SPDX-License-Identifier: BUSL-1.1
/**
 * DB-free unit tests for the read contract of a data-classified column (#168).
 *
 * Field-level redaction nulls a classified column for a reader without a write
 * grant. Rendering that column non-nullable made the two rules incompatible:
 * the redacted null became "Cannot return null for non-nullable field", which
 * GraphQL propagates to the nearest nullable parent — so a single redacted
 * field nulled the whole row, and inside a non-null connection, the whole page.
 *
 * No shipped entity declares a classification, so asserting against the real
 * generatedEntityTypeDefs would be vacuous. These render synthetic tables
 * through the actual rendering path instead.
 */
import { describe, expect, test } from "bun:test";
import { getGeneratedCrudTables } from "../generated-crud.js";
import { nonNullSuffix, renderTypeDefinition } from "../generated-entity-schema.js";

type GeneratedTable = ReturnType<typeof getGeneratedCrudTables>[number];
type GeneratedColumn = GeneratedTable["columns"][number];

function column(overrides: Partial<GeneratedColumn> & { name: string }): GeneratedColumn {
  return { type: "text", ...overrides } as GeneratedColumn;
}

/** A table shaped like the compiler's output, with only what rendering reads. */
function tableWith(columns: GeneratedColumn[]): GeneratedTable {
  return {
    name: "erp.widgets",
    schema: "erp",
    table: "widgets",
    primaryKey: "id",
    columns,
    source: {
      graphql: {
        typeName: "Widget",
        singleQueryName: "widget",
        listQueryName: "widgets",
        createMutationName: "createWidget",
        updateMutationName: "updateWidget",
        deleteMutationName: "deleteWidget",
        relationships: [],
      },
    },
  } as unknown as GeneratedTable;
}

describe("nonNullSuffix", () => {
  test("marks required and primary-key columns non-null", () => {
    expect(nonNullSuffix(column({ name: "id", primaryKey: true }))).toBe("!");
    expect(nonNullSuffix(column({ name: "title", required: true }))).toBe("!");
  });

  test("leaves an optional column nullable", () => {
    expect(nonNullSuffix(column({ name: "note" }))).toBe("");
  });

  test("a classified column is nullable even when required", () => {
    // The exact case in #168: ContactDetail.value is required: true and its
    // semantic type carries classification.sensitivity: pii.
    expect(
      nonNullSuffix(column({ name: "value", required: true, classification: "pii" })),
    ).toBe("");
    expect(
      nonNullSuffix(column({ name: "bsn", required: true, classification: "bsn" })),
    ).toBe("");
    expect(
      nonNullSuffix(column({ name: "note", required: true, classification: "confidential" })),
    ).toBe("");
  });
});

describe("renderTypeDefinition", () => {
  const sdl = renderTypeDefinition(
    tableWith([
      column({ name: "id", primaryKey: true, type: "uuid" }),
      column({ name: "title", required: true }),
      column({ name: "note" }),
      column({ name: "value", required: true, classification: "pii" }),
    ]),
  );

  test("a required classified column renders nullable", () => {
    expect(sdl).toContain("value: String\n");
    expect(sdl).not.toContain("value: String!");
  });

  test("required and primary-key columns are otherwise unchanged", () => {
    expect(sdl).toContain("id: ID!");
    expect(sdl).toContain("title: String!");
    expect(sdl).toContain("note: String\n");
  });

  test("the write contract still demands the classified field", () => {
    // Nullability is a statement about reads. Create/update inputs are
    // unaffected: the column is still NOT NULL in Postgres, and a writer holds
    // the grant that redaction keys on, so it can supply and read the value.
    expect(sdl).toContain("input CreateWidgetInput");
    expect(sdl.split("input CreateWidgetInput")[1]).toContain("value: String");
  });
});
