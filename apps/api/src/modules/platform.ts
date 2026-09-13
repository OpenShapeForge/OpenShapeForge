// SPDX-License-Identifier: BUSL-1.1
/** Core-owned services made available to reviewed runtime modules. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transaction } from "kysely";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withDbSession } from "../db/session.js";
import { appendEntityEvent } from "../platform/entity-events.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import type { DB, Json } from "../generated/db/types.js";
import type {
  RuntimeOperationDefinition,
  RuntimeDeclarativeServiceRequest,
  RuntimeOperationExecutionResult,
  RuntimeOperationExecutionOptions,
  RuntimeOperationProvider,
  RuntimeOperationRequest,
  RuntimeHostOperationRequest,
} from "@openshapeforge/plugin-runtime";
import {
  executeEntityOperation,
  getEntityOperationContracts,
  tableForEntityOperation,
} from "../operations/entity/index.js";
import { serializeEntityResult } from "../operations/entity/serialize-result.js";
import type {
  McpInvocationContext,
  ModuleAuthorizationDecision,
  ModuleAuthorizationSubject,
  ModuleConnectionSelector,
  ModuleInvocationSourceResolution,
  ModuleInvocationSourceSelector,
  ModulePlatformServices,
  ModuleToolExecutionOptions,
  ModuleToolExecutionResult,
  RuntimeModule,
} from "./contract.js";
import { parseModuleToolExecutionOptions } from "./invocation-sources.js";
import { resolveConnectionValues } from "./connection-secrets.js";
import { connectSocket } from "./socket-egress.js";
import { classifyDatabaseError } from "../db/database-refusals.js";
import { generatedRuntimeFieldSchemas, runtimeJsonSchemas } from "./field-schemas.js";
import { organizationServiceIdentities } from "../auth/organization-service-identities.js";
import { operationContractFingerprint } from "../operations/contract-fingerprint.js";
import { executeKeyedOperation } from "../operations/execution-receipts.js";
import { operationErrorOf } from "@openshapeforge/operations";
import { ArtifactStorageRuntime } from "./artifact-storage.js";
import { runtimeSettings } from "./settings.js";
import { RecordAccessRuntime } from "./record-access.js";

function contractPreconditionFailure(
  definition: RuntimeOperationDefinition,
  request: RuntimeOperationRequest,
): RuntimeOperationExecutionResult | undefined {
  if (request.expectedContractFingerprint === undefined ||
    request.expectedContractFingerprint === operationContractFingerprint(definition)) {
    return undefined;
  }
  return {
    error: {
      code: "OPERATION_CONTRACT_CHANGED",
      message: "The Operation contract changed after it was authorized.",
      retryable: false,
    },
  };
}

function storedRuntimeOperationResult(value: unknown): RuntimeOperationExecutionResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored runtime Operation receipt is not an object.");
  }
  const candidate = value as RuntimeOperationExecutionResult;
  if ("error" in candidate) {
    if (!candidate.error || typeof candidate.error.code !== "string" ||
      typeof candidate.error.message !== "string" || typeof candidate.error.retryable !== "boolean") {
      throw new Error("Stored runtime Operation receipt has an invalid error.");
    }
    return candidate;
  }
  if (!Object.hasOwn(candidate, "data") || !Array.isArray(candidate.operations)) {
    throw new Error("Stored runtime Operation receipt has an invalid success envelope.");
  }
  return candidate;
}

/**
 * Narrow a module's selector to exactly one form before it reaches a query.
 * A module cannot pass both halves, and cannot pass anything else: the
 * selector is the only untrusted input on this path.
 */
function parseConnectionSelector(
  selector: ModuleConnectionSelector,
): ModuleConnectionSelector {
  const candidate = selector as { connectionId?: unknown; adapterKey?: unknown };
  const hasId = typeof candidate.connectionId === "string" && candidate.connectionId !== "";
  const hasKey = typeof candidate.adapterKey === "string" && candidate.adapterKey !== "";
  if (hasId === hasKey) {
    throw new Error("A connection selector names either connectionId or adapterKey.");
  }
  return hasId
    ? { connectionId: candidate.connectionId as string }
    : { adapterKey: candidate.adapterKey as string };
}

const platformRuntimes = new WeakMap<
  ModulePlatformServices,
  ModulePlatformRuntime
>();
type ActiveOperationSession = {
  runtime: ModulePlatformRuntime;
  session: TrustedSessionContext;
};
const activeOperationSessionStorage =
  new AsyncLocalStorage<ActiveOperationSession>();

