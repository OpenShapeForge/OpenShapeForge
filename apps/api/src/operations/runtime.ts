// SPDX-License-Identifier: BUSL-1.1
import { withConnectionDelegationOrigin, withConnectionGrantSubject } from "../auth/connection-delegation.js";
import { assertCurrentAccountAuthority } from "../accounts/account-current-authority.js";
import { authorizationProfileDecision } from "../auth/authorization-profile-decision.js";
import { resolveAuthorizationProfileAccess } from "../auth/authorization-profile-session.js";
import { withAuditContext } from "../platform/audit-context.js";
import { liveMaintenanceRunner } from "../modules/maintenance.js";
import { type ValidateFunction } from "ajv/dist/2020.js";
import { sql, type Transaction } from "kysely";
import rawCatalog from "../generated/operations/catalog.json" with { type: "json" };
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import type {
  ModuleOperationErrorResult,
  ModuleOperationHandler,
  ModuleOperationAvailabilityHandler,
  ModuleOperationResult,
  ModuleOperationSuccessResult,
  RuntimeModule,
} from "../modules/contract.js";
import type { RuntimeOperationDefinition } from "@openshapeforge/plugin-runtime";
import {
  operationFailure,
  type OperationEnvelope,
  type OperationError,
  type OperationPrerequisite,
} from "@openshapeforge/operations";
import {
  invokeModuleDeclarativeService,
  invokeModuleHostOperation,
  withModuleOperationSession,
  withModuleOperationTransaction,
} from "../modules/platform.js";
import {
  consumeEntityConfirmationInTransaction,
  issueEntityConfirmationChallenge,
  type ChallengeProtectedOperation,
} from "./entity/confirmation-challenges.js";
import {
  consumeEntityEditLeaseInTransaction,
  type LeaseProtectedOperation,
  validateEntityVersionInTransaction,
} from "./entity/edit-leases.js";
import { policyOperation } from "./entity/subtype-scope.js";
import { withConsumedCollectionLeaseInTransaction } from "./entity/collection-lease-context.js";
import { getGeneratedCrudTables, recordActionTable } from "./entity/catalog.js";
import { resolvePrincipalClass } from "../db/session.js";
import {
  applyOwnedEntityFields,
  assertOwnedTarget,
  captureOwnedTarget,
} from "./entity/owned-fields.js";
import { getEntityOperationOffers } from "./entity/runtime.js";
import { entityBusinessUnavailability } from "./entity/availability.js";
import type { EntityOperationContract, GeneratedCrudTable } from "./entity/types.js";
import {
  assertRecordAction,
  assertRecordActionInTransaction,
  assertRecordPermission,
  assertRecordPermissionInTransaction,
  type RecordPermissionAction,
  recordActionDeclaration,
} from "./entity/record-permissions.js";
import { withAdmittedRecordAction, type AdmittedRecordAction } from "./entity/record-action-admission.js";
import { normalizeTimestampToken } from "../db/timestamps.js";
import { classifyOperationFailure } from "./operation-failure-classification.js";
import { OperationRefusal } from "./operation-refusal.js";
import { issueOperationPrerequisiteReceipt } from "./prerequisite-receipts.js";
import { sessionOperationRoleGroupsAllow, sessionOperationRolesAllow } from "./session-authorization.js";
import { operationContractFingerprint } from "./contract-fingerprint.js";
import { createOperationAjv } from "./operation-ajv.js";
import { executeKeyedOperation } from "./execution-receipts.js";
import type { DB } from "../generated/db/types.js";
import { evaluateOperationAvailability } from "./availability.js";
import { assertOperationAdmitted } from "./execution-policy.js";
import { capabilityGrantRefusal, consumeCapabilityGrantInTransaction } from "./capability-grant-resolution.js";

export type OperationContract = {
  /** Compiler-owned source-adapter normalization. No shape guessing or authored override. */
  resultProjection?: { kind: "entity-record"; entityName: string; idField: string };
  key: string;
  /** Built-in executor selected only by the compiler, never request input. */
  implementation?:
    | { type: "ownedDelete"; plan: import("@openshapeforge/operations").OwnedDeletePlan }
    | { type: "collection"; entityName: string; field: string; action: "insert" | "move" | "update" | "remove" }
    | { type: "collection-options"; sources: Array<{entity:string;labels?:{en?:string;nl?:string};list:string;get?:string;labelField?:string;fields:Record<string,{type:string;many:boolean}>}> }
    | { type: "application-search"; sources: Array<{entity:string;labels:Record<string,string>;description:string|Record<string,string>;list:string;get?:string;field?:string;descriptionField?:string}> }
    | { type: "color-palette" }
    | { type: "entity-type-list"; labels: Record<string, { en: string; nl: string }> }
    | { type: "constrained-reference-create"; targetEntityName: string; collectionEntityName?: string; parentField?: string; targetValues: Record<string, string | number | boolean>; childValues?: Record<string, string | number | boolean> };
  /** Static Operations default to invoke; Entity-backed handlers retain CRUD intent. */
  intent?: "invoke" | "create" | "update" | "delete";
  plugin: string;
  title: string;
  description: string;
  handler: string;
  target?: {
    entityId: string;
    entityName: string;
    scope: "collection" | "record";
    inputField?: string;
    inputBindings?: Record<string, string>;
  };
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  errors: {
    status: number;
    code: string;
    description: string;
    schema?: Record<string, unknown>;
    rest?: { body?: unknown; contentType?: string };
  }[];
  auth:
    | { mode: "public" }
    | { mode: "control"; roles: string[] }
    | {
        mode: "session";
        roles?: string[];
        roleGroups?: string[][];
        scopes?: string[];
        recordPermission?: RecordPermissionAction;
        recordPermissions?: readonly RecordPermissionAction[];
        /**
         * A named action on the target record, independent of its `view`:
         * see docs/operations.md. Checked beside any recordPermissions, never
         * instead of them.
         */
        recordAction?: string;
      }
    | { mode: "capability" }
    | { mode: "custom"; scheme: string; description: string; securityScheme: Record<string, unknown> };
  tenancy: { mode: "required" | "derived" | "none"; description?: string };
  idempotency: { mode: "none" | "intrinsic" | "idempotency-key"; header?: string; inputField?: string; description?: string };
  effects: {
    data: "read" | "write" | "delete";
    external: "none" | "read" | "write";
  };
  concurrency?: import("@openshapeforge/operations").OperationConcurrency;
  confirmation?: import("@openshapeforge/operations").OperationConfirmation;
  prerequisites?: readonly OperationPrerequisite[];
  transports: {
    rest: { method: string; path: string; response: { status?: number; kind: "json" | "binary" | "stream"; contentType?: string } };
    mcp: { enabled: boolean; name?: string; reason?: string };
    graphql: { enabled: boolean; kind?: "query" | "mutation"; field?: string; reason?: string };
    typescript: { enabled: boolean; functionName?: string; reason?: string };
  };
};

const catalog = rawCatalog as unknown as {
  version: number;
  operations: OperationContract[];
  entityOperations?: EntityOperationContract[];
};
const ajv = createOperationAjv();
const defaultErrorSchema = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
      },
    },
  },
} as const;
type OperationValidators = {
  input: ValidateFunction;
  output: ValidateFunction;
  errors: Map<string, ValidateFunction>;
};
const validators = new WeakMap<OperationContract, OperationValidators>();

