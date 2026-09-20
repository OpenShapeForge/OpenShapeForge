// SPDX-License-Identifier: BUSL-1.1
/** Compile generated CRUD into interface-neutral entity operation contracts. */
import type {
  CompiledAuthorization,
  CompiledEntityOperation,
  CrudSection,
  EntityOperationIntent,
} from "../types.js";
import type { CoreEntity } from "../types.js";
import {
  deriveEntityOperationErrors,
  withDeclaredEntityOperationErrors,
} from "./entity-operation-errors.js";
import { operationByAction } from "../entity-model.js";

const OPERATION_ORDER: readonly EntityOperationIntent[] = [
  "list",
  "get",
  "create",
  "update",
  "delete",
];

type OperationSource = {
  entity: { id: string; name: string };
  coreEntity?: CoreEntity;
  crud: CrudSection;
  authorization: CompiledAuthorization;
};

function defaultEffects(intent: EntityOperationIntent) {
  return {
    data: intent === "list" || intent === "get"
      ? "read" as const
      : intent === "delete"
        ? "delete" as const
        : "write" as const,
    external: "none" as const,
  };
}

function defaultIdempotency(intent: EntityOperationIntent) {
  return {
    idempotency: {
      mode: intent === "list" || intent === "get" || intent === "delete"
        ? "natural" as const
        : "none" as const,
    },
  };
}

function authorizationAction(
  intent: EntityOperationIntent,
): keyof CompiledAuthorization["roles"] {
  return intent === "list" || intent === "get" ? "read" : intent;
}

function recordPermissions(
  authorization: CompiledAuthorization,
  intent: EntityOperationIntent,
): NonNullable<CompiledEntityOperation["authorization"]["recordPermissions"]> | undefined {
  const policy = authorization.rowAccess?.recordPermissions;
  if (!policy) return undefined;
  switch (intent) {
    case "list":
    case "get":
      return ["view"];
    case "create":
      return [...policy.createRequires];
    case "update":
      return ["edit"];
    case "delete":
      return ["delete"];
  }
}

function compileOperation(
  source: OperationSource,
  intent: EntityOperationIntent,
): CompiledEntityOperation {
  const action = authorizationAction(intent);
  const authored = source.coreEntity
    ? operationByAction(source.coreEntity)[intent]
    : undefined;
  const key = authored?.[0] ?? intent;
  const definition = authored?.[1];
  const pluginImplementation = definition?.implementation.type === "plugin"
    ? definition.implementation
    : undefined;
  const shared = {
    id: definition?.id ?? `${source.entity.name}.${key}`,
    key,
    entityId: source.entity.id,
    entityName: source.entity.name,
    intent,
    name: definition?.name ?? `${source.entity.name} ${intent}`,
    description: definition?.description ?? `${intent} ${source.entity.name}`,
    implementation: pluginImplementation
      ? {
          type: "plugin" as const,
          plugin: pluginImplementation.plugin,
          handler: pluginImplementation.handler,
        }
      : { type: "entity" as const },
    ...(pluginImplementation && definition?.target
      ? {
          target: {
            entityId: source.entity.id,
            entityName: source.entity.name,
            ...definition.target,
          },
        }
      : {}),
    errors: withDeclaredEntityOperationErrors(
      deriveEntityOperationErrors(source.entity.name, intent, {
        concurrency: definition?.concurrency,
        confirmation: definition?.confirmation ?? { mode: "none" },
        recordPermissions: source.authorization.rowAccess?.recordPermissions !== undefined,
      }),
      pluginImplementation ? definition?.errors : undefined,
    ),
    ...(pluginImplementation && source.coreEntity?.interfaces
      ? {
          interfaces: Object.fromEntries(
            (["rest", "graphql", "mcp", "web"] as const).flatMap((name) => {
              const contract = source.coreEntity!.interfaces?.[name];
              if (!contract) return [];
              return [[name, contract.operations?.[key] ?? {}]];
            }),
          ),
        }
      : {}),
    ...(definition?.guidance ? { guidance: definition.guidance } : {}),
    ...(definition?.prerequisites
      ? { prerequisites: definition.prerequisites.map((prerequisite) => ({
          operation: prerequisite.operation,
          receipt: { ...prerequisite.receipt },
        })) }
      : {}),
    authorization: {
      action,
      roles: [...source.authorization.roles[action]],
      ...(() => {
        const permissions = recordPermissions(source.authorization, intent);
        return permissions ? { recordPermissions: permissions } : {};
      })(),
    },
    effects: definition?.effects ?? defaultEffects(intent),
    reliability: definition?.reliability ?? defaultIdempotency(intent),
    ...(definition?.concurrency ? { concurrency: definition.concurrency } : {}),
    interaction: {
      confirmation: definition?.confirmation ?? { mode: "none" as const },
      ...(definition?.interaction ? { secureInput: definition.interaction } : {}),
    },
  };
  switch (intent) {
    case "list":
      return {
        ...shared,
        input: {
          kind: "collection-query",
          entityId: source.entity.id,
          filterMode: "declared-fields",
          sortMode: "declared-fields",
          pagination: { kind: "cursor", defaultLimit: 50, maxLimit: 200 },
        },
        output: { kind: "entity-connection", entityId: source.entity.id },
      };
    case "get":
      return {
        ...shared,
        input: { kind: "identity", identityField: "id" },
        output: { kind: "entity-record", entityId: source.entity.id, nullable: true },
      };
    case "create":
      return {
        ...shared,
        input: pluginImplementation
          ? { kind: "json-schema", schema: definition!.input!.schema }
          : { kind: "entity-create", entityId: source.entity.id },
        output: pluginImplementation
          ? { kind: "json-schema", schema: definition!.output!.schema }
          : { kind: "entity-record", entityId: source.entity.id, nullable: false },
      };
    case "update":
      return {
        ...shared,
        input: pluginImplementation
          ? { kind: "json-schema", schema: definition!.input!.schema }
          : {
              kind: "entity-update",
              entityId: source.entity.id,
              identityField: "id",
            },
        output: pluginImplementation
          ? { kind: "json-schema", schema: definition!.output!.schema }
          : { kind: "entity-record", entityId: source.entity.id, nullable: true },
      };
    case "delete":
      return {
        ...shared,
        input: pluginImplementation
          ? { kind: "json-schema", schema: definition!.input!.schema }
          : { kind: "identity", identityField: "id" },
        output: pluginImplementation
          ? { kind: "json-schema", schema: definition!.output!.schema }
          : { kind: "deletion-result" },
      };
  }
}

export function buildEntityOperations(
  source: OperationSource,
): Partial<Record<EntityOperationIntent, CompiledEntityOperation>> {
  return Object.fromEntries(
    OPERATION_ORDER
      .filter((intent) => source.crud.operations[intent])
      .map((intent) => [intent, compileOperation(source, intent)]),
  );
}
