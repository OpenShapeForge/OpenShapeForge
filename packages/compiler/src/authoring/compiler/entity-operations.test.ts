// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { assertV2Authoring, v2GraphqlOperationActions } from "../entity-v2.js";
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

  test("projects action-specific record permissions from one entity policy", () => {
    const source = relationSource();
    source.crud.operations.delete = true;
    source.authorization.rowAccess = {
      enabled: true,
      empty: "public",
      recordPermissions: {
        field: "authorization",
        column: "authorization",
        empty: "public",
        createRequires: ["view", "edit"],
        defaultValue: {},
      },
    };

    const operations = buildEntityOperations(source);
    expect(operations.list?.authorization.recordPermissions).toEqual(["view"]);
    expect(operations.get?.authorization.recordPermissions).toEqual(["view"]);
    expect(operations.create?.authorization.recordPermissions).toEqual(["view", "edit"]);
    expect(operations.update?.authorization.recordPermissions).toEqual(["edit"]);
    expect(operations.delete?.authorization.recordPermissions).toEqual(["delete"]);
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

  test("compiles secure input once on the canonical create Operation", () => {
    const source = relationSource();
    source.coreEntity = {
      schemaVersion: 2,
      kind: "coreEntity",
      module: "core",
      entity: "Connection",
      title: "Connection",
      language: "en",
      fields: [
        {
          key: "adapterId",
          valueType: "string",
          persisted: { column: "adapter_id", storageClass: "core" },
        },
        {
          key: "configurationValues",
          valueType: "object",
          persisted: { column: "configuration_values", storageClass: "core" },
        },
      ],
      operations: {
        create: {
          name: "Create connection",
          description: "Creates a connection from securely entered values.",
          implementation: { type: "entity", action: "create" },
          effects: { data: "write", external: "none" },
          reliability: { idempotency: { mode: "none" } },
          confirmation: { mode: "none" },
          interaction: {
            type: "secureInput",
            sourceField: "adapterId",
            sourceEntity: "Adapter",
            definitionsField: "configurationFields",
            into: "configurationValues",
          },
        },
      },
      interfaces: {
        rest: {},
        graphql: {},
        mcp: {},
        web: {
          views: {
            collection: { route: "/connections", columns: [{ key: "adapterId" }] },
          },
        },
      },
    };
    source.entity = { id: "integrations.Connection", name: "Connection" };
    source.crud.operations = {
      list: false,
      get: false,
      create: true,
      update: false,
      delete: false,
    };

    expect(() => assertV2Authoring(source.coreEntity!, "connection.yaml")).not.toThrow();
    expect(buildEntityOperations(source).create?.interaction).toEqual({
      confirmation: { mode: "none" },
      secureInput: {
        type: "secureInput",
        sourceField: "adapterId",
        sourceEntity: "Adapter",
        definitionsField: "configurationFields",
        into: "configurationValues",
      },
    });

    const createImplementation = source.coreEntity.operations!.create!.implementation;
    if (createImplementation.type !== "entity") throw new Error("Expected entity implementation");
    createImplementation.action = "update";
    expect(() => assertV2Authoring(source.coreEntity!, "connection.yaml")).toThrow(
      /secureInput.*supported only on create/,
    );
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
    const challengedImplementation = source.coreEntity.operations!.update!.implementation;
    if (challengedImplementation.type !== "entity") throw new Error("Expected entity implementation");
    challengedImplementation.action = "create";
    expect(() => assertV2Authoring(source.coreEntity!, "relation.yaml")).toThrow(
      /challenges require a mutable record target/,
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
      /version concurrency requires a mutable record target/,
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

  test("projects v2 GraphQL through canonical Operations and permits explicit exclusions", () => {
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
      interfaces: { graphql: {} },
    };
    source.crud.operations = {
      list: true,
      get: false,
      create: false,
      update: false,
      delete: false,
    };

    expect(() => assertV2Authoring(source.coreEntity!, "relation.yaml")).not.toThrow();
    expect(v2GraphqlOperationActions(source.coreEntity!)).toEqual({
      list: true,
      get: false,
      create: false,
      update: false,
      delete: false,
    });

    source.coreEntity.interfaces = { graphql: { operations: { list: false } } };
    expect(v2GraphqlOperationActions(source.coreEntity!)).toEqual({
      list: false,
      get: false,
      create: false,
      update: false,
      delete: false,
    });
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

    const updateImplementation = source.coreEntity.operations!.update!.implementation;
    if (updateImplementation.type !== "entity") throw new Error("Expected entity implementation");
    updateImplementation.action = "create";
    source.coreEntity.operations!.update!.concurrency = {
      version: { mode: "required", field: "updatedAt" },
      editLease: { mode: "required", expiresAfterInactivity: "PT15M" },
    };
    expect(() => assertV2Authoring(source.coreEntity!, "relation.yaml")).toThrow(
      /version concurrency requires a mutable record target/,
    );

    updateImplementation.action = "update";
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

  test("allows record permission only on a record-scoped plugin Operation with an entity ACL", () => {
    const source = relationSource();
    source.coreEntity = {
      schemaVersion: 2,
      kind: "coreEntity",
      module: "core",
      entity: "Relation",
      title: "Relation",
      language: "en",
      fields: [{
        key: "authorization",
        valueType: "object",
        required: true,
        defaultValue: {},
        persisted: { column: "authorization", storageClass: "core" },
      }],
      authorization: {
        roles: {
          read: ["Relations.Read"],
          create: ["Relations.Write"],
          update: ["Relations.Write"],
          delete: ["Relations.Delete"],
        },
        rowAccess: {
          enabled: true,
          recordPermissions: {
            field: "authorization",
            empty: "public",
            createRequires: ["view", "edit"],
          },
        },
      },
      operations: {
        archive: {
          name: "Archive relation",
          description: "Archives one relation.",
          implementation: { type: "plugin", plugin: "example", handler: "archive" },
          target: { scope: "record", inputField: "id" },
          input: {
            schema: {
              type: "object",
              properties: { id: { type: "string", format: "uuid" } },
              required: ["id"],
              additionalProperties: false,
            },
          },
          output: { schema: { type: "object", additionalProperties: true } },
          errors: [],
          auth: {
            mode: "session",
            roles: ["Relations.Write"],
            recordPermission: "delete",
          },
          tenancy: { mode: "required" },
          effects: { data: "write", external: "none" },
          reliability: { idempotency: { mode: "natural" } },
          confirmation: { mode: "none" },
        },
      },
      interfaces: { rest: { operations: { archive: {} } } },
    };
    expect(() => assertV2Authoring(source.coreEntity!, "relation.yaml")).not.toThrow();

    source.coreEntity.operations!.archive!.target = { scope: "collection" };
    expect(() => assertV2Authoring(source.coreEntity!, "relation.yaml")).toThrow(
      /recordPermission requires a record target/,
    );

    source.coreEntity.operations!.archive!.target = { scope: "record", inputField: "id" };
    delete source.coreEntity.authorization!.rowAccess!.recordPermissions;
    expect(() => assertV2Authoring(source.coreEntity!, "relation.yaml")).toThrow(
      /entity has no authorization\.rowAccess\.recordPermissions policy/,
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
