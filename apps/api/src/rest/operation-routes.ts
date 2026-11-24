// SPDX-License-Identifier: BUSL-1.1
import {
  bearerIssuerOf,
  controlSessionHttpError,
  resolveControlSession,
} from "../control/control-session.js";
import { type ValidateFunction } from "ajv/dist/2020.js";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { resolveSessionContext } from "../auth/identity.js";
import { SessionAuthenticationUnavailableError } from "../auth/session-unavailable.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import { headersFromFastify } from "../http/headers.js";
import type { ModuleRuntimeContext, RuntimeModule } from "../modules/contract.js";
import type { RuntimeOperationDefinition, RuntimeOperationExecutionResult } from "@openshapeforge/plugin-runtime";
import {
  compactRecordOffers,
  isOperationAccepted,
  type OperationOffer,
} from "@openshapeforge/operations";
import { withModuleOperationSession } from "../modules/platform.js";
import { isWithheldOperation } from "../operations/entity/runtime.js";
import { HttpError, toHttpError } from "./http-error.js";
import { createOperationAjv } from "../operations/operation-ajv.js";
import { capabilityGrantRefusal, resolveCapabilityGrantSession } from "../operations/capability-grant-resolution.js";
import { grantTokenFromAuthorization } from "../operations/capability-grant-token.js";
import { addressable, executeForCaller } from "../operations/caller-projection.js";
import { bindOperationHandlers, type BindOperationOptions } from "../operations/composition.js";
import {
  asInput,
  invokeOperation,
  isDeclaredOperationErrorBody,
  listOperationContracts,
  requireOperationAuthorization,
  runtimeDefinitionAuthMode,
  DeclaredOperationError,
  type OperationContract,
} from "../operations/runtime.js";