function errorKey(status: number, code: string): string {
  return `${status}:${code}`;
}

function isJsonContentType(value: string): boolean {
  if (value !== value.trim()) return false;
  const mediaType = value.toLowerCase();
  return mediaType === "application/json" ||
    /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+\+json$/.test(mediaType);
}

function compileValidators(operation: OperationContract): OperationValidators {
  return {
    input: ajv.compile(operation.inputSchema),
    output: ajv.compile(operation.outputSchema),
    errors: new Map(operation.errors.map((error) => [
      errorKey(error.status, error.code),
      ajv.compile(error.schema ?? defaultErrorSchema),
    ])),
  };
}

for (const operation of catalog.operations) {
  validators.set(operation, compileValidators(operation));
}

function validatorsFor(operation: OperationContract) {
  let validation = validators.get(operation);
  if (!validation) {
    validation = compileValidators(operation);
    validators.set(operation, validation);
  }
  return validation;
}

/** Validate a fixed adapter error against the canonical Operation declaration. */
export function isDeclaredOperationErrorBody(
  operation: OperationContract,
  status: number,
  code: string,
  body: unknown,
): boolean {
  const validate = validatorsFor(operation).errors.get(errorKey(status, code));
  return isJsonValue(body) && validate?.(body) === true;
}

/** Validated declared failure carried to each transport's error projection. */
export class DeclaredOperationError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: unknown;
  readonly headers: Record<string, string> | undefined;
  readonly contentType: string | undefined;

  constructor(
    declaration: OperationContract["errors"][number],
    result: ModuleOperationErrorResult,
  ) {
    super(declaration.description);
    this.status = result.status;
    this.code = result.code;
    this.body = result.body;
    this.headers = result.headers;
    this.contentType = result.contentType ?? declaration.rest?.contentType ?? "application/json";
  }
}

export function listOperationContracts(): readonly OperationContract[] {
  return catalog.operations;
}

function operationText(
  value: string | Readonly<Record<string, string>>,
  fallback: string,
): string {
  if (typeof value === "string") return value;
  return value.en ?? value.nl ??
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right))[0]?.[1] ??
    fallback;
}

/**
 * Adapt plugin-backed Entity CRUD into the existing module handler boundary.
 * These contracts are execution-only: entity REST/GraphQL/MCP projections
 * remain the sole public discovery surface for the canonical Entity Operation.
 */
export function entityPluginOperationContracts(): readonly OperationContract[] {
  return (catalog.entityOperations ?? [])
    .filter((operation) => operation.implementation?.type === "plugin")
    .map((operation) => {
      const table = getGeneratedCrudTables().find(
        (candidate) => candidate.source?.authoringEntityName === operation.entityName,
      );
      if (!table) {
        throw new Error(
          `Plugin-backed entity Operation "${operation.id}" has no generated table.`,
        );
      }
      return entityPluginOperationContract(operation, table);
    });
}

/** Pure adapter exported for focused compiler/runtime contract tests. */
export function entityPluginOperationContract(
  operation: EntityOperationContract,
  table: GeneratedCrudTable,
): OperationContract {
  const implementation = operation.implementation;
  const target = operation.target;
  if (!implementation || implementation.type !== "plugin" || !target) {
    throw new Error(
      `Plugin-backed entity Operation "${operation.id}" has an incomplete runtime target.`,
    );
  }
  if (
    target.entityId !== operation.entityId ||
    target.entityName !== operation.entityName ||
    (operation.intent === "create" && target.scope !== "collection") ||
    ((operation.intent === "update" || operation.intent === "delete") &&
      target.scope !== "record") ||
    (operation.intent !== "create" && operation.intent !== "update" &&
      operation.intent !== "delete")
  ) {
    throw new Error(
      `Plugin-backed entity Operation "${operation.id}" has an invalid CRUD target.`,
    );
  }
  if (!operation.inputSchema || !operation.outputSchema) {
    throw new Error(
      `Plugin-backed entity Operation "${operation.id}" has no concrete JSON schemas.`,
    );
  }
  const rest = operation.interfaces?.rest === false ? undefined : operation.interfaces?.rest;
  const graphql = operation.interfaces?.graphql;
  const mcp = operation.interfaces?.mcp;
  const idempotency = operation.reliability.idempotency;
  if (idempotency.mode === "keyed" && !idempotency.inputField) {
    throw new Error(
      `Plugin-backed entity Operation "${operation.id}" has no idempotency input field.`,
    );
  }
  const idempotencyInputField = idempotency.inputField;
  return {
    key: operation.id,
    intent: operation.intent,
    plugin: implementation.plugin,
    title: operationText(operation.name, operation.id),
    description: operationText(operation.description, operation.id),
    handler: implementation.handler,
    target,
    inputSchema: operation.inputSchema,
    outputSchema: operation.outputSchema,
    errors: operation.errors ?? [],
    auth: {
      mode: "session",
      roles: operation.authorization.roles,
      ...((operation.intent === "update" || operation.intent === "delete") &&
      operation.authorization.recordPermissions?.length
        ? { recordPermissions: operation.authorization.recordPermissions }
        : {}),
    },
    tenancy: { mode: table.tenantScoped ? "required" : "none" },
    idempotency: idempotency.mode === "keyed"
      ? {
        mode: "idempotency-key",
        header: "Idempotency-Key",
        inputField: idempotencyInputField!,
      }
      : idempotency.mode === "natural"
      ? { mode: "intrinsic" }
      : { mode: "none" },
    effects: operation.effects,
    ...(operation.concurrency ? { concurrency: operation.concurrency } : {}),
    confirmation: operation.interaction.confirmation,
    ...(operation.prerequisites ? { prerequisites: operation.prerequisites } : {}),
    transports: {
      rest: {
        method: rest && rest.method
          ? rest.method
          : operation.intent === "create"
          ? "POST"
          : operation.intent === "delete"
          ? "DELETE"
          : "PATCH",
        path: rest && rest.path
          ? rest.path
          : `/api/operations/${operation.id}/execute`,
        response: {
          ...(rest?.response?.status !== undefined
            ? { status: rest.response.status }
            : { status: operation.intent === "create" ? 201 : 200 }),
          kind: rest ? (rest.response?.kind ?? "json") : "json",
          ...(rest && rest.response?.contentType
            ? { contentType: rest.response.contentType }
            : {}),
        },
      },
      mcp: mcp === false
        ? { enabled: false, reason: "Disabled by the entity interface contract." }
        : { enabled: true, ...(mcp?.name ? { name: mcp.name } : {}) },
      graphql: graphql === false
        ? { enabled: false, reason: "Disabled by the entity interface contract." }
        : {
          enabled: true,
          kind: graphql?.kind ?? "mutation",
          ...(graphql?.field ? { field: graphql.field } : {}),
        },
      typescript: { enabled: false, reason: "Entity adapters own this Operation." },
    },
  } satisfies OperationContract;
}

function operationIntent(
  operation: OperationContract,
): "invoke" | "create" | "update" | "delete" {
  return operation.intent ?? "invoke";
}

// Server-only provenance: an arbitrary available definition cannot become a
// control Operation by being returned under an operator session.
const runtimeDefinitionAuthModes = new WeakMap<RuntimeOperationDefinition, OperationContract["auth"]["mode"]>();

export function runtimeDefinitionAuthMode(definition: RuntimeOperationDefinition): OperationContract["auth"]["mode"] | undefined {
  return runtimeDefinitionAuthModes.get(definition);
}

