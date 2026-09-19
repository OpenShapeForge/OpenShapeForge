// SPDX-License-Identifier: BUSL-1.1
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { Kysely, Transaction } from "kysely";
import type { RuntimeArtifactServices, RuntimeArtifactStorageContribution } from "./artifacts.js";
import type { RuntimeSettingsService } from "./settings.js";
import type { RuntimeRecordAccessServices } from "./record-access.js";
export type { RuntimeRecordAccessServices, RuntimeRecordAccessRequest, RuntimeRecordAccessIntent } from "./record-access.js";
export type { RuntimeSettingValue, RuntimeSettingsService } from "./settings.js";
export type { RuntimeArtifactDescriptor, RuntimeArtifactStageInput, RuntimeArtifactOwnerInput, RuntimeArtifactBindInput,
  RuntimeArtifactContents, RuntimeArtifactSessionContext, RuntimeArtifactServices, RuntimeArtifactStorageContribution } from "./artifacts.js";
import type {
  OperationConfirmation,
  OperationError,
  OperationPrerequisite,
  OperationReference,
  OperationResult,
} from "@openshapeforge/operations";

export type PluginSessionScope = "tenant" | "group" | "self";
export type PluginSessionCredential =
  | "none"
  | "bearer"
  | "api-key"
  | "trusted-context"
  /**
   * A platform operator of the host's control realm: no tenant, ever. Only
   * the host's own control Operations accept it; a plugin Operation never
   * sees one, and a plugin must never treat it as a tenant session.
   */
  | "control-bearer";

/** Verified by the host. A plugin must never populate this from tool input. */
export type PluginSessionContext = {
  tenantId: string | null;
  userId: string | null;
  /** Opaque host binding to the verified bearer login session, when available. */
  loginSessionBinding?: string;
  userDisplayName?: string | null;
  /** Display language from verified identity claims; never a permission or client input. */
  locale?: string;
  roles: string[];
  oauthScopes?: string[];
  groups: string[];
  /** Active RelationGroup memberships resolved by the host, never plugin input. */
  relationGroupIds?: readonly string[];
  scope: PluginSessionScope;
  credential: PluginSessionCredential;
  relation?: unknown;
};

export type PluginDatabaseSchema = Record<string, unknown>;

export type RuntimeSchemaValidationResult =
  | { valid: true }
  | { valid: false; error: OperationError };

export type RuntimeJsonSchemaValidator = {
  /** Host validation without coercion, defaults, mutation or external reference loading. */
  validate(schema: Readonly<Record<string, unknown>>, values: unknown): RuntimeSchemaValidationResult;
};

export type RuntimeFieldSchemaCompiler = {
  /**
   * Validate canonical stored FieldDefinitions and project their value object
   * through the host's active osf-type and reference-data registries.
   */
  object(
    fields: readonly Readonly<Record<string, unknown>>[],
  ): Readonly<Record<string, unknown>>;
  /** Validate values against the same active FieldDefinitions used for rendering. */
  validateObject(
    fields: readonly Readonly<Record<string, unknown>>[], values: unknown,
  ): RuntimeSchemaValidationResult;
};

/** Compiler-owned projection of a dynamically selected normal entity shape. */
export type RuntimeEntityValueDefinition = {
  readonly entityName: string;
  readonly schemaVersion: 1;
  readonly definitionHash: string;
  readonly fields: readonly Readonly<Record<string, unknown>>[];
  readonly valueSchema: Readonly<Record<string, unknown>>;
  readonly references: readonly {
    readonly fieldKey: string;
    readonly targetEntity: string;
    readonly schema: string;
    readonly table: string;
    readonly column: string;
    readonly parameterColumn?: string;
    readonly required: boolean;
  }[];
  readonly materializeOperationId?: string;
};

