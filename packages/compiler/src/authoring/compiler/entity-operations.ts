// SPDX-License-Identifier: BUSL-1.1
/** Compile generated CRUD into interface-neutral entity operation contracts. */
import type {
  CompiledAuthorization,
  CompiledEntityOperation,
  CrudSection,
  EntityOperationIntent,
} from "../types.js";

const OPERATION_ORDER: readonly EntityOperationIntent[] = [
  "list",
  "get",
  "create",
  "update",
  "delete",
];

type OperationSource = {
  entity: { id: string; name: string };
  crud: CrudSection;
  authorization: CompiledAuthorization;
};

function authorizationAction(
  intent: EntityOperationIntent,
): keyof CompiledAuthorization["roles"] {
  return intent === "list" || intent === "get" ? "read" : intent;
}

function compileOperation(
  source: OperationSource,
  intent: EntityOperationIntent,
): CompiledEntityOperation {
  const action = authorizationAction(intent);
  const shared = {
    id: `${source.entity.name}.${intent}`,
    entityId: source.entity.id,
    entityName: source.entity.name,
    intent,
    authorization: { action, roles: [...source.authorization.roles[action]] },
    interaction: { confirmation: "none" as const },
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
        input: { kind: "entity-create", entityId: source.entity.id },
        output: { kind: "entity-record", entityId: source.entity.id, nullable: false },
      };
    case "update":
      return {
        ...shared,
        input: {
          kind: "entity-update",
          entityId: source.entity.id,
          identityField: "id",
        },
        output: { kind: "entity-record", entityId: source.entity.id, nullable: true },
      };
    case "delete":
      return {
        ...shared,
        input: { kind: "identity", identityField: "id" },
        output: { kind: "deletion-result" },
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