export type ModuleMcpServerBinding = {
  server: Server;
  session: TrustedSessionContext;
  liveNotifications: boolean;
  notifyToolsChanged(): Promise<void>;
  notifyResourcesChanged(): Promise<void>;
  authorize(
    action: string,
    subject: ModuleAuthorizationSubject,
  ): Promise<ModuleAuthorizationDecision>;
  resolveInvocationSources(
    toolName: string,
    args: Record<string, unknown>,
    selector: ModuleInvocationSourceSelector,
    invocationToken: object,
    signal?: AbortSignal,
  ): Promise<ModuleInvocationSourceResolution>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    options: ModuleToolExecutionOptions | undefined,
    requestId: string | number,
    invocationToken: object,
    assertInvocationActive: () => void,
    signal?: AbortSignal,
  ): Promise<ModuleToolExecutionResult>;
  endInvocation?(invocationToken: object): void;
};

export type ModuleDeclarativeServiceExecutor = (
  session: TrustedSessionContext,
  request: RuntimeDeclarativeServiceRequest,
  options?: RuntimeOperationExecutionOptions,
) => Promise<RuntimeOperationExecutionResult>;

export type ModuleHostOperationExecutor = (
  session: TrustedSessionContext,
  request: RuntimeHostOperationRequest,
  options?: RuntimeOperationExecutionOptions,
) => Promise<RuntimeOperationExecutionResult>;

export type ModuleStaticOperationRegistration = {
  definition: RuntimeOperationDefinition;
  available(session: TrustedSessionContext): boolean;
  execute(
    session: TrustedSessionContext,
    request: RuntimeOperationRequest,
    options?: RuntimeOperationExecutionOptions,
  ): Promise<RuntimeOperationExecutionResult>;
};

const SENSITIVE_EVENT_WORDS = new Set([
  "secret",
  "password",
  "token",
  "cookie",
  "credential",
]);

function deepFreezeClone<T>(value: T): T {
  const cloned = structuredClone(value);
  const freeze = (candidate: unknown, seen = new WeakSet<object>()): void => {
    if (!candidate || typeof candidate !== "object" || seen.has(candidate))
      return;
    seen.add(candidate);
    for (const nested of Object.values(candidate as Record<string, unknown>)) {
      freeze(nested, seen);
    }
    Object.freeze(candidate);
  };
  freeze(cloned);
  return cloned;
}
const SENSITIVE_EVENT_COMPACT_KEYS = new Set([
  "authorization",
  "apikey",
  "authcode",
  "authorizationcode",
  "accesstoken",
  "refreshtoken",
  "clientsecret",
  "idtoken",
  "bearertoken",
]);

function isSensitiveEventKey(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.some((word) => SENSITIVE_EVENT_WORDS.has(word))) return true;
  return SENSITIVE_EVENT_COMPACT_KEYS.has(words.join(""));
}

function assertSecretFree(value: unknown, path = "payload"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSecretFree(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveEventKey(key)) {
      throw new Error(`Module event ${path}.${key} uses a sensitive field name.`);
    }
    assertSecretFree(entry, `${path}.${key}`);
  }
}

/**
 * Mint an object-identity capability from a core-verified session. The clone
 * prevents a module from mutating core's session object; freezing every nested
 * authority-bearing array prevents widening the clone.
 */
export function createModuleSessionCapability(
  session: TrustedSessionContext,
): TrustedSessionContext {
  const capability = {
    ...session,
    roles: Object.freeze([...session.roles]),
    groups: Object.freeze([...session.groups]),
    ...(session.oauthScopes
      ? { oauthScopes: Object.freeze([...session.oauthScopes]) }
      : {}),
  };
  // A stateful MCP server lives across HTTP requests. Its bearer roles and
  // login binding are pinned, while domain memberships are deliberately
  // refreshed from storage for every request. A getter keeps the plugin-facing
  // capability immutable while reading the latest core-owned membership set.
  Object.defineProperty(capability, "relationGroupIds", {
    enumerable: true,
    configurable: false,
    get: () => Object.freeze([...(session.relationGroupIds ?? [])]),
  });
  return Object.freeze(capability) as unknown as TrustedSessionContext;
}

/**
 * Process-local session capability dispatcher.
 *
 * Session objects supplied by modules are never authority. MCP services match
 * the exact capability of a currently registered server; operation-scoped
 * work matches the exact capability in the current async invocation. Closed
 * servers and completed operations are removed, so stale handles cannot cross
 * a reconnect or request boundary.
 */
