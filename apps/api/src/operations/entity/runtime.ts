// SPDX-License-Identifier: BUSL-1.1
import { createFromBlueprint } from "./blueprints.js";
import {
  operationFailure,
  operationErrorOf,
  type OperationConcurrency,
  type OperationError,
  type OperationTargetBinding,
} from "@openshapeforge/operations";
import { sanitizeError } from "@openshapeforge/observability";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import type { DbSessionInput } from "../../db/session.js";
import { normalizeTimestampToken } from "../../db/timestamps.js";
import rawOperationCatalog from "../../generated/operations/catalog.json" with { type: "json" };
import { collectionManagedFields, collectionMutationError, withoutCollectionInputs } from "./collection-policy.js";
import {
  generatedCrudError,
  getGeneratedCrudTables,
  requireEntityOperation,
} from "./catalog.js";
import {
  acquireEntityEditLease,
  editLeaseErrorsByTarget,
  type EntityEditLease,
  type LeaseProtectedOperation,
} from "./edit-leases.js";
import {
  issueEntityConfirmationChallenge,
  type ChallengeProtectedOperation,
} from "./confirmation-challenges.js";
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
import { fieldNameForColumn } from "./columns.js";
import {
  assertRecordPermission,
  recordPermissionsAllowRow,
  type RecordPermissionAction,
} from "./record-permissions.js";
import { sessionOperationRoleGroupsAllow, sessionOperationRolesAllow } from "../session-authorization.js";
import { requireOperationPrerequisites } from "../prerequisite-receipts.js";
import { executeEntityPlugin } from "./plugin-executor.js";
import { entityBusinessUnavailability } from "./availability.js";
import { assertEntityValuesValid, type EntityValuesValidation } from "./input-validation.js";
import { assertNoCallerElicitedOutput, assertNoOperationWrittenValues } from "./write-policy.js";

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
  operations?: Array<{
    key: string;
    target?: {
      entityId: string;
      entityName: string;
      scope: "collection" | "record";
      inputField?: string;
    };
    auth:
      | { mode: "public" }
      | {
          mode: "session";
          roles?: string[];
          roleGroups?: string[][];
          scopes?: string[];
          recordPermission?: RecordPermissionAction;
        }
      | { mode: "custom" };
    concurrency?: OperationConcurrency;
    confirmation?: import("@openshapeforge/operations").OperationConfirmation;
    transports: {
      rest: { method: string; path: string };
      mcp: { enabled: boolean };
    };
  }>;
};
const entityOperations = (operationCatalog.entityOperations ?? []).map((operation) => {
  if (operation.implementation?.type === "plugin" || (operation.intent !== "create" && operation.intent !== "update")) return operation;
  const table = getGeneratedCrudTables().find((table) => table.source?.authoringEntityName === operation.entityName);
  if (!table || !operation.inputSchema) return operation;
  return { ...operation, inputSchema: withoutCollectionInputs(operation.inputSchema, collectionManagedFields(table, getGeneratedCrudTables())) };
});
const pluginOperations = operationCatalog.operations ?? [];

type OperationAuthorizationSession = Pick<DbSessionInput, "roles"> & {
  oauthScopes?: readonly string[];
  credential?: string;
};

export function pluginOperationAuthAllowsOffer(
  auth: (typeof pluginOperations)[number]["auth"],
  session: OperationAuthorizationSession,
): boolean {
  return auth.mode === "public" ||
    (auth.mode === "session" &&
      sessionOperationRolesAllow(auth.roles, session.roles ?? []) &&
      sessionOperationRoleGroupsAllow(auth.roleGroups, session.roles ?? []) &&
      (!(auth.scopes?.length) || (session.credential !== "api-key" &&
        auth.scopes.every((scope) => session.oauthScopes?.includes(scope)))));
}
const entityOperationsById = new Map(
  entityOperations.map((operation) => [operation.id, operation]),
);

