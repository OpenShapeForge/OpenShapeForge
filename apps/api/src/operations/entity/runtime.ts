// SPDX-License-Identifier: BUSL-1.1
import {
  operationErrorOf,
  type OperationError,
} from "@openshapeforge/operations";
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
  EntityOperationOffer,
  EntityOperationRef,
  EntityOperationRequest,
  EntityOperationResult,
  GeneratedCrudExposureOperation,
  GeneratedCrudTable,
} from "./types.js";

const COLLECTION_OFFER_INTENTS: readonly GeneratedCrudExposureOperation[] = [
  "list",
  "create",
];
const RECORD_OFFER_INTENTS: readonly GeneratedCrudExposureOperation[] = [
  "get",
  "update",
  "delete",
];

const operationCatalog = rawOperationCatalog as unknown as {
  entityOperations?: EntityOperationContract[];
};
const entityOperations = operationCatalog.entityOperations ?? [];
const entityOperationsById = new Map(
  entityOperations.map((operation) => [operation.id, operation]),
);

function requireId(input: EntityOperationInput | undefined): string {
  if (!input?.id) {
    throw generatedCrudError("Entity operation requires an id.", "BAD_USER_INPUT");
  }
  return input.id;
}

function requireValues(input: EntityOperationInput | undefined): Record<string, unknown> {
  if (!input?.values) {
    throw generatedCrudError("Entity operation requires values.", "BAD_USER_INPUT");
  }
  return input.values;
}

function authoredEntityId(table: GeneratedCrudTable): string {
  const entityId = table.source?.authoringEntityName?.trim();
  if (!entityId) {
    throw generatedCrudError(
      `Generated CRUD table ${table.name} has no authored entity identity.`,
      "INTERNAL_SERVER_ERROR",
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
    );
  }
  if (contract.intent !== operation.intent) {
    throw generatedCrudError(
      `Entity operation ${operation.id} does not match intent ${operation.intent}.`,
      "BAD_USER_INPUT",
    );
  }
  const table = getGeneratedCrudTables().find(
    (candidate) => candidate.source?.authoringEntityName === contract.entityName,
  );
  if (!table) {
    throw generatedCrudError(
      `Entity operation ${operation.id} is not available.`,
      "GENERATED_CRUD_NOT_ENABLED",
    );
  }
  return table;
}

export function getEntityOperationContracts(): readonly EntityOperationContract[] {
  return entityOperations;
}

/**
 * Produce the request-bound offers an interface may show. Operations the
 * session is not authorized to invoke are omitted rather than disclosed.
 */
export function getEntityOperationOffers(
  entityName: string,
  session: Pick<DbSessionInput, "roles">,
  intents: readonly GeneratedCrudExposureOperation[],
  unavailable: Readonly<Record<string, OperationError | undefined>> = {},
): EntityOperationOffer[] {
  const heldRoles = new Set(session.roles ?? []);
  return entityOperations
    .filter(
      (operation) =>
        operation.entityName === entityName &&
        intents.includes(operation.intent) &&
        operation.authorization.roles.some((role) => heldRoles.has(role)),
    )
    .map((operation) => {
      const error = unavailable[operation.id];
      const reference = { id: operation.id, intent: operation.intent };
      return error
        ? { operation: reference, available: false as const, error }
        : { operation: reference, available: true as const };
    });
}

function internalOperationError(): OperationError {
  return {
    code: "INTERNAL_SERVER_ERROR",
    message: "Internal server error.",
    retryable: false,
  };
}

function projectedOfferIntents(
  request: EntityOperationRequest,
  candidates: readonly GeneratedCrudExposureOperation[],
): GeneratedCrudExposureOperation[] {
  if (!request.offerIntents) return [...candidates];
  const projected = new Set(request.offerIntents);
  return candidates.filter((intent) => projected.has(intent));
}

/** Interface-neutral dispatcher used by REST, MCP and future transports. */
export async function executeEntityOperation(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  request: EntityOperationRequest,
): Promise<EntityOperationResult> {
  try {
    const table = tableForEntityOperation(request.operation);
    const entityName = authoredEntityId(table);
    switch (request.operation.intent) {
      case "list": {
        const connection = await listGeneratedEntities(db, session, {
          table: table.name,
          ...request.input,
        });
        return {
          intent: "list",
          data: {
            items: connection.rows.map((row) => ({
              data: row,
              operations: getEntityOperationOffers(
                entityName,
                session,
                projectedOfferIntents(request, RECORD_OFFER_INTENTS),
              ),
            })),
            totalCount: connection.totalCount,
            nextCursor: connection.nextCursor,
          },
          operations: getEntityOperationOffers(
            entityName,
            session,
            projectedOfferIntents(request, COLLECTION_OFFER_INTENTS),
          ),
        };
      }
      case "get": {
        const data = await getGeneratedEntity(db, session, {
          table: table.name,
          id: requireId(request.input),
        });
        return {
          intent: "get",
          data,
          operations: data
            ? getEntityOperationOffers(
                entityName,
                session,
                projectedOfferIntents(request, RECORD_OFFER_INTENTS),
              )
            : [],
        };
      }
      case "create": {
        const data = await createGeneratedEntity(db, session, {
          table: table.name,
          values: requireValues(request.input),
        });
        return {
          intent: "create",
          data,
          operations: getEntityOperationOffers(
            entityName,
            session,
            projectedOfferIntents(request, RECORD_OFFER_INTENTS),
          ),
        };
      }
      case "update": {
        const data = await updateGeneratedEntity(db, session, {
          table: table.name,
          id: requireId(request.input),
          values: requireValues(request.input),
        });
        return {
          intent: "update",
          data,
          operations: data
            ? getEntityOperationOffers(
                entityName,
                session,
                projectedOfferIntents(request, RECORD_OFFER_INTENTS),
              )
            : [],
        };
      }
      case "delete": {
        const deleted = await deleteGeneratedEntity(db, session, {
          table: table.name,
          id: requireId(request.input),
        });
        return {
          intent: "delete",
          data: { deleted },
          operations: getEntityOperationOffers(
            entityName,
            session,
            projectedOfferIntents(request, COLLECTION_OFFER_INTENTS),
          ),
        };
      }
    }
  } catch (error) {
    return {
      intent: request.operation.intent,
      error: operationErrorOf(error) ?? internalOperationError(),
    } as EntityOperationResult;
  }
}