export class ModulePlatformRuntime {
  readonly services: ModulePlatformServices;
  readonly #db: OpenShapeForgeDatabase;
  readonly #artifactStorage: ArtifactStorageRuntime<TrustedSessionContext, Transaction<DB>>;
  readonly #servers = new Map<Server, ModuleMcpServerBinding>();
  readonly #activeOperationSessions = new WeakSet<ActiveOperationSession>();
  readonly #activeInvocations = new WeakMap<McpInvocationContext, number>();
  readonly #invocationStorage = new AsyncLocalStorage<McpInvocationContext>();
  readonly #toolCallStack = new AsyncLocalStorage<readonly string[]>();
  readonly #pendingChildren = new WeakMap<
    McpInvocationContext,
    Set<Promise<unknown>>
  >();
  readonly #operationProviders = new Map<string, RuntimeOperationProvider>();
  readonly #staticOperations = new Map<string, ModuleStaticOperationRegistration>();
  readonly #operationCallStack = new AsyncLocalStorage<readonly string[]>();
  readonly #operationTransactionStorage = new AsyncLocalStorage<{
    session: TrustedSessionContext;
    trx: Transaction<DB>;
  }>();
  #declarativeServiceExecutor: ModuleDeclarativeServiceExecutor | undefined;
  #hostOperationExecutor: ModuleHostOperationExecutor | undefined;

  constructor(db: OpenShapeForgeDatabase) {
    this.#db = db;
    const records = new RecordAccessRuntime({
      acceptsSession: (session) => this.#acceptsScopedSession(session),
      currentTransaction: (session) => {
        const active = this.#operationTransactionStorage.getStore();
        return active?.session === session ? active.trx : undefined;
      },
      withSession: (session, work) => {
        const active = this.#operationTransactionStorage.getStore();
        if (active) {
          if (active.session !== session) throw new Error("Record authorization transaction belongs to another session.");
          return work(active.trx);
        }
        return withDbSession(this.#db, session, work);
      },
    });
    this.#artifactStorage = new ArtifactStorageRuntime({
      acceptsSession: (session) => this.#acceptsScopedSession(session),
      currentTransaction: (session) => {
        const active = this.#operationTransactionStorage.getStore();
        return active?.session === session ? active.trx : undefined;
      },
      withTransaction: (session, work) => {
        const active = this.#operationTransactionStorage.getStore();
        if (active) {
          if (active.session !== session) throw new Error("Artifact transaction belongs to another session.");
          return work(active.trx);
        }
        return withDbSession(this.#db, session, work);
      },
    });
    this.services = {
      records: records.services,
      settings: runtimeSettings,
      artifacts: this.#artifactStorage.services,
      durableOperations: {
        organizationServiceIdentity: async (session) => {
          if (!this.#acceptsScopedSession(session) || !session.tenantId || !session.userId) {
            throw new Error("Service identity resolution requires a live verified organization session.");
          }
          const identity = organizationServiceIdentities().find((entry) => entry.tenantId === session.tenantId);
          if (!identity) throw new Error("No automatic service identity is configured for this organization.");
          return { serviceIdentityId: identity.clientId };
        },
      },
      db: {
        withSession: (session, fn) => {
          if (!this.#acceptsScopedSession(session)) {
            throw new Error("Module database work requires a live verified session.");
          }
          const active = this.#operationTransactionStorage.getStore();
          if (active) {
            if (active.session !== session) {
              throw new Error("Module database transaction belongs to another session.");
            }
            return fn(active.trx);
          }
          return withDbSession(this.#db, session, fn);
        },
      },
      schemas: {
        fields: generatedRuntimeFieldSchemas,
        json: runtimeJsonSchemas,
      },
      events: {
        append: async (session, event) => {
          if (!this.#acceptsScopedSession(session)) {
            throw new Error("Module event append requires a live verified session.");
          }
          assertSecretFree(event.payload);
          await appendEntityEvent(this.#db, session, {
            ...event,
            payload: event.payload as Json,
          });
        },
      },
      errors: {
        classifyDatabase: (cause) => {
          const refusal = classifyDatabaseError(cause);
          if (!refusal) return undefined;
          const detail = [refusal.detail, refusal.hint]
            .filter((part): part is string => typeof part === "string" && part.length > 0)
            .join("\n\n");
          return {
            code: refusal.code,
            message: refusal.message,
            ...(detail ? { detail } : {}),
            retryable: false,
          };
        },
      },
      operations: {
        list: (session) => this.#listOperations(session),
        get: (session, operationId) =>
          this.#getOperation(session, operationId),
        execute: (session, request, options) =>
          this.#executeOperation(session, request, options),
      },
      secrets: {
        resolveConnectionValues: async (session, selector) => {
          // Same liveness rule as `db.withSession`: a module may only open a
          // credential while it is genuinely serving that session's request.
          // A retained handle replayed later fails closed, exactly like a
          // retained database session does.
          if (!this.#acceptsScopedSession(session)) {
            throw new Error(
              "Module connection resolution requires a live verified session.",
            );
          }
          return resolveConnectionValues({
            db: this.#db,
            session,
            selector: parseConnectionSelector(selector),
          });
        },
      },
      egress: {
        connect: async (session, grant, request) => {
          if (!this.#acceptsScopedSession(session)) {
            throw new Error("Module egress requires a live verified session.");
          }
          return connectSocket(grant, {
            host: String(request.host ?? ""),
            port: Number(request.port),
            tls: request.tls === true,
            ...(request.servername ? { servername: String(request.servername) } : {}),
            ...(request.rejectUnauthorized === false
              ? { rejectUnauthorized: false }
              : {}),
            ...(typeof request.timeoutMs === "number"
              ? { timeoutMs: request.timeoutMs }
              : {}),
          });
        },
      },
      mcp: {
        notifyToolsChanged: (scope) => {
          this.#notify(scope.tenantId, "tools");
        },
        notifyResourcesChanged: (scope) => {
          this.#notify(scope.tenantId, "resources");
        },
        authorize: async (session, request) => {
          const binding = this.#bindingForSession(session);
          if (!binding) return { allowed: false, code: "NOT_FOUND" };
          return binding.authorize(request.action, request.subject);
        },
        resolveInvocationSources: async (
          session,
          toolName,
          args,
          selector,
          signal,
        ) => {
          signal?.throwIfAborted();
          const ctx = this.#invocationStorage.getStore();
          const binding = ctx ? this.#servers.get(ctx.server) : undefined;
          if (
            !ctx ||
            !binding ||
            binding.session !== session ||
            !this.#activeInvocations.has(ctx)
          ) return { sources: [], unavailable: [] };
          return binding.resolveInvocationSources(
            toolName,
            deepFreezeClone(args),
            selector,
            ctx,
            signal,
          );
        },
        callTool: async (ctx, name, args, options, signal) =>
          this.#callTool(ctx, name, args, options, signal),
      },
    };
    platformRuntimes.set(this.services, this);
    Object.defineProperty(this.services, "artifacts", { writable: false, configurable: false });
    Object.defineProperty(this.services, "settings", { writable: false, configurable: false });
    Object.defineProperty(this.services, "records", { writable: false, configurable: false });
  }

  registerArtifactStorage(modules: readonly RuntimeModule[]): void {
    this.#artifactStorage.configure(modules, runtimeSettings.selectedProviders("artifact-storage"));
  }

  async #listOperations(
    session: TrustedSessionContext,
  ): Promise<readonly RuntimeOperationDefinition[]> {
    if (!this.#acceptsScopedSession(session)) {
      throw new Error("Module Operation listing requires a live verified session.");
    }
    const heldRoles = new Set(session.roles);
    const entityOperations = getEntityOperationContracts().filter((operation) =>
      operation.authorization.roles.some((role) => heldRoles.has(role))
    );
    const staticOperations = [...this.#staticOperations.values()]
      .filter((registration) => registration.available(session))
      .map((registration) => registration.definition);
    const provided = await this.listRuntimeProviderOperations(session);
    const byId = new Map<string, RuntimeOperationDefinition>();
    for (const definition of [
      ...entityOperations,
      ...staticOperations,
      ...provided,
    ]) {
      if (!definition.id || byId.has(definition.id)) {
        throw new Error(
          `Runtime Operation id ${JSON.stringify(definition.id)} is empty or duplicated.`,
        );
      }
      byId.set(definition.id, definition);
    }
    return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  /**
   * Core adapter seam for record-derived Operations only. Entity and authored
   * static Operations already have their own adapter projections, so exposing
   * them here would duplicate names and handlers in MCP.
   */
  async listRuntimeProviderOperations(
    session: TrustedSessionContext,
  ): Promise<readonly RuntimeOperationDefinition[]> {
    if (!this.#acceptsScopedSession(session)) {
      throw new Error(
        "Runtime provider Operation listing requires a live verified session.",
      );
    }
    const definitions = (await Promise.all(
      [...this.#operationProviders.values()].map((provider) =>
        provider.list(session)
      ),
    )).flat();
    const reservedIds = new Set([
      ...getEntityOperationContracts().map((operation) => operation.id),
      ...this.#staticOperations.keys(),
    ]);
    const byId = new Map<string, RuntimeOperationDefinition>();
    for (const definition of definitions) {
      if (
        !definition.id ||
        reservedIds.has(definition.id) ||
        byId.has(definition.id)
      ) {
        throw new Error(
          `Runtime provider Operation id ${JSON.stringify(definition.id)} is empty or duplicated.`,
        );
      }
      byId.set(definition.id, definition);
    }
    return [...byId.values()].sort((left, right) =>
      left.id.localeCompare(right.id)
    );
  }

  /** Activate only providers from modules that loaded and initialised cleanly. */
  registerOperationProviders(modules: readonly RuntimeModule[]): void {
    const providers = modules.flatMap((module) => module.operationProviders ?? []);
    const next = new Map<string, RuntimeOperationProvider>();
    for (const provider of providers) {
      if (!provider.id || next.has(provider.id)) {
        throw new Error(
          `Runtime Operation provider id ${JSON.stringify(provider.id)} is empty or duplicated.`,
        );
      }
      next.set(provider.id, provider);
    }
    this.#operationProviders.clear();
    for (const [id, provider] of next) this.#operationProviders.set(id, provider);
  }

  registerStaticOperations(
    registrations: readonly ModuleStaticOperationRegistration[],
  ): void {
    const next = new Map<string, ModuleStaticOperationRegistration>();
    for (const registration of registrations) {
      const id = registration.definition.id;
      if (!id || next.has(id)) {
        throw new Error(
          `Static Operation id ${JSON.stringify(id)} is empty or duplicated.`,
        );
      }
      next.set(id, registration);
    }
    this.#staticOperations.clear();
    for (const [id, registration] of next) this.#staticOperations.set(id, registration);
  }

  /** Register the single core-owned declarative engine used by every adapter. */
  registerDeclarativeServiceExecutor(
    executor: ModuleDeclarativeServiceExecutor,
  ): void {
    if (this.#declarativeServiceExecutor) {
      throw new Error("The declarative Service executor is already registered.");
    }
    this.#declarativeServiceExecutor = executor;
  }

  async #getOperation(
    session: TrustedSessionContext,
    operationId: string,
  ): Promise<RuntimeOperationDefinition | undefined> {
    if (!this.#acceptsScopedSession(session)) {
      throw new Error("Module Operation lookup requires a live verified session.");
    }
    const entityOperation = getEntityOperationContracts().find(
      (candidate) => candidate.id === operationId,
    );
    if (entityOperation) {
      const heldRoles = new Set(session.roles);
      if (!entityOperation.authorization.roles.some((role) => heldRoles.has(role))) {
        return undefined;
      }
      return entityOperation;
    }
    const staticOperation = this.#staticOperations.get(operationId);
    if (staticOperation) {
      return staticOperation.available(session)
        ? staticOperation.definition
        : undefined;
    }
    const matches = (
      await Promise.all(
        [...this.#operationProviders.values()].map((provider) =>
          provider.get(session, operationId),
        ),
      )
    ).filter((definition): definition is RuntimeOperationDefinition =>
      definition !== undefined
    );
    if (matches.length > 1) {
      throw new Error(`Runtime Operation id ${JSON.stringify(operationId)} is ambiguous.`);
    }
    if (matches[0] && matches[0].id !== operationId) {
      throw new Error(
        `Runtime Operation provider returned ${JSON.stringify(matches[0].id)} for ` +
          `${JSON.stringify(operationId)}.`,
      );
    }
    return matches[0];
  }

  async #executeOperation(
    session: TrustedSessionContext,
    request: RuntimeOperationRequest,
    options: RuntimeOperationExecutionOptions = {},
  ): Promise<RuntimeOperationExecutionResult> {
    options.signal?.throwIfAborted();
    if (!this.#acceptsScopedSession(session)) {
      throw new Error("Module Operation execution requires a live verified session.");
    }
    const entityOperation = getEntityOperationContracts().find(
      (candidate) => candidate.id === request.operation.id,
    );
    if (entityOperation) {
      if (entityOperation.intent !== request.operation.intent) {
        return {
          error: {
            code: "BAD_USER_INPUT",
            message: "The Operation intent does not match its canonical definition.",
            retryable: false,
          },
        };
      }
      const contractFailure = contractPreconditionFailure(entityOperation, request);
      if (contractFailure) return contractFailure;
      const result = await executeEntityOperation(this.#db, session, {
        operation: { id: entityOperation.id, intent: entityOperation.intent },
        ...(request.input ? { input: request.input as never } : {}),
      });
      return serializeEntityResult(tableForEntityOperation(entityOperation), result);
    }
    const staticOperation = this.#staticOperations.get(request.operation.id);
    if (staticOperation) {
      if (
        !staticOperation.available(session) ||
        staticOperation.definition.intent !== request.operation.intent
      ) {
        return {
          error: {
            code: "OPERATION_NOT_FOUND",
            message: "The requested Operation is not available.",
            retryable: false,
          },
        };
      }
      const contractFailure = contractPreconditionFailure(
        staticOperation.definition,
        request,
      );
      if (contractFailure) return contractFailure;
      const staticStack = this.#operationCallStack.getStore() ?? [];
      if (staticStack.includes(request.operation.id)) {
        return {
          error: {
            code: "OPERATION_CYCLE",
            message: "Recursive canonical Operation execution is not allowed.",
            retryable: false,
          },
        };
      }
      return this.#operationCallStack.run(
        [...staticStack, request.operation.id],
        () => staticOperation.execute(session, request, options),
      );
    }
    const matches: Array<{
      provider: RuntimeOperationProvider;
      definition: RuntimeOperationDefinition;
    }> = [];
    for (const provider of this.#operationProviders.values()) {
      const definition = await provider.get(session, request.operation.id);
      if (definition) matches.push({ provider, definition });
    }
    if (matches.length === 0) {
      return {
        error: {
          code: "OPERATION_NOT_FOUND",
          message: "The requested Operation is not available.",
          retryable: false,
        },
      };
    }
    if (matches.length > 1) {
      return {
        error: {
          code: "OPERATION_AMBIGUOUS",
          message: "More than one runtime provider owns the requested Operation.",
          retryable: false,
        },
      };
    }
    const match = matches[0]!;
    if (
      match.definition.id !== request.operation.id ||
      match.definition.intent !== request.operation.intent
    ) {
      return {
        error: {
          code: "BAD_USER_INPUT",
          message: "The Operation reference does not match its runtime definition.",
          retryable: false,
        },
      };
    }
    const contractFailure = contractPreconditionFailure(match.definition, request);
    if (contractFailure) return contractFailure;
    const stack = this.#operationCallStack.getStore() ?? [];
    if (stack.includes(request.operation.id)) {
      return {
        error: {
          code: "OPERATION_CYCLE",
          message: "Recursive canonical Operation execution is not allowed.",
          retryable: false,
        },
      };
    }
    const execute = () => this.#operationCallStack.run(
      [...stack, request.operation.id],
      () => match.provider.execute({
        session,
        ...(options.signal ? { signal: options.signal } : {}),
        execute: (nested, nestedOptions) => this.#executeOperation(
          session,
          nested,
          nestedOptions?.signal ?? options.signal
            ? { signal: (nestedOptions?.signal ?? options.signal)! }
            : {},
        ),
        invokeDeclarativeService: (declarative, declarativeOptions) =>
          this.invokeDeclarativeService(
            session,
            declarative,
            declarativeOptions?.signal ?? options.signal
              ? { signal: (declarativeOptions?.signal ?? options.signal)! }
              : {},
          ),
        invokeHostOperation: (hostRequest, hostOptions) =>
          this.invokeHostOperation(
            session,
            hostRequest,
            hostOptions?.signal ?? options.signal
              ? { signal: (hostOptions?.signal ?? options.signal)! }
              : {},
          ),
      }, request),
    );
    if (match.definition.reliability.idempotency.mode !== "keyed") return execute();
    if (!request.idempotencyKey) {
      return {
        error: {
          code: "IDEMPOTENCY_KEY_REQUIRED",
          message: "This Operation requires an idempotency key.",
          retryable: false,
        },
      };
    }
    try {
      return await executeKeyedOperation(this.#db, session, {
        operation: request.operation,
        idempotencyKey: request.idempotencyKey,
        input: request.input ?? {},
        contractFingerprint: operationContractFingerprint(match.definition),
        externalWrite: match.definition.effects.external === "write",
        execute: async (markEffectsAdmitted) => {
          markEffectsAdmitted();
          return execute();
        },
        encode: (result) => result,
        decode: storedRuntimeOperationResult,
      });
    } catch (error) {
      const operationError = operationErrorOf(error);
      if (operationError) return { error: operationError };
      throw error;
    }
  }

  registerHostOperationExecutor(executor: ModuleHostOperationExecutor): void {
    if (this.#hostOperationExecutor) {
      throw new Error("The host Operation executor is already registered.");
    }
    this.#hostOperationExecutor = executor;
  }

  async invokeHostOperation(
    session: TrustedSessionContext,
    request: RuntimeHostOperationRequest,
    options: RuntimeOperationExecutionOptions,
  ): Promise<RuntimeOperationExecutionResult> {
    options.signal?.throwIfAborted();
    if (!this.#acceptsScopedSession(session)) {
      throw new Error("Host Operation execution requires a live verified session.");
    }
    if (!this.#hostOperationExecutor) {
      return {
        error: {
          code: "HOST_OPERATION_UNAVAILABLE",
          message: "The host Operation implementation is unavailable.",
          retryable: false,
        },
      };
    }
    return this.#hostOperationExecutor(session, request, options);
  }

  async invokeDeclarativeService(
    session: TrustedSessionContext,
    request: RuntimeDeclarativeServiceRequest,
    options: RuntimeOperationExecutionOptions,
  ): Promise<RuntimeOperationExecutionResult> {
    options.signal?.throwIfAborted();
    if (!this.#acceptsScopedSession(session)) {
      throw new Error(
        "Declarative Service execution requires a live verified session.",
      );
    }
    if (!this.#declarativeServiceExecutor) {
      return {
        error: {
          code: "DECLARATIVE_SERVICE_UNAVAILABLE",
          message: "The declarative Service engine is unavailable for this invocation.",
          retryable: false,
        },
      };
    }
    return this.#declarativeServiceExecutor(
      session,
      request,
      options,
    );
  }

  registerServer(binding: ModuleMcpServerBinding): void {
    this.#servers.set(binding.server, binding);
  }

  unregisterServer(server: Server): void {
    this.#servers.delete(server);
  }

  /**
   * Activate one immutable session capability while core invokes a canonical
   * operation handler. An existing live MCP capability keeps its exact identity;
   * other transports receive an invocation-scoped capability. A nested dispatch
   * inherits the outer capability, so its caller-supplied session cannot widen
   * authority. AsyncLocalStorage keeps concurrent requests disjoint, while the
   * live set makes continuations retained past completion fail closed.
   */
  async withActiveOperationSession<T>(
    verifiedSession: TrustedSessionContext,
    work: (session: TrustedSessionContext) => Promise<T>,
  ): Promise<T> {
    const current = activeOperationSessionStorage.getStore();
    if (current) {
      if (!current.runtime.#activeOperationSessions.has(current)) {
        throw new Error("Module operation session is no longer active.");
      }
      return work(current.session);
    }

    const capability = this.#bindingForSession(verifiedSession)
      ? verifiedSession
      : createModuleSessionCapability(verifiedSession);
    const active = { runtime: this, session: capability };
    this.#activeOperationSessions.add(active);
    try {
      return await activeOperationSessionStorage.run(
        active,
        () => work(capability),
      );
    } finally {
      this.#activeOperationSessions.delete(active);
    }
  }

  /**
   * Keep canonical mutation guards and every plugin database write in one
   * transaction. A handler's platform.db.withSession call reuses this exact
   * transaction and cannot substitute another session.
   */
  async withOperationTransaction<T>(
    session: TrustedSessionContext,
    work: (trx: Transaction<DB>) => Promise<T>,
  ): Promise<T> {
    if (!this.#acceptsScopedSession(session)) {
      throw new Error("Module Operation transaction requires a live verified session.");
    }
    const active = this.#operationTransactionStorage.getStore();
    if (active) {
      if (active.session !== session) {
        throw new Error("Module Operation transaction belongs to another session.");
      }
      return work(active.trx);
    }
    return withDbSession(this.#db, session, async (trx) =>
      this.#operationTransactionStorage.run({ session, trx }, () => work(trx))
    );
  }

  /** Keep one exact invocation capability live only while core runs its hook chain. */
  async withActiveInvocation<T>(
    ctx: McpInvocationContext,
    work: () => Promise<T>,
    toolName?: string,
  ): Promise<T> {
    const binding = this.#servers.get(ctx.server);
    if (
      !binding ||
      binding.session !== ctx.session ||
      ctx.db !== this.#db
    ) {
      throw new Error("MCP invocation context is not active for this server and session.");
    }
    this.#activeInvocations.set(
      ctx,
      (this.#activeInvocations.get(ctx) ?? 0) + 1,
    );
    try {
      const run = () => this.#invocationStorage.run(ctx, work);
      if (!toolName) return await run();
      const stack = this.#toolCallStack.getStore() ?? [];
      const rooted = stack.at(-1) === toolName ? stack : [...stack, toolName];
      return await this.#toolCallStack.run(rooted, run);
    } finally {
      const remaining = (this.#activeInvocations.get(ctx) ?? 1) - 1;
      if (remaining === 0) {
        const pending = this.#pendingChildren.get(ctx);
        while (pending && pending.size > 0) {
          await Promise.allSettled([...pending]);
        }
        this.#pendingChildren.delete(ctx);
        this.#activeInvocations.delete(ctx);
        binding.endInvocation?.(ctx);
      } else this.#activeInvocations.set(ctx, remaining);
    }
  }

  #bindingForSession(
    session: TrustedSessionContext,
  ): ModuleMcpServerBinding | undefined {
    for (const binding of this.#servers.values()) {
      if (binding.session === session) return binding;
    }
    return undefined;
  }

  #acceptsScopedSession(session: TrustedSessionContext): boolean {
    const current = activeOperationSessionStorage.getStore();
    // An operation context is authoritative, including after its live token is
    // cleared. Never fall back to an unrelated registered MCP binding here.
    if (current) {
      return current.runtime === this && current.session === session &&
        this.#activeOperationSessions.has(current);
    }
    return this.#bindingForSession(session) !== undefined;
  }

  async #callTool(
    ctx: McpInvocationContext,
    name: string,
    args: Record<string, unknown>,
    options?: ModuleToolExecutionOptions,
    signal?: AbortSignal,
  ): Promise<ModuleToolExecutionResult> {
    signal?.throwIfAborted();
    const binding = this.#servers.get(ctx.server);
    if (
      !binding ||
      ctx.db !== this.#db ||
      binding.session !== ctx.session ||
      !this.#activeInvocations.has(ctx) ||
      this.#invocationStorage.getStore() !== ctx
    ) {
      throw new Error("MCP invocation context is not active for this server and session.");
    }
    const safeArgs = deepFreezeClone(args);
    const safeOptions =
      options === undefined ? undefined : deepFreezeClone(options);
    parseModuleToolExecutionOptions(safeOptions);
    signal?.throwIfAborted();
    const stack = this.#toolCallStack.getStore() ?? [];
    if (stack.includes(name)) {
      throw new Error("Recursive MCP platform tool calls are not allowed.");
    }
    const assertInvocationActive = () => {
      const current = this.#servers.get(ctx.server);
      if (
        current !== binding ||
        binding.session !== ctx.session ||
        !this.#activeInvocations.has(ctx)
      ) {
        throw new Error(
          "MCP invocation context is not active for this server and session.",
        );
      }
    };
    const child = this.#toolCallStack.run([...stack, name], () =>
      binding.callTool(
        name,
        safeArgs,
        safeOptions,
        ctx.requestId,
        ctx,
        assertInvocationActive,
        signal,
      ),
    );
    const pending = this.#pendingChildren.get(ctx) ?? new Set<Promise<unknown>>();
    this.#pendingChildren.set(ctx, pending);
    pending.add(child);
    void child.catch(() => undefined);
    void child.finally(() => pending.delete(child)).catch(() => undefined);
    return child;
  }

  #notify(tenantId: string | null, kind: "tools" | "resources"): void {
    for (const binding of this.#servers.values()) {
      if (!binding.liveNotifications) continue;
      if (tenantId !== null && binding.session.tenantId !== tenantId) continue;
      const notify =
        kind === "tools"
          ? binding.notifyToolsChanged
          : binding.notifyResourcesChanged;
      void notify().catch(() => {
        // Notification delivery is a cache hint. The next list/read still
        // re-evaluates current state even when a client has no open stream.
      });
    }
  }
}