async function leaseUnavailabilityByTarget(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  entityName: string,
  table: GeneratedCrudTable,
  targetIds: readonly string[],
): Promise<ReadonlyMap<string, Readonly<Record<string, OperationError>>>> {
  const protectedOperations = [
    ...entityOperations.filter(
      (operation) =>
        operation.entityName === entityName &&
        operation.concurrency?.editLease?.mode === "required",
    ),
    ...pluginOperations.filter((operation) =>
      operation.target?.entityName === entityName &&
      operation.target.scope === "record" &&
      operation.concurrency?.editLease?.mode === "required"
    ).map((operation) => ({ id: operation.key, entityId: operation.target!.entityId })),
  ];
  if (protectedOperations.length === 0) return new Map();
  const byTarget = await editLeaseErrorsByTarget(db, session, {
    entityId: protectedOperations[0]!.entityId,
    targetIds,
  });
  return new Map(
    [...byTarget].map(([targetId, error]) => [
      targetId,
      Object.fromEntries(protectedOperations.map(({ id }) => [id, error])),
    ]),
  );
}

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

/**
 * The compiled write contract, enforced once for every interface. The
 * operation-written and elicited refusals run first so a field that exists but
 * is not the caller's to set is named as such, not as an unknown field.
 */
function requireContractValues(
  operation: EntityOperationContract,
  table: GeneratedCrudTable,
  values: Record<string, unknown>,
  options: EntityValuesValidation,
): void {
  assertNoCallerElicitedOutput(table, values);
  assertNoOperationWrittenValues(table, values);
  assertEntityValuesValid(operation, table, values, options);
}

function requireControl(
  input: EntityOperationInput | undefined,
  key: "expectedVersion" | "leaseToken" | "confirmationToken" | "confirmationAnswer",
): string {
  const value = input?.[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw generatedCrudError(`Entity operation requires ${key}.`, "BAD_USER_INPUT");
  }
  return value;
}

/** Canonical semantic validation failure shared by every interface adapter. */
export function invalidExpectedVersionFailure(versionField: string) {
  return operationFailure({
    code: "VALIDATION",
    message: "The supplied record version is not valid.",
    detail: `Reload the record and use its ${versionField} value.`,
    violations: [
      {
        field: "expectedVersion",
        code: "INVALID_DATETIME",
        message: "Expected version must be a valid timestamp.",
      },
    ],
  });
}

/** Canonical type failure for interface-neutral mutation controls. */
export function invalidMutationControlTypeFailure(
  field: "expectedVersion" | "leaseToken" | "confirmed" | "confirmationToken" | "confirmationAnswer",
  expectedType: "string" | "boolean",
) {
  return operationFailure({
    code: "VALIDATION",
    message: "The supplied mutation control is not valid.",
    detail: `${field} must be a ${expectedType}.`,
    violations: [
      {
        field,
        code: "INVALID_TYPE",
        message: `${field} must be a ${expectedType}.`,
      },
    ],
  });
}

/** Enforce a lightweight caller acknowledgement without treating it as proof. */
export function requireOperationAcknowledgement(
  operation: EntityOperationContract,
  input: EntityOperationInput | undefined,
): void {
  if (operation.interaction.confirmation.mode !== "acknowledgement") return;
  if (input?.confirmed !== true) {
    throw operationFailure({
      code: "CONFIRMATION_REQUIRED",
      message: `Confirm ${operation.entityName}.${operation.intent} before continuing.`,
      detail: "Retry the operation with confirmed set to true.",
      retryable: true,
      data: {
        confirmation: {
          kind: "acknowledgement",
          requiredValue: true,
        },
      },
    });
  }
}

/** Create has no current target, so only a lightweight acknowledgement is meaningful. */
export function requireCreateOperationConfirmation(
  operation: EntityOperationContract,
  input: EntityOperationInput | undefined,
): void {
  if (operation.interaction.confirmation.mode === "challenge") {
    throw operationFailure({
      code: "CONFIRMATION_NOT_SUPPORTED",
      message: "A current-record challenge cannot protect a create operation.",
    });
  }
  requireOperationAcknowledgement(operation, input);
}

/**
 * A secure-input target is server-owned. The ordinary canonical create path
 * cannot accept it from REST, GraphQL, Web or a runtime module; an interaction
 * adapter must collect, validate and store it through the dedicated core path.
 */
