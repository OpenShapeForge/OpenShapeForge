// SPDX-License-Identifier: BUSL-1.1
/**
 * The runtime half of the plugin contract.
 *
 * `CompilerPlugin` (packages/compiler/src/plugins.ts) runs inside
 * `bun run generate`: it contributes platform tables and emits artifacts, and
 * every hook must be a pure function of the repo state. Runtime concerns cannot
 * live there. `connectors/loader.ts` states why, and it applies verbatim:
 *
 *   The compiler must never do this — output would depend on node_modules and
 *   the determinism gates would break — so resolution happens here, once, at
 *   boot.
 *
 * So a plugin package has two entry points. The compiler imports `<plugin>` for
 * its `CompilerPlugin`; the API imports `<plugin>/runtime` for a `RuntimeModule`
 * and gets GraphQL, routes, seeds and worker roles from it. Both are registered
 * by the same `plugins:` list in authoring.config.yaml, so a deployment cannot
 * end up running one half without the other.
 *
 * A plugin with no runtime entry point is normal, not an error — `entity-docs`
 * has nothing to contribute at runtime.
 *
 * GraphQL contributions are split into typeDefs / query fields / mutation
 * fields rather than one SDL blob because the root types are assembled, not
 * concatenated: `type Query { … }` appears exactly once and every module adds
 * fields inside it. Handing us a second `type Query` would be a schema error
 * that only surfaced at boot.
 */
