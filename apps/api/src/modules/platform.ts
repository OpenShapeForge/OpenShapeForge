// SPDX-License-Identifier: BUSL-1.1
/** Core-owned services made available to reviewed runtime modules. */
import { withRuntimeSpan } from "@openshapeforge/observability";
import { isControlSession } from "../control/control-session.js";
import { systemSessionForAdministrator } from "../control/platform-admin.js";
import { auditContext, withAuditContext } from "../platform/audit-context.js";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Server } from "@modelcontextprotocol/server";
import { sql, type Transaction } from "kysely";
import { assertSameDatabase, databasePoolLimit, type OpenShapeForgeDatabase } from "../db/connection.js";
import { sharedReadBarriers, type SharedReadBarriers } from "../db/read-barrier.js";
import { withDbSession, withInvocationSavepoint, withSystemSession } from "../db/session.js";
import { enqueueJob } from "../jobs/store.js";
import { actorSessionOf, type JobActorCredential } from "../jobs/actor-session.js";
import { appendEntityEventInTransaction } from "../platform/entity-events.js";
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
  entityOperationAdmitsPrincipal,
  getEntityOperationContracts,
  tableForEntityOperation,
} from "../operations/entity/index.js";
import { serializeEntityResult } from "../operations/entity/serialize-result.js";
import { pluginEntityTransportInput } from "../operations/entity/transport-input.js";
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
import { generatedEntityValues } from "./entity-value-registry.js";
import { generatedVersioning } from "./versioning-registry.js";
import { organizationServiceIdentities } from "../auth/organization-service-identities.js";
import { operationContractFingerprint } from "../operations/contract-fingerprint.js";
import { executeKeyedOperation } from "../operations/execution-receipts.js";
import { assertOperationAdmitted } from "../operations/execution-policy.js";
import { operationErrorOf } from "@openshapeforge/operations";
import { ArtifactStorageRuntime } from "./artifact-storage.js";
import { runtimeSettings } from "./settings.js";
import { RecordAccessRuntime } from "./record-access.js";
import { PrincipalRuntime } from "./principals.js";
import { createWebhookSecretServices } from "./webhook-secrets.js";
import { createInboundEndpointServices } from "./inbound-endpoints.js";
import { inboundEndpointWriter, findInboundConnectionEndpoint, findInboundRegistration, insertInboundEndpoint, revokeInboundConnectionEndpoint } from "./inbound-store.js";
import { ReadProgressRuntime, type ReadProgressDefinition } from "./read-progress.js";
import type { RuntimeReadProgress } from "@openshapeforge/plugin-runtime";
import {
  generatedCapabilityOperations,
  issueCapabilityGrantInTransaction,
  listCapabilityGrantsInTransaction,
  revokeCapabilityGrantInTransaction,
} from "../operations/capability-grants.js";
import { CapabilityGrantNotFoundError } from "../operations/grants-operations.js";
import { actingRelationId } from "../db/acting-relation.js";
import { generatedCrudTools, matchNativeCrudTool } from "../mcp/native-crud-tool.js";
import { withAdmittedRecordAction } from "../operations/entity/record-action-admission.js";

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

