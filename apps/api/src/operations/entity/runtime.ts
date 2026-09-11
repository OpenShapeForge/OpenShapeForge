// SPDX-License-Identifier: BUSL-1.1
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import type { DbSessionInput } from "../../db/session.js";
import rawOperationCatalog from "../../generated/operations/catalog.json" with { type: "json" };
import { generatedCrudError, getGeneratedCrudTables } from "./catalog.js";
import {
  createGeneratedEntity,
  deleteGeneratedEntity,
  updateGeneratedEntity,
} from "./mutations.js";
import { getGeneratedEntity, listGeneratedEntities } from "./queries.js";
import type {
  EntityOperationInput,
  EntityOperationContract,
  EntityOperationRef,
  EntityOperationRequest,
  EntityOperationResult,
  GeneratedCrudExposureOperation,
  GeneratedCrudTable,
} from "./types.js";

const operationCatalog = rawOperationCatalog as unknown as {
  entityOperations?: EntityOperationContract[];
};
const entityOperations = operationCatalog.entityOperations ?? [];
const entityOperationsById = new Map(
  entityOperations.map((operation) => [operation.id, operation]),
);

function requireId(input: EntityOperationInput | undefined): string {
  if (!input?.id) {
    throw generatedCrudError("Entity operation requires an id.", "BAD_USER_INPUT", 400);
  }
  return input.id;
}

function requireValues(input: EntityOperationInput | undefined): Record<string, unknown> {
  if (!input?.values) {
    throw generatedCrudError("Entity operation requires values.", "BAD_USER_INPUT", 400);
  }
  return input.values;
}

function authoredEntityId(table: GeneratedCrudTable): string {
  const entityId = table.source?.authoringEntityName?.trim();
  if (!entityId) {
    throw generatedCrudError(
      `Generated CRUD table ${table.name} has no authored entity identity.`,
      "INTERNAL_SERVER_ERROR",
      500,
    );
  }
  return entityId;
}

export function entityOperationRef(
  table: GeneratedCrudTable,
  intent: GeneratedCrudExposureOperation,
): EntityOperationRef {
  const entityName = authoredEntityId(table);
  const operation = entityOperations.find(
    (candidate) => candidate.entityName === entityName && candidate.intent === intent,
  );
  if (!operation) {
    throw generatedCrudError(
      `Entity operation ${entityName}.${intent} is not available.`,
      "GENERATED_CRUD_NOT_ENABLED",
      404,
    );
  }
  return { id: operation.id, intent: operation.intent };
}

export function tableForEntityOperation(operation: EntityOperationRef): GeneratedCrudTable {
  const contract = entityOperationsById.get(operation.id);
  if (!contract) {
    throw generatedCrudError(
      `Entity operation ${operation.id} is not available.`,
      "GENERATED_CRUD_NOT_ENABLED",
      404,
    );
  }
  if (contract.intent !== operation.intent) {
    throw generatedCrudError(
      `Entity operation ${operation.id} does not match intent ${operation.intent}.`,
      "BAD_USER_INPUT",
      400,
    );
  }
  const table = getGeneratedCrudTables().find(
    (candidate) => candidate.source?.authoringEntityName === contract.entityName,
  );
  if (!table) {
    throw generatedCrudError(
      `Entity operation ${operation.id} is not available.`,
      "GENERATED_CRUD_NOT_ENABLED",
      404,
    );
  }
  return table;
}

export function getEntityOperationContracts(): readonly EntityOperationContract[] {
  return entityOperations;
}

/** Interface-neutral dispatcher used by REST, MCP and future transports. */
export async function executeEntityOperation(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  request: EntityOperationRequest,
): Promise<EntityOperationResult> {
  const table = tableForEntityOperation(request.operation);
  switch (request.operation.intent) {
    case "list": {
      const connection = await listGeneratedEntities(db, session, {
        table: table.name,
        ...request.input,
      });
      return { intent: "list", connection };
    }
    case "get": {
      const record = await getGeneratedEntity(db, session, {
        table: table.name,
        id: requireId(request.input),
      });
      return { intent: "get", record };
    }
    case "create": {
      const record = await createGeneratedEntity(db, session, {
        table: table.name,
        values: requireValues(request.input),
      });
      return { intent: "create", record };
    }
    case "update": {
      const record = await updateGeneratedEntity(db, session, {
        table: table.name,
        id: requireId(request.input),
        values: requireValues(request.input),
      });
      return { intent: "update", record };
    }
    case "delete": {
      const deleted = await deleteGeneratedEntity(db, session, {
        table: table.name,
        id: requireId(request.input),
      });
      return { intent: "delete", deleted };
    }
  }
}
