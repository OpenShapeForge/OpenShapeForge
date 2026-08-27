// SPDX-License-Identifier: BUSL-1.1
/**
 * DB-free unit tests for the writability rule every transport shares (#177).
 *
 * An authored `immutable: true` field reaches the runtime on its manifest
 * column, the way `classification` does. `isWritableColumn` is the one place
 * that reads it, so REST body validation, the GraphQL input types, the OpenAPI
 * bodies and the MCP tool schemas cannot disagree about whether a field can be
 * written — that disagreement was the bug.
 *
 * The shipped manifest has exactly one immutable column
 * (`erp.payment_details.relation_id`), so the negative cases render synthetic
 * tables through the actual rendering path rather than asserting vacuously.
 */
import { describe, expect, test } from "bun:test";
import { buildSchema } from "graphql";
import { getGeneratedCrudTables, isWritableColumn } from "../generated-crud.js";
import {
  generatedEntityTypeDefs,
  renderTypeDefinition,
} from "../generated-entity-schema.js";

type GeneratedTable = ReturnType<typeof getGeneratedCrudTables>[number];
type GeneratedColumn = GeneratedTable["columns"][number];

function column(overrides: Partial<GeneratedColumn> & { name: string }): GeneratedColumn {
  return { type: "text", ...overrides } as GeneratedColumn;
}

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

/** The property names of a rendered `input <name> { ... }` block. */
function inputFields(sdl: string, name: string): string[] {
  const block = new RegExp(`input ${name} \\{([^}]*)\\}`).exec(sdl);
  if (!block) throw new Error(`expected input ${name} in rendered SDL`);
  return block[1]!
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes(":"))
    .map((line) => line.split(":")[0]!.trim());
}

describe("isWritableColumn", () => {
  test("server-managed columns are refused at create and at update", () => {
    const managed = [
      column({ name: "id", primaryKey: true, type: "uuid" }),
      column({ name: "seq", generated: "identity", type: "integer" }),
      column({ name: "tenant_id", type: "uuid" }),
      column({ name: "created_at", type: "timestamptz" }),
      column({ name: "updated_at", type: "timestamptz" }),
    ];
    for (const candidate of managed) {
      expect(isWritableColumn(candidate, "create")).toBe(false);
      expect(isWritableColumn(candidate, "update")).toBe(false);
    }
  });

  test("an immutable column is settable at create and refused at update", () => {
    const relationId = column({ name: "relation_id", type: "uuid", immutable: true });
    expect(isWritableColumn(relationId, "create")).toBe(true);
    expect(isWritableColumn(relationId, "update")).toBe(false);
  });

  test("authored readOnly is not a writability input: only the stamped flag is", () => {
    // `readOnly` never reaches the manifest column, so a column without
    // `immutable` is writable in both directions however its field is rendered.
    const displayOnly = column({ name: "display_only" });
    expect(isWritableColumn(displayOnly, "create")).toBe(true);
    expect(isWritableColumn(displayOnly, "update")).toBe(true);
  });
});

describe("the shipped manifest", () => {
  test("carries the authored immutable flag on PaymentDetail.relationId", () => {
    const table = getGeneratedCrudTables().find((entry) => entry.name === "erp.payment_details");
    const relationId = table?.columns.find((entry) => entry.name === "relation_id");

    expect(relationId?.immutable).toBe(true);
    expect(isWritableColumn(relationId!, "create")).toBe(true);
    expect(isWritableColumn(relationId!, "update")).toBe(false);
  });

  test("renders PaymentDetail's shipped SDL with relationId on create only", () => {
    const createInput = /input CreatePaymentDetailInput \{([^}]*)\}/.exec(
      generatedEntityTypeDefs,
    );
    const updateInput = /input UpdatePaymentDetailInput \{([^}]*)\}/.exec(
      generatedEntityTypeDefs,
    );

    expect(createInput?.[1]).toContain("relationId:");
    expect(updateInput?.[1]).not.toContain("relationId:");
  });

  test("leaves every other column writable in both directions", () => {
    for (const table of getGeneratedCrudTables()) {
      for (const candidate of table.columns) {
        if (candidate.immutable) continue;
        expect(isWritableColumn(candidate, "create")).toBe(
          isWritableColumn(candidate, "update"),
        );
      }
    }
  });
});

describe("renderTypeDefinition", () => {
  test("offers an immutable column on create and withholds it on update", () => {
    const sdl = renderTypeDefinition(
      tableWith([
        column({ name: "id", primaryKey: true, type: "uuid" }),
        column({ name: "title", required: true }),
        column({ name: "relation_id", type: "uuid", immutable: true, sourceField: "relationId" }),
      ]),
    );

    expect(inputFields(sdl, "CreateWidgetInput")).toEqual(["title", "relationId"]);
    expect(inputFields(sdl, "UpdateWidgetInput")).toEqual(["id", "title"]);
  });

  test("an entity with no immutable column keeps identical create and update inputs", () => {
    const sdl = renderTypeDefinition(
      tableWith([
        column({ name: "id", primaryKey: true, type: "uuid" }),
        column({ name: "title", required: true }),
        column({ name: "note" }),
      ]),
    );

    expect(inputFields(sdl, "CreateWidgetInput")).toEqual(["title", "note"]);
    // `id` is the update mutation's target, not a writable field.
    expect(inputFields(sdl, "UpdateWidgetInput")).toEqual(["id", "title", "note"]);
  });

  test("keeps filter names unique for real fields ending in In", () => {
    const sdl = renderTypeDefinition(
      tableWith([
        column({ name: "id", primaryKey: true, type: "uuid" }),
        column({ name: "status", sourceField: "status" }),
        column({ name: "status_in", sourceField: "statusIn" }),
        column({ name: "is_opted_in", sourceField: "isOptedIn", type: "boolean" }),
      ]),
    );

    expect(inputFields(sdl, "WidgetFilter")).toEqual([
      "id",
      "idIn",
      "status",
      "statusInIn",
      "isOptedInIn",
    ]);
    expect(() => buildSchema(`
      scalar JSON
      type PageInfo { hasNextPage: Boolean, endCursor: String }
      type AggregateResult { count: Int! }
      ${sdl}
    `)).not.toThrow();
  });

  test("replaces a lone surrogate before rendering an SDL description", () => {
    const documentation = new Map([
      [
        "Widget",
        {
          typeName: "Widget",
          description: "Truncated emoji \ud83d remains readable.",
          fields: [],
        },
      ],
    ]);
    const sdl = renderTypeDefinition(
      tableWith([column({ name: "id", primaryKey: true, type: "uuid" })]),
      documentation,
    );
    const schema = buildSchema(`
      scalar JSON
      type PageInfo { hasNextPage: Boolean, endCursor: String }
      type AggregateResult { count: Int! }
      ${sdl}
    `);

    expect(schema.getType("Widget")?.description).toBe(
      "Truncated emoji \ufffd remains readable.",
    );
  });
});