export function runtimeDefinition(entry: Bound): RuntimeOperationDefinition {
  const definition: RuntimeOperationDefinition = {
    id: entry.operation.key,
    key: entry.operation.key,
    intent: operationIntent(entry.operation),
    ...(entry.operation.implementation?.type === "collection"
      ? { implementation: entry.operation.implementation }
      : {}),
    name: entry.operation.title,
    description: entry.operation.description,
    ...(entry.operation.target ? { target: entry.operation.target } : {}),
    input: { kind: "json-schema", schema: entry.operation.inputSchema },
    output: { kind: "json-schema", schema: entry.operation.outputSchema },
    effects: entry.operation.effects,
    reliability: {
      idempotency: {
        mode: entry.operation.idempotency.mode === "intrinsic"
          ? "natural"
          : entry.operation.idempotency.mode === "idempotency-key"
            ? "keyed"
            : "none",
        ...(entry.operation.idempotency.mode === "idempotency-key" && entry.operation.idempotency.inputField
          ? { inputField: entry.operation.idempotency.inputField }
          : {}),
      },
    },
    ...(entry.operation.prerequisites
      ? { prerequisites: entry.operation.prerequisites }
      : {}),
    errors: entry.operation.errors.map((error) => ({
      status: error.status,
      code: error.code,
      description: error.description,
    })),
    ...(entry.operation.concurrency
      ? { concurrency: entry.operation.concurrency }
      : {}),
    interaction: {
      confirmation: entry.operation.confirmation ?? { mode: "none" },
    },
  };
  runtimeDefinitionAuthModes.set(definition, entry.operation.auth.mode);
  return definition;
}

/**
 * Nested Operations and entity plugins consume validated Operation failures.
 * GraphQL resolver errors belong to the separate GraphQL contribution surface;
 * arbitrary exceptions from a handler are not declared Operation failures.
 */
export function runtimeOperationError(error: unknown) {
  const projected = error instanceof DeclaredOperationError
    ? error.body
    : classifyOperationFailure(error).body;
  const candidate = projected && typeof projected === "object"
    ? (projected as { error?: Record<string, unknown> }).error
    : undefined;
  return {
    code: typeof candidate?.code === "string"
      ? candidate.code
      : error instanceof DeclaredOperationError
      ? error.code
      : "OPERATION_FAILED",
    message: typeof candidate?.message === "string"
      ? candidate.message
      : error instanceof DeclaredOperationError
      ? error.message
      : "The Operation failed.",
    ...(typeof candidate?.detail === "string"
      ? { detail: candidate.detail }
      : {}),
    retryable: candidate?.retryable === true,
    ...(typeof candidate?.retryAt === "string"
      ? { retryAt: candidate.retryAt }
      : {}),
    ...(candidate?.data && typeof candidate.data === "object"
      ? { data: candidate.data as Record<string, unknown> }
      : {}),
    ...(Array.isArray(candidate?.violations)
      ? {
        violations: candidate.violations as NonNullable<OperationError["violations"]>,
      }
      : {}),
  };
}

export type BoundOperation = {
  operation: OperationContract;
  handler: ModuleOperationHandler;
  maintenanceOwner?: RuntimeModule;
  availability?: ModuleOperationAvailabilityHandler;
};
type Bound = BoundOperation;

export function requireOperationAuthorization(
  operation: OperationContract,
  session: TrustedSessionContext | undefined,
): void {
  // A control Operation takes a control-realm session and nothing else; a
  // tenant credential is refused with the same 401 as no credential, so the
  // refusal discloses nothing about which realm the surface trusts. Which of
  // the realm roles it needs is the Operation's own any-of list.
  if (operation.auth.mode === "control") {
    if (!session || session.credential !== "control-bearer" || !session.userId) {
      throw new OperationRefusal(401, "UNAUTHENTICATED", "Operation requires a control-realm operator token.");
    }
    if (!sessionOperationRolesAllow(operation.auth.roles, session.roles)) {
      throw new OperationRefusal(403, "FORBIDDEN", "Operator lacks a required control-realm role.");
    }
    return;
  }
  // A capability Operation takes the grant session core resolved from the
  // presented token and nothing else; the grant's own Operation list and its
  // subject entity are the whole authorization, there are no roles to consult.
  if (operation.auth.mode === "capability") {
    if (!session || session.credential !== "grant" || !session.grant || !session.tenantId) {
      throw capabilityGrantRefusal("GRANT_INVALID");
    }
    if (!session.grant.operations.includes(operation.key)) throw capabilityGrantRefusal("GRANT_SCOPE");
    if (operation.target && operation.target.entityName !== session.grant.subject.entity) {
      throw capabilityGrantRefusal("GRANT_SCOPE");
    }
    return;
  }
  if (operation.auth.mode !== "session") return;
  // The mirror image: a platform operator has no tenant and is not a session
  // on this surface, whatever roles the control realm gave them — and a grant
  // session covers its listed capability Operations only.
  if (
    !session || session.credential === "none" || session.credential === "control-bearer" ||
    session.credential === "grant" || !session.userId
  ) {
    throw new OperationRefusal(401, "UNAUTHENTICATED", "Operation requires an authenticated bearer session.");
  }
  if (operation.tenancy.mode === "required" && !session.tenantId) {
    throw new OperationRefusal(401, "TENANT_REQUIRED", "Operation requires an authenticated tenant context.");
  }
  const profile = authorizationProfileDecision(session, operation.key, operation.target?.entityName);
  if (profile === false || (profile !== true && !sessionOperationRolesAllow(operation.auth.roles, session.roles))) {
    throw new OperationRefusal(403, "FORBIDDEN", "Session lacks a required operation role.");
  }
  if (!sessionOperationRoleGroupsAllow(operation.auth.roleGroups, session.roles)) {
    throw new OperationRefusal(403, "FORBIDDEN", "Session lacks a required operation role group.");
  }
  const requiredScopes = operation.auth.scopes ?? [];
  if ((session.credential === "api-key" || session.credential === "personal-key") && requiredScopes.length > 0) {
    throw new OperationRefusal(403, "INSUFFICIENT_SCOPE", "OAuth-scoped operations cannot be invoked with an API key.");
  }
  const heldScopes = new Set(session.oauthScopes ?? []);
  if (requiredScopes.some((scope) => !heldScopes.has(scope))) {
    throw new OperationRefusal(403, "INSUFFICIENT_SCOPE", "Session lacks a required OAuth scope.");
  }
  if (!recordActionPrincipalReachable(operation, session)) {
    throw new OperationRefusal(
      403,
      "FORBIDDEN",
      "This Operation is authorized by a record action no session of this kind can hold.",
    );
  }
}

/**
 * Could this session's verified principal class EVER hold the action this
 * Operation requires?
 *
 * An action declares the principal kinds a grant of it may name: `person`
 * admits the ACL's users/groups/roles subjects, `integration` admits a
 * resolved API-key integration, and a `service` or unclassified session
 * satisfies neither. So an application-only action is unreachable to a person
 * no matter which record it names, and vice versa.
 *
 * The record check reaches the same answer — `recordActionAllows` matches the
 * class before it looks at a subject — so this adds no new refusal. What it
 * adds is WHERE: an Operation nothing about this session could ever satisfy is
 * refused before a record is consulted, and is therefore absent from the
 * Operation listing and the MCP catalogue rather than advertised and then
 * refused. A target or declaration that cannot be resolved answers `false`:
 * an Operation whose action the manifest does not carry is unreachable, not
 * open.
 */