import type { Duplex } from "node:stream";
import type { RuntimeSettingsService } from "@openshapeforge/plugin-runtime";
import type {
  ModuleOperationErrorResult as PublicModuleOperationErrorResult,
  ModuleOperationContextContract,
  ModuleOperationHandlerContract,
  ModuleOperationAvailabilityHandlerContract,
  ModuleOperationResult as PublicModuleOperationResult,
  ModuleOperationSuccessResult as PublicModuleOperationSuccessResult,
  ModuleReadinessCheck as PublicModuleReadinessCheck,
  ModuleRuntimeContextContract,
  ModuleSeedContract,
  RuntimeOperationDefinition,
  RuntimeOperationExecutionOptions,
  RuntimeOperationExecutionResult,
  RuntimeOperationProvider,
  RuntimeOperationRequest,
  RuntimeFieldSchemaCompiler,
  RuntimeJsonSchemaValidator,
  RuntimeModuleContract,
  RuntimeArtifactServices,
  RuntimeArtifactStorageContribution,
  RuntimeWorkerContextContract,
  RuntimeWorkerContract,
  RuntimeWorkerHandle,
  RuntimeWorkerLogger,
} from "@openshapeforge/plugin-runtime";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely, Transaction } from "kysely";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type {
  CallToolResult,
  ReadResourceResult,
  Resource,
  ResourceTemplate,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { DB } from "../generated/db/types.js";
import type { CatalogSeedResult } from "../db/migrations/catalog-seed.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import type { PlatformCatalogProvider } from "../control/platform-catalog.js";
import type { OperationError } from "@openshapeforge/operations";

/** What a module may read when building its surfaces. */
export type ModuleRuntimeContext = ModuleRuntimeContextContract<
  OpenShapeForgeDatabase,
  ModulePlatformServices
>;

/** Closed subjects whose identifiers core can resolve from trusted state. */
export type ModuleAuthorizationSubject =
  | { kind: "tool"; name: string }
  | { kind: "entity-row"; entity: string; id: string }
  | { kind: "resource-handle"; uri: string };

export type ModuleAuthorizationRequest = {
  action: string;
  subject: ModuleAuthorizationSubject;
};

export type ModuleAuthorizationDecision =
  | { allowed: true; fieldAllowlist?: readonly string[] }
  | {
      allowed: false;
      code:
        | "NOT_FOUND"
        | "FORBIDDEN"
        | "CONNECTION_REQUIRED"
        | "REAUTHORIZATION_REQUIRED";
    };

export type ModuleDefinitionReference = {
  kind: string;
  /** Core-owned opaque definition id; never model-visible. */
  id: string;
  version: number;
};

export type ModuleInvocationSource = {
  /** Opaque core capability valid for one invocation only. */
  sourceHandle: string;
  /** Durable opaque reference. It carries no authority by itself. */
  sourceReference: string;
  scope: "tenant" | "personal";
  binding: number;
  definition: ModuleDefinitionReference;
};

/**
 * A matching authored binding for which core found no eligible source.
 *
 * The closed outcome lets a coordinating module report an honest partial or
 * failed result without exposing a connection, provider or stored row.
 */
export type ModuleUnavailableInvocationSource = {
  binding: number;
  definition: ModuleDefinitionReference;
  outcome:
    | "unavailable"
    | "connection_required"
    | "reauthorization_required";
  /**
   * The platform's own next step for a connection gap, worded for the
   * caller (mcp/connection-guidance.ts): which Adapter, which tool, who may
   * run it. Never provider text. A coordinating module should surface it
   * verbatim as the source's explanation when present.
   */
  guidance?: string;
};

export type ModuleInvocationSourceResolution = {
  sources: readonly ModuleInvocationSource[];
  unavailable: readonly ModuleUnavailableInvocationSource[];
};

/** Trusted coordination identity for outbound work using a resolved source. */
export type ModuleEgressInvocationSource = {
  /** Durable opaque reference; it carries no authority and reveals no row id. */
  sourceReference: string;
  scope: "tenant" | "personal";
};

export type ModuleInvocationSourceSelector =
  | {
      mode: "default";
      /** A hint only; core re-authorizes it within the matching source set. */
      preferredSourceReference?: string;
    }
  | { mode: "explicit"; sourceHandle: string }
  | { mode: "all-authorized" };

export type ModuleToolExecutionOptions =
  | {
      sourceHandle: string;
      sourceReference?: never;
      expectedDefinition: ModuleDefinitionReference;
    }
  | {
      sourceHandle?: never;
      sourceReference: string;
      expectedDefinition: ModuleDefinitionReference;
    }
  | {
      sourceHandle?: never;
      sourceReference?: never;
      expectedDefinition?: never;
    };

export type ModuleToolExecutionResult = {
  result: CallToolResult;
  execution?: {
    sourceHandle: string;
    sourceReference: string;
    binding: number;
    definition: ModuleDefinitionReference;
  };
};

export type ModuleEgressRequest = {
  /** Parsed and protocol/allowlist-checked by core before this hook runs. */
  url: URL;
  init: RequestInit;
  allowlist: readonly string[];
  purpose: "provider" | "oauth" | "discovery" | "probe";
  scope: {
    tenantId: string | null;
    actorId: string | null;
    provider: string;
    operation: string;
    kind: "query" | "mutation";
  };
  /**
   * Present only when core resolved an invocation source for this execution.
   * OAuth, discovery, probes and other source-less traffic omit it.
   */
  source?: ModuleEgressInvocationSource;
  signal?: AbortSignal;
  /**
   * Create a core-owned failure with one of the closed egress outcomes. The
   * factory deliberately accepts no message or details.
   */
  createFailure(kind: ModuleEgressFailureKind): Error;
};

export type ModuleEgressFailureKind = "policy_blocked" | "timeout";

/**
 * Which Connection a module wants. `adapterKey` is the ordinary case — "the
 * caller's own connection to this Adapter" — and deliberately needs no
 * identifier from tool input, which would be untrusted anyway. `connectionId`
 * is for a module that already holds one from its own stored state.
 */
export type ModuleConnectionSelector =
  | { connectionId: string; adapterKey?: never }
  | { adapterKey: string; connectionId?: never };

/**
 * Permission to open outbound connections, minted by core alongside a resolved
 * Connection. Opaque on purpose: a module cannot read the allow-list off it,
 * cannot widen it, and cannot construct one. It is handed straight back to
 * `platform.egress.connect`, which looks the real policy up again.
 */
export type ModuleSocketGrant = { readonly __brand: unique symbol };

export type ModuleSocketRequest = {
  host: string;
  port: number;
  /** Implicit TLS from the first byte (an IMAPS port, say). */
  tls: boolean;
  /** SNI name; defaults to `host`. */
  servername?: string;
  /** Only a test server against a self-signed certificate sets this false. */
  rejectUnauthorized?: boolean;
  /** Deadline for establishing the connection. */
  timeoutMs?: number;
};

/** One Connection's values, opened for the module core decided may see them. */
export type ModuleConnectionValues = {
  connectionId: string;
  connectionKey: string;
  adapterKey: string;
  /** The Adapter's declared transport, e.g. "rest" or "socket". */
  transport: string;
  /** Whether this Adapter's Connections are per employee or per organization. */
  connectionScope: "tenant" | "user";
  /** The employee this Connection belongs to; null for an organization one. */
  ownerUserId: string | null;
  /**
   * Every configuration value, decrypted: the plain ones and the ones stored
   * as ciphertext, keyed by the Adapter's configuration field keys. Any OAuth
   * tokens stored against the Connection appear as `accessToken` /
   * `refreshToken` — a socket koppeling authenticates with the token the same
   * way an HTTP one puts it in a header.
   */
  values: Readonly<Record<string, string>>;
  /** Which of those keys the Adapter classifies as secret, for a module's own logging. */
  secretKeys: readonly string[];
  /** Permission to connect where this Adapter says it may. */
  egressGrant: ModuleSocketGrant;
};

export type ModuleConnectionResolution =
  | { ok: true; connection: ModuleConnectionValues }
  | {
      ok: false;
      code:
        | "NOT_FOUND"
        | "FORBIDDEN"
        | "CONNECTION_REQUIRED"
        | "SECRET_KEYRING_MISSING"
        /** The stored OAuth sign-in expired and could not be renewed: the person signs in again. */
        | "REAUTHORIZATION_REQUIRED"
        /** The provider's token endpoint or the Adapter's OAuth configuration failed; nothing was handed over. */
        | "TOKEN_REFRESH_FAILED";
      /** A sentence for the person who has to fix it. */
      message: string;
    };

export type ModulePlatformServices = {
  readonly settings: RuntimeSettingsService;
  readonly artifacts: RuntimeArtifactServices<TrustedSessionContext>;
  durableOperations?: {
    organizationServiceIdentity(session: TrustedSessionContext): Promise<{ serviceIdentityId: string }>;
  };
  db: {
    withSession<T>(
      session: TrustedSessionContext,
      fn: (trx: Transaction<DB>) => Promise<T>,
    ): Promise<T>;
  };
  schemas: {
    fields: RuntimeFieldSchemaCompiler;
    json: RuntimeJsonSchemaValidator;
  };
  events: {
    append(
      session: TrustedSessionContext,
      event: {
        aggregateType: string;
        aggregateId: string;
        eventType: string;
        payload: Record<string, unknown>;
      },
    ): Promise<void>;
  };
  errors: {
    classifyDatabase(cause: unknown): OperationError | undefined;
  };
  operations: {
    list(
      session: TrustedSessionContext,
    ): Promise<readonly RuntimeOperationDefinition[]>;
    get(
      session: TrustedSessionContext,
      operationId: string,
    ): Promise<RuntimeOperationDefinition | undefined>;
    execute(
      session: TrustedSessionContext,
      request: RuntimeOperationRequest,
      options?: RuntimeOperationExecutionOptions,
    ): Promise<RuntimeOperationExecutionResult>;
  };
  /**
   * The plaintext of a Connection's configuration — the seam a koppeling that
   * is not HTTP needs and had no way to reach. Core resolves the row under the
   * caller's session, enforces the Adapter's connection scope, and only then
   * decrypts; the keyring itself never leaves core. See
   * `modules/connection-secrets.ts` for the three gates.
   */
  secrets: {
    resolveConnectionValues(
      session: TrustedSessionContext,
      selector: ModuleConnectionSelector,
    ): Promise<ModuleConnectionResolution>;
  };
  /**
   * Outbound connections that are not requests. `egressHosts` entries naming a
   * port (`mail.example.com:993`) grant a socket to exactly that host and
   * port; a bare hostname stays an HTTP grant and grants no socket. See
   * `modules/socket-egress.ts`.
   */
  egress: {
    connect(
      session: TrustedSessionContext,
      grant: ModuleSocketGrant,
      request: ModuleSocketRequest,
    ): Promise<Duplex>;
  };
  mcp: {
    notifyToolsChanged(scope: { tenantId: string | null }): void;
    notifyResourcesChanged(scope: { tenantId: string | null }): void;
    authorize(
      session: TrustedSessionContext,
      request: ModuleAuthorizationRequest,
    ): Promise<ModuleAuthorizationDecision>;
    resolveInvocationSources(
      session: TrustedSessionContext,
      toolName: string,
      /** Untrusted invocation values, cloned and frozen by core. */
      args: Record<string, unknown>,
      selector: ModuleInvocationSourceSelector,
      signal?: AbortSignal,
    ): Promise<ModuleInvocationSourceResolution>;
    callTool(
      ctx: McpInvocationContext,
      name: string,
      args: Record<string, unknown>,
      options?: ModuleToolExecutionOptions,
      signal?: AbortSignal,
    ): Promise<ModuleToolExecutionResult>;
  };
};

export type McpClientCapabilities = {
  elicitation: boolean;
  mcpApp: boolean;
};

export type McpProjectionContext = {
  db: OpenShapeForgeDatabase;
  session: TrustedSessionContext;
  clientCapabilities: McpClientCapabilities;
};

export type McpInvocationContext = McpProjectionContext & {
  server: Server;
  requestId: string | number;
};

export type McpToolCallSource =
  | "crud"
  | "derived"
  | "operation"
  | "connector"
  | "module";

export type RuntimeMcpContribution = {
  /**
   * Refine core authorization or claim a registered module-owned MCP surface.
   * Return `undefined` to abstain. This hook deliberately receives no platform
   * service, projection context, or `next` callback: core authorization is
   * composed exactly once outside module code.
   */
  authorize?(
    session: TrustedSessionContext,
    request: ModuleAuthorizationRequest,
  ): Promise<ModuleAuthorizationDecision | undefined>;
  tools?(ctx: McpProjectionContext): Promise<Tool[]>;
  callTool?(
    name: string,
    args: Record<string, unknown>,
    ctx: McpInvocationContext,
  ): Promise<CallToolResult>;
  decorateTool?(
    tool: Tool,
    source: McpToolCallSource,
    ctx: McpProjectionContext,
  ): Tool;
  resources?(ctx: McpProjectionContext): Promise<Resource[]>;
  resourceTemplates?(ctx: McpProjectionContext): Promise<ResourceTemplate[]>;
  readResource?(
    uri: string,
    ctx: McpInvocationContext,
  ): Promise<ReadResourceResult | undefined>;
  interceptToolCall?(
    call: {
      name: string;
      source: McpToolCallSource;
      arguments: Record<string, unknown>;
      ctx: McpInvocationContext;
    },
    next: (
      options?: ModuleToolExecutionOptions,
    ) => Promise<ModuleToolExecutionResult>,
  ): Promise<ModuleToolExecutionResult>;
};

export type ModuleGraphqlContribution = {
  /** Type/input/enum definitions. Must NOT declare `type Query`/`type Mutation`. */
  typeDefs?: string;
  /** Field lines spliced into the single root `type Query`. */
  queryFields?: string;
  /** Field lines spliced into the single root `type Mutation`. */
  mutationFields?: string;
  /**
   * Resolvers keyed by type name, including `Query` and `Mutation`. Merged
   * per type, so two modules may each add root fields; colliding field names
   * are refused at boot rather than silently last-wins.
   */
  resolvers?: Record<string, Record<string, unknown>>;
};

/** A migration-chain seed step contributed by a module. */
export type ModuleSeed = ModuleSeedContract<Kysely<DB>, CatalogSeedResult>;

export type ModuleReadinessCheck = PublicModuleReadinessCheck;

/**
 * The logger a worker writes to. Structurally the slice of Fastify's logger a
 * worker needs, declared here so a plugin's worker does not have to import
 * Fastify — or, worse, reach for `console` and land outside the process's log
 * stream.
 */
export type ModuleWorkerLogger = RuntimeWorkerLogger;

/**
 * What a worker may read when it starts.
 *
 * `db` is REQUIRED here, unlike {@link ModuleRuntimeContext} where a module must
 * degrade without one. A GraphQL surface with no database can still answer with
 * DATABASE_NOT_CONFIGURED; a queue-draining worker with no database has nothing
 * to do at all, so the worker role refuses to start rather than idling.
 */
export type ModuleWorkerContext = RuntimeWorkerContextContract<
  OpenShapeForgeDatabase
>;

export type ModuleWorkerHandle = RuntimeWorkerHandle;

/**
 * A long-running process a module contributes, run by the `worker` role rather
 * than alongside the API.
 *
 * Separate processes on purpose: a poll loop and a request path have unrelated
 * failure modes and unrelated scaling needs, and a worker that wedges must not
 * take GraphQL down with it. It is also what lets a worker's database identity
 * differ from a request's: a worker connects as `openshapeforge_worker` (its
 * own OPENSHAPEFORGE_WORKER_DATABASE_URL, never the API's) and presents
 * `app.worker_role` on top, and the queue policies check both.
 */
export type ModuleWorker = RuntimeWorkerContract<ModuleWorkerContext>;

export type ModuleOperationSuccessResult = PublicModuleOperationSuccessResult<
  CallToolResult["content"]
>;

/** A non-success result must match one error declared by the compiler plugin. */
export type ModuleOperationErrorResult = PublicModuleOperationErrorResult;

export type ModuleOperationResult = PublicModuleOperationResult<
  CallToolResult["content"]
>;

export type ModuleOperationContext = ModuleOperationContextContract<
  ModuleRuntimeContext,
  TrustedSessionContext,
  FastifyRequest,
  FastifyReply
>;

export type ModuleOperationHandler = ModuleOperationHandlerContract<
  ModuleOperationContext,
  ModuleOperationResult
>;

export type ModuleOperationAvailabilityHandler = ModuleOperationAvailabilityHandlerContract<
  Transaction<DB>, TrustedSessionContext
>;

export type RuntimeModule = RuntimeModuleContract<
  ModuleRuntimeContext,
  ModuleOperationHandler,
  FastifyInstance,
  ModuleSeed,
  RuntimeOperationProvider,
  ModuleWorker,
  ModuleOperationAvailabilityHandler,
  RuntimeArtifactStorageContribution<TrustedSessionContext, Transaction<DB>>
> & {
  graphql?(context: ModuleRuntimeContext): ModuleGraphqlContribution;
  /** Dynamic MCP projection and invocation hooks, evaluated per request. */
  mcp?: RuntimeMcpContribution;
  /** At most one loaded module may own final outbound request execution. */
  egress?: { fetch(request: ModuleEgressRequest): Promise<Response> };
  /**
   * A platform-level (cross-tenant) catalog this module administers, used
   * ONLY by the control plane's platform administrator MCP
   * (`control/platform-catalog.ts`) on an audited system session. Never
   * reached from a tenant session. At most one loaded module may supply it.
   */
  platformCatalog?: PlatformCatalogProvider;
};