export type RuntimeEntityValueCarrier = {
  readonly entityName: string;
  readonly fieldKey: string;
  readonly definitionField: string;
  readonly schema: string;
  readonly table: string;
  readonly valuesColumn: string;
  readonly definitionColumn: string;
  readonly definitions: Readonly<Record<string, RuntimeEntityValueDefinition>>;
};

/** Metadata only. Possessing a definition grants no record or Operation access. */
export type RuntimeEntityValueRegistry = {
  get(entityName: string, fieldKey: string): RuntimeEntityValueCarrier | undefined;
  collection(entityName: string, fieldKey: string): Readonly<{
    targetEntity: string;
    allowedDefinitions: readonly string[];
  }> | undefined;
};

export type RuntimeOperationDefinition = OperationReference & {
  key?: string;
  /** Native field binding is part of execution identity, without physical storage names. */
  implementation?:
    | { type: "entity" }
    | { type: "plugin"; plugin: string; handler: string }
    | { type: "collection"; entityName: string; field: string; action: "insert" | "move" | "update" | "remove" };
  entityId?: string;
  entityName?: string;
  name: string | Readonly<Record<string, string>>;
  description: string | Readonly<Record<string, string>>;
  target?: {
    entityId: string;
    entityName: string;
    scope: "collection" | "record";
    inputField?: string;
  };
  input: Readonly<Record<string, unknown>>;
  output: Readonly<Record<string, unknown>>;
  effects: {
    data: "read" | "write" | "delete";
    external: "none" | "read" | "write";
  };
  reliability: {
    idempotency: { mode: "natural" | "keyed" | "none" };
  };
  /** Core-issued completion proof is required before this Operation may run. */
  prerequisites?: readonly OperationPrerequisite[];
  concurrency?: {
    version?: { mode: "required"; field: string };
    editLease?: { mode: "required"; expiresAfterInactivity: string };
  };
  /** Canonical interaction meaning; adapters decide only how to render it. */
  interaction?: {
    confirmation?: OperationConfirmation;
    secureInput?: {
      type: "secureInput";
      sourceField: string;
      sourceEntity: string;
      definitionsField: string;
      into: string;
      message?: string;
    };
  };
};

export type RuntimeOperationRequest = {
  operation: OperationReference;
  input?: Record<string, unknown>;
  /** Durable engines persist and reuse this value across retries. */
  idempotencyKey?: string;
  /** Optional optimistic precondition over canonical execution semantics. */
  expectedContractFingerprint?: string;
};

export type RuntimeOperationExecutionOptions = {
  signal?: AbortSignal;
};

/** Stable identity of one stored declarative Service definition. */
export type RuntimeDeclarativeServiceDefinition = {
  entity: string;
  id: string;
  key: string;
  version: string | number;
};

export type RuntimeDeclarativeServiceRequest = {
  definition: RuntimeDeclarativeServiceDefinition;
  input?: Record<string, unknown>;
  /** Reused across retries; core derives a stable key per Service step. */
  idempotencyKey?: string;
  /** Durable reference only; core re-authorizes the referenced source live. */
  sourceReference?: string;
};

/**
 * Temporary call into a core-owned implementation behind a canonical plugin
 * Operation. The canonical key is resolved from generated internal metadata;
 * no transport name or caller-supplied authority crosses this boundary.
 */
export type RuntimeHostOperationRequest = {
  operation: string;
  input?: Record<string, unknown>;
  idempotencyKey?: string;
};

export type RuntimeOperationExecutionResult =
  & { intent?: string }
  & OperationResult<unknown>;