/** UUIDv5 for SQL owner helpers; the separate system audit retains the qualified identity. */
function controlDatabaseActorId(issuer: string, subject: string): string {
  const bytes = createHash("sha1")
    .update(Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex"))
    .update(JSON.stringify(["osf-control", issuer, subject])).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Mint an object-identity capability from a core-verified session.
 *
 * The capability is a DETACHED SNAPSHOT, not a view onto core's session. A
 * shallow spread would copy only the top level: every nested object the
 * session carries — `appPrincipal`, `grant`, `administrator`, `relation` —
 * would remain the very object core holds, and `Object.freeze` on the
 * capability leaves all of them writable. A module handed such a capability
 * could assign `session.appPrincipal.integrationId` and thereby rewrite
 * CORE's own verified session: `principals.application` would report the
 * module's chosen integration as verified, `applyDbSession` would write it to
 * `app.app_principal_id`, and `app.record_action_allows` would answer for
 * another application's grants. The same hole widens a capability grant
 * (`grant.records`, `grant.subject`) and forges the audited control actor
 * (`administrator.subject`).
 *
 * So every own property whose value is an object is replaced by a deep-frozen
 * structural clone. The sweep is deliberately generic rather than a list of
 * today's authority fields: a nested field added to TrustedSessionContext
 * later is detached by construction instead of by somebody remembering. A
 * value that cannot be structurally cloned is a session carrying something
 * other than verified data, and failing here is the right answer.
 *
 * Credential-resolution facts (the application principal, the capability
 * grant, the control administrator, the issuer roles) are snapshots: they are
 * what the carrier resolved to when the session was established and no core
 * path rewrites them afterwards. The request-fresh fields below are accessors
 * for the opposite reason.
 */
export function createModuleSessionCapability(
  session: TrustedSessionContext,
): TrustedSessionContext {
  const capability: Record<string, unknown> = { ...session };
  for (const [key, value] of Object.entries(capability)) {
    if (value !== null && typeof value === "object") {
      capability[key] = deepFreezeClone(value);
    }
  }
  // A stateful MCP server lives across HTTP requests. Its login binding is
  // pinned, while roles, scope and domain memberships are the current
  // request's (mcp/stateful-session-authorization.ts): a copy taken here would
  // keep a revoked role alive for as long as the client stays connected.
  // Getters keep the plugin-facing capability immutable while reading the
  // latest core-owned values.
  Object.defineProperty(capability, "roles", {
    enumerable: true,
    configurable: false,
    get: () => Object.freeze([...session.roles]),
  });
  Object.defineProperty(capability, "scope", {
    enumerable: true,
    configurable: false,
    get: () => session.scope,
  });
  Object.defineProperty(capability, "relationGroupIds", {
    enumerable: true,
    configurable: false,
    get: () => Object.freeze([...(session.relationGroupIds ?? [])]),
  });
  // The acting Relation is request-scoped on a stateful MCP session too (a
  // getter there); a copy taken when the capability was minted would be the
  // Relation of no request, and person-owned rows would be written as nobody.
  Object.defineProperty(capability, "relation", {
    enumerable: true,
    configurable: false,
    // A detached deep-frozen clone per read, for the same reason the sweep
    // above exists: the link carries the identity row this session acts as,
    // and a plugin can never rewrite whom core acts as.
    get: () => {
      const link = session.relation;
      return link ? deepFreezeClone(link) : link;
    },
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
const documentPlatformRuntimes = new WeakMap<OpenShapeForgeDatabase, ModulePlatformRuntime>();

export class ModulePlatformRuntime {
  readonly services: ModulePlatformServices;
  readonly #db: OpenShapeForgeDatabase;
  readonly #readBarriers: SharedReadBarriers;
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
  readonly #readProgress = new ReadProgressRuntime<TrustedSessionContext>(assertSecretFree);

  readonly #staticOperations = new Map<string, ModuleStaticOperationRegistration>();
  readonly #operationCallStack = new AsyncLocalStorage<readonly string[]>();
  readonly #operationTransactionStorage = new AsyncLocalStorage<{
    session: TrustedSessionContext;
    trx: Transaction<DB>;
  }>();
  // Temporary object registry and expiry outbox must survive an enclosing
  // Operation rollback; bytes already written outside SQL still need GC.
  readonly #artifactStageTransactionStorage = new AsyncLocalStorage<{
    session: TrustedSessionContext;
    trx: Transaction<DB>;
  }>();
  readonly #recordAccessTransactionStorage = new AsyncLocalStorage<{
    session: TrustedSessionContext;
    trx: Transaction<DB>;
  }>();

  /**
   * The one transaction a call is inside, if any: the Operation's, or else
   * the one an artifact stage or read opened. Every platform service that
   * writes — module database work, the outbox, entity events, the record
   * oracle — joins it, so a provider staging a file and scheduling its
   * collection, or an Operation nested in that stage, commits with the
   * row or not at all. A different session inside it is a bug, not a case.
   */
  #activeTransaction(session: TrustedSessionContext, what: string): Transaction<DB> | undefined {
    const active = this.#artifactStageTransactionStorage.getStore() ??
      this.#operationTransactionStorage.getStore() ?? this.#recordAccessTransactionStorage.getStore();
    if (!active) return undefined;
    if (active.session !== session) throw new Error(`${what} belongs to another session.`);
    return active.trx;
  }
  #declarativeServiceExecutor: ModuleDeclarativeServiceExecutor | undefined;
  #hostOperationExecutor: ModuleHostOperationExecutor | undefined;

  readonly #capabilityOperations: ReadonlySet<string> | undefined;

  withReadProgressObserver<T>(
    session: TrustedSessionContext,
    emit: (snapshot: RuntimeReadProgress) => Promise<void>,
    work: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.#readProgress.observe(session, emit, work, signal);
  }

  /** Core transport adapter for authored Operations invoked directly. */
  withReadProgressOperation<T>(
    session: TrustedSessionContext, definition: ReadProgressDefinition,
    signal: AbortSignal | undefined, work: (signal?: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return this.#readProgress.operation(session, definition, signal, work);
  }

  constructor(
    db: OpenShapeForgeDatabase,
    options: {
      /** Keys of the `auth.mode: capability` Operations a grant may name; defaults to the generated catalog. */
      capabilityOperations?: ReadonlySet<string>;
    } = {},
  ) {
    this.#db = db;
    this.#readBarriers = sharedReadBarriers(db);
    documentPlatformRuntimes.set(db, this);
    this.#capabilityOperations = options.capabilityOperations;
    const principals = new PrincipalRuntime({
      acceptsSession: (session) => this.#acceptsScopedSession(session),
    });
    const records = new RecordAccessRuntime({
      acceptsSession: (session) => this.#acceptsScopedSession(session),
      currentTransaction: (session) => this.#activeTransaction(session, "Record authorization transaction"),
      withSession: (session, work) => {
        const active = this.#activeTransaction(session, "Record authorization transaction");
        return active ? work(active) : withDbSession(this.#db, session, work);
      },
    });
    this.#artifactStorage = new ArtifactStorageRuntime({
      withStageTransaction: (session, work) => withDbSession(this.#db, session, trx =>
        this.#artifactStageTransactionStorage.run({ session, trx }, () => work(trx)), { independent: true }),
      records: records.services,
      acceptsSession: (session) => this.#acceptsScopedSession(session),
      currentTransaction: (session) => {
        const active = this.#operationTransactionStorage.getStore();
        return active?.session === session ? active.trx : undefined;
      },
      // Joins the Operation transaction when there is one, else the read
      // transaction an enclosing artifact call opened: a download's oracle
      // check and the provider's read are then one transaction, so the record
      // the session was found to reach is the record the bytes are read
      // against. `currentTransaction` (bind) stays on the Operation one alone.
      withTransaction: (session, work) => {
        const active = this.#activeTransaction(session, "Artifact transaction");
        if (active) return work(active);
        return withDbSession(this.#db, session, async (trx) =>
          this.#recordAccessTransactionStorage.run({ session, trx }, () => work(trx))
        );
      },
    });
    this.services = {
      readProgress: {
        report: (session, snapshot) => this.#acceptsScopedSession(session)
          ? this.#readProgress.report(session, snapshot) : Promise.resolve(false),
      },
      webhookSecrets: createWebhookSecretServices({
        acceptsSession: (session) => this.#acceptsScopedSession(session),
        serviceIdentity: (tenantId) => organizationServiceIdentities().find((entry) => entry.tenantId === tenantId)?.clientId,
        runVerified: (session, work) => {
          if (activeOperationSessionStorage.getStore()) throw new Error("Signed webhook admission requires its own verified invocation.");
          return this.withActiveOperationSession(session, work);
        },
      }),
      // Authenticated inbound provider deliveries. Registration only: the
      // admission path is the host's own route, so nothing here can be handed
      // bytes and asked whether they are genuine.
      inboundEndpoints: createInboundEndpointServices({
        acceptsSession: (session) => this.#acceptsScopedSession(session),
        serviceIdentity: (tenantId) => organizationServiceIdentities().find((entry) => entry.tenantId === tenantId)?.clientId,
        // The dispatch target is resolved through the caller's OWN catalog
        // authorization, so nobody can bind a webhook to an Operation they
        // could not invoke themselves and have the service identity run it.
        resolveOperation: (session, operationId) => this.#getOperation(session, operationId),
        store: inboundEndpointWriter(db),
        managed: {
          activeTransaction: (session) => this.#operationTransactionStorage.getStore()?.session === session,
          connection: (session, connectionId) => {
            const active = this.#operationTransactionStorage.getStore();
            if (!active || active.session !== session) throw new Error("An active Operation transaction is required.");
            return resolveConnectionValues({ db: this.#db, session, selector: { connectionId },
              transaction: active.trx, skipTokenRefresh: true });
          },
          find: (session, key) => {
            const active = this.#operationTransactionStorage.getStore();
            if (!active || active.session !== session) throw new Error("An active Operation transaction is required.");
            return findInboundRegistration(active.trx, key);
          },
          findConnection: (session, input) => {
            const active = this.#operationTransactionStorage.getStore();
            if (!active || active.session !== session) throw new Error("An active Operation transaction is required.");
            return findInboundConnectionEndpoint(active.trx, input);
          },
          insert: (session, input) => {
            const active = this.#operationTransactionStorage.getStore();
            if (!active || active.session !== session) throw new Error("An active Operation transaction is required.");
            return insertInboundEndpoint(active.trx, input);
          },
          revoke: (session, input) => {
            const active = this.#operationTransactionStorage.getStore();
            if (!active || active.session !== session) throw new Error("An active Operation transaction is required.");
            return revokeInboundConnectionEndpoint(active.trx, input);
          },
        },
      }),
      records: records.services,
      principals: principals.services,
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
        withSharedReadBarrier: async (session, namespace, work, options) => {
          if (!this.#acceptsScopedSession(session) || !session.tenantId) {
            throw new Error("Read barriers require a live verified tenant session.");
          }
          if (!/^[a-z][a-z0-9.-]{0,127}$/.test(namespace)) throw new Error("Invalid read barrier namespace.");
          options?.signal?.throwIfAborted();
          const active = this.#activeTransaction(session, "Module read barrier");
          const tenantId = session.tenantId.toLowerCase();
          if (this.#readBarriers.hasScope()) return this.#readBarriers.run(namespace, tenantId, work, options?.signal);
          if (active || databasePoolLimit(this.#db) === 1) {
            return this.services.db.withSession(session, async trx => {
              await sql`select pg_advisory_xact_lock_shared(hashtext(${'osf.read-barrier:' + namespace}), hashtext(${tenantId}))`.execute(trx);
              options?.signal?.throwIfAborted();
              const result = await work();
              options?.signal?.throwIfAborted();
              return result;
            });
          }
          return this.#readBarriers.run(namespace, tenantId, work, options?.signal);
        },
        withControlSession: async (session, work) => {
          const active = activeOperationSessionStorage.getStore();
          const operationId = auditContext()?.operationId;
          if (!active || !this.#acceptsScopedSession(session) ||
              !isControlSession(session) || !session.roles.includes("platform-operator") || !operationId) {
            throw new Error("Cross-tenant database work requires a live audited control Operation.");
          }
          return withSystemSession(this.#db,
            {
              ...systemSessionForAdministrator(session.administrator, `${operationId} plugin database access`),
              databaseActorId: controlDatabaseActorId(session.administrator.issuer, session.administrator.subject),
            }, work);
        },
        withSession: (session, fn) => {
          if (!this.#acceptsScopedSession(session)) {
            throw new Error("Module database work requires a live verified session.");
          }
          const active = this.#activeTransaction(session, "Module database transaction");
          return active ? fn(active) : withDbSession(this.#db, session, (trx) =>
            this.#recordAccessTransactionStorage.run({ session, trx }, () => fn(trx))
          );
        },
      },
      jobs: {
        // The outbox: inside the active transaction when there is one — the
        // Operation's, so the job commits exactly when the handler's own
        // writes do, or an artifact stage's, so a provider that stages a
        // file and schedules its collection commits the row and the job
        // together.
        enqueue: (session, input) => {
          if (!this.#acceptsScopedSession(session)) {
            throw new Error("Job enqueue requires a live verified session.");
          }
          if (!session.tenantId || !session.userId) {
            throw new Error("Job enqueue requires an authenticated tenant session.");
          }
          const tenantId = session.tenantId;
          const actorId = session.userId;
          // A capability grant is verified per request against its expiry and
          // its remaining uses, and the session contract has the grant present
          // exactly when the credential is "grant". Neither can be re-verified
          // when a worker runs the job later, so rather than replay a grant
          // nobody checked — or hand an execution policy a session missing the
          // grant it is supposed to judge — enqueue refuses it outright.
          if (session.credential === "grant") {
            throw new Error(
              "A capability grant session cannot enqueue a job: its expiry and remaining uses " +
                "are verified per request, so a worker could not run the job as the grant it was issued for.",
            );
          }
          // The whole effective session goes on the row: the job runs later
          // as this person, with what this request could reach — not more.
          // `actorSessionOf` refuses a credential a job may not carry, so the
          // snapshot is a session an execution policy can decide on.
          const actorSession = actorSessionOf({
            credential: session.credential as JobActorCredential,
            roles: session.roles,
            groups: session.groups,
            relationGroupIds: session.relationGroupIds ?? [],
            ...(actingRelationId(session) ? { relationId: actingRelationId(session)! } : {}),
            scope: session.scope,
            ...(session.oauthScopes ? { oauthScopes: session.oauthScopes } : {}),
            ...(session.locale ? { locale: session.locale } : {}),
            ...(session.userDisplayName ? { userDisplayName: session.userDisplayName } : {}),
          });
          // One path in: the module session join (or open) is what fences the tenant.
          return this.services.db.withSession(session, (trx) =>
            enqueueJob(trx, { ...input, tenantId, actorId, actorSession }),
          );
        },
      },
      schemas: {
        fields: generatedRuntimeFieldSchemas,
        json: runtimeJsonSchemas,
        entityValues: generatedEntityValues,
        versioning: generatedVersioning,
      },
      events: {
        append: async (session, event) => {
          if (!this.#acceptsScopedSession(session)) {
            throw new Error("Module event append requires a live verified session.");
          }
          assertSecretFree(event.payload);
          if (!session.tenantId) throw new Error("Module event append requires an authenticated tenant session.");
          const tenantId = session.tenantId;
          // The same join-or-open as every module write, and the same tenant
          // check on both: the session's tenant must be the transaction's.
          await this.services.db.withSession(session, (trx) =>
            appendEntityEventInTransaction(trx, { ...event, tenantId, payload: event.payload as Json }),
          );
        },
      },
      grants: {
        issue: (session, input) => {
          if (!this.#acceptsScopedSession(session)) {
            throw new Error("Issuing a capability grant requires a live verified session.");
          }
          if (session.credential === "grant") {
            throw new Error("A grant session cannot issue capability grants.");
          }
          return this.services.db.withSession(session, (trx) =>
            issueCapabilityGrantInTransaction(trx, session, input, {
              capabilityOperations: this.#capabilityOperations ?? generatedCapabilityOperations(),
              // The issuer's own access, through the same oracle a handler
              // uses: a delegated record is one the issuer could reach.
              assertIssuerAccess: (record) => this.services.records.assertAccess(session, record),
            })
          );
        },
        revoke: (session, input) => {
          if (!this.#acceptsScopedSession(session)) {
            throw new Error("Revoking a capability grant requires a live verified session.");
          }
          return this.services.db.withSession(session, async (trx) => {
            const summary = await revokeCapabilityGrantInTransaction(trx, input);
            if (!summary) throw new CapabilityGrantNotFoundError(input.id);
            return summary;
          });
        },
        list: (session, subject) => {
          if (!this.#acceptsScopedSession(session)) {
            throw new Error("Listing capability grants requires a live verified session.");
          }
          return this.services.db.withSession(session, (trx) => listCapabilityGrantsInTransaction(trx, subject));
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
          withRuntimeSpan("operation.resolve", () => this.#getOperation(session, operationId), { operationId }),
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
    Object.defineProperty(this.services, "principals", { writable: false, configurable: false });
  }

  registerArtifactStorage(modules: readonly RuntimeModule[]): void {
    this.#artifactStorage.configure(modules, runtimeSettings.selectedProviders("artifact-storage"));
  }

  async #listOperations(
    session: TrustedSessionContext,
  ): Promise<readonly RuntimeOperationDefinition[]> {
    return (await this.listOperationSnapshot(session)).definitions;
  }

  /**
   * One enumeration of the session's Operations, with the ids among them that
   * a runtime provider listed. A caller that needs both reads them from this
   * single snapshot instead of asking the providers a second time, which could
   * also answer differently in between.
   */
  async listOperationSnapshot(
    session: TrustedSessionContext,
  ): Promise<{ definitions: readonly RuntimeOperationDefinition[]; providerIds: ReadonlySet<string> }> {
    if (!this.#acceptsScopedSession(session)) {
      throw new Error("Module Operation listing requires a live verified session.");
    }
    // A control-realm operator has no tenant: entity Operations and the
    // record-derived ones a provider lists are tenant-scoped by construction,
    // so only the static Operations — whose own authorization says whether a
    // control session may use them — are on offer.
    const controlSession = isControlRealmSession(session);
    const heldRoles = new Set(session.roles);
    const entityOperations = controlSession ? [] : getEntityOperationContracts().filter((operation) =>
      operation.authorization.roles.some((role) => heldRoles.has(role)) &&
      // The entity's principal-class policy, so an Operation this session
      // could not invoke is not listed as if it could. The derived
      // application search enumerates exactly this list before it reads
      // anything, so an entity that excludes this class is absent from the
      // search rather than refused inside it.
      entityOperationAdmitsPrincipal(operation, session)
    );
    const staticOperations = [...this.#staticOperations.values()]
      .filter((registration) => registration.available(session))
      .map((registration) => registration.definition);
    const provided = controlSession ? [] : await this.listRuntimeProviderOperations(session);
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
    return {
      definitions: [...byId.values()].sort((left, right) => left.id.localeCompare(right.id)),
      providerIds: new Set(provided.map((definition) => definition.id)),
    };
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
    const controlSession = isControlRealmSession(session);
    const entityContract = (id: string) => {
      const entityOperation = getEntityOperationContracts().find(
        (candidate) => candidate.id === id,
      );
      if (!entityOperation) return undefined;
      if (controlSession) return null;
      const heldRoles = new Set(session.roles);
      return entityOperation.authorization.roles.some((role) => heldRoles.has(role))
        ? entityOperation
        : null;
    };
    const entityOperation = entityContract(operationId);
    if (entityOperation !== undefined) return entityOperation ?? undefined;
    // A generated entity tool name a native Capability may name instead of
    // the canonical id answers with that canonical contract, under the same
    // checks, matched exactly as native execution matches it. A name several
    // entities share needs the entity a binding supplies, so it stays
    // unresolved here rather than picking one.
    const generated = matchNativeCrudTool(generatedCrudTools, operationId);
    if (generated.kind === "shared-name") return undefined;
    if (generated.kind === "tool" && generated.tool.operationId !== operationId) {
      return entityContract(generated.tool.operationId) ?? undefined;
    }
    const staticOperation = this.#staticOperations.get(operationId);
    if (staticOperation) {
      return staticOperation.available(session)
        ? staticOperation.definition
        : undefined;
    }
    if (controlSession) return undefined;
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

  #executeOperation(session: TrustedSessionContext, request: RuntimeOperationRequest, options: RuntimeOperationExecutionOptions = {}): Promise<RuntimeOperationExecutionResult> {
    return withAuditContext(request.operation.id, session.credential, () => withRuntimeSpan("operation.execute", () => this.#executeOperationWithContext(session, request, options), { operationId: request.operation.id }), session.principalKind);
  }

  async #executeOperationWithContext(
    session: TrustedSessionContext,
    request: RuntimeOperationRequest,
    options: RuntimeOperationExecutionOptions = {},
  ): Promise<RuntimeOperationExecutionResult> {
    options.signal?.throwIfAborted();
    if (!this.#acceptsScopedSession(session)) {
      throw new Error("Module Operation execution requires a live verified session.");
    }
    const controlSession = isControlRealmSession(session);
    const entityOperation = getEntityOperationContracts().find(
      (candidate) => candidate.id === request.operation.id,
    );
    if (entityOperation && !controlSession) {
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
      // An explicit transport key binds the declared input field exactly as
      // the REST header does; a conflicting input value is refused.
      let input = request.input;
      if (request.idempotencyKey !== undefined &&
        entityOperation.reliability.idempotency.mode === "keyed") {
        try {
          input = pluginEntityTransportInput(entityOperation, input ?? {}, undefined, request.idempotencyKey);
        } catch (error) {
          const operationError = operationErrorOf(error);
          if (operationError) return { error: operationError };
          throw error;
        }
      }
      const result = await executeEntityOperation(this.#db, session, {
        operation: { id: entityOperation.id, intent: entityOperation.intent },
        ...(input ? { input: input as never } : {}),
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
        () => this.#readProgress.operation(session, staticOperation.definition, options.signal,
          signal => staticOperation.execute(session, request, signal ? {signal} : options)),
      );
    }
    if (controlSession) {
      return {
        error: {
          code: "OPERATION_NOT_FOUND",
          message: "The requested Operation is not available.",
          retryable: false,
        },
      };
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
    // A keyed Operation declares its canonical input field. All transports may
    // supply that field; an explicit transport key still takes precedence and
    // the provider rejects a conflicting input value before admitting effects.
    const idempotency = match.definition.reliability.idempotency;
    if (idempotency.mode === "keyed" && !request.idempotencyKey && idempotency.inputField) {
      const inputKey = request.input?.[idempotency.inputField];
      if (typeof inputKey === "string" && inputKey.trim()) request = { ...request, idempotencyKey: inputKey };
    }
    const contractFailure = contractPreconditionFailure(match.definition, request);
    if (contractFailure) return contractFailure;
    // Every core-owned refusal that does not depend on a policy comes first,
    // so no decision is spent on an Operation this process will not run — and
    // so the admission below is the LAST core step before the provider.
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
    const keyed = match.definition.reliability.idempotency.mode === "keyed";
    const idempotencyKey = request.idempotencyKey;
    if (keyed && !idempotencyKey) {
      return {
        error: {
          code: "IDEMPOTENCY_KEY_REQUIRED",
          message: "This Operation requires an idempotency key.",
          retryable: false,
        },
      };
    }
    // Record-derived provider Operations do not pass through the canonical
    // runtime, so the host execution policies are evaluated here on the
    // definition's own declared effects, before the provider is reached.
    const admit = () => assertOperationAdmitted(this.#db, session, {
      id: match.definition.id,
      intent: match.definition.intent,
      effects: match.definition.effects,
    });
    // A provider's own code runs below, so it gets a record-action admission
    // of its own — which, for a provider Operation, is none: nothing here
    // authorizes a record action. Without this an enclosing record-action
    // Operation would lend its authorized target to a provider's handler
    // (operations/entity/record-action-admission.ts).
    const execute = () => withAdmittedRecordAction(null, () => this.#operationCallStack.run(
      [...stack, request.operation.id],
      () => this.#readProgress.operation(session, match.definition, options.signal, signal => match.provider.execute({
        session,
        ...(signal ? { signal } : {}),
        execute: (nested, nestedOptions) => this.#executeOperation(
          session,
          nested,
          nestedOptions?.signal ?? signal
            ? { signal: (nestedOptions?.signal ?? signal)! }
            : {},
        ),
        invokeDeclarativeService: (declarative, declarativeOptions) =>
          this.invokeDeclarativeService(
            session,
            declarative,
            declarativeOptions?.signal ?? signal
              ? { signal: (declarativeOptions?.signal ?? signal)! }
              : {},
          ),
        invokeHostOperation: (hostRequest, hostOptions) =>
          this.invokeHostOperation(
            session,
            hostRequest,
            hostOptions?.signal ?? signal
              ? { signal: (hostOptions?.signal ?? signal)! }
              : {},
          ),
      }, request)),
    ));
    if (!keyed) {
      // `none` and `natural`: this decision is the pre-effect decision. There
      // is no receipt to claim and nothing core-owned between here and the
      // dispatch below — no lock, no round trip — so the provider is reached
      // on the state the policy just read. What happens INSIDE the provider
      // after dispatch is the provider's own, and core says so rather than
      // pretending to see it (docs/execution-policies.md).
      try {
        await admit();
      } catch (error) {
        const operationError = operationErrorOf(error);
        if (operationError) return { error: operationError };
        throw error;
      }
      return execute();
    }
    // Keyed: decide early for a friendly refusal before the receipt work,
    // and again below once the claim is committed.
    try {
      await admit();
    } catch (error) {
      const operationError = operationErrorOf(error);
      if (operationError) return { error: operationError };
      throw error;
    }
    try {
      return await executeKeyedOperation(this.#db, session, {
        operation: request.operation,
        idempotencyKey: idempotencyKey!,
        input: request.input ?? {},
        contractFingerprint: operationContractFingerprint(match.definition),
        externalWrite: match.definition.effects.external === "write",
        execute: async (markEffectsAdmitted) => {
          // Decided again on live state, after the receipt claim was locked
          // and committed and before effects are admitted: a refusal that
          // arrives while this request waited for its claim must delete that
          // claim, not report an uncertain external delivery.
          await admit();
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
    // The bridge runs a core implementation behind a canonical Operation key,
    // so the host execution policies apply to it as well. A key this process
    // has no registered definition for is treated as a governed change: the
    // conservative reading, never looser than the Operation it stands in for.
    try {
      const definition = this.#staticOperations.get(request.operation)?.definition;
      await assertOperationAdmitted(this.#db, session, {
        id: request.operation,
        intent: definition?.intent ?? "invoke",
        effects: definition?.effects ?? { data: "write", external: "write" },
      });
    } catch (error) {
      const operationError = operationErrorOf(error);
      if (operationError) return { error: operationError };
      throw error;
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

  async assertRestrictedOperationConnection(expectedDatabase?: OpenShapeForgeDatabase): Promise<void> {
    if (expectedDatabase) await assertSameDatabase(this.#db, expectedDatabase);
    const result = await sql<{ rolbypassrls: boolean; rolsuper: boolean }>`select rolbypassrls, rolsuper from pg_roles where rolname = current_user`.execute(this.#db);
    if (!result.rows[0] || result.rows[0].rolbypassrls || result.rows[0].rolsuper) throw new Error("Maintenance Operations require the restricted application connection.");
  }

  assertActiveOperationSession(session: TrustedSessionContext): void {
    const current = activeOperationSessionStorage.getStore();
    if (!current || current.runtime !== this || current.session !== session || !this.#activeOperationSessions.has(current)) {
      throw new Error("Maintenance requires the active verified Operation session.");
    }
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
   * transaction and cannot substitute another session. An Operation invoked
   * inside an artifact stage or read runs its guards on that transaction
   * rather than opening a second one next to it.
   */
  async withOperationTransaction<T>(
    session: TrustedSessionContext,
    work: (trx: Transaction<DB>) => Promise<T>,
  ): Promise<T> {
    if (!this.#acceptsScopedSession(session)) {
      throw new Error("Module Operation transaction requires a live verified session.");
    }
    const operation = this.#operationTransactionStorage.getStore();
    if (operation) {
      if (operation.session !== session) {
        throw new Error("Module Operation transaction belongs to another session.");
      }
      return work(operation.trx);
    }
    const artifact = this.#activeTransaction(session, "Module Operation transaction");
    if (artifact) {
      return this.#operationTransactionStorage.run({ session, trx: artifact }, () => work(artifact));
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

/** A control-realm operator's session (control/control-session.ts): no tenant, ever. */
function isControlRealmSession(session: TrustedSessionContext): boolean {
  return session.credential === "control-bearer";
}

/**
 * Run a canonical operation with the runtime that owns its exact platform
 * capability. The ownership lookup is identity-based and is not exposed to
 * modules, so a platform-shaped object cannot activate a session.
 *
 * A control-realm session activates like any other and binds nothing: the
 * capability is tenant-agnostic, `platform.db.withSession` refuses a session
 * without a tenant, and the control handlers never ask for one — they
 * elevate themselves with `withSystemSession`, audited per Operation.
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

/**
 * Core-only transaction wrapper used by canonical custom write Operations.
 *
 * The guarded work runs inside its own savepoint. This transaction is often
 * somebody else's — a nested `execute`, a host bridge call or an artifact
 * stage reaches here on the transaction that is already open — and a failure
 * after this invocation consumed its mutation controls must take those
 * controls with it rather than leave them for the caller to commit
 * (db/session.ts `withInvocationSavepoint`).
 */
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
  return runtime.withOperationTransaction(
    session,
    (trx) => withInvocationSavepoint(trx, () => work(trx)),
  );
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

/** Core-only ownership check for a live maintenance elevation. */
export function assertLiveModuleOperationSession(platform: ModulePlatformServices | undefined, session: TrustedSessionContext | undefined): void {
  const current = activeOperationSessionStorage.getStore();
  if (!current || !platform || !session || platformRuntimes.get(platform) !== current.runtime || current.session !== session) {
    throw new Error("Maintenance requires the live verified Operation session.");
  }
  current.runtime.assertActiveOperationSession(session);
}

export async function assertRestrictedModuleOperationConnection(platform: ModulePlatformServices, expectedDatabase?: OpenShapeForgeDatabase): Promise<void> {
  const runtime = platformRuntimes.get(platform);
  if (!runtime) throw new Error("Maintenance platform is not core owned.");
  await runtime.assertRestrictedOperationConnection(expectedDatabase);
}

/** Core-owned bridge for canonical blueprint document copies; never exported to plugins. */
export async function withBlueprintDocumentServices<T>(db: OpenShapeForgeDatabase, session: import("../db/session.js").DbSessionInput,
  work: (services: ModulePlatformServices, live: TrustedSessionContext) => Promise<T>): Promise<T> {
  const runtime = documentPlatformRuntimes.get(db);
  if (!runtime || !session.userId || !session.tenantId || !Array.isArray(session.roles) || !Array.isArray(session.groups)) throw new Error("A live tenant document runtime is required.");
  return runtime.withActiveOperationSession(session as TrustedSessionContext, live => {
    if (live.tenantId !== session.tenantId || live.userId !== session.userId) throw new Error("Blueprint document session mismatch.");
    return work(runtime.services, live);
  });
}