export function secureInputInteractionError(
  operation: EntityOperationContract,
): OperationError | undefined {
  const secureInput = operation.interaction.secureInput;
  if (!secureInput) return undefined;
  return {
    code: "INTERACTION_REQUIRED",
    message: `Secure input is required before ${operation.entityName}.${operation.intent} can run.`,
    ...(secureInput.message ? { detail: secureInput.message } : {}),
    retryable: false,
    data: {
      interaction: {
        kind: "secureInput",
        sourceField: secureInput.sourceField,
        sourceEntity: secureInput.sourceEntity,
        definitionsField: secureInput.definitionsField,
      },
    },
  };
}

type PreparedMutationConfirmation =
  | { ready: true; confirmationToken?: string; confirmationAnswer?: string }
  | { ready: false; error: OperationError };

async function prepareMutationConfirmation(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  operation: EntityOperationContract,
  table: GeneratedCrudTable,
  input: EntityOperationInput | undefined,
  concurrencyGuard: ReturnType<typeof mutationConcurrencyGuard>,
): Promise<PreparedMutationConfirmation> {
  const confirmation = operation.interaction.confirmation;
  if (confirmation.mode === "none") return { ready: true };
  if (confirmation.mode === "acknowledgement") {
    requireOperationAcknowledgement(operation, input);
    return { ready: true };
  }
  if (!concurrencyGuard?.expectedVersion) {
    throw operationFailure({
      code: "INTERNAL_SERVER_ERROR",
      message: "The operation's confirmation contract is incomplete.",
    });
  }
  const confirmationToken = input?.confirmationToken;
  const confirmationAnswer = input?.confirmationAnswer;
  if (Boolean(confirmationToken) !== Boolean(confirmationAnswer)) {
    throw generatedCrudError(
      "Entity operation requires confirmationToken and confirmationAnswer together.",
      "BAD_USER_INPUT",
    );
  }
  if (!confirmationToken && !confirmationAnswer) {
    return {
      ready: false,
      error: await issueEntityConfirmationChallenge(db, session, {
        operation: operation as ChallengeProtectedOperation,
        table,
        targetId: requireId(input),
        expectedVersion: concurrencyGuard.expectedVersion,
        ...(concurrencyGuard.leaseToken
          ? { leaseToken: concurrencyGuard.leaseToken }
          : {}),
      }),
    };
  }
  return {
    ready: true,
    confirmationToken: requireControl(input, "confirmationToken"),
    confirmationAnswer: requireControl(input, "confirmationAnswer"),
  };
}

/**
 * Build the interface-neutral precondition passed to the mutation engine.
 * Version concurrency stands on its own; a lease is an additional control,
 * never the switch that enables the version predicate.
 */
