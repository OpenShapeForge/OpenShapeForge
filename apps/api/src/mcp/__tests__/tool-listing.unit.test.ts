// SPDX-License-Identifier: BUSL-1.1
/**
 * The tool listing agrees with what the generic CRUD path can do: an action
 * the collection policy refuses for every caller — deleting an owned child,
 * creating a record that must also write an owned collection — is omitted,
 * not advertised as available. Runs without a database.
 */
import { describe, expect, it } from "bun:test";
import { __crudToolCanSucceedForTests as crudToolCanSucceed } from "../generated-mcp-server.js";

const owner = {
  name: "erp.documents",
  columns: [{ name: "id", type: "uuid" }],
  source: {
    graphql: {
      typeName: "Document",
      relationships: [
        {
          fieldKey: "variants",
          resolve: "hasMany",
          target: "DocumentVariant",
          foreignKey: "document_id",
          ownership: "owned",
        },
      ],
    },
  },
} as never;

const child = {
  name: "erp.document_variants",
  columns: [
    { name: "id", type: "uuid" },
    { name: "document_id", type: "uuid", sourceField: "document" },
  ],
  source: { graphql: { typeName: "DocumentVariant", relationships: [] } },
} as never;

const tables = new Map<string, never>([
  ["erp.documents", owner],
  ["erp.document_variants", child],
]);

const tool = (operation: "list" | "get" | "create" | "update" | "delete", entity: string, table: string) =>
  ({
    name: `${entity}_${operation}`,
    operationId: `${entity}.${operation}`,
    operation,
    entity,
    table,
    description: "",
    inputSchema: {},
    outputSchema: { type: "object" },
    annotations: {},
  }) as never;

describe("crudToolCanSucceed", () => {
  it("omits the delete of an owned child, which the generic path always refuses", () => {
    expect(crudToolCanSucceed(tool("delete", "DocumentVariant", "erp.document_variants"), tables)).toBe(false);
  });

  it("keeps the owner's delete: refusing while children exist is a row-level check", () => {
    expect(crudToolCanSucceed(tool("delete", "Document", "erp.documents"), tables)).toBe(true);
  });

  it("keeps reads and updates of the child; update drops the collection fields from its schema instead", () => {
    for (const operation of ["list", "get", "update"] as const) {
      expect(crudToolCanSucceed(tool(operation, "DocumentVariant", "erp.document_variants"), tables)).toBe(true);
    }
  });

  it("omits the create of an owner whose owned collection must hold at least one child", () => {
    const parent = {
      ...(owner as Record<string, unknown>),
      source: {
        graphql: {
          typeName: "Document",
          relationships: [
            {
              fieldKey: "variants",
              resolve: "hasMany",
              target: "DocumentVariant",
              foreignKey: "document_id",
              ownership: "owned",
              cardinality: { min: 1 },
            },
          ],
        },
      },
    } as never;
    const strict = new Map<string, never>([["erp.documents", parent], ["erp.document_variants", child]]);
    // Named as an entity the manifest has no plugin-backed create for: a
    // plugin create owns its own contract and is not the generic path.
    expect(crudToolCanSucceed(tool("create", "Folder", "erp.documents"), strict)).toBe(false);
    // Without the lower bound the same create is available.
    expect(crudToolCanSucceed(tool("create", "Folder", "erp.documents"), tables)).toBe(true);
  });

  it("omits the create of a child whose managed owner key is required", () => {
    const strictChild = {
      ...(child as Record<string, unknown>),
      columns: [
        { name: "id", type: "uuid" },
        { name: "document_id", type: "uuid", sourceField: "document", required: true },
      ],
    } as never;
    const strict = new Map<string, never>([["erp.documents", owner], ["erp.document_variants", strictChild]]);
    expect(crudToolCanSucceed(tool("create", "DocumentVariant", "erp.document_variants"), strict)).toBe(false);
    // The optional key of the fixture above leaves the child's create available.
    expect(crudToolCanSucceed(tool("create", "DocumentVariant", "erp.document_variants"), tables)).toBe(true);
  });

  it("omits a tool whose table is missing from the manifest", () => {
    expect(crudToolCanSucceed(tool("delete", "Ghost", "erp.ghosts"), tables)).toBe(false);
  });
});