export type RuntimeOperationExecutionContext = {
  /** Exact, host-minted live capability for this invocation. */
  session: PluginSessionContext;
  signal?: AbortSignal;
  /** Nested canonical dispatch; it cannot widen or replace the live session. */
  execute(
    request: RuntimeOperationRequest,
    options?: RuntimeOperationExecutionOptions,
  ): Promise<RuntimeOperationExecutionResult>;
  /**
   * Invoke the core declarative Service engine without routing through an MCP
   * tool name. Core re-reads the named definition and every connection under
   * this invocation's live session before any provider call.
   */
  invokeDeclarativeService(
    request: RuntimeDeclarativeServiceRequest,
    options?: RuntimeOperationExecutionOptions,
  ): Promise<RuntimeOperationExecutionResult>;
  invokeHostOperation(
    request: RuntimeHostOperationRequest,
    options?: RuntimeOperationExecutionOptions,
  ): Promise<RuntimeOperationExecutionResult>;
};

/**
 * Runtime source for record-derived Operations. Core adapters ask providers
 * for definitions and dispatch by stable Operation id; providers never own a
 * transport-specific tool name or route.
 */
export type RuntimeOperationProvider = {
  id: string;
  list(session: PluginSessionContext): Promise<readonly RuntimeOperationDefinition[]>;
  get(
    session: PluginSessionContext,
    operationId: string,
  ): Promise<RuntimeOperationDefinition | undefined>;
  execute(
    context: RuntimeOperationExecutionContext,
    request: RuntimeOperationRequest,
  ): Promise<RuntimeOperationExecutionResult>;
};

/** The database capabilities exposed by the host to a runtime plugin. */
export type PluginDatabase = {
  withSession<T>(
    session: PluginSessionContext,
    fn: (trx: Transaction<PluginDatabaseSchema>) => Promise<T>,
  ): Promise<T>;
};

export type PluginPlatformServices = {
  readonly records: RuntimeRecordAccessServices<PluginSessionContext>;
  readonly settings: RuntimeSettingsService;
  readonly artifacts: RuntimeArtifactServices<PluginSessionContext>;
  /** Server configuration, never a service identity selected in operation input. */
  durableOperations?: {
    organizationServiceIdentity(session: PluginSessionContext): Promise<{ serviceIdentityId: string }>;
  };
  db: PluginDatabase;
  /** The durable outbox; see `RuntimeJobServices`. */
  readonly jobs: RuntimeJobServices;
  schemas: {
    fields: RuntimeFieldSchemaCompiler;
    json: RuntimeJsonSchemaValidator;
    /** Absent on hosts without entity-value support; callers must fail closed. */
    entityValues?: RuntimeEntityValueRegistry;
  };
  events: {
    append(
      session: PluginSessionContext,
      event: {
        aggregateType: string;
        aggregateId: string;
        eventType: string;
        payload: Record<string, unknown>;
      },
    ): Promise<void>;
  };
  errors: {
    /**
     * Turn only recognised, safely authored database refusals into canonical
     * public meaning. `undefined` means the cause must stay redacted.
     */
    classifyDatabase(cause: unknown): OperationError | undefined;
  };
  operations: {
    /** Definitions currently available to this live verified session. */
    list(
      session: PluginSessionContext,
    ): Promise<readonly RuntimeOperationDefinition[]>;
    /** Returns only a definition available to this live verified session. */
    get(
      session: PluginSessionContext,
      operationId: string,
    ): Promise<RuntimeOperationDefinition | undefined>;
    execute(
      session: PluginSessionContext,
      request: RuntimeOperationRequest,
      options?: RuntimeOperationExecutionOptions,
    ): Promise<RuntimeOperationExecutionResult>;
  };
};

/**
 * Explicit authority for durable execution. A stored roles array is never an
 * authority and deliberately has no representation in this contract.
 */
export type RuntimeDurableOperationAuthority =
  | { mode: "currentSubject"; subjectId: string }
  | { mode: "serviceIdentity"; serviceIdentityId: string };

/** Opaque, short-lived capability minted and verified by the core host. */
export type RuntimeDelegatedOperationCapability = {
  readonly __brand: unique symbol;
};

export type RuntimeDurableOperationRequest = {
  authority: RuntimeDurableOperationAuthority;
  capability: RuntimeDelegatedOperationCapability;
  operation: RuntimeOperationRequest;
};

