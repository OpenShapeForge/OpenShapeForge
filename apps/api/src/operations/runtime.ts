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
  ModuleOperationSuccessResult,
  ModuleRuntimeContext,
  RuntimeModule,
} from "../modules/contract.js";
import { withModuleOperationSession } from "../modules/platform.js";
import { HttpError, toHttpError } from "../rest/http-error.js";

export type OperationContract = {
  key: string;
  plugin: string;
  title: string;
  description: string;
  handler: string;
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

type Bound = { operation: OperationContract; handler: ModuleOperationHandler };
const bindingCache = new WeakMap<readonly RuntimeModule[], Map<string, Bound>>();

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
  context: Parameters<ModuleOperationHandler>[1],
): Promise<ModuleOperationSuccessResult> {
  const input = asInput(inputValue);
  const run = async (activeContext: Parameters<ModuleOperationHandler>[1]) => {
    requireOperationAuthorization(bound.operation, activeContext.session);
    const validation = validatorsFor(bound.operation);
    if (!validation.input(input)) {
      throw new HttpError(400, "BAD_USER_INPUT", "Operation input does not match its canonical schema.");
    }
    let result;
    try {
      result = await bound.handler(input, activeContext);
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

  return withModuleOperationSession(
    context.platform,
    context.session,
    (session) => run({ ...context, ...(session ? { session } : {}) }),
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

export function operationGraphqlContribution(
  modules: readonly RuntimeModule[],
  runtime: ModuleRuntimeContext,
): RuntimeModule | undefined {
  const activePlugins = new Set(modules.map((module) => module.name));
  const projected = catalog.operations.filter((operation) =>
    activePlugins.has(operation.plugin) && operation.transports.graphql.enabled
  );
  if (projected.length === 0) return undefined;
  const bound = bindOperationHandlers(modules);
  const queryFields = projected.filter((operation) => operation.transports.graphql.kind === "query").map((operation) => `${operation.transports.graphql.field}(input: JSON!): JSON!`).join("\n");
  const mutationFields = projected.filter((operation) => operation.transports.graphql.kind === "mutation").map((operation) => `${operation.transports.graphql.field}(input: JSON!): JSON!`).join("\n");
  const resolvers = { Query: {} as Record<string, unknown>, Mutation: {} as Record<string, unknown> };
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
