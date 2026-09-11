// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { buildEntityOperations } from "./entity-operations.js";

function relationSource(): Parameters<typeof buildEntityOperations>[0] {
  return {
    entity: { id: "hubble.Relation", name: "Relation" },
    crud: {
      operations: { list: true, get: true, create: true, update: true, delete: false },
    },
    authorization: {
      entitySlug: "relation",
      roles: {
        read: ["Relations.Read"],
        create: ["Relations.Write"],
        update: ["Relations.Write"],
        delete: ["Relations.Delete"],
      },
      compositeRoles: [],
      fieldAuthorizations: [],
      profileAuthorizations: {},
    },
  };
}

describe("canonical entity operations", () => {
  test("compiles identity, fields, rights and interaction once", () => {
    const operations = buildEntityOperations(relationSource());

    expect(Object.keys(operations)).toEqual(["list", "get", "create", "update"]);
    expect(operations.list).toMatchObject({
      id: "Relation.list",
      entityId: "hubble.Relation",
      authorization: { action: "read", roles: ["Relations.Read"] },
      interaction: { confirmation: "none" },
      input: {
        kind: "collection-query",
        entityId: "hubble.Relation",
        filterMode: "declared-fields",
        sortMode: "declared-fields",
        pagination: { kind: "cursor", defaultLimit: 50, maxLimit: 200 },
      },
      output: { kind: "entity-connection", entityId: "hubble.Relation" },
    });
    expect(operations.create?.input).toMatchObject({
      kind: "entity-create",
      entityId: "hubble.Relation",
    });
    expect(operations.update?.input).toMatchObject({
      kind: "entity-update",
      entityId: "hubble.Relation",
      identityField: "id",
    });
    expect(operations.delete).toBeUndefined();
  });
});