function recordActionPrincipalReachable(
  operation: OperationContract,
  session: TrustedSessionContext,
): boolean {
  if (operation.auth.mode !== "session" || !operation.auth.recordAction) return true;
  const entityName = operation.target?.entityName;
  const table = entityName ? recordActionTable(entityName) : undefined;
  const declaration = table
    ? recordActionDeclaration(table, operation.auth.recordAction)
    : undefined;
  if (!declaration) return false;
  switch (resolvePrincipalClass(session)) {
    case "person":
      return declaration.principals.includes("person");
    case "application":
      return declaration.principals.includes("integration");
    default:
      return false;
  }
}

export function asInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OperationRefusal(400, "BAD_USER_INPUT", "Operation input must be an object.");
  }
  return value as Record<string, unknown>;
}

const CUSTOM_MUTATION_CONTROLS = [
  "expectedVersion",
  "leaseToken",
  "confirmed",
  "confirmationToken",
  "confirmationAnswer",
] as const;

type CustomMutationControl = typeof CUSTOM_MUTATION_CONTROLS[number];

function requireStringControl(
  input: Readonly<Record<string, unknown>>,
  key: Exclude<CustomMutationControl, "confirmed">,
): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw operationFailure({
      code: "VALIDATION",
      message: "The supplied mutation control is not valid.",
      detail: `${key} must be a non-empty string.`,
      violations: [{ field: key, code: "INVALID_TYPE", message: `${key} must be a non-empty string.` }],
    });
  }
  return value;
}

function targetTable(operation: OperationContract): GeneratedCrudTable {
  const entityName = operation.target?.entityName;
  const table = entityName
    ? getGeneratedCrudTables().find((candidate) =>
        candidate.source?.authoringEntityName === entityName
      )
    : undefined;
  if (!table?.primaryKey) {
    throw operationFailure({
      code: "INTERNAL_SERVER_ERROR",
      message: "The Operation target has no generated CRUD table for record authorization.",
    });
  }
  return table;
}

async function assertCurrentRecordPermission(
  operation: OperationContract,
  input: Readonly<Record<string, unknown>>,
  context: Parameters<ModuleOperationHandler>[1],
  trx: Transaction<DB>,
): Promise<void> {
  const recordPermissions = operationRecordPermissions(operation);
  const recordActions = operationRecordActions(operation);
  if (authorizationProfileDecision(context.session, operation.key, operation.target?.entityName) === true) {
    if (operation.target?.scope === "record" && operation.target.inputField) {
      const target = input[operation.target.inputField];
      const table = targetTable(operation);
      if (recordActions.length === 0) {
        const { fetchGeneratedEntityRow } = await import("./entity/queries.js");
        if (typeof target !== "string" || !await fetchGeneratedEntityRow(trx, context.session!, table, target, true)) {
          throw operationFailure({ code: "FORBIDDEN", message: "The Operation is not permitted on this record." });
        }
      }
    } else {
      const result = await sql<{ allowed: boolean }>`select app.authorization_allows(${operation.target?.entityName}, '{}'::jsonb) as allowed`.execute(trx);
      if (result.rows[0]?.allowed !== true) throw operationFailure({ code: "FORBIDDEN", message: "The Operation is not permitted." });
    }
  }
  if (recordPermissions.length === 0 && recordActions.length === 0) return;
  if (!operation.target || operation.target.scope !== "record" ||
    !operation.target.inputField || !context.session || !context.db) {
    throw operationFailure({
      code: "INTERNAL_SERVER_ERROR",
      message: "The protected Operation contract is incomplete.",
    });
  }
  const targetValue = input[operation.target.inputField];
  if (typeof targetValue !== "string" || targetValue.trim() === "") {
    throw operationFailure({
      code: "VALIDATION",
      message: "The Operation target is not valid.",
      violations: [{
        field: operation.target.inputField,
        code: "REQUIRED",
        message: `${operation.target.inputField} must be a non-empty string.`,
      }],
    });
  }
  for (const permission of recordPermissions) {
    await assertRecordPermissionInTransaction(
      trx,
      context.session,
      targetTable(operation),
      targetValue,
      permission,
    );
  }
  for (const action of recordActions) {
    await assertRecordActionInTransaction(
      trx,
      context.session,
      targetTable(operation),
      targetValue,
      action,
    );
  }
}

function operationRecordPermissions(
  operation: OperationContract,
): readonly RecordPermissionAction[] {
  if (operation.auth.mode !== "session") return [];
  return operation.auth.recordPermissions ??
    (operation.auth.recordPermission ? [operation.auth.recordPermission] : []);
}

/**
 * The named record actions this Operation requires. A separate list from the
 * record PERMISSIONS above because the two are checked independently: an
 * action never implies `view`, so satisfying one says nothing about the other.
 */
function operationRecordActions(operation: OperationContract): readonly string[] {
  if (operation.auth.mode !== "session") return [];
  return operation.auth.recordAction ? [operation.auth.recordAction] : [];
}

function protectedCustomOperation(
  operation: OperationContract,
): ChallengeProtectedOperation & LeaseProtectedOperation {
  const intent = operationIntent(operation);
  if (!operation.target || intent === "create") {
    throw operationFailure({
      code: "INTERNAL_SERVER_ERROR",
      message: "The protected Operation has no valid record target.",
    });
  }
  return {
    id: operation.key,
    entityId: operation.target.entityId,
    entityName: operation.target.entityName,
    intent,
    ...(operation.concurrency ? { concurrency: operation.concurrency } : {}),
    interaction: { confirmation: operation.confirmation ?? { mode: "none" } },
  };
}

function customHandlerInput(
  operation: OperationContract,
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const stripped = { ...input };
  // Native collection execution validates the caller's original version in the
  // already guarded transaction. Plugin handlers receive no platform controls.
  if (operation.concurrency?.version && operation.implementation?.type !== "collection") delete stripped.expectedVersion;
  if (operation.concurrency?.editLease) delete stripped.leaseToken;
  if (operation.confirmation?.mode === "acknowledgement") delete stripped.confirmed;
  if (operation.confirmation?.mode === "challenge") {
    delete stripped.confirmationToken;
    delete stripped.confirmationAnswer;
  }
  return stripped;
}

async function invokeCustomOperationWithControls(
  bound: Bound,
  input: Readonly<Record<string, unknown>>,
  context: Parameters<ModuleOperationHandler>[1],
  invokeHandler: (handlerInput: Record<string, unknown>) => Promise<ModuleOperationSuccessResult>,
): Promise<ModuleOperationSuccessResult> {
  const operation = bound.operation;
  if (operation.auth.mode === "capability") {
    // The grant is used in the handler's transaction: a handler that fails
    // leaves it usable, a single-use grant that succeeded is spent for good.
    // Any further guard below joins this same transaction.
    const session = context.session;
    if (!session || session.credential !== "grant" || !context.platform) {
      throw capabilityGrantRefusal("GRANT_INVALID");
    }
    return withModuleOperationTransaction(context.platform, session, async (trx) => {
      await consumeCapabilityGrantInTransaction(trx, session, operation.key);
      return invokeGuardedCustomOperation(bound, input, context, invokeHandler);
    });
  }
  // Data-writing plugin handlers need the same owning Operation transaction
  // even when their invoke contract has no record/version/confirmation guard.
  // This joins a keyed receipt transaction and keeps artifact binding and
  // canonical data changes atomic. Control handlers own audited system
  // transactions: their verified operator session deliberately has no tenant.
  // Unhosted contract tests may have no platform.
  if (operation.auth.mode !== "control" && operation.effects.data === "write" && context.platform && context.session) {
    return withModuleOperationTransaction(context.platform, context.session, () =>
      invokeGuardedCustomOperation(bound, input, context, invokeHandler));
  }
  return invokeGuardedCustomOperation(bound, input, context, invokeHandler);
}

