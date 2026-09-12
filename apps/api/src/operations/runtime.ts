// SPDX-License-Identifier: BUSL-1.1
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { GraphQLError } from "graphql";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
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
  ModuleOperationResult,
  ModuleOperationSuccessResult,
  ModuleRuntimeContext,
  RuntimeModule,
} from "../modules/contract.js";
import type {
  RuntimeOperationDefinition,
  RuntimeOperationExecutionResult,
} from "@openshapeforge/plugin-runtime";
import { operationFailure } from "@openshapeforge/operations";
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
import type { GeneratedCrudTable } from "./entity/types.js";
import { normalizeTimestampToken } from "../db/timestamps.js";
import { HttpError, toHttpError } from "../rest/http-error.js";

export type OperationContract = {
  key: string;
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
    | { mode: "session"; roles: string[]; scopes?: string[] }
    | { mode: "custom"; scheme: string; description: string; securityScheme: Record<string, unknown> };
  tenancy: { mode: "required" | "derived" | "none"; description?: string };
  idempotency: { mode: "none" | "intrinsic" | "idempotency-key"; header?: string; inputField?: string; description?: string };
  effects?: {
    data: "read" | "write" | "delete";
    external: "none" | "read" | "write";
  };
  concurrency?: import("@openshapeforge/operations").OperationConcurrency;
  confirmation?: import("@openshapeforge/operations").OperationConfirmation;
  transports: {
    rest: { method: string; path: string; response: { status?: number; kind: "json" | "binary" | "stream"; contentType?: string } };
    mcp: { enabled: boolean; name?: string; reason?: string };
    graphql: { enabled: boolean; kind?: "query" | "mutation"; field?: string; reason?: string };
    typescript: { enabled: boolean; functionName?: string; reason?: string };
  };
};

const catalog = rawCatalog as unknown as { version: number; operations: OperationContract[] };
function operationAjv(coerceTypes = false) {
  const instance = new Ajv2020.default({ strict: true, allErrors: true, coerceTypes });
  (addFormats as unknown as (target: typeof instance) => unknown)(instance);
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

function runtimeOperationError(error: unknown) {
  const projected = error instanceof DeclaredOperationError
    ? error.body
    : toHttpError(error).body;
  const candidate = projected && typeof projected === "object"
    ? (projected as { error?: Record<string, unknown> }).error
    : undefined;
  return {
    code: typeof candidate?.code === "string"
      ? candidate.code
      : "OPERATION_FAILED",
    message: typeof candidate?.message === "string"
      ? candidate.message
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
    const method = entry.operation.transports.rest.method;
    const definition: RuntimeOperationDefinition = {
      id: entry.operation.key,
      key: entry.operation.key,
      intent: "invoke",
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
      ...(entry.operation.concurrency
        ? { concurrency: entry.operation.concurrency }
        : {}),
      interaction: {
        confirmation: entry.operation.confirmation ?? { mode: "none" },
      },
    };
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
          return { data: result.value, operations: [] };
        } catch (error) {
          return { error: runtimeOperationError(error) };
        }
      },
    };
  });
}

type Bound = { operation: OperationContract; handler: ModuleOperationHandler };
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

export function bindOperationHandlers(
  modules: readonly RuntimeModule[],
  operations: readonly OperationContract[] = catalog.operations,
): Map<string, Bound> {
  const usesGeneratedCatalog = operations === catalog.operations;
  const cached = usesGeneratedCatalog ? bindingCache.get(modules) : undefined;
  if (cached) return cached;
  const modulesByName = new Map(modules.map((module) => [module.name, module]));
  const bound = new Map<string, Bound>();
  for (const operation of operations) {
    const module = modulesByName.get(operation.plugin);
    if (!module) {
      throw new Error(`Canonical operation "${operation.key}" has no loaded runtime module "${operation.plugin}".`);
    }
    const handler = module?.operationHandlers?.[operation.handler];
    if (!handler) {
      throw new Error(`Canonical operation "${operation.key}" has no runtime handler "${operation.handler}" in module "${operation.plugin}".`);
    }
    bound.set(operation.key, { operation, handler });
  }
  for (const module of modules) {
    const declared = new Set(operations.filter((operation) => operation.plugin === module.name).map((operation) => operation.handler));
    const extras = Object.keys(module.operationHandlers ?? {}).filter((handler) => !declared.has(handler));
    if (extras.length > 0) {
      throw new Error(`Runtime module "${module.name}" has operation handlers absent from its compiler contract: ${extras.sort().join(", ")}.`);
    }
  }
  if (usesGeneratedCatalog) bindingCache.set(modules, bound);
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
  const heldRoles = new Set(session.roles);
  if (!operation.auth.roles.some((role) => heldRoles.has(role))) {
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

function protectedCustomOperation(
  operation: OperationContract,
): ChallengeProtectedOperation & LeaseProtectedOperation {
  if (!operation.target) {
    throw operationFailure({
      code: "INTERNAL_SERVER_ERROR",
      message: "The Operation target is not available.",
    });
  }
  return {
    id: operation.key,
    entityId: operation.target.entityId,
    entityName: operation.target.entityName,
    intent: "invoke",
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
  const hasGuard = Boolean(operation.concurrency || confirmation.mode === "challenge");
  if (!hasGuard) return invokeHandler(customHandlerInput(operation, input));
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
        table: targetTable(operation),
        targetId: targetValue,
        expectedVersion,
        ...(leaseToken ? { leaseToken } : {}),
      });
      throw operationFailure(error);
    }
    confirmationToken = requireStringControl(input, "confirmationToken");
    confirmationAnswer = requireStringControl(input, "confirmationAnswer");
  }
  const table = targetTable(operation);
  return withModuleOperationTransaction(
    context.platform,
    context.session,
    async (trx) => {
      if (expectedVersion) {
        await validateEntityVersionInTransaction(trx, context.session!, {
          operation: protectedOperation,
          table,
          targetId: targetValue,
          expectedVersion,
        });
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
      const declaredStatus = bound.operation.transports.rest.response.status ?? 200;
      if (result.status !== undefined && result.status !== declaredStatus) {
        throw new HttpError(500, "HANDLER_CONTRACT_VIOLATION", "Operation handler returned an undeclared success status.");
      }
      if (bound.operation.transports.rest.response.kind === "json" && !validation.output(result.value)) {
        throw new HttpError(500, "HANDLER_CONTRACT_VIOLATION", "Operation handler returned a value outside its canonical output schema.");
      }
      if (result.mcp !== undefined && !isMcpProjection(result.mcp)) {
        throw new HttpError(
          500,
          "HANDLER_CONTRACT_VIOLATION",
          "Operation handler returned an MCP projection that is not a list of well-formed content blocks.",
        );
      }
      return result;
    };
    return invokeCustomOperationWithControls(
      bound,
      input,
      activeContext,
      invokeHandler,
    );
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