const queryAjv = createOperationAjv(true);
const queryValidators = new WeakMap<OperationContract, ValidateFunction>();

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
  if (!isDeclaredOperationErrorBody(operation, error.status, error.code, declaration.rest.body)) {
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
  bind: (input: Record<string, unknown>) => Record<string, unknown> = (input) => input,
): Record<string, unknown> {
  let body: Record<string, unknown> = {};
  if (request.body instanceof Uint8Array) {
    if (request.body.byteLength === 0) {
      return operationRestInputFromParts(request, operation, body, bind);
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
  return operationRestInputFromParts(request, operation, body, bind);
}

function operationRestInputFromParts(
  request: FastifyRequest,
  operation: OperationContract,
  body: Record<string, unknown>,
  bind: (input: Record<string, unknown>) => Record<string, unknown>,
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
  // Server-supplied input (a capability grant's subject) joins before the
  // query is validated: a GET whose record target the grant names must not be
  // refused for leaving out the field the caller may not choose.
  // URL path components always arrive as strings, including on POST/PATCH.
  // Only convert a canonical integer when the Operation declares that exact
  // type; malformed and unsafe numbers stay strings and fail validation.
  const typedParams = { ...params };
  const properties = operation.inputSchema.properties && typeof operation.inputSchema.properties === "object"
    ? operation.inputSchema.properties as Record<string, unknown> : {};
  for (const name of pathParameters) {
    const schema = properties[name];
    const value = params[name];
    if (!schema || typeof schema !== "object" || Array.isArray(schema) || (schema as Record<string,unknown>).type!=="integer" || typeof value!=="string")continue;
    const canonical=/^(?:0|-?[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value));
    if(canonical)typedParams[name]=Number(value);
    // Query coercion must not turn a rejected path spelling into a valid int.
    else if(readsInputFromQuery)throw new HttpError(400,"BAD_USER_INPUT","Operation integer path input must use a canonical safe integer.");
  }
  const input = bind(readsInputFromQuery ? { ...query, ...typedParams } : { ...body, ...typedParams });
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

/**
 * The session for a control Operation on REST: the control realm's own
 * verifier, never the tenant one. An unconfigured control plane answers the
 * 503 every control Operation declares, naming what is missing, rather than
 * a 401 that would send an operator looking at their token.
 */
async function resolveControlRestSession(
  request: FastifyRequest,
  context: ModuleRuntimeContext,
): Promise<TrustedSessionContext> {
  const control = context.control;
  if (!control) {
    throw new HttpError(503, "CONTROL_PLANE_NOT_CONFIGURED", "The control plane is not assembled in this process.");
  }
  if (!control.config.ok) {
    throw new HttpError(
      503,
      "CONTROL_PLANE_NOT_CONFIGURED",
      `The control plane is not configured. Missing environment: ${control.config.missing.join(", ")}.`,
    );
  }
  try {
    return await resolveControlSession(headersFromFastify(request.headers), control.config.config, { mcpAppResource: true });
  } catch (error) {
    throw controlSessionHttpError(error);
  }
}

/**
 * A capability Operation is authenticated by its grant token alone: no bearer
 * is consulted, and the database is required because the grant row is the
 * credential.
 */
async function resolveCapabilityRestSession(
  request: FastifyRequest,
  context: ModuleRuntimeContext,
  operation: OperationContract,
): Promise<TrustedSessionContext> {
  if (!context.db) throw new HttpError(503, "DATABASE_NOT_CONFIGURED", "Capability grants require a database.");
  const header = request.headers.authorization;
  const token = grantTokenFromAuthorization(Array.isArray(header) ? header[0] : header);
  return resolveCapabilityGrantSession(context.db, token, {
    key: operation.key,
    ...(operation.target ? { target: { entityName: operation.target.entityName } } : {}),
  });
}

/**
 * The grant names the one record; when the Operation declares a record
 * target the runtime supplies it, so the caller cannot point the Operation
 * at another record than the grant was issued for.
 */
function bindGrantSubject(
  operation: OperationContract,
  session: TrustedSessionContext | undefined,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (operation.auth.mode !== "capability" || !session?.grant) return input;
  const field = operation.target?.inputField;
  if (!field) return input;
  if (field in input && input[field] !== session.grant.subject.id) throw capabilityGrantRefusal("GRANT_SCOPE");
  return { ...input, [field]: session.grant.subject.id };
}

export function registerOperationRestRoutes(
  app: FastifyInstance,
  modules: readonly RuntimeModule[],
  context: ModuleRuntimeContext,
  operations: readonly OperationContract[] = listOperationContracts(),
  options: BindOperationOptions = {},
): void {
  const bound = bindOperationHandlers(modules, operations, options);
  for (const entry of bound.values()) {
    const handler = async (request: FastifyRequest, reply: FastifyReply) => {
      let session: TrustedSessionContext | undefined;
      try {
        session = entry.operation.auth.mode === "custom"
          ? undefined
          : entry.operation.auth.mode === "control"
          ? await resolveControlRestSession(request, context)
          : entry.operation.auth.mode === "capability"
          ? await resolveCapabilityRestSession(request, context, entry.operation)
          : await resolveSessionContext(headersFromFastify(request.headers), { db: context.db, mcpAppResource: true });
      } catch (error) {
        return sendOperationRestFailure(reply, entry.operation, error, true);
      }
      let input: Record<string, unknown>;
      try {
        input = operationRestInput(request, entry.operation, (parts) => bindGrantSubject(entry.operation, session, parts));
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
 * The record offers of a list page in the compact format, when the caller
 * asked for it (`offerFormat: "compact"`, see @openshapeforge/operations
 * compact-offers.ts). Every other answer — a failure, an acceptance, a
 * non-list result — is returned as it is, and so is a page of any other shape.
 */
export function projectRecordOfferFormat(
  result: RuntimeOperationExecutionResult,
  format: "full" | "compact" | undefined,
): RuntimeOperationExecutionResult {
  if (format !== "compact" || !result || typeof result !== "object" || "error" in result || isOperationAccepted(result)) return result;
  const data = (result as { data?: unknown }).data as { items?: unknown } | null | undefined;
  const items = data && typeof data === "object" ? data.items : undefined;
  if (!Array.isArray(items) || !items.every((item) => item && typeof item === "object" &&
    Object.hasOwn(item, "data") && Array.isArray((item as { operations?: unknown }).operations))) return result;
  const compact = compactRecordOffers(items as { data: unknown; operations: OperationOffer[] }[]);
  return {
    ...result,
    data: { ...data, items: compact.items, offerFormat: "compact", offerTemplates: compact.offerTemplates },
  } as RuntimeOperationExecutionResult;
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
    work: (session: TrustedSessionContext, definition?: RuntimeOperationDefinition) => Promise<T>,
    operationId?: string,
  ): Promise<T> => {
    const headers = headersFromFastify(request.headers);
    const control = runtime.control?.config.ok ? runtime.control.config.config : undefined;
    const controlCandidate = control && bearerIssuerOf(headers) === control.operator.issuer;
    const active = <R>(session: TrustedSessionContext, action: (session: TrustedSessionContext) => Promise<R>) =>
      withModuleOperationSession(runtime.platform!, session, (verified) => action(verified!));
    const available = (session: TrustedSessionContext) => active(
      session, (verified) => runtime.platform!.operations.get(verified, operationId!),
    );
    // A person may be both an organization member and a platform operator.
    // Choose the Operation's available canonical context before execution;
    // never merge the two sessions or retry a business refusal under another.
    let tenant: TrustedSessionContext | undefined;
    let tenantError: unknown;
    // A distinct control issuer cannot be a tenant credential. Do not consult
    // an unrelated or intentionally absent tenant verifier in that deployment.
    if (!controlCandidate || control?.operator.issuer === process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER) {
      try {
        const resolved = await resolveSessionContext(headers, { db: runtime.db, mcpAppResource: true });
        if (resolved.userId && resolved.credential !== "none") tenant = resolved;
      } catch (error) {
        tenantError = error;
      }
    }
    // Discovery has one catalog: an admitted tenant wins deterministically.
    let tenantDefinition: RuntimeOperationDefinition | undefined;
    if (tenant && (operationId === undefined || !controlCandidate || (tenantDefinition = await available(tenant)))) {
      return active(tenant, (session) => work(session, tenantDefinition));
    }
    let operator: TrustedSessionContext | undefined;
    let controlError: unknown;
    if (control && controlCandidate) {
      try {
        operator = await resolveControlSession(headers, control, { mcpAppResource: true });
      } catch (error) {
        controlError = controlSessionHttpError(error);
      }
    }
    if (operator) {
      const definition = operationId === undefined ? undefined : await available(operator);
      if (operationId === undefined || (definition && runtimeDefinitionAuthMode(definition) === "control")) {
        return active(operator, (session) => work(session, definition));
      }
    }
    // Preserve normal unavailable-Operation results without widening authority.
    // An admission failure remains a failure for a tenant/provider Operation.
    if (tenant) return active(tenant, work);
    if (tenantError) throw tenantError;
    if (operator) throw new HttpError(404, "NOT_FOUND", "Operation is not available.");
    if (controlError) throw controlError;
    throw new HttpError(401, "UNAUTHENTICATED", "Operation discovery requires an authenticated session.");
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
          async (session) => addressable(await runtime.platform!.operations.list(session)),
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
          async (session, definition) => definition ?? runtime.platform!.operations.get(session, id),
          id,
        );
        if (!definition || isWithheldOperation(id)) {
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
        const offerFormat = body.offerFormat;
        if (offerFormat !== undefined && offerFormat !== "full" && offerFormat !== "compact") {
          throw new HttpError(400, "BAD_USER_INPUT", "offerFormat must be \"full\" or \"compact\".");
        }
        if (offerFormat === "compact" && body.intent !== "list") {
          throw new HttpError(400, "BAD_USER_INPUT", "offerFormat \"compact\" applies to a list only.");
        }
        const idempotencyKey = request.headers["idempotency-key"];
        if (idempotencyKey !== undefined && typeof idempotencyKey !== "string") {
          throw new HttpError(
            400,
            "BAD_USER_INPUT",
            "Idempotency-Key must have exactly one value.",
          );
        }
        const result = await withSession(
          request,
          (session) => executeForCaller(runtime.platform!, session, {
            operation: { id, intent: body.intent as string },
            ...(operationInput ? { input: operationInput } : {}),
            ...(idempotencyKey ? { idempotencyKey } : {}),
            ...(expectedContractFingerprint
              ? { expectedContractFingerprint }
              : {}),
          }),
          id,
        );
        // Taken over by an operation override: answered, not yet in effect.
        if (isOperationAccepted(result)) return reply.status(202).send(result);
        return projectRecordOfferFormat(result, offerFormat);
      } catch (error) {
        return failed(reply, error);
      }
    });
  });
}