export type RuntimeWorkerOperationExecutor = {
  /** Fails closed when the authority mode or fresh capability is absent. */
  execute(
    request: RuntimeDurableOperationRequest,
    options?: RuntimeOperationExecutionOptions,
  ): Promise<RuntimeOperationExecutionResult>;
};

/** References only: core resolves all authority and operation input from the claimed work. */
export type RuntimeDurableWorkReference = {
  workId: string;
  attempt: number;
  workerId: string;
};

export type RuntimeResolvedOperationWork = {
  tenantId: string;
  serviceIdentityId: string;
  /** Persisted before first dispatch; prevents changed contracts reopening unsafe retries. */
  operationContractFingerprint?: string;
  operation: { id: string; input?: Record<string, unknown>; idempotencyKey: string };
};

export type RuntimeWorkerOperationBroker = RuntimeWorkerOperationExecutor & {
  authorize(reference: RuntimeDurableWorkReference): Promise<RuntimeDurableOperationRequest>;
};

/**
 * The durable job/outbox primitive. A module enqueues a job inside the same
 * transaction as its domain write; the host's `job-worker` role claims it and
 * runs the handler registered for its kind under a tenant session for the
 * person who enqueued it.
 */
export type RuntimeJobSubject = { entity: string; id: string };

export type RuntimeJobStatus = "queued" | "running" | "done" | "failed" | "dead" | "outcome_unknown";

export type RuntimeJobEnqueueInput = {
  /** Namespaced, e.g. `mail.deliver` or `<plugin>.<job>`. */
  kind: string;
  payload: Record<string, unknown>;
  /**
   * Idempotent enqueue: the same key for the same tenant and kind returns the
   * existing job instead of a second one.
   */
  deliveryKey?: string;
  /** Not before; defaults to now. */
  availableAt?: Date;
  maxAttempts?: number;
  /** The record this job is about, so a screen can list the jobs of one record. */
  subject?: RuntimeJobSubject;
};

export type RuntimeJobEnqueueResult = {
  id: string;
  /** False when `deliveryKey` matched an existing job, which is returned instead. */
  created: boolean;
  status: RuntimeJobStatus;
};

export type RuntimeJobServices = {
  /**
   * Enqueue under the live verified session's tenant, inside the active
   * Operation transaction when there is one — the outbox pattern: the job
   * exists exactly when the domain write does.
   */
  enqueue(session: PluginSessionContext, input: RuntimeJobEnqueueInput): Promise<RuntimeJobEnqueueResult>;
};

/** What a job handler may read about the job it is running. */
export type RuntimeJobClaim = {
  id: string;
  tenantId: string;
  actorId: string;
  kind: string;
  /** 1 on the first run. */
  attempt: number;
  maxAttempts: number;
  subject: RuntimeJobSubject | null;
};

export type RuntimeJobError = { message: string; code?: string; detail?: Record<string, unknown> };

/**
 * How a handler ends. `retry` backs off with jitter and turns `dead` once the
 * attempt bound is reached; `failed` is terminal without retry;
 * `outcome_unknown` says an external effect MAY have happened and must never
 * be repeated automatically — an operator decides. A handler that throws is
 * treated as `retry`; one that returns nothing is `done`.
 */
export type RuntimeJobOutcome =
  | { outcome: "done"; result?: Record<string, unknown> }
  | { outcome: "retry"; error: RuntimeJobError; retryAt?: Date }
  | { outcome: "failed"; error: RuntimeJobError }
  | { outcome: "outcome_unknown"; error: RuntimeJobError };

export type RuntimeJobHandlerContextContract<Database> = {
  job: RuntimeJobClaim;
  /** A tenant session for the job's tenant and enqueuing actor, as the worker role. */
  db: Database;
  log: RuntimeWorkerLogger;
};