export function mutationConcurrencyGuard(
  operation: EntityOperationContract,
  input: EntityOperationInput | undefined,
): {
  operation: LeaseProtectedOperation;
  expectedVersion: string;
  leaseToken?: string;
} | undefined {
  const concurrency = operation.concurrency;
  if (concurrency?.editLease && !concurrency.version) {
    throw generatedCrudError(
      `Entity operation ${operation.id} has an invalid edit-lease contract.`,
      "INTERNAL_SERVER_ERROR",
    );
  }
  let expectedVersion: string | undefined;
  if (concurrency?.version) {
    const rawExpectedVersion = requireControl(input, "expectedVersion");
    try {
      expectedVersion = normalizeTimestampToken(rawExpectedVersion);
    } catch {
      throw invalidExpectedVersionFailure(concurrency.version.field);
    }
  }
  const leaseToken = concurrency?.editLease
    ? requireControl(input, "leaseToken")
    : undefined;
  return expectedVersion
    ? {
        operation: operation as LeaseProtectedOperation,
        expectedVersion,
        ...(leaseToken ? { leaseToken } : {}),
      }
    : undefined;
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

/** Lease-protected Operations this identity may reach through the REST adapter. */
export function restEditLeaseOperationIdsForSession(
  session: OperationAuthorizationSession,
): string[] {
  const heldRoles = new Set(session.roles ?? []);
  const generatedIds = entityOperations
    .filter((operation) => {
      if (
        (operation.intent !== "update" && operation.intent !== "delete") ||
        operation.concurrency?.editLease?.mode !== "required" ||
        !operation.authorization.roles.some((role) => heldRoles.has(role))
      ) {
        return false;
      }
      const table = tableForEntityOperation({
        id: operation.id,
        intent: operation.intent,
      });
      return (table.source?.authoringVersion ?? 1) >= 2 &&
        table.source?.rest?.operations[operation.intent] === true;
    })
    .map(({ id }) => id);
  return [
    ...generatedIds,
    ...pluginEditLeaseOperationIdsForSession(session, "rest"),
  ];
}

/** Lease-protected YAML plugin Operations available on one interface. */
export function pluginEditLeaseOperationIdsForSession(
  session: OperationAuthorizationSession,
  transport: "rest" | "mcp",
): string[] {
  return pluginOperations
    .filter((operation) =>
      operation.target?.scope === "record" &&
      operation.concurrency?.version?.mode === "required" &&
      operation.concurrency.editLease?.mode === "required" &&
      operation.auth.mode === "session" &&
      pluginOperationAuthAllowsOffer(operation.auth, session) &&
      (transport === "rest" || operation.transports.mcp.enabled)
    )
    .map(({ key }) => key);
}

export function entityOperationContract(operationId: string): EntityOperationContract {
  const operation = entityOperationsById.get(operationId);
  if (!operation) {
    throw generatedCrudError(
      `Entity operation ${operationId} is not available.`,
      "GENERATED_CRUD_NOT_ENABLED",
    );
  }
  return operation;
}

/** Central acquisition entry point shared by REST, MCP and Web adapters. */
export async function acquireEditLeaseForEntityOperation(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput & { oauthScopes?: readonly string[]; credential?: string },
  input: { operationId: string; targetId: string },
): Promise<EntityEditLease> {
  const custom = pluginOperations.find((operation) => operation.key === input.operationId);
  if (custom) {
    if (
      custom.target?.scope !== "record" ||
      custom.auth.mode !== "session" ||
      !pluginOperationAuthAllowsOffer(custom.auth, session) ||
      !custom.concurrency?.version ||
      !custom.concurrency.editLease
    ) {
      throw generatedCrudError(
        `Entity operation ${custom.key} cannot acquire an edit lease.`,
        "LEASE_NOT_SUPPORTED",
      );
    }
    const table = getGeneratedCrudTables().find((candidate) =>
      candidate.source?.authoringEntityName === custom.target!.entityName
    );
    if (!table) {
      throw generatedCrudError(
        `Entity operation ${custom.key} has no generated target table.`,
        "INTERNAL_SERVER_ERROR",
      );
    }
    if (custom.auth.mode === "session" && custom.auth.recordPermission) {
      await assertRecordPermission(
        db,
        session,
        table,
        input.targetId,
        custom.auth.recordPermission,
      );
    }
    return acquireEntityEditLease(db, session, {
      operation: {
        id: custom.key,
        entityId: custom.target.entityId,
        entityName: custom.target.entityName,
        intent: "invoke",
        concurrency: custom.concurrency,
      },
      table,
      targetId: input.targetId,
    });
  }
  const operation = entityOperationContract(input.operationId);
  if (operation.intent !== "update" && operation.intent !== "delete") {
    throw generatedCrudError(
      `Entity operation ${operation.id} cannot acquire an edit lease.`,
      "LEASE_NOT_SUPPORTED",
    );
  }
  const table = tableForEntityOperation({ id: operation.id, intent: operation.intent });
  requireEntityOperation(table, operation.intent, session);
  for (const permission of operation.authorization.recordPermissions ?? []) {
    await assertRecordPermission(db, session, table, input.targetId, permission);
  }
  return acquireEntityEditLease(db, session, {
    operation: operation as LeaseProtectedOperation,
    table,
    targetId: input.targetId,
  });
}

/**
 * Produce the request-bound offers an interface may show. Operations the
 * session is not authorized to invoke are omitted rather than disclosed.
 */
export function getEntityOperationOffers(
  entityName: string,
  session: Pick<DbSessionInput, "roles"> & { oauthScopes?: readonly string[]; credential?: string },
  intents: readonly GeneratedCrudExposureOperation[],
  unavailable: Readonly<Record<string, OperationError | undefined>> = {},
  target?: { id: string; version?: string; row?: Readonly<Record<string, unknown>> },
): EntityOperationOffer[] {
  const heldRoles = new Set(session.roles ?? []);
  const table = target
    ? getGeneratedCrudTables().find((candidate) =>
        candidate.source?.authoringEntityName === entityName
      )
    : undefined;
  const hasRecordPermissions = (
    permissions: readonly RecordPermissionAction[] | undefined,
  ) =>
    !permissions?.length ||
    Boolean(
      table &&
      target?.row &&
      recordPermissionsAllowRow(table, target.row, permissions, session),
    );
  const generatedOffers = entityOperations
    .filter(
      (operation) =>
        operation.entityName === entityName &&
        intents.includes(operation.intent) &&
        operation.authorization.roles.some((role) => heldRoles.has(role)) &&
        (!target || hasRecordPermissions(operation.authorization.recordPermissions)),
    )
    .map((operation) => {
      const operationTable = getGeneratedCrudTables().find((table) => table.source?.authoringEntityName === entityName);
      const error = unavailable[operation.id] ?? (operation.implementation?.type !== "plugin" && operationTable
        ? collectionMutationError(operationTable, operation.intent, getGeneratedCrudTables()) : undefined);
      const reference = { id: operation.id, intent: operation.intent };
      return error
        ? { operation: reference, available: false as const, error }
        : {
            operation: reference,
            available: true as const,
            ...(operation.concurrency ? { concurrency: operation.concurrency } : {}),
            ...entityRecordOfferBinding(operation, target),
          };
    });
  const scope = target ? "record" : "collection";
  const customOffers: EntityOperationOffer[] = pluginOperations
    .filter((operation) =>
      operation.target?.entityName === entityName &&
      operation.target.scope === scope &&
      pluginOperationAuthAllowsOffer(operation.auth, session) &&
      (!target ||
        operation.auth.mode !== "session" ||
        !operation.auth.recordPermission ||
        hasRecordPermissions([operation.auth.recordPermission]))
    )
    .map((operation) => {
      const error = unavailable[operation.key];
      const reference = { id: operation.key, intent: "invoke" as const };
      if (error) return { operation: reference, available: false as const, error };
      return {
        operation: reference,
        available: true as const,
        ...(operation.concurrency ? { concurrency: operation.concurrency } : {}),
        ...(target && operation.target?.inputField
          ? {
              binding: {
                target: {
                  entityId: operation.target.entityId,
                  id: target.id,
                  ...(target.version ? { version: target.version } : {}),
                },
                input: { [operation.target.inputField]: target.id },
              },
            }
          : {}),
      };
    });
  return [...generatedOffers, ...customOffers];
}

async function businessAndLeaseUnavailability(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  entityName: string,
  table: GeneratedCrudTable,
  targets: Array<ReturnType<typeof offerTarget>>,
  intents: readonly GeneratedCrudExposureOperation[],
): Promise<ReadonlyMap<string, Readonly<Record<string, OperationError>>>> {
  const business = await entityBusinessUnavailability(db, session, targets.map(target => ({
    id: target.id,
    operationIds: getEntityOperationOffers(entityName, session, intents, {}, target).map(offer => offer.operation.id),
  })));
  const leases = await leaseUnavailabilityByTarget(db, session, entityName, table, targets.map(target => target.id));
  for (const [id, errors] of leases) business.set(id, { ...errors, ...business.get(id) });
  return business;
}

export async function currentRecordOffers(
  db: OpenShapeForgeDatabase, session: DbSessionInput, entityName: string,
  table: GeneratedCrudTable, target: ReturnType<typeof offerTarget>,
  intents: readonly GeneratedCrudExposureOperation[],
): Promise<EntityOperationOffer[]> {
  const unavailable = await businessAndLeaseUnavailability(db, session, entityName, table, [target], intents);
  return getEntityOperationOffers(entityName, session, intents, unavailable.get(target.id), target);
}

/** Bind each record mutation to its canonical identity and current version. */
export function entityRecordOfferBinding(
  operation: EntityOperationContract,
  target?: { id: string; version?: string },
): { binding: OperationTargetBinding } | Record<string, never> {
  if (
    !target ||
    (operation.intent !== "update" && operation.intent !== "delete")
  ) {
    return {};
  }
  const plugin = operation.implementation?.type === "plugin";
  const inputField = plugin
    ? operation.target?.scope === "record" ? operation.target.inputField : undefined
    : typeof operation.input.identityField === "string" ? operation.input.identityField : undefined;
  if (!inputField) return {};
  return {
    binding: {
      target: {
        entityId: plugin ? operation.target!.entityId : operation.entityId,
        id: target.id,
        ...(target.version ? { version: target.version } : {}),
      },
      input: { [inputField]: target.id },
    },
  };
}

export function offerTarget(
  row: Readonly<Record<string, unknown>>,
  table: GeneratedCrudTable,
): { id: string; version?: string; row: Readonly<Record<string, unknown>> } {
  const primaryColumn = table.columns.find(({ name }) => name === table.primaryKey);
  const idKey = primaryColumn ? fieldNameForColumn(primaryColumn) : table.primaryKey!;
  // Native CRUD returns storage keys; plugin results may already use authored
  // keys. Offers are built before the public result serializer runs.
  const id = String(row[primaryColumn?.name ?? idKey] ?? row[idKey] ?? "");
  const versionColumn = table.columns.find((column) => fieldNameForColumn(column) === "updatedAt");
  const version = row[versionColumn?.name ?? "updatedAt"] ?? row.updatedAt;
  return {
    id,
    row,
    ...(typeof version === "string" && version ? { version: normalizeTimestampToken(version) } : {}),
  };
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
    // Authorization precedes request controls and database access. Otherwise
    // an unauthorized caller can distinguish lease/version/challenge state
    // even though the underlying mutation still refuses the write later.
    requireEntityOperation(table, request.operation.intent, session);
    const entityName = authoredEntityId(table);
    const operation = entityOperationContract(request.operation.id);
    if (operation.implementation?.type === "plugin") {
      if (operation.intent !== "create" && operation.intent !== "update" &&
        operation.intent !== "delete") {
        throw generatedCrudError(
          `Entity operation ${operation.id} has an unsupported plugin-backed intent.`,
          "INTERNAL_SERVER_ERROR",
        );
      }
      await requireOperationPrerequisites(db, session, operation);
      if (operation.intent === "delete") {
        const data = await executeEntityPlugin(
          db,
          session,
          operation as EntityOperationContract & { intent: "delete" },
          request.input ?? {},
        );
        return {
          intent: "delete",
          data,
          operations: getEntityOperationOffers(
            entityName,
            session,
            projectedOfferIntents(request, COLLECTION_OFFER_INTENTS),
          ),
        };
      }
      const data = await executeEntityPlugin(
        db,
        session,
        operation as EntityOperationContract & { intent: "create" | "update" },
        request.input ?? {},
      );
      return {
        intent: operation.intent,
        data,
        operations: await currentRecordOffers(db, session, entityName, table, offerTarget(data, table),
          projectedOfferIntents(request, RECORD_OFFER_INTENTS)),
      };
    }
    const collectionError = collectionMutationError(table, request.operation.intent, getGeneratedCrudTables(), request.input?.values);
    if (collectionError) throw operationFailure(collectionError);
    switch (request.operation.intent) {
      case "list": {
        const connection = await listGeneratedEntities(db, session, {
          table: table.name,
          ...request.input,
        });
        const targets = connection.rows.map((row) => offerTarget(row, table));
        const unavailableByTarget = await businessAndLeaseUnavailability(
          db,
          session,
          entityName,
          table,
          targets,
          projectedOfferIntents(request, RECORD_OFFER_INTENTS),
        );
        return {
          intent: "list",
          data: {
            items: connection.rows.map((row, index) => ({
              data: row,
              operations: getEntityOperationOffers(
                entityName,
                session,
                projectedOfferIntents(request, RECORD_OFFER_INTENTS),
                unavailableByTarget.get(targets[index]!.id) ?? {},
                targets[index],
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
        const unavailableByTarget = data
          ? await businessAndLeaseUnavailability(
              db,
              session,
              entityName,
              table,
              [offerTarget(data, table)],
              projectedOfferIntents(request, RECORD_OFFER_INTENTS),
            )
          : new Map();
        return {
          intent: "get",
          data,
          operations: data
            ? getEntityOperationOffers(
                entityName,
                session,
                projectedOfferIntents(request, RECORD_OFFER_INTENTS),
                unavailableByTarget.get(offerTarget(data, table).id) ?? {},
                offerTarget(data, table),
              )
            : [],
        };
      }
      case "create": {
        await requireOperationPrerequisites(db, session, operation);
        requireCreateOperationConfirmation(operation, request.input);
        const interactionError = secureInputInteractionError(operation);
        if (interactionError) return { intent: "create", error: interactionError };
        const blueprintId = typeof request.input?.blueprintId === "string" ? request.input.blueprintId : undefined;
        const values = blueprintId === undefined ? requireValues(request.input) : request.input?.values ?? {};
        requireContractValues(operation, table, values, { partial: blueprintId !== undefined });
        const data = blueprintId !== undefined
          ? await createFromBlueprint(db, session, table, blueprintId, values)
          : await createGeneratedEntity(db, session, { table: table.name, values });
        return {
          intent: "create",
          data,
          operations: await currentRecordOffers(db, session, entityName, table, offerTarget(data, table),
            projectedOfferIntents(request, RECORD_OFFER_INTENTS)),
        };
      }
      case "update": {
        for (const permission of operation.authorization.recordPermissions ?? []) {
          await assertRecordPermission(
            db,
            session,
            table,
            requireId(request.input),
            permission,
          );
        }
        const concurrencyGuard = mutationConcurrencyGuard(operation, request.input);
        const confirmation = await prepareMutationConfirmation(
          db,
          session,
          operation,
          table,
          request.input,
          concurrencyGuard,
        );
        if (!confirmation.ready) return { intent: "update", error: confirmation.error };
        const guard = concurrencyGuard
          ? {
              ...concurrencyGuard,
              operation: operation as ChallengeProtectedOperation & LeaseProtectedOperation,
              ...(confirmation.confirmationToken
                ? {
                    confirmationToken: confirmation.confirmationToken,
                    confirmationAnswer: confirmation.confirmationAnswer!,
                  }
                : {}),
            }
          : undefined;
        const values = requireValues(request.input);
        requireContractValues(operation, table, values, { partial: true });
        const data = await updateGeneratedEntity(db, session, {
          table: table.name,
          id: requireId(request.input),
          values,
          ...(guard ? { guard } : {}),
        });
        return {
          intent: "update",
          data,
          operations: data
            ? await currentRecordOffers(db, session, entityName, table, offerTarget(data, table),
                projectedOfferIntents(request, RECORD_OFFER_INTENTS))
            : [],
        };
      }
      case "delete": {
        for (const permission of operation.authorization.recordPermissions ?? []) {
          await assertRecordPermission(
            db,
            session,
            table,
            requireId(request.input),
            permission,
          );
        }
        const concurrencyGuard = mutationConcurrencyGuard(operation, request.input);
        const confirmation = await prepareMutationConfirmation(
          db,
          session,
          operation,
          table,
          request.input,
          concurrencyGuard,
        );
        if (!confirmation.ready) return { intent: "delete", error: confirmation.error };
        const guard = concurrencyGuard
          ? {
              ...concurrencyGuard,
              operation: operation as ChallengeProtectedOperation & LeaseProtectedOperation,
              ...(confirmation.confirmationToken
                ? {
                    confirmationToken: confirmation.confirmationToken,
                    confirmationAnswer: confirmation.confirmationAnswer!,
                  }
                : {}),
            }
          : undefined;
        const deleted = await deleteGeneratedEntity(db, session, {
          table: table.name,
          id: requireId(request.input),
          ...(guard ? { guard } : {}),
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
    const operationError = operationErrorOf(error);
    // A canonical failure is the answer; anything else is a defect. Report it
    // before it collapses into the opaque internal error the caller sees, so
    // the server log holds the cause (#471). Message only — no input, no session.
    if (!operationError) {
      console.error(
        `[entity-runtime] ${request.operation.id} (${request.operation.intent}) failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
        sanitizeError(error, "entity.unexpected"),
      );
    }
    return {
      intent: request.operation.intent,
      error: operationError ?? internalOperationError(),
    } as EntityOperationResult;
  }
}