/**
 * Every custom Operation handler runs with ITS OWN record-action admission
 * and never with an enclosing one (entity/record-action-admission.ts). A
 * handler that dispatches a second Operation would otherwise lend its
 * authorized target to that Operation's handler, and a second plugin could
 * read a record it was never authorized on.
 */
function invokeGuardedCustomOperation(
  bound: Bound,
  input: Readonly<Record<string, unknown>>,
  context: Parameters<ModuleOperationHandler>[1],
  invokeHandler: (handlerInput: Record<string, unknown>) => Promise<ModuleOperationSuccessResult>,
): Promise<ModuleOperationSuccessResult> {
  return withAdmittedRecordAction(null, () =>
    guardedCustomOperation(bound, input, context, invokeHandler));
}

async function guardedCustomOperation(
  bound: Bound,
  input: Readonly<Record<string, unknown>>,
  context: Parameters<ModuleOperationHandler>[1],
  invokeHandler: (handlerInput: Record<string, unknown>) => Promise<ModuleOperationSuccessResult>,
): Promise<ModuleOperationSuccessResult> {
  const operation = bound.operation;
  if(operation.auth.mode==='session' && operation.auth.roles?.includes('Organization.Security.Manage') && context.session?.issuer && context.session.tenantId && context.session.userId && context.platform && context.db) {
    const principal=context.session as TrustedSessionContext & {tenantId:string;userId:string};
    await withModuleOperationTransaction(context.platform,principal,trx=>assertCurrentAccountAuthority(context.db!,trx,principal,'Organization.Security.Manage'));
  }
  const confirmation = operation.confirmation ?? { mode: "none" as const };
  if (confirmation.mode === "acknowledgement" && input.confirmed !== true) {
    throw operationFailure({
      code: "CONFIRMATION_REQUIRED",
      message: `Confirm ${operation.title} before continuing.`,
      detail: "Retry the Operation with confirmed set to true.",
      retryable: true,
      data: { confirmation: { kind: "acknowledgement", requiredValue: true } },
    });
  }
  const recordPermissions = operationRecordPermissions(operation);
  const recordActions = operationRecordActions(operation);
  const profileGuard = authorizationProfileDecision(context.session, operation.key, operation.target?.entityName) === true;
  const forcesTransaction = operationIntent(operation) !== "invoke";
  const hasGuard = Boolean(
    profileGuard ||
    bound.availability ||
    operation.concurrency ||
    confirmation.mode === "challenge" ||
    recordPermissions.length > 0 ||
    recordActions.length > 0 ||
    forcesTransaction,
  );
  if (!hasGuard) return invokeHandler(customHandlerInput(operation, input));
  if (profileGuard && operation.target?.scope === "collection") {
    if (!context.platform || !context.session) throw operationFailure({ code: "FORBIDDEN", message: "A verified tenant session is required." });
    return withModuleOperationTransaction(context.platform, context.session, async trx => {
      const decision = await sql<{ allowed: boolean }>`select app.authorization_allows(${operation.target!.entityName}, '{}'::jsonb) as allowed`.execute(trx);
      if (decision.rows[0]?.allowed !== true) throw operationFailure({ code: "FORBIDDEN", message: "The Operation is not permitted." });
      return invokeHandler(customHandlerInput(operation, input));
    });
  }

  if (
    forcesTransaction &&
    operation.target?.scope === "collection" &&
    !operation.concurrency &&
    confirmation.mode !== "challenge" &&
    recordPermissions.length === 0 &&
    recordActions.length === 0
  ) {
    if (!context.session || !context.db || !context.platform) {
      throw operationFailure({
        code: "INTERNAL_SERVER_ERROR",
        message: "The Entity Operation transaction is unavailable.",
      });
    }
    return withModuleOperationTransaction(
      context.platform,
      context.session,
      () => invokeHandler(customHandlerInput(operation, input)),
    );
  }
  // Lease and challenge consumption are keyed on the record version; without
  // one they would silently not run.
  if (!operation.target || operation.target.scope !== "record" ||
    !operation.target.inputField || !context.session || !context.db || !context.platform ||
    ((operation.concurrency?.editLease || confirmation.mode === "challenge") && !operation.concurrency?.version)) {
    throw operationFailure({
      code: "INTERNAL_SERVER_ERROR",
      message: "The protected Operation contract is incomplete.",
    });
  }
  const targetValue = input[operation.target.inputField];
  if (typeof targetValue !== "string" || targetValue.trim() === "") {
    throw operationFailure({
      code: "VALIDATION",
      message: "The Operation target is not valid.",
      violations: [{
        field: operation.target.inputField,
        code: "REQUIRED",
        message: `${operation.target.inputField} must be a non-empty string.`,
      }],
    });
  }
  const expectedVersion = operation.concurrency?.version
    ? requireStringControl(input, "expectedVersion")
    : undefined;
  if (expectedVersion) {
    try {
      normalizeTimestampToken(expectedVersion);
    } catch {
      throw operationFailure({
        code: "VALIDATION",
        message: "The supplied record version is not valid.",
        violations: [{
          field: "expectedVersion",
          code: "INVALID_DATETIME",
          message: "Expected version must be a valid timestamp.",
        }],
      });
    }
  }
  const leaseToken = operation.concurrency?.editLease
    ? requireStringControl(input, "leaseToken")
    : undefined;
  // Source-backed record Operations can have business availability without a
  // generated CRUD table. Only platform-owned record guards require one.
  const table = profileGuard || recordPermissions.length > 0 || recordActions.length > 0 ||
    expectedVersion || confirmation.mode === "challenge"
    ? targetTable(operation)
    : undefined;
  // A subtype target's leases and challenges are the base record's
  // (entity/subtype-scope.ts), so the protected contract carries that identity.
  const protectedOperation = table
    ? policyOperation(table, protectedCustomOperation(operation))
    : protectedCustomOperation(operation);
  for (const permission of recordPermissions) {
    await assertRecordPermission(
      context.db,
      context.session,
      table!,
      targetValue,
      permission,
    );
  }
  // Refuse before a challenge or a lease is issued. This read is in its own
  // transaction, so it is an early answer and never the authoritative one —
  // the check inside the Operation's transaction below is, and it is the one
  // holding the lock when the effect runs.
  for (const action of recordActions) {
    await assertRecordAction(context.db, context.session, table!, targetValue, action);
  }
  let confirmationToken: string | undefined;
  let confirmationAnswer: string | undefined;
  if (confirmation.mode === "challenge") {
    const hasToken = input.confirmationToken !== undefined;
    const hasAnswer = input.confirmationAnswer !== undefined;
    if (hasToken !== hasAnswer) {
      throw operationFailure({
        code: "VALIDATION",
        message: "Confirmation token and answer must be supplied together.",
      });
    }
    if (!hasToken) {
      if (!expectedVersion) {
        throw operationFailure({
          code: "INTERNAL_SERVER_ERROR",
          message: "The confirmation version contract is incomplete.",
        });
      }
      const error = await issueEntityConfirmationChallenge(context.db, context.session, {
        operation: protectedOperation,
        table: table!,
        targetId: targetValue,
        expectedVersion,
        ...(leaseToken ? { leaseToken } : {}),
      }, bound.availability ? async trx => {
        const decisions = await evaluateOperationAvailability(operation, bound.availability!, [targetValue], {
          db: trx, session: context.session!,
        });
        const decision = decisions[targetValue]!;
        if (!decision.available) throw operationFailure(decision.error);
      } : undefined);
      throw operationFailure(error);
    }
    confirmationToken = requireStringControl(input, "confirmationToken");
    confirmationAnswer = requireStringControl(input, "confirmationAnswer");
  }
  // The record and the actions this invocation was authorized on, for the
  // handler's bounded read and for nothing else. Established only where it is
  // established at all: below, inside the Operation's transaction, after the
  // decisive `assertRecordActionInTransaction` has passed and under the
  // ACL-row lock it took. An Operation that requires no action admits none,
  // and `invokeGuardedCustomOperation` already cleared whatever an enclosing
  // dispatch had admitted.
  const admitted: AdmittedRecordAction | null =
    recordActions.length > 0 && context.session && operation.target?.entityName
      ? {
        session: context.session,
        entityName: operation.target.entityName,
        id: targetValue,
        actions: new Set(recordActions),
      }
      : null;
  const runHandler = (handlerInput: Record<string, unknown>) =>
    withAdmittedRecordAction(admitted, () => invokeHandler(handlerInput));
  return withModuleOperationTransaction(
    context.platform,
    context.session,
    async (trx) => {
      // Authorize the record inside the effect transaction, independently of get.
      // Named-action reads retain their existing resolver and ACL admission.
      if (profileGuard && recordActions.length === 0) {
        const { fetchGeneratedEntityRow } = await import("./entity/queries.js");
        if (!await fetchGeneratedEntityRow(trx, context.session!, table!, targetValue, true)) {
          throw operationFailure({ code: "FORBIDDEN", message: "The Operation is not permitted on this record." });
        }
      }
      for (const permission of recordPermissions) {
        await assertRecordPermissionInTransaction(
          trx,
          context.session!,
          table!,
          targetValue,
          permission,
        );
      }
      for (const action of recordActions) {
        await assertRecordActionInTransaction(
          trx,
          context.session!,
          table!,
          targetValue,
          action,
        );
      }
      if (expectedVersion) {
        await validateEntityVersionInTransaction(trx, context.session!, {
          operation: protectedOperation,
          table: table!,
          targetId: targetValue,
          expectedVersion,
        });
      }
      if (bound.availability) {
        const decisions = await evaluateOperationAvailability(operation, bound.availability, [targetValue], {
          db: trx, session: context.session!,
        });
        const decision = decisions[targetValue]!;
        if (!decision.available) throw operationFailure(decision.error);
      }
      if (leaseToken && expectedVersion) {
        if (operation.implementation?.type === "collection") {
          return withConsumedCollectionLeaseInTransaction(trx, context.session!, {
            operation: protectedOperation, targetId: targetValue, expectedVersion, leaseToken,
          }, () => runHandler(customHandlerInput(operation, input)));
        }
        await consumeEntityEditLeaseInTransaction(trx, context.session!, {
          operation: protectedOperation,
          targetId: targetValue,
          expectedVersion,
          leaseToken,
        });
      }
      if (confirmationToken && confirmationAnswer && expectedVersion) {
        await consumeEntityConfirmationInTransaction(trx, context.session!, {
          operation: protectedOperation,
          targetId: targetValue,
          expectedVersion,
          confirmationToken,
          confirmationAnswer,
        });
      }
      return runHandler(customHandlerInput(operation, input));
    },
  );
}