/**
 * Run a canonical operation with the runtime that owns its exact platform
 * capability. The ownership lookup is identity-based and is not exposed to
 * modules, so a platform-shaped object cannot activate a session.
 */
export async function withModuleOperationSession<T>(
  platform: ModulePlatformServices | undefined,
  verifiedSession: TrustedSessionContext | undefined,
  work: (session: TrustedSessionContext | undefined) => Promise<T>,
): Promise<T> {
  const current = activeOperationSessionStorage.getStore();
  if (current) {
    return current.runtime.withActiveOperationSession(current.session, work);
  }
  if (!platform || !verifiedSession) return work(verifiedSession);
  const runtime = platformRuntimes.get(platform);
  if (!runtime) {
    throw new Error("Module operation platform is not core-owned.");
  }
  return runtime.withActiveOperationSession(verifiedSession, work);
}

/** Core-only transaction wrapper used by canonical custom write Operations. */
export async function withModuleOperationTransaction<T>(
  platform: ModulePlatformServices | undefined,
  session: TrustedSessionContext | undefined,
  work: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  const current = activeOperationSessionStorage.getStore();
  if (!current || !platform || !session) {
    throw new Error("Protected Operation requires a core-owned database session.");
  }
  const runtime = platformRuntimes.get(platform);
  if (!runtime || runtime !== current.runtime || session !== current.session) {
    throw new Error("Protected Operation requires the live verified session.");
  }
  return runtime.withOperationTransaction(session, work);
}

