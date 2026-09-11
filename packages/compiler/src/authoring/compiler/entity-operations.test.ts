// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { assertV2Authoring } from "../entity-v2.js";
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
      interaction: { confirmation: { mode: "none" } },
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

  test("uses v2 operation identity and canonical metadata", () => {
    const source = relationSource();
    source.coreEntity = {
      schemaVersion: 2,
      kind: "coreEntity",
      module: "core",
      entity: "Relation",
      title: "Relation",
      language: "en",
      fields: [],
      operations: {
        browse: {
          name: { en: "Browse relations", nl: "Relaties bekijken" },
          description: "Returns relations.",
          implementation: { type: "entity", action: "list" },
          effects: { data: "read", external: "none" },
          reliability: { idempotency: { mode: "natural" } },
          confirmation: { mode: "none" },
        },
      },
      interfaces: { web: { operations: { browse: {} }, views: { collection: { route: "/relations", columns: [{ key: "id" }] } } } },
    };
    source.crud.operations = { list: true, get: false, create: false, update: false, delete: false };

    expect(buildEntityOperations(source).list).toMatchObject({
      id: "Relation.browse",
      key: "browse",
      intent: "list",
      name: { en: "Browse relations", nl: "Relaties bekijken" },
      effects: { data: "read", external: "none" },
      reliability: { idempotency: { mode: "natural" } },
      interaction: { confirmation: { mode: "none" } },
    });
  });

  test("preserves a server-issued version-bound challenge without interface translation", () => {
    const source = relationSource();
    source.coreEntity = {
      schemaVersion: 2,
      kind: "coreEntity",
      module: "core",
      entity: "Relation",
      title: "Relation",
      language: "en",
      fields: [{ key: "displayName", valueType: "string" }],
      operations: {
        remove: {
          name: "Remove relation",
          description: "Permanently removes a relation.",
          implementation: { type: "entity", action: "delete" },
          effects: { data: "delete", external: "none" },
          reliability: { idempotency: { mode: "natural" } },
          confirmation: {
            mode: "challenge",
            challenge: {
              kind: "type-current-field",
              field: "displayName",
              issuedBy: "server",
              bindTo: ["subject", "tenant", "operation", "target.id", "target.version"],
              expiresAfter: "PT5M",
              singleUse: true,
            },
          },
        },
      },
      interfaces: {
        mcp: { operations: { remove: {} } },
        web: {
          operations: { remove: {} },
          views: { collection: { route: "/relations", columns: [{ key: "displayName" }] } },
        },
      },
    };
    source.crud.operations = { list: false, get: false, create: false, update: false, delete: true };

    expect(buildEntityOperations(source).delete?.interaction.confirmation).toEqual(
      source.coreEntity.operations!.remove!.confirmation,
    );
    expect(() => assertV2Authoring(source.coreEntity!, "relation.yaml")).toThrow(
      /runtime enforcement must land/,
    );
  });

  test("reserves keyed idempotency until server-side enforcement exists", () => {
    const source = relationSource();
    source.coreEntity = {
      schemaVersion: 2,
      kind: "coreEntity",
      module: "core",
      entity: "Relation",
      title: "Relation",
      language: "en",
      fields: [],
      operations: {
        create: {
          name: "Create relation",
          description: "Creates a relation.",
          implementation: { type: "entity", action: "create" },
          effects: { data: "write", external: "none" },
          reliability: { idempotency: { mode: "keyed" } },
          confirmation: { mode: "none" },
        },
      },
      interfaces: {
        rest: { operations: { create: {} } },
      },
    };

    expect(() => assertV2Authoring(source.coreEntity!, "relation.yaml")).toThrow(
      /server-side key enforcement must land/,
    );
  });
});