const BASE64_BLOCK = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * The optional MCP projection of a success result: JSON-safe content blocks
 * of the kinds the MCP tool result carries. Text needs `text`; image and
 * audio need base64 `data` and a `mimeType`; resource links need a `uri`.
 */
export function isMcpProjection(projection: unknown): boolean {
  if (!projection || typeof projection !== "object" || Array.isArray(projection)) return false;
  const { content, structuredContent } = projection as { content?: unknown; structuredContent?: unknown };
  if (!Array.isArray(content) || content.length === 0 || !isJsonValue(content)) return false;
  if (
    structuredContent !== undefined &&
    (!structuredContent || typeof structuredContent !== "object" || Array.isArray(structuredContent) ||
      !isJsonValue(structuredContent))
  ) {
    return false;
  }
  return content.every((block) => {
    if (!block || typeof block !== "object") return false;
    const { type, text, data, mimeType, uri } = block as Record<string, unknown>;
    switch (type) {
      case "text":
        return typeof text === "string";
      case "image":
      case "audio":
        return typeof data === "string" && BASE64_BLOCK.test(data) && typeof mimeType === "string";
      case "resource_link":
        return typeof uri === "string";
      default:
        return false;
    }
  });
}

function isJsonValue(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  seen.add(value);
  let valid = true;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value) || !isJsonValue(value[index], seen)) {
        valid = false;
        break;
      }
    }
  } else {
    valid = Object.values(value).every((entry) => isJsonValue(entry, seen));
  }
  seen.delete(value);
  return valid;
}

function isCanonicalSuccessEnvelope(value: unknown): value is OperationEnvelope<unknown> {
  const object = (entry: unknown): entry is Record<string, unknown> => entry !== null && typeof entry === "object" && !Array.isArray(entry);
  const text = (entry: unknown) => typeof entry === "string" && entry.length > 0;
  if (!object(value) || !isJsonValue(value) || "error" in value || !Object.hasOwn(value, "data") || !Array.isArray(value.operations)) return false;
  if (!value.operations.every((offer) => object(offer) && object(offer.operation)
    && text(offer.operation.id) && text(offer.operation.intent)
    && (offer.available === true ? !("error" in offer)
      : offer.available === false && object(offer.error) && text(offer.error.code)
        && text(offer.error.message) && typeof offer.error.retryable === "boolean"))) return false;
  return value.resources === undefined || (Array.isArray(value.resources) && value.resources.every((resource) =>
    object(resource) && text(resource.uri) && text(resource.name)
      && ["title", "description", "mimeType"].every((field) => resource[field] === undefined || typeof resource[field] === "string")));
}

function decodedOperationSuccess(
  operation: OperationContract,
  validation: OperationValidators,
  value: unknown,
): ModuleOperationSuccessResult {
  if (!value || typeof value !== "object" || Array.isArray(value) || !isJsonValue(value) ||
    !Object.hasOwn(value, "value")) {
    throw new Error("Stored Operation receipt is not a canonical success result.");
  }
  const result = value as ModuleOperationSuccessResult;
  if (result.ok !== undefined && result.ok !== true) {
    throw new Error("Stored Operation receipt has an invalid success discriminant.");
  }
  if (result.resultKind !== undefined &&
    (result.resultKind !== "operation-envelope" || !isCanonicalSuccessEnvelope(result.value))) {
    throw new Error("Stored Operation receipt has an invalid canonical envelope.");
  }
  const declaredStatus = operation.transports.rest.response.status ?? 200;
  if (result.status !== undefined && result.status !== declaredStatus) {
    throw new Error("Stored Operation receipt has an invalid response status.");
  }
  if (operation.transports.rest.response.kind !== "json" || !validation.output(result.value)) {
    throw new Error("Stored Operation receipt has an invalid canonical output.");
  }
  if (result.mcp !== undefined && !isMcpProjection(result.mcp)) {
    throw new Error("Stored Operation receipt has an invalid MCP projection.");
  }
  if (result.headers !== undefined && Object.entries(result.headers).some(
    ([name, header]) => name === "" || typeof header !== "string",
  )) {
    throw new Error("Stored Operation receipt has invalid response headers.");
  }
  if (result.contentType !== undefined && typeof result.contentType !== "string") {
    throw new Error("Stored Operation receipt has an invalid content type.");
  }
  return result;
}

