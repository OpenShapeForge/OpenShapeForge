// SPDX-License-Identifier: BUSL-1.1
import { blueprintOperationHandler } from "./entity/blueprints.js";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { operationReferenceKeyword, operationI18nKeyword } from "@openshapeforge/operations";
import { GraphQLError } from "graphql";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Transaction } from "kysely";
import rawCatalog from "../generated/operations/catalog.json" with { type: "json" };
import {
  resolveSessionContext,
  SessionAuthenticationUnavailableError,
} from "../auth/identity.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import type { GraphqlContext } from "../graphql/context.js";
import { headersFromFastify } from "../http/headers.js";
import type {
  ModuleGraphqlContribution,
  ModuleOperationErrorResult,
  ModuleOperationHandler,
  ModuleOperationAvailabilityHandler,
  ModuleOperationResult,
  ModuleOperationSuccessResult,
  ModuleRuntimeContext,
  RuntimeModule,
} from "../modules/contract.js";
import type {
  RuntimeOperationDefinition,
  RuntimeOperationExecutionResult,
} from "@openshapeforge/plugin-runtime";
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
  type ModuleStaticOperationRegistration,
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
import { getGeneratedCrudTables } from "./entity/catalog.js";
import type { EntityOperationContract, GeneratedCrudTable } from "./entity/types.js";
import {
  assertRecordPermission,
  assertRecordPermissionInTransaction,
  type RecordPermissionAction,
} from "./entity/record-permissions.js";
import { normalizeTimestampToken } from "../db/timestamps.js";
import { HttpError, toHttpError } from "../rest/http-error.js";
import { issueOperationPrerequisiteReceipt } from "./prerequisite-receipts.js";
import { sessionOperationRolesAllow } from "./session-authorization.js";
import { operationContractFingerprint } from "./contract-fingerprint.js";
import { executeKeyedOperation } from "./execution-receipts.js";
import type { DB } from "../generated/db/types.js";
import { evaluateOperationAvailability } from "./availability.js";

