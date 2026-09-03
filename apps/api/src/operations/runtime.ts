// SPDX-License-Identifier: BUSL-1.1
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { GraphQLError } from "graphql";
import type { FastifyInstance, FastifyRequest } from "fastify";
import rawCatalog from "../generated/operations/catalog.json" with { type: "json" };
import { resolveSessionContext } from "../auth/identity.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import type { GraphqlContext } from "../graphql/context.js";
import { headersFromFastify } from "../http/headers.js";
import type {
  ModuleGraphqlContribution,
  ModuleOperationHandler,
  ModuleOperationResult,
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
  errors: { status: number; code: string; description: string }[];
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
const validators = new Map<string, { input: ValidateFunction; output: ValidateFunction }>(
  catalog.operations.map((operation) => [
    operation.key,
    { input: ajv.compile(operation.inputSchema), output: ajv.compile(operation.outputSchema) },
  ]),
);

export function listOperationContracts(): readonly OperationContract[] {
  return catalog.operations;
}

type Bound = { operation: OperationContract; handler: ModuleOperationHandler };
const bindingCache = new WeakMap<readonly RuntimeModule[], Map<string, Bound>>();

export function bindOperationHandlers(modules: readonly RuntimeModule[]): Map<string, Bound> {
  const cached = bindingCache.get(modules);
  if (cached) return cached;
  const modulesByName = new Map(modules.map((module) => [module.name, module]));
  const bound = new Map<string, Bound>();
  for (const operation of catalog.operations) {
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
    const declared = new Set(catalog.operations.filter((operation) => operation.plugin === module.name).map((operation) => operation.handler));
    const extras = Object.keys(module.operationHandlers ?? {}).filter((handler) => !declared.has(handler));
    if (extras.length > 0) {
      throw new Error(`Runtime module "${module.name}" has operation handlers absent from its compiler contract: ${extras.sort().join(", ")}.`);
    }
  }
  bindingCache.set(modules, bound);
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

export async function invokeOperation(
  bound: Bound,
  inputValue: unknown,
  context: Parameters<ModuleOperationHandler>[1],
): Promise<ModuleOperationResult> {
  const input = asInput(inputValue);
  const run = async (activeContext: Parameters<ModuleOperationHandler>[1]) => {
    requireOperationAuthorization(bound.operation, activeContext.session);
    const validation = validators.get(bound.operation.key)!;
    if (!validation.input(input)) {
      throw new HttpError(400, "BAD_USER_INPUT", "Operation input does not match its canonical schema.");
    }
    const result = await bound.handler(input, activeContext);
    const declaredStatus = bound.operation.transports.rest.response.status ?? 200;
    if (result.status !== undefined && result.status !== declaredStatus) {
      throw new HttpError(500, "HANDLER_CONTRACT_VIOLATION", "Operation handler returned an undeclared success status.");
    }
    if (bound.operation.transports.rest.response.kind === "json" && !validation.output(result.value)) {
      throw new HttpError(500, "HANDLER_CONTRACT_VIOLATION", "Operation handler returned a value outside its canonical output schema.");
    }
    return result;
  };

  return withModuleOperationSession(
    context.platform,
    context.session,
    (session) => run({ ...context, ...(session ? { session } : {}) }),
  );
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
): void {
  const bound = bindOperationHandlers(modules);
  for (const entry of bound.values()) {
    app.route({
      method: entry.operation.transports.rest.method as "GET",
      url: entry.operation.transports.rest.path,
      handler: async (request, reply) => {
        try {
          const session = entry.operation.auth.mode === "custom"
            ? undefined
            : await resolveSessionContext(headersFromFastify(request.headers), { db: context.db });
          const result = await invokeOperation(entry, operationRestInput(request, entry.operation), {
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
          const { status, body } = toHttpError(error);
          return reply.status(status).send(body);
        }
      },
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
        const { status, body } = toHttpError(error);
        throw new GraphQLError(body.error.message, { extensions: { code: body.error.code, status } });
      }
    };
  }
  const contribution: ModuleGraphqlContribution = { queryFields, mutationFields, resolvers };
  return { name: "__canonical_operations", graphql: () => contribution };
}