export type InvokeOperationOptions = {
  /** Core-owned normalization that runs inside the guarded write transaction. */
  prepareSuccess?: (
    result: ModuleOperationSuccessResult,
    context: Parameters<ModuleOperationHandler>[1],
  ) => Promise<ModuleOperationSuccessResult> | ModuleOperationSuccessResult;
};

/**
 * REST binds its own input, and this check applies on every path into a
 * capability Operation, a handler's nested execute included.
 */
function assertGrantSubjectTarget(
  operation: OperationContract,
  session: TrustedSessionContext | undefined,
  input: Record<string, unknown>,
): void {
  if (operation.auth.mode !== "capability") return;
  const field = operation.target?.inputField;
  if (field && input[field] !== session?.grant?.subject.id) throw capabilityGrantRefusal("GRANT_SCOPE");
}

export async function invokeOperation(
  bound: Bound,
  inputValue: unknown,
  context: Omit<
    Parameters<ModuleOperationHandler>[1],
    "invokeHostOperation" | "invokeDeclarativeService" | "runSeed"
  > & Partial<Pick<
    Parameters<ModuleOperationHandler>[1],
    "invokeHostOperation" | "invokeDeclarativeService"
  >>,
  options: InvokeOperationOptions = {},
): Promise<ModuleOperationSuccessResult> {
  const input = asInput(inputValue);
  const ownedTarget = captureOwnedTarget(bound.operation, input);
  const run = async (activeContext: Parameters<ModuleOperationHandler>[1]) => {
    if (activeContext.session) await resolveAuthorizationProfileAccess(activeContext.session, activeContext.db);
    requireOperationAuthorization(bound.operation, activeContext.session);
    assertGrantSubjectTarget(bound.operation, activeContext.session, input);
    // Host execution policies, on the declared effects of the Operation that
    // is actually about to run. Without a database no policy can be
    // registered, so the check is skipped with it.
    const admit = async () => {
      if (!activeContext.db) return;
      await assertOperationAdmitted(activeContext.db, activeContext.session, {
        id: bound.operation.key,
        intent: operationIntent(bound.operation),
        effects: bound.operation.effects,
      });
    };
    // The early decision: after authorization, so a refusal discloses nothing
    // to a caller who was never allowed the action, and before the input
    // schema, the keyed receipt, any transaction and the handler — so the
    // ordinary refusal is friendly and precedes every effect. A nested
    // `execute` reaches this again on its own Operation's declaration, so a
    // read cannot lend its admission to a write it dispatches. It is decided
    // again inside the owning transaction below, immediately before effects:
    // this one can be minutes old by the time a lease, a challenge or a row
    // lock has been consumed.
    await admit();
    const validation = validatorsFor(bound.operation);
    // The compiler augments a custom Operation's canonical schema with the
    // platform-owned mutation controls. Validate that complete request before
    // acknowledgement, lease, version or challenge handling can have side
    // effects. The handler receives only authored business input below.
    if (!validation.input(input)) {
      throw new OperationRefusal(400, "BAD_USER_INPUT", "Operation input does not match its canonical schema.");
    }
    const invokeHandler = async (
      handlerInput: Record<string, unknown>,
    ): Promise<ModuleOperationSuccessResult> => {
      let result: ModuleOperationResult;
      try {
        result = await bound.handler(handlerInput, activeContext);
      } catch (error) {
        if (error instanceof DeclaredOperationError) {
          throw new OperationRefusal(
            500,
            "HANDLER_CONTRACT_VIOLATION",
            "Operation handlers must return declared errors instead of forwarding a transport error.",
          );
        }
        throw error;
      }
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        throw new OperationRefusal(
          500,
          "HANDLER_CONTRACT_VIOLATION",
          "Operation handler must return an operation result object.",
        );
      }
      if ("ok" in result && result.ok !== true && result.ok !== false) {
        throw new OperationRefusal(
          500,
          "HANDLER_CONTRACT_VIOLATION",
          "Operation handler returned an invalid result discriminant.",
        );
      }
      if (result.ok === false) {
        const declaration = bound.operation.errors.find((error) =>
          error.status === result.status && error.code === result.code
        );
        if (!declaration) {
          throw new OperationRefusal(
            500,
            "HANDLER_CONTRACT_VIOLATION",
            "Operation handler returned an undeclared error status or code.",
          );
        }
        if (!isJsonValue(result.body)) {
          throw new OperationRefusal(
            500,
            "HANDLER_CONTRACT_VIOLATION",
            "Operation handler returned a non-serializable error body.",
          );
        }
        const validate = validation.errors.get(errorKey(result.status, result.code))!;
        if (!validate(result.body)) {
          throw new OperationRefusal(
            500,
            "HANDLER_CONTRACT_VIOLATION",
            "Operation handler returned a body outside its declared error schema.",
          );
        }
        if (!declaration.schema) {
          const bodyCode = (result.body as { error?: { code?: unknown } }).error?.code;
          if (bodyCode !== result.code) {
            throw new OperationRefusal(
              500,
              "HANDLER_CONTRACT_VIOLATION",
              "Operation handler returned an error code inconsistent with the default error body.",
            );
          }
        }
        const declaredContentType = declaration.rest?.contentType ?? "application/json";
        const headerContentType = Object.entries(result.headers ?? {})
          .find(([name]) => name.toLowerCase() === "content-type")?.[1];
        if (
          !isJsonContentType(declaredContentType) ||
          (result.contentType !== undefined && result.contentType !== declaredContentType) ||
          (headerContentType !== undefined && headerContentType !== declaredContentType)
        ) {
          throw new OperationRefusal(
            500,
            "HANDLER_CONTRACT_VIOLATION",
            "Operation handler returned an error content type outside its declaration.",
          );
        }
        throw new DeclaredOperationError(declaration, result);
      }
      let success = result as ModuleOperationSuccessResult;
      if (bound.operation.resultProjection) {
        const projection = bound.operation.resultProjection;
        const record = success.value as Record<string, unknown> | undefined;
        const id = record?.[projection.idField];
        if (success.resultKind || !record || typeof record !== "object" || Array.isArray(record) ||
            typeof id !== "string" || id !== input[bound.operation.target?.inputField ?? "id"]) {
          throw new OperationRefusal(500, "HANDLER_CONTRACT_VIOLATION", "The source adapter must return the requested record, not an envelope or another target.");
        }
        const visible = getEntityOperationOffers(projection.entityName, activeContext.session!, [], {}, { id, row: record });
        const unavailable = activeContext.db && activeContext.session
          ? (await entityBusinessUnavailability(activeContext.db, activeContext.session,
              [{ id, operationIds: visible.map(offer => offer.operation.id) }])).get(id) ?? {}
          : {};
        success = { ...success, resultKind: "operation-envelope", value: { data: record,
          operations: getEntityOperationOffers(projection.entityName, activeContext.session!, [], unavailable, { id, row: record }) } };
      }
      if (options.prepareSuccess) {
        success = await options.prepareSuccess(success, activeContext);
        if (!success || typeof success !== "object" || Array.isArray(success)) {
          throw new OperationRefusal(
            500,
            "HANDLER_CONTRACT_VIOLATION",
            "Core Operation result normalization returned an invalid success result.",
          );
        }
      }
      if (success.resultKind !== undefined &&
        (success.resultKind !== "operation-envelope" || !isCanonicalSuccessEnvelope(success.value))) {
        throw new OperationRefusal(500, "HANDLER_CONTRACT_VIOLATION", "Operation handler returned an invalid canonical success envelope.");
      }
      const declaredStatus = bound.operation.transports.rest.response.status ?? 200;
      if (success.status !== undefined && success.status !== declaredStatus) {
        throw new OperationRefusal(500, "HANDLER_CONTRACT_VIOLATION", "Operation handler returned an undeclared success status.");
      }
      if (bound.operation.transports.rest.response.kind === "json" && !validation.output(success.value)) {
        throw new OperationRefusal(500, "HANDLER_CONTRACT_VIOLATION", "Operation handler returned a value outside its canonical output schema.");
      }
      if (success.mcp !== undefined && !isMcpProjection(success.mcp)) {
        throw new OperationRefusal(
          500,
          "HANDLER_CONTRACT_VIOLATION",
          "Operation handler returned an MCP projection that is not a list of well-formed content blocks.",
        );
      }
      return success;
    };
    const execute = async (markEffectsAdmitted: () => void) => {
      const result = await invokeCustomOperationWithControls(
        bound,
        input,
        activeContext,
        async (handlerInput) => {
          // The decisive admission: inside the owning Operation transaction
          // when there is one, after every record lock, availability
          // decision, lease and confirmation this invocation consumed, and
          // before `markEffectsAdmitted` — so a refusal here neither leaves a
          // receipt claiming success nor reports an uncertain external
          // delivery. It is the same decision, on live state.
          await admit();
          markEffectsAdmitted();
          return invokeHandler(handlerInput);
        },
      );
      const prerequisiteTargets = (catalog.entityOperations ?? []).filter((operation) =>
        operation.prerequisites?.some((prerequisite) =>
          prerequisite.operation === bound.operation.key
        )
      );
      if (prerequisiteTargets.length > 0) {
        if (!activeContext.db || !activeContext.session) {
          throw operationFailure({
            code: "PREREQUISITE_RECEIPT_UNAVAILABLE",
            message: "This prerequisite requires a verified interactive login session.",
            detail: "Sign in with a user account and complete the prerequisite again.",
            retryable: false,
          });
        }
        for (const target of prerequisiteTargets) {
          await issueOperationPrerequisiteReceipt(
            activeContext.db,
            activeContext.session,
            {
              sourceOperationId: bound.operation.key,
              targetOperationId: target.id,
            },
          );
        }
      }
      return result;
    };

    if (bound.operation.idempotency.mode !== "idempotency-key") {
      return execute(() => undefined);
    }
    if (!activeContext.db || !activeContext.platform || !activeContext.session) {
      // A direct unhosted invocation remains useful for pure contract tests,
      // but no registered adapter may claim durable keyed execution without
      // the core database/platform boundary.
      if (activeContext.transport !== "operation" && !activeContext.request && !activeContext.reply) {
        return execute(() => undefined);
      }
      throw operationFailure({
        code: "IDEMPOTENCY_RECEIPT_UNAVAILABLE",
        message: "The Operation cannot persist its required idempotency receipt.",
        retryable: true,
      });
    }
    if (bound.operation.transports.rest.response.kind !== "json") {
      throw operationFailure({
        code: "IDEMPOTENCY_RECEIPT_UNAVAILABLE",
        message: "Keyed Operations require a replayable JSON result.",
        retryable: false,
      });
    }
    const field = bound.operation.idempotency.inputField!;
    return executeKeyedOperation(activeContext.db, activeContext.session, {
      operation: { id: bound.operation.key, intent: operationIntent(bound.operation) },
      idempotencyKey: typeof input[field] === "string" ? input[field] : "",
      input,
      idempotencyInputField: field,
      platformControlFields: [
        ...(bound.operation.concurrency?.version ? ["expectedVersion"] : []),
        ...(bound.operation.concurrency?.editLease ? ["leaseToken"] : []),
        ...(bound.operation.confirmation?.mode === "acknowledgement" ? ["confirmed"] : []),
        ...(bound.operation.confirmation?.mode === "challenge"
          ? ["confirmationToken", "confirmationAnswer"]
          : []),
      ],
      contractFingerprint: operationContractFingerprint(runtimeDefinition(bound)),
      externalWrite: runtimeDefinition(bound).effects.external === "write",
      // Record ACL is current authorization, not a one-shot mutation control.
      // Re-evaluate it in the same transaction that selects a replay. A
      // completed delete has no record left to authorize, while its receipt
      // is still bound to the exact tenant, actor, Operation and input and
      // returns only the canonical boolean deletion result. The initial
      // delete continues to check record ACL inside execute() before effects.
      ...(operationIntent(bound.operation) === "delete"
        ? {}
        : {
            authorizeReplay: (trx: Transaction<DB>) => assertCurrentRecordPermission(
              bound.operation,
              input,
              activeContext,
              trx,
            ),
          }),
      execute,
      encode: (result) => result,
      decode: (stored) => decodedOperationSuccess(bound.operation, validation, stored),
    });
  };

  return withConnectionGrantSubject(ownedTarget ? {entity:ownedTarget.target.entityName,id:ownedTarget.id} : undefined, () => withAuditContext(bound.operation.key, context.session?.credential, () => withModuleOperationSession(
    context.platform,
    context.session,
    (session) => {
      // Only the module's Control handlers receive live maintenance
      // (docs/maintenance.md), whatever session another of its Operations runs under.
      const runSeed = bound.maintenanceOwner && bound.operation.auth.mode === "control"
        ? liveMaintenanceRunner(bound.maintenanceOwner, context.platform, session) : undefined;
      return run({
      ...context,
      ...(session ? { session } : {}),
      ...(runSeed ? { runSeed } : {}),
      applyOwnedEntityFields: async (change) => {
        assertOwnedTarget(ownedTarget, change.id);
        if (!context.db || !context.platform || !session) {
          throw operationFailure({code:"FORBIDDEN",message:"Owned fields require an authenticated canonical plugin Operation.",retryable:false});
        }
        await context.platform.records.assertAccess(session,{entityName:ownedTarget.target.entityName,id:change.id,intent:"update"});
        return applyOwnedEntityFields(context.db, session, ownedTarget, change);
      },
      invokeHostOperation: (request, options) => invokeModuleHostOperation(
        context.platform,
        session,
        request,
        options,
      ),
      invokeDeclarativeService: (request, options) =>
        withConnectionDelegationOrigin(bound.operation.key, () => invokeModuleDeclarativeService(
          context.platform,
          session,
          request,
          options,
        )),
    });
    },
  ), context.session?.principalKind));
}