export type RuntimeJobHandlerContract<Context> = (
  payload: Record<string, unknown>,
  context: Context,
) => Promise<RuntimeJobOutcome | void>;

export type RuntimeJobHandler = RuntimeJobHandlerContract<
  RuntimeJobHandlerContextContract<Transaction<PluginDatabaseSchema>>
>;

/** Minimal structured logger shared by every contributed worker. */
export type RuntimeWorkerLogger = {
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
  error(payload: Record<string, unknown>, message: string): void;
};

/**
 * Host resources supplied when a contributed worker starts.
 *
 * The database is deliberately generic: core supplies its worker-role Kysely
 * connection, while this public package exposes no generated application
 * schema. The optional broker crosses into canonical Operations using a fresh
 * organization service identity; it never widens this queue-only DB connection.
 */
export type RuntimeWorkerContextContract<Database> = {
  db: Database;
  log: RuntimeWorkerLogger;
  /** The host's active generated registries, with no database or identity authority. */
  schemas?: PluginPlatformServices["schemas"];
  /** The same immutable compiled policy as the API; grants no session authority. */
  readonly settings?: RuntimeSettingsService;
  durableOperations?: RuntimeWorkerOperationBroker;
};

export type RuntimeWorkerHandle = {
  /** Settle only after any in-flight claim has stopped using host resources. */
  stop(): Promise<void>;
};

export type RuntimeWorkerContract<Context> = {
  start(context: Context): RuntimeWorkerHandle | Promise<RuntimeWorkerHandle>;
  /**
   * Core calls the registered implementation, not a callback supplied by the
   * poll loop. Read the exact current claim and active owning work from DB;
   * reject a different worker, attempt, cancelled owner or absent identity.
   */
  resolveOperationWork?(
    context: Context,
    reference: RuntimeDurableWorkReference,
  ): Promise<RuntimeResolvedOperationWork | undefined>;
  /** Atomically pin once under the exact active claim; reject a different fingerprint. */
  pinOperationContract?(
    context: Context,
    reference: RuntimeDurableWorkReference,
    fingerprint: string,
  ): Promise<void>;
};

export type ModuleRuntimeContextContract<Database, Platform> = {
  /** Absent in database-free API roles; plugins must degrade safely. */
  db?: Database | undefined;
  platform?: Platform | undefined;
};

export type ModuleRuntimeContext = ModuleRuntimeContextContract<
  Kysely<PluginDatabaseSchema>,
  PluginPlatformServices
>;

export type ModuleOperationSuccessResult<McpContent = readonly unknown[]> = {
  ok?: true;
  value: unknown;
  /** Explicitly preserve an already canonical success envelope in nested execution. */
  resultKind?: "operation-envelope";
  status?: number;
  headers?: Record<string, string>;
  contentType?: string;
  mcp?: {
    content: McpContent;
    structuredContent?: Record<string, unknown>;
  };
};

export type ModuleOperationErrorResult = {
  ok: false;
  status: number;
  code: string;
  body: unknown;
  headers?: Record<string, string>;
  contentType?: string;
};

export type ModuleOperationResult<McpContent = readonly unknown[]> =
  | ModuleOperationSuccessResult<McpContent>
  | ModuleOperationErrorResult;

export type ModuleOperationContextContract<
  RuntimeContext,
  Session,
  Request,
  Reply,
> = RuntimeContext & {
  transport: "rest" | "mcp" | "graphql" | "operation";
  session?: Session;
  request?: Request;
  reply?: Reply;
  /**
   * Live, host-minted bridge to a temporary core compatibility handler.
   * The canonical Operation handler remains the public entry point; this
   * bridge carries no transport name and cannot replace the active session.
   */
  invokeHostOperation(
    request: RuntimeHostOperationRequest,
    options?: RuntimeOperationExecutionOptions,
  ): Promise<RuntimeOperationExecutionResult>;
  /** Execute the core declarative Service engine under this live session. */
  invokeDeclarativeService(
    request: RuntimeDeclarativeServiceRequest,
    options?: RuntimeOperationExecutionOptions,
  ): Promise<RuntimeOperationExecutionResult>;
};

