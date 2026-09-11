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
      fields: [
        {
          key: "displayName",
          valueType: "string",
          persisted: { column: "display_name", storageClass: "core" },
        },
        {
          key: "updatedAt",
          valueType: "datetime",
          readOnly: true,
          persisted: { column: "updated_at", storageClass: "core" },
        },
      ],
      authorization: {
        roles: {
          read: ["Relations.Read", "Relations.Write"],
          create: ["Relations.Write"],
          update: ["Relations.Write"],
          delete: ["Relations.Write"],
        },
      },
      operations: {
        remove: {
          name: "Remove relation",
          description: "Permanently removes a relation.",
          implementation: { type: "entity", action: "delete" },
          effects: { data: "delete", external: "none" },
          reliability: { idempotency: { mode: "natural" } },
          concurrency: {
            version: { mode: "required", field: "updatedAt" },
          },
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
    expect(buildEntityOperations(source).delete?.concurrency).toEqual({
      version: { mode: "required", field: "updatedAt" },
    });
    expect(() => assertV2Authoring(source.coreEntity!, "relation.yaml")).not.toThrow();
  });

  test("allows bounded challenges for existing update targets only", () => {
    const source = relationSource();
    source.coreEntity = {
      schemaVersion: 2,
      kind: "coreEntity",
      module: "core",
      entity: "Relation",
      title: "Relation",
      language: "en",
      fields: [
        {
          key: "displayName",
          valueType: "string",
          persisted: { column: "display_name", storageClass: "core" },
        },
        {
          key: "updatedAt",
          valueType: "datetime",
          readOnly: true,
          persisted: { column: "updated_at", storageClass: "core" },
        },
      ],
      authorization: {
        roles: {
          read: ["Relations.Read", "Relations.Write"],
          create: ["Relations.Write"],
          update: ["Relations.Write"],
          delete: ["Relations.Write"],
        },
      },
      operations: {
        update: {
          name: "Update relation",
          description: "Updates a relation after a server challenge.",
          implementation: { type: "entity", action: "update" },
          effects: { data: "write", external: "none" },
          reliability: { idempotency: { mode: "none" } },
          concurrency: {
            version: { mode: "required", field: "updatedAt" },
          },
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
      interfaces: { rest: { operations: { update: {} } } },
    };
    source.crud.operations = {
      list: false,
      get: false,
      create: false,
      update: true,
      delete: false,
    };
    const updateConfirmation =
      source.coreEntity.operations!.update!.confirmation;
    if (updateConfirmation.mode !== "challenge") {
      throw new Error("Expected challenge fixture.");
    }

    expect(() => assertV2Authoring(source.coreEntity!, "relation.yaml")).not.toThrow();

    updateConfirmation.challenge.expiresAfter = "PT16M";
    expect(() => assertV2Authoring(source.coreEntity!, "relation.yaml")).toThrow(
      /between PT30S and PT15M/,
    );

    updateConfirmation.challenge.expiresAfter = "P1M";
    expect(() => assertV2Authoring(source.coreEntity!, "relation.yaml")).toThrow(
      /fixed ISO-8601 duration/,
    );

    updateConfirmation.challenge.expiresAfter = "PT5M";
    const displayName = source.coreEntity.fields[0]!;
    displayName.valueType = "object";
    expect(() => assertV2Authoring(source.coreEntity!, "relation.yaml")).toThrow(
      /must be a single scalar field/,
    );

    displayName.valueType = "string";
    displayName.cardinality = "collection";
    expect(() => assertV2Authoring(source.coreEntity!, "relation.yaml")).toThrow(
      /must be a single scalar field/,
    );

    displayName.cardinality = "single";
    source.coreEntity.authorization!.roles.update = ["Relations.UpdateOnly"];
    expect(() => assertV2Authoring(source.coreEntity!, "relation.yaml")).toThrow(
      /operation role\(s\) that cannot read it: "Relations.UpdateOnly"/,
    );

    source.coreEntity.authorization!.roles.read.push("Relations.UpdateOnly");
    displayName.authorization = { roles: { read: ["Relations.Read"] } };
    expect(() => assertV2Authoring(source.coreEntity!, "relation.yaml")).toThrow(
      /operation role\(s\) that cannot read it: "Relations.UpdateOnly"/,
    );

    displayName.authorization.roles.read!.push("Relations.UpdateOnly");
    expect(() => assertV2Authoring(source.coreEntity!, "relation.yaml")).not.toThrow();

    delete displayName.persisted;
    expect(() => assertV2Authoring(source.coreEntity!, "relation.yaml")).toThrow(
      /challenge field "displayName" must resolve to a persisted runtime column/,
    );
    displayName.persisted = { column: "display_name", storageClass: "core" };

    delete source.coreEntity.operations!.update!.concurrency;
    source.coreEntity.operations!.update!.implementation.action = "create";
    expect(() => assertV2Authoring(source.coreEntity!, "relation.yaml")).toThrow(
      /challenges require an existing target/,
    );
  });

  test("rejects mutation controls on reads and version concurrency on create", () => {
    const source = relationSource();
    source.coreEntity = {
      schemaVersion: 2,
      kind: "coreEntity",
      module: "core",
      entity: "Relation",
      title: "Relation",
      language: "en",
      fields: [
        {
          key: "updatedAt",
          valueType: "datetime",
          readOnly: true,
          persisted: { column: "updated_at", storageClass: "core" },
        },
      ],
      operations: {
        list: {
          name: "List relations",
          description: "Lists relations.",
          implementation: { type: "entity", action: "list" },
          effects: { data: "read", external: "none" },
          reliability: { idempotency: { mode: "natural" } },
          confirmation: { mode: "acknowledgement" },
        },
      },
      interfaces: { rest: { operations: { list: {} } } },
    };
    source.crud.operations = {
      list: true,
      get: false,
      create: false,
      update: false,
      delete: false,
    };

    expect(() => assertV2Authoring(source.coreEntity!, "relation.yaml")).toThrow(
      /read operations cannot require mutation controls/,
    );

    source.coreEntity.operations = {
      create: {
        name: "Create relation",
        description: "Creates a relation.",
        implementation: { type: "entity", action: "create" },
        effects: { data: "write", external: "none" },
        reliability: { idempotency: { mode: "none" } },
        concurrency: { version: { mode: "required", field: "updatedAt" } },
        confirmation: { mode: "none" },
      },
    };
    source.coreEntity.interfaces = { rest: { operations: { create: {} } } };
    expect(() => assertV2Authoring(source.coreEntity!, "relation.yaml")).toThrow(
      /version concurrency is allowed only on update or delete/,
    );

    delete source.coreEntity.operations.create!.concurrency;
    source.coreEntity.operations.create!.confirmation = {
      mode: "acknowledgement",
    };
    expect(() => assertV2Authoring(source.coreEntity!, "relation.yaml")).not.toThrow();
  });

  test("reserves canonical mutation-control names from v2 entity fields", () => {
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
        list: {
          name: "List relations",
          description: "Lists relations.",
          implementation: { type: "entity", action: "list" },
          effects: { data: "read", external: "none" },
          reliability: { idempotency: { mode: "natural" } },
          confirmation: { mode: "none" },
        },
      },
      interfaces: { rest: { operations: { list: {} } } },
    };

    for (const key of [
      "expectedVersion",
      "leaseToken",
      "confirmed",
      "confirmationToken",
      "confirmationAnswer",
    ]) {
      source.coreEntity.fields = [{ key, valueType: "string" }];
      expect(() => assertV2Authoring(source.coreEntity!, "relation.yaml")).toThrow(
        new RegExp(`field "${key}" uses a reserved platform mutation-control name`),
      );
    }
  });

  test("fails closed for every v2 GraphQL projection until it is canonical", () => {
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
        list: {
          name: "List relations",
          description: "Lists relations.",
          implementation: { type: "entity", action: "list" },
          effects: { data: "read", external: "none" },
          reliability: { idempotency: { mode: "natural" } },
          confirmation: { mode: "none" },
        },
      },
      interfaces: { graphql: { operations: { list: {} } } },
    };
    source.crud.operations = {
      list: true,
      get: false,
      create: false,
      update: false,
      delete: false,
    };

    expect(() => assertV2Authoring(source.coreEntity!, "relation.yaml")).toThrow(
      /GraphQL adapter still exposes legacy direct CRUD and non-canonical response envelopes/,
    );

    source.coreEntity.schemaVersion = 1;
    expect(() => assertV2Authoring(source.coreEntity!, "relation.yaml")).not.toThrow();

    source.coreEntity.schemaVersion = 2;
    source.coreEntity.interfaces = { rest: { operations: { list: {} } } };
    expect(() => assertV2Authoring(source.coreEntity!, "relation.yaml")).not.toThrow();
  });

  test("validates version fields and edit-lease dependencies before compilation", () => {
    const source = relationSource();
    source.coreEntity = {
      schemaVersion: 2,
      kind: "coreEntity",
      module: "core",
      entity: "Relation",
      title: "Relation",
      language: "en",
      fields: [
        {
          key: "updatedAt",
          valueType: "datetime",
          readOnly: true,
          persisted: { column: "updated_at", storageClass: "core" },
        },
      ],
      operations: {
        update: {
          name: "Update relation",
          description: "Updates a relation.",
          implementation: { type: "entity", action: "update" },
          effects: { data: "write", external: "none" },
          reliability: { idempotency: { mode: "none" } },
          concurrency: {
            version: { mode: "required", field: "updatedAt" },
            editLease: { mode: "required", expiresAfterInactivity: "PT15M" },
          },
          confirmation: { mode: "none" },
        },
      },
      interfaces: { rest: { operations: { update: {} } } },
    };
    source.crud.operations = {
      list: false,
      get: false,
      create: false,
      update: true,
      delete: false,
    };

    expect(() => assertV2Authoring(source.coreEntity!, "relation.yaml")).not.toThrow();
    expect(buildEntityOperations(source).update?.concurrency).toEqual({
      version: { mode: "required", field: "updatedAt" },
      editLease: { mode: "required", expiresAfterInactivity: "PT15M" },
    });

    source.coreEntity.operations!.update!.concurrency = {
      editLease: { mode: "required", expiresAfterInactivity: "PT15M" },
    };
    expect(() => assertV2Authoring(source.coreEntity!, "relation.yaml")).toThrow(
      /editLease without required version concurrency/,
    );

    source.coreEntity.operations!.update!.concurrency = {
      version: { mode: "required", field: "updatedAt" },
    };
    source.coreEntity.fields[0]!.readOnly = false;
    expect(() => assertV2Authoring(source.coreEntity!, "relation.yaml")).toThrow(
      /must be a readOnly datetime field/,
    );

    source.coreEntity.fields[0]!.readOnly = true;
    delete source.coreEntity.fields[0]!.persisted;
    expect(() => assertV2Authoring(source.coreEntity!, "relation.yaml")).toThrow(
      /version field "updatedAt".*persisted runtime column/,
    );
    source.coreEntity.fields[0]!.persisted = {
      column: "updated_at",
      storageClass: "core",
    };

    source.coreEntity.operations!.update!.implementation.action = "create";
    source.coreEntity.operations!.update!.concurrency = {
      version: { mode: "required", field: "updatedAt" },
      editLease: { mode: "required", expiresAfterInactivity: "PT15M" },
    };
    expect(() => assertV2Authoring(source.coreEntity!, "relation.yaml")).toThrow(
      /version concurrency is allowed only on update or delete/,
    );

    source.coreEntity.operations!.update!.implementation.action = "update";
    source.coreEntity.operations!.update!.concurrency = {
      version: { mode: "required", field: "updatedAt" },
      editLease: { mode: "required", expiresAfterInactivity: "P1M" },
    };
    expect(() => assertV2Authoring(source.coreEntity!, "relation.yaml")).toThrow(
      /fixed ISO-8601 duration between PT30S and P1D/,
    );

    source.coreEntity.operations!.update!.concurrency.editLease!.expiresAfterInactivity =
      "PT5S";
    expect(() => assertV2Authoring(source.coreEntity!, "relation.yaml")).toThrow(
      /fixed ISO-8601 duration between PT30S and P1D/,
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