export type OperationContract = {
  key: string;
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
    | {
        mode: "session";
        roles?: string[];
        scopes?: string[];
        recordPermission?: RecordPermissionAction;
        recordPermissions?: readonly RecordPermissionAction[];
      }
    | { mode: "custom"; scheme: string; description: string; securityScheme: Record<string, unknown> };
  tenancy: { mode: "required" | "derived" | "none"; description?: string };
  idempotency: { mode: "none" | "intrinsic" | "idempotency-key"; header?: string; inputField?: string; description?: string };
  effects?: {
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
function operationAjv(coerceTypes = false) {
  const instance = new Ajv2020.default({ strict: true, allErrors: true, coerceTypes });
  (addFormats as unknown as (target: typeof instance) => unknown)(instance);
  // Presentation-only binding used by generated forms. It does not validate
  // or authorize a value, but strict AJV must recognize the canonical keyword.
  instance.addKeyword({ keyword: "x-osf-sourceField", schemaType: "string", valid: true });
  instance.addKeyword({ keyword: "x-osf-control", schemaType: "string", valid: true });
  instance.addKeyword(operationReferenceKeyword);
  instance.addKeyword(operationI18nKeyword);
  return instance;
}

const ajv = operationAjv();
const queryAjv = operationAjv(true);
const queryValidators = new WeakMap<OperationContract, ValidateFunction>();
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

function runtimeDefinition(entry: Bound): RuntimeOperationDefinition {
  const method = entry.operation.transports.rest.method;
  return {
    id: entry.operation.key,
    key: entry.operation.key,
    intent: operationIntent(entry.operation),
    name: entry.operation.title,
    description: entry.operation.description,
    ...(entry.operation.target ? { target: entry.operation.target } : {}),
    input: { kind: "json-schema", schema: entry.operation.inputSchema },
    output: { kind: "json-schema", schema: entry.operation.outputSchema },
    effects: {
      data: entry.operation.effects?.data ?? (method === "GET"
        ? "read"
        : method === "DELETE"
          ? "delete"
          : "write"),
      external: entry.operation.effects?.external ?? (method === "GET" ? "read" : "write"),
    },
    reliability: {
      idempotency: {
        mode: entry.operation.idempotency.mode === "intrinsic"
          ? "natural"
          : entry.operation.idempotency.mode === "idempotency-key"
            ? "keyed"
            : "none",
      },
    },
    ...(entry.operation.prerequisites
      ? { prerequisites: entry.operation.prerequisites }
      : {}),
    ...(entry.operation.concurrency
      ? { concurrency: entry.operation.concurrency }
      : {}),
    interaction: {
      confirmation: entry.operation.confirmation ?? { mode: "none" },
    },
  };
}

export function runtimeOperationError(error: unknown) {
  const projected = error instanceof DeclaredOperationError
    ? error.body
    : toHttpError(error).body;
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

/** Bind compiler-contributed static Operations into the same runtime registry. */
export function runtimeStaticOperationRegistrations(
  modules: readonly RuntimeModule[],
  runtime: ModuleRuntimeContext,
  operations: readonly OperationContract[] = catalog.operations,
): readonly ModuleStaticOperationRegistration[] {
  const bound = bindOperationHandlers(modules, operations);
  return [...bound.values()].map((entry) => {
    const definition = runtimeDefinition(entry);
    return {
      definition,
      available: (session) => {
        try {
          requireOperationAuthorization(entry.operation, session);
          return true;
        } catch {
          return false;
        }
      },
      execute: async (session, request, options): Promise<RuntimeOperationExecutionResult> => {
        options?.signal?.throwIfAborted();
        const input = { ...(request.input ?? {}) };
        if (entry.operation.idempotency.mode === "idempotency-key") {
          const field = entry.operation.idempotency.inputField!;
          if (!request.idempotencyKey) {
            return {
              error: {
                code: "IDEMPOTENCY_KEY_REQUIRED",
                message: "This Operation requires an idempotency key.",
                retryable: false,
              },
            };
          }
          if (field in input && input[field] !== request.idempotencyKey) {
            return {
              error: {
                code: "BAD_USER_INPUT",
                message: "The Operation input conflicts with its idempotency key.",
                retryable: false,
              },
            };
          }
          input[field] = request.idempotencyKey;
        }
        try {
          const result = await invokeOperation(entry, input, {
            ...runtime,
            transport: "operation",
            session,
          });
          options?.signal?.throwIfAborted();
          return result.resultKind === "operation-envelope"
            ? result.value as OperationEnvelope<unknown>
            : { data: result.value, operations: [] };
        } catch (error) {
          return { error: runtimeOperationError(error) };
        }
      },
    };
  });
}

export type BoundOperation = {
  operation: OperationContract;
  handler: ModuleOperationHandler;
  availability?: ModuleOperationAvailabilityHandler;
};
type Bound = BoundOperation;
const bindingCache = new WeakMap<readonly RuntimeModule[], Map<string, Bound>>();

/**
 * Whether any module in this process claims a canonical operation.
 *
 * A build with no such module — a core-only deployment, or a test that
 * resolves no modules — advertises no operation tools rather than failing
 * every request over a handler nothing was ever going to provide. The moment
 * one operation module is present, every operation has to bind, and
 * `bindOperationHandlers` throws for the ones that cannot. REST boot
 * (roles/api.ts) and the MCP server (mcp/generated-mcp-server.ts) read this
 * one rule, so the two transports cannot disagree about whether operations
 * exist.
 */
export function operationModulesConfigured(
  modules: readonly Pick<RuntimeModule, "name">[],
  operations: readonly OperationContract[] = catalog.operations,
): boolean {
  const plugins = new Set(operations.map((operation) => operation.plugin));
  return modules.some((module) => plugins.has(module.name));
}

export type BindOperationOptions = {
  /**
   * Whether plugin operations must bind. "required" is what a host that
   * configured an operation module wants — including one whose module failed
   * to load, so the failure stops boot instead of silently deleting the API.
   * "absent" is a process without any operation module: the core operations
   * bind, the plugin ones are absent rather than broken. Defaults to what the
   * given modules say ({@link operationModulesConfigured}).
   */
  pluginOperations?: "required" | "absent";
};

export function bindOperationHandlers(
  modules: readonly RuntimeModule[],
  operations: readonly OperationContract[] = catalog.operations,
  options: BindOperationOptions = {},
): Map<string, Bound> {
  const pluginOperations = options.pluginOperations ??
    (operationModulesConfigured(modules, operations) ? "required" : "absent");
  const usesGeneratedCatalog = operations === catalog.operations;
  const cached = usesGeneratedCatalog && pluginOperations === "required" ? bindingCache.get(modules) : undefined;
  if (cached) return cached;
  const modulesByName = new Map(modules.map((module) => [module.name, module]));
  const bound = new Map<string, Bound>();
  const knownOperations = usesGeneratedCatalog
    ? [...catalog.operations, ...entityPluginOperationContracts()]
    : operations;
  for (const operation of operations) {
    if (bound.has(operation.key)) {
      throw new Error(
        `Canonical operation id "${operation.key}" is duplicated at runtime.`,
      );
    }
    if (operation.plugin === "osf-blueprints") {
      if (modulesByName.has("osf-blueprints")) throw new Error("The core blueprint runtime cannot be replaced by a plugin.");
      bound.set(operation.key, { operation, handler: blueprintOperationHandler(operation.handler) });
      continue;
    }
    if (pluginOperations === "absent") continue;
    const module = modulesByName.get(operation.plugin);
    if (!module) {
      throw new Error(`Canonical operation "${operation.key}" has no loaded runtime module "${operation.plugin}".`);
    }
    const handler = module?.operationHandlers?.[operation.handler];
    if (!handler) {
      throw new Error(`Canonical operation "${operation.key}" has no runtime handler "${operation.handler}" in module "${operation.plugin}".`);
    }
    const availability = module.operationAvailabilityHandlers?.[operation.handler];
    if (availability && (operation.auth.mode !== "session" || operation.tenancy.mode !== "required" ||
      operation.target?.scope !== "record" || !operation.target.inputField)) {
      throw new Error(`Operation "${operation.key}" availability requires an authenticated tenant record target.`);
    }
    bound.set(operation.key, { operation, handler, ...(availability ? { availability } : {}) });
  }
  for (const module of modules) {
    const declared = new Set(
      knownOperations
        .filter((operation) => operation.plugin === module.name)
        .map((operation) => operation.handler),
    );
    const extras = Object.keys(module.operationHandlers ?? {}).filter((handler) => !declared.has(handler));
    if (extras.length > 0) {
      throw new Error(`Runtime module "${module.name}" has operation handlers absent from its compiler contract: ${extras.sort().join(", ")}.`);
    }
    const extraAvailability = Object.keys(module.operationAvailabilityHandlers ?? {}).filter(key => !declared.has(key));
    if (extraAvailability.length > 0) throw new Error(`Runtime module "${module.name}" has availability handlers absent from its compiler contract.`);
  }
  if (usesGeneratedCatalog && pluginOperations === "required") bindingCache.set(modules, bound);
  return bound;
}

export function requireOperationAuthorization(
  operation: OperationContract,
  session: TrustedSessionContext | undefined,
): void {
  if (operation.auth.mode !== "session") return;
  if (!session || session.credential === "none" || !session.userId) {
    throw new HttpError(401, "UNAUTHENTICATED", "Operation requires an authenticated bearer session.");
  }
  if (operation.tenancy.mode === "required" && !session.tenantId) {
    throw new HttpError(401, "TENANT_REQUIRED", "Operation requires an authenticated tenant context.");
  }
  if (!sessionOperationRolesAllow(operation.auth.roles, session.roles)) {
    throw new HttpError(403, "FORBIDDEN", "Session lacks a required operation role.");
  }
  const requiredScopes = operation.auth.scopes ?? [];
  if (session.credential === "api-key" && requiredScopes.length > 0) {
    throw new HttpError(403, "INSUFFICIENT_SCOPE", "OAuth-scoped operations cannot be invoked with an API key.");
  }
  const heldScopes = new Set(session.oauthScopes ?? []);
  if (requiredScopes.some((scope) => !heldScopes.has(scope))) {
    throw new HttpError(403, "INSUFFICIENT_SCOPE", "Session lacks a required OAuth scope.");
  }
}

function asInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "BAD_USER_INPUT", "Operation input must be an object.");
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
      message: "The Operation target is not available.",
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
  if (recordPermissions.length === 0) return;
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
}

function operationRecordPermissions(
  operation: OperationContract,
): readonly RecordPermissionAction[] {
  if (operation.auth.mode !== "session") return [];
  return operation.auth.recordPermissions ??
    (operation.auth.recordPermission ? [operation.auth.recordPermission] : []);
}

function protectedCustomOperation(
  operation: OperationContract,
): ChallengeProtectedOperation & LeaseProtectedOperation {
  const intent = operationIntent(operation);
  if (!operation.target || intent === "create") {
    throw operationFailure({
      code: "INTERNAL_SERVER_ERROR",
      message: "The Operation target is not available.",
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
  if (operation.concurrency?.version) delete stripped.expectedVersion;
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
  const forcesTransaction = operationIntent(operation) !== "invoke";
  const hasGuard = Boolean(
    bound.availability ||
    operation.concurrency ||
    confirmation.mode === "challenge" ||
    recordPermissions.length > 0 ||
    forcesTransaction,
  );
  if (!hasGuard) return invokeHandler(customHandlerInput(operation, input));
  if (
    forcesTransaction &&
    operation.target?.scope === "collection" &&
    !operation.concurrency &&
    confirmation.mode !== "challenge" &&
    recordPermissions.length === 0
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
  if (!operation.target || operation.target.scope !== "record" ||
    !operation.target.inputField || !context.session || !context.db || !context.platform) {
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
  const protectedOperation = protectedCustomOperation(operation);
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
  const table = targetTable(operation);
  for (const permission of recordPermissions) {
    await assertRecordPermission(
      context.db,
      context.session,
      table,
      targetValue,
      permission,
    );
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
        table,
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
  return withModuleOperationTransaction(
    context.platform,
    context.session,
    async (trx) => {
      for (const permission of recordPermissions) {
        await assertRecordPermissionInTransaction(
          trx,
          context.session!,
          table,
          targetValue,
          permission,
        );
      }
      if (expectedVersion) {
        await validateEntityVersionInTransaction(trx, context.session!, {
          operation: protectedOperation,
          table,
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
      return invokeHandler(customHandlerInput(operation, input));
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

export async function invokeOperation(
  bound: Bound,
  inputValue: unknown,
  context: Omit<
    Parameters<ModuleOperationHandler>[1],
    "invokeHostOperation" | "invokeDeclarativeService"
  > & Partial<Pick<
    Parameters<ModuleOperationHandler>[1],
    "invokeHostOperation" | "invokeDeclarativeService"
  >>,
  options: InvokeOperationOptions = {},
): Promise<ModuleOperationSuccessResult> {
  const input = asInput(inputValue);
  const run = async (activeContext: Parameters<ModuleOperationHandler>[1]) => {
    requireOperationAuthorization(bound.operation, activeContext.session);
    const validation = validatorsFor(bound.operation);
    // The compiler augments a custom Operation's canonical schema with the
    // platform-owned mutation controls. Validate that complete request before
    // acknowledgement, lease, version or challenge handling can have side
    // effects. The handler receives only authored business input below.
    if (!validation.input(input)) {
      throw new HttpError(400, "BAD_USER_INPUT", "Operation input does not match its canonical schema.");
    }
    const invokeHandler = async (
      handlerInput: Record<string, unknown>,
    ): Promise<ModuleOperationSuccessResult> => {
      let result: ModuleOperationResult;
      try {
        result = await bound.handler(handlerInput, activeContext);
      } catch (error) {
        if (error instanceof DeclaredOperationError) {
          throw new HttpError(
            500,
            "HANDLER_CONTRACT_VIOLATION",
            "Operation handlers must return declared errors instead of forwarding a transport error.",
          );
        }
        throw error;
      }
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        throw new HttpError(
          500,
          "HANDLER_CONTRACT_VIOLATION",
          "Operation handler must return an operation result object.",
        );
      }
      if ("ok" in result && result.ok !== true && result.ok !== false) {
        throw new HttpError(
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
          throw new HttpError(
            500,
            "HANDLER_CONTRACT_VIOLATION",
            "Operation handler returned an undeclared error status or code.",
          );
        }
        if (!isJsonValue(result.body)) {
          throw new HttpError(
            500,
            "HANDLER_CONTRACT_VIOLATION",
            "Operation handler returned a non-serializable error body.",
          );
        }
        const validate = validation.errors.get(errorKey(result.status, result.code))!;
        if (!validate(result.body)) {
          throw new HttpError(
            500,
            "HANDLER_CONTRACT_VIOLATION",
            "Operation handler returned a body outside its declared error schema.",
          );
        }
        if (!declaration.schema) {
          const bodyCode = (result.body as { error?: { code?: unknown } }).error?.code;
          if (bodyCode !== result.code) {
            throw new HttpError(
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
          throw new HttpError(
            500,
            "HANDLER_CONTRACT_VIOLATION",
            "Operation handler returned an error content type outside its declaration.",
          );
        }
        throw new DeclaredOperationError(declaration, result);
      }
      let success = result as ModuleOperationSuccessResult;
      if (options.prepareSuccess) {
        success = await options.prepareSuccess(success, activeContext);
        if (!success || typeof success !== "object" || Array.isArray(success)) {
          throw new HttpError(
            500,
            "HANDLER_CONTRACT_VIOLATION",
            "Core Operation result normalization returned an invalid success result.",
          );
        }
      }
      if (success.resultKind !== undefined &&
        (success.resultKind !== "operation-envelope" || !isCanonicalSuccessEnvelope(success.value))) {
        throw new HttpError(500, "HANDLER_CONTRACT_VIOLATION", "Operation handler returned an invalid canonical success envelope.");
      }
      const declaredStatus = bound.operation.transports.rest.response.status ?? 200;
      if (success.status !== undefined && success.status !== declaredStatus) {
        throw new HttpError(500, "HANDLER_CONTRACT_VIOLATION", "Operation handler returned an undeclared success status.");
      }
      if (bound.operation.transports.rest.response.kind === "json" && !validation.output(success.value)) {
        throw new HttpError(500, "HANDLER_CONTRACT_VIOLATION", "Operation handler returned a value outside its canonical output schema.");
      }
      if (success.mcp !== undefined && !isMcpProjection(success.mcp)) {
        throw new HttpError(
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
        (handlerInput) => {
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

  return withModuleOperationSession(
    context.platform,
    context.session,
    (session) => run({
      ...context,
      ...(session ? { session } : {}),
      invokeHostOperation: (request, options) => invokeModuleHostOperation(
        context.platform,
        session,
        request,
        options,
      ),
      invokeDeclarativeService: (request, options) =>
        invokeModuleDeclarativeService(
          context.platform,
          session,
          request,
          options,
        ),
    }),
  );
}

function applyErrorResponseMetadata(
  reply: FastifyReply,
  response: {
    headers?: Record<string, string> | undefined;
    contentType?: string | undefined;
  },
): void {
  for (const [name, value] of Object.entries(response.headers ?? {})) {
    reply.header(name, value);
  }
  if (response.contentType) reply.header("content-type", response.contentType);
}

function sendDeclaredRestError(
  reply: FastifyReply,
  response: {
    status: number;
    body: unknown;
    headers?: Record<string, string> | undefined;
    contentType?: string | undefined;
  },
) {
  const headerContentType = Object.entries(response.headers ?? {})
    .find(([name]) => name.toLowerCase() === "content-type")?.[1];
  const contentType = response.contentType ?? headerContentType ?? "application/json";
  applyErrorResponseMetadata(reply, { ...response, contentType });
  const serialized = JSON.stringify(response.body);
  if (serialized === undefined) {
    throw new HttpError(
      500,
      "HANDLER_CONTRACT_VIOLATION",
      "Operation error body is not JSON serializable.",
    );
  }
  return reply.status(response.status).send(Buffer.from(serialized));
}

function fixedDeclaredRestError(
  operation: OperationContract,
  error: unknown,
): { status: number; body: unknown; contentType?: string } | undefined {
  if (!(error instanceof HttpError)) return undefined;
  const declaration = operation.errors.find((candidate) =>
    candidate.status === error.status && candidate.code === error.code
  );
  if (!declaration?.rest || !Object.hasOwn(declaration.rest, "body")) return undefined;
  const validate = validatorsFor(operation).errors.get(errorKey(error.status, error.code));
  if (!isJsonValue(declaration.rest.body) || !validate?.(declaration.rest.body)) {
    throw new HttpError(
      500,
      "HANDLER_CONTRACT_VIOLATION",
      "Operation contract contains an invalid fixed REST error body.",
    );
  }
  if (
    !declaration.schema &&
    (declaration.rest.body as { error?: { code?: unknown } }).error?.code !== declaration.code
  ) {
    throw new HttpError(
      500,
      "HANDLER_CONTRACT_VIOLATION",
      "Operation contract contains a fixed REST body inconsistent with its error code.",
    );
  }
  return {
    status: declaration.status,
    body: declaration.rest.body,
    contentType: declaration.rest.contentType ?? "application/json",
  };
}

function sendOperationRestFailure(
  reply: FastifyReply,
  operation: OperationContract,
  error: unknown,
  allowFixedRepresentation: boolean,
) {
  const projectedError = error instanceof SessionAuthenticationUnavailableError
    ? new HttpError(503, "AUTHENTICATION_UNAVAILABLE", error.message)
    : error;
  if (projectedError instanceof DeclaredOperationError) {
    return sendDeclaredRestError(reply, projectedError);
  }
  const fixed = allowFixedRepresentation
    ? fixedDeclaredRestError(operation, projectedError)
    : undefined;
  if (fixed) return sendDeclaredRestError(reply, fixed);
  const { status, body } = toHttpError(projectedError);
  return reply.status(status).send(body);
}

export function operationRestInput(
  request: FastifyRequest,
  operation: OperationContract,
): Record<string, unknown> {
  let body: Record<string, unknown> = {};
  if (request.body instanceof Uint8Array) {
    if (request.body.byteLength === 0) {
      return operationRestInputFromParts(request, operation, body);
    }
    try {
      const parsed = JSON.parse(new TextDecoder().decode(request.body));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      body = parsed as Record<string, unknown>;
    } catch {
      throw new HttpError(400, "BAD_USER_INPUT", "Operation body must be a valid JSON object.");
    }
  } else if (request.body && typeof request.body === "object" && !Array.isArray(request.body)) {
    body = request.body as Record<string, unknown>;
  }
  return operationRestInputFromParts(request, operation, body);
}

function operationRestInputFromParts(
  request: FastifyRequest,
  operation: OperationContract,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const query = request.query && typeof request.query === "object" ? request.query as Record<string, unknown> : {};
  const params = request.params && typeof request.params === "object" ? request.params as Record<string, unknown> : {};
  const pathParameters = new Set(
    [...operation.transports.rest.path.matchAll(/:([_A-Za-z][_0-9A-Za-z]*)/g)]
      .map((match) => match[1]!),
  );
  for (const name of pathParameters) {
    if (name in body || name in query) {
      throw new HttpError(400, "BAD_USER_INPUT", `Path parameter "${name}" must only be supplied in the URL.`);
    }
  }
  const readsInputFromQuery = operation.transports.rest.method === "GET" ||
    operation.transports.rest.method === "DELETE";
  if (readsInputFromQuery && Object.keys(body).length > 0) {
    throw new HttpError(400, "BAD_USER_INPUT", "This operation accepts input through path and query parameters, not a request body.");
  }
  if (!readsInputFromQuery) {
    const declared = operation.inputSchema.properties && typeof operation.inputSchema.properties === "object"
      ? operation.inputSchema.properties as Record<string, unknown>
      : {};
    const collisions = Object.keys(query).filter((name) => name in declared);
    if (collisions.length > 0) {
      throw new HttpError(400, "BAD_USER_INPUT", `Declared operation input must not be supplied through query parameters: ${collisions.sort().join(", ")}.`);
    }
  }
  const input = readsInputFromQuery ? { ...query, ...params } : { ...body, ...params };
  if (operation.idempotency.mode === "idempotency-key") {
    const field = operation.idempotency.inputField!;
    if (field in input) {
      throw new HttpError(400, "BAD_USER_INPUT", `Idempotency input "${field}" must only be supplied through the ${operation.idempotency.header} header on REST.`);
    }
    const header = request.headers[operation.idempotency.header!.toLowerCase()];
    if (typeof header === "string") input[field] = header;
  }
  if (readsInputFromQuery) {
    let validate = queryValidators.get(operation);
    if (!validate) {
      validate = queryAjv.compile(operation.inputSchema);
      queryValidators.set(operation, validate);
    }
    if (!validate(input)) {
      throw new HttpError(400, "BAD_USER_INPUT", "Operation query input does not match its canonical schema.");
    }
  }
  return input;
}

export function registerOperationRestRoutes(
  app: FastifyInstance,
  modules: readonly RuntimeModule[],
  context: ModuleRuntimeContext,
  operations: readonly OperationContract[] = catalog.operations,
): void {
  const bound = bindOperationHandlers(modules, operations);
  for (const entry of bound.values()) {
    const handler = async (request: FastifyRequest, reply: FastifyReply) => {
      let session: TrustedSessionContext | undefined;
      try {
        const declaresAuthenticationUnavailable = entry.operation.errors.some((error) =>
          error.status === 503 && error.code === "AUTHENTICATION_UNAVAILABLE"
        );
        session = entry.operation.auth.mode === "custom"
          ? undefined
          : await resolveSessionContext(headersFromFastify(request.headers), {
              db: context.db,
              failOnUnavailable:
                entry.operation.auth.mode === "session" && declaresAuthenticationUnavailable,
            });
      } catch (error) {
        return sendOperationRestFailure(reply, entry.operation, error, true);
      }
      let input: Record<string, unknown>;
      try {
        input = operationRestInput(request, entry.operation);
      } catch (error) {
        return sendOperationRestFailure(reply, entry.operation, error, false);
      }
      try {
        requireOperationAuthorization(entry.operation, session);
      } catch (error) {
        return sendOperationRestFailure(reply, entry.operation, error, true);
      }
      try {
        const result = await invokeOperation(entry, input, {
          ...context,
          transport: "rest",
          ...(session ? { session } : {}),
          request,
          reply,
        });
        for (const [name, value] of Object.entries(result.headers ?? {})) reply.header(name, value);
        if (result.contentType ?? entry.operation.transports.rest.response.contentType) {
          reply.type(result.contentType ?? entry.operation.transports.rest.response.contentType!);
        }
        return reply.status(result.status ?? entry.operation.transports.rest.response.status ?? 200).send(result.value);
      } catch (error) {
        return sendOperationRestFailure(reply, entry.operation, error, false);
      }
    };
    app.route({
      method: entry.operation.transports.rest.method as "GET",
      url: entry.operation.transports.rest.path,
      handler,
    });
  }
}

/**
 * Stable adapter for entity and record-derived Operations. Definitions stay
 * dynamic and session-filtered; adding a stored Operation never adds a route.
 */
export function registerRuntimeOperationRestRoutes(
  app: FastifyInstance,
  runtime: ModuleRuntimeContext,
): void {
  if (!runtime.platform || !runtime.db) return;
  const withSession = async <T>(
    request: FastifyRequest,
    work: (session: TrustedSessionContext) => Promise<T>,
  ): Promise<T> => {
    const session = await resolveSessionContext(
      headersFromFastify(request.headers),
      { db: runtime.db },
    );
    if (!session.userId || session.credential === "none") {
      throw new HttpError(
        401,
        "UNAUTHENTICATED",
        "Operation discovery requires an authenticated session.",
      );
    }
    return withModuleOperationSession(
      runtime.platform,
      session,
      (active) => work(active!),
    );
  };
  const failed = (reply: FastifyReply, error: unknown) => {
    const response = toHttpError(error);
    return reply.status(response.status).send(response.body);
  };

  // createApiApp keeps JSON as bytes for GraphQL Yoga. Runtime Operation
  // routes own ordinary JSON and therefore parse it in an encapsulated scope,
  // just like generated CRUD and edit-lease routes do.
  void app.register(async (instance) => {
    instance.removeContentTypeParser("application/json");
    instance.addContentTypeParser(
      "application/json",
      { parseAs: "string" },
      (_request, body, done) => {
        try {
          done(null, body ? JSON.parse(body as string) : {});
        } catch {
          done(new HttpError(400, "BAD_USER_INPUT", "Request body is not valid JSON."), undefined);
        }
      },
    );
    instance.setErrorHandler((error, _request, reply) => {
      void failed(reply, error);
    });

    instance.get("/api/operations", async (request, reply) => {
      try {
        return await withSession(
          request,
          (session) => runtime.platform!.operations.list(session),
        );
      } catch (error) {
        return failed(reply, error);
      }
    });
    instance.get("/api/operations/:id", async (request, reply) => {
      try {
        const id = (request.params as { id?: unknown }).id;
        if (typeof id !== "string" || id.length === 0) {
          throw new HttpError(400, "BAD_USER_INPUT", "Operation id is required.");
        }
        const definition = await withSession(
          request,
          (session) => runtime.platform!.operations.get(session, id),
        );
        if (!definition) {
          throw new HttpError(404, "NOT_FOUND", "Operation is not available.");
        }
        return definition;
      } catch (error) {
        return failed(reply, error);
      }
    });
    instance.post("/api/operations/:id/execute", async (request, reply) => {
      try {
        const id = (request.params as { id?: unknown }).id;
        if (typeof id !== "string" || id.length === 0) {
          throw new HttpError(400, "BAD_USER_INPUT", "Operation id is required.");
        }
        const body = asInput(request.body ?? {});
        if (typeof body.intent !== "string" || body.intent.length === 0) {
          throw new HttpError(400, "BAD_USER_INPUT", "Operation intent is required.");
        }
        const operationInput = body.input === undefined
          ? undefined
          : asInput(body.input);
        const expectedContractFingerprint = body.expectedContractFingerprint;
        if (expectedContractFingerprint !== undefined &&
          (typeof expectedContractFingerprint !== "string" ||
            !/^sha256:[0-9a-f]{64}$/.test(expectedContractFingerprint))) {
          throw new HttpError(
            400,
            "BAD_USER_INPUT",
            "Expected Operation contract fingerprint is invalid.",
          );
        }
        const idempotencyKey = request.headers["idempotency-key"];
        if (idempotencyKey !== undefined && typeof idempotencyKey !== "string") {
          throw new HttpError(
            400,
            "BAD_USER_INPUT",
            "Idempotency-Key must have exactly one value.",
          );
        }
        return await withSession(request, (session) =>
          runtime.platform!.operations.execute(session, {
            operation: { id, intent: body.intent as string },
            ...(operationInput ? { input: operationInput } : {}),
            ...(idempotencyKey ? { idempotencyKey } : {}),
            ...(expectedContractFingerprint
              ? { expectedContractFingerprint }
              : {}),
          })
        );
      } catch (error) {
        return failed(reply, error);
      }
    });
  });
}

export function operationGraphqlContribution(
  modules: readonly RuntimeModule[],
  runtime: ModuleRuntimeContext,
): RuntimeModule | undefined {
  const activePlugins = new Set(modules.map((module) => module.name));
  const projected = catalog.operations.filter((operation) =>
    activePlugins.has(operation.plugin) && operation.transports.graphql.enabled
  );
  if (projected.length === 0 && !runtime.platform) return undefined;
  const bound = projected.length > 0 ? bindOperationHandlers(modules) : new Map();
  const runtimeQueryFields = runtime.platform
    ? [
        "operationCatalog: JSON!",
        "operationDefinition(id: String!): JSON",
      ]
    : [];
  const runtimeMutationFields = runtime.platform
    ? [
        "executeOperation(id: String!, intent: String!, input: JSON, idempotencyKey: String): JSON!",
      ]
    : [];
  const queryFields = [
    ...runtimeQueryFields,
    ...projected
      .filter((operation) => operation.transports.graphql.kind === "query")
      .map((operation) => `${operation.transports.graphql.field}(input: JSON!): JSON!`),
  ].join("\n");
  const mutationFields = [
    ...runtimeMutationFields,
    ...projected
      .filter((operation) => operation.transports.graphql.kind === "mutation")
      .map((operation) => `${operation.transports.graphql.field}(input: JSON!): JSON!`),
  ].join("\n");
  const resolvers = { Query: {} as Record<string, unknown>, Mutation: {} as Record<string, unknown> };
  const withRuntimeSession = async <T>(
    context: GraphqlContext,
    work: (session: TrustedSessionContext) => Promise<T>,
  ): Promise<T> => {
    if (!runtime.platform || !context.session?.userId) {
      throw new HttpError(
        401,
        "UNAUTHENTICATED",
        "Operation discovery requires an authenticated session.",
      );
    }
    return withModuleOperationSession(
      runtime.platform,
      context.session,
      (session) => work(session!),
    );
  };
  if (runtime.platform) {
    resolvers.Query.operationCatalog = (
      _parent: unknown,
      _args: unknown,
      context: GraphqlContext,
    ) => withRuntimeSession(
      context,
      (session) => runtime.platform!.operations.list(session),
    );
    resolvers.Query.operationDefinition = (
      _parent: unknown,
      args: { id: string },
      context: GraphqlContext,
    ) => withRuntimeSession(
      context,
      (session) => runtime.platform!.operations.get(session, args.id),
    );
    resolvers.Mutation.executeOperation = (
      _parent: unknown,
      args: {
        id: string;
        intent: string;
        input?: unknown;
        idempotencyKey?: string;
      },
      context: GraphqlContext,
    ) => withRuntimeSession(context, (session) => {
      const input = args.input === undefined ? undefined : asInput(args.input);
      return runtime.platform!.operations.execute(session, {
        operation: { id: args.id, intent: args.intent },
        ...(input ? { input } : {}),
        ...(args.idempotencyKey
          ? { idempotencyKey: args.idempotencyKey }
          : {}),
      });
    });
  }
  for (const operation of projected) {
    const target = operation.transports.graphql.kind === "query" ? resolvers.Query : resolvers.Mutation;
    target[operation.transports.graphql.field!] = async (_parent: unknown, args: { input: unknown }, context: GraphqlContext) => {
      try {
        if (operation.idempotency.mode === "idempotency-key" && (!runtime.db || !runtime.platform)) {
          throw operationFailure({
            code: "IDEMPOTENCY_RECEIPT_UNAVAILABLE",
            message: "The Operation cannot persist its required idempotency receipt.",
            retryable: true,
          });
        }
        return (await invokeOperation(bound.get(operation.key)!, args.input, {
          ...runtime,
          transport: "graphql",
          session: context.session,
        })).value;
      } catch (error) {
        if (error instanceof DeclaredOperationError) {
          throw new GraphQLError(error.message, {
            extensions: { code: error.code, status: error.status, body: error.body },
          });
        }
        const { status, body } = toHttpError(error);
        throw new GraphQLError(body.error.message, { extensions: { code: body.error.code, status } });
      }
    };
  }
  const contribution: ModuleGraphqlContribution = { queryFields, mutationFields, resolvers };
  return { name: "__canonical_operations", graphql: () => contribution };
}