export type ModuleOperationHandlerContract<Context, Result> = (
  input: Record<string, unknown>,
  context: Context,
) => Result | Promise<Result>;

export type OperationAvailabilityDecision =
  | { available: true }
  | { available: false; error: OperationError };

/** Owner policy, evaluated for authorized records only. Must have no side effects. */
export type ModuleOperationAvailabilityHandlerContract<Database, Session> = (
  targetIds: readonly string[],
  context: { db: Database; session: Session },
) => Readonly<Record<string, OperationAvailabilityDecision>>
  | Promise<Readonly<Record<string, OperationAvailabilityDecision>>>;

export type ModuleOperationAvailabilityHandler = ModuleOperationAvailabilityHandlerContract<
  Transaction<PluginDatabaseSchema>, PluginSessionContext
>;

export type ModuleSeedResult = {
  present: boolean;
  skipped: boolean;
  rows?: number;
  reason?: string;
};

export type ModuleSeedContract<Database, Result> = {
  name: string;
  apply(db: Database, context?: ModuleSeedContext): Promise<Result>;
};

/** Managed seed services; no user identity or additional database authority. */
export type ModuleSeedContext = {
  schemas: PluginPlatformServices["schemas"];
  /** Compiler-collected fixtures from the active composed application. */
  seedDirectory?: string;
};

export type ModuleReadinessCheck = {
  name: string;
  check(): Promise<void> | void;
};

export type RuntimeModuleContract<
  RuntimeContext,
  OperationHandler,
  Routes,
  Seed,
  OperationProvider = RuntimeOperationProvider,
  Worker = RuntimeWorkerContract<
    RuntimeWorkerContextContract<Kysely<PluginDatabaseSchema>>
  >,
  AvailabilityHandler = ModuleOperationAvailabilityHandler,
  ArtifactStorage = RuntimeArtifactStorageContribution<PluginSessionContext, Transaction<PluginDatabaseSchema>>,
  JobHandler = RuntimeJobHandler,
> = {
  /** Must match the compiler plugin name. */
  name: string;
  init?(context: RuntimeContext): Promise<void>;
  readinessChecks?: readonly ModuleReadinessCheck[];
  close?(): Promise<void>;
  restRoutes?(routes: Routes, context: RuntimeContext): void;
  operationHandlers?: Record<string, OperationHandler>;
  /** Same compiler-owned handler keys; core rechecks these policies before execution. */
  operationAvailabilityHandlers?: Record<string, AvailabilityHandler>;
  /** At most one configured module supplies the internal provider-neutral storage port. */
  artifactStorage?: ArtifactStorage;
  operationProviders?: readonly OperationProvider[];
  workers?: Record<string, Worker>;
  /**
   * Handlers for durable job kinds, keyed by kind. A kind two active modules
   * both register fails closed when the host composes its handlers; a queued
   * job whose kind no module handles ends `dead`.
   */
  jobHandlers?: Record<string, JobHandler>;
  seeds?: Seed[];
};

export type ModuleOperationContext = ModuleOperationContextContract<
  ModuleRuntimeContext,
  PluginSessionContext,
  FastifyRequest,
  FastifyReply
>;
export type ModuleOperationHandler = ModuleOperationHandlerContract<
  ModuleOperationContext,
  ModuleOperationResult
>;
export type ModuleSeed = ModuleSeedContract<
  Kysely<PluginDatabaseSchema>,
  ModuleSeedResult
>;
export type RuntimeModule = RuntimeModuleContract<
  ModuleRuntimeContext,
  ModuleOperationHandler,
  FastifyInstance,
  ModuleSeed,
  RuntimeOperationProvider
>;