/**
 * Invoke a generated host compatibility handler only inside the exact live
 * Operation session that core established for a canonical module handler.
 */
export async function invokeModuleHostOperation(
  platform: ModulePlatformServices | undefined,
  session: TrustedSessionContext | undefined,
  request: RuntimeHostOperationRequest,
  options: RuntimeOperationExecutionOptions = {},
): Promise<RuntimeOperationExecutionResult> {
  const current = activeOperationSessionStorage.getStore();
  if (!current || !platform || !session) {
    return {
      error: {
        code: "HOST_OPERATION_UNAVAILABLE",
        message: "The host Operation implementation is unavailable.",
        retryable: false,
      },
    };
  }
  const runtime = platformRuntimes.get(platform);
  if (
    !runtime ||
    runtime !== current.runtime ||
    session !== current.session
  ) {
    throw new Error("Host Operation execution requires the live verified session.");
  }
  return runtime.invokeHostOperation(session, request, options);
}

/** Live-session equivalent for canonical static Operation handlers. */
export async function invokeModuleDeclarativeService(
  platform: ModulePlatformServices | undefined,
  session: TrustedSessionContext | undefined,
  request: RuntimeDeclarativeServiceRequest,
  options: RuntimeOperationExecutionOptions = {},
): Promise<RuntimeOperationExecutionResult> {
  const current = activeOperationSessionStorage.getStore();
  if (!current || !platform || !session) {
    return {
      error: {
        code: "DECLARATIVE_SERVICE_UNAVAILABLE",
        message: "The declarative Service engine is unavailable for this invocation.",
        retryable: false,
      },
    };
  }
  const runtime = platformRuntimes.get(platform);
  if (!runtime || runtime !== current.runtime || session !== current.session) {
    throw new Error("Declarative Service execution requires the live verified session.");
  }
  return runtime.invokeDeclarativeService(session, request, options);
}

export const __assertSecretFreeModuleEventForTests = assertSecretFree;
export const __isSensitiveModuleEventKeyForTests = isSensitiveEventKey;
