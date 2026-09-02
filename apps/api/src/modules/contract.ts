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

/** What a module may read when building its surfaces. */
export type ModuleRuntimeContext = {
  /** Absent when DATABASE_URL is unset; a module must degrade, not throw. */
  db?: OpenShapeForgeDatabase | undefined;
  /** Core-owned capabilities. Absent alongside `db` in database-free roles. */
  platform?: ModulePlatformServices | undefined;
};

/** Closed subjects whose identifiers core can resolve from trusted state. */
export type ModuleAuthorizationSubject =
  | { kind: "tool"; name: string }
  | { kind: "entity-row"; entity: string; id: string }
  | { kind: "resource-handle"; uri: string };

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

/** Trusted coordination identity for outbound work using a resolved source. */
export type ModuleEgressInvocationSource = {
  /** Durable opaque reference; it carries no authority and reveals no row id. */
  sourceReference: string;
  scope: "tenant" | "personal";
};

export type ModuleInvocationSourceSelector =
  | { mode: "default" }
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
};

export type ModuleEgressFailureKind = "policy_blocked" | "timeout";

/**
 * The only failure meaning a trusted egress owner may add to an outbound call.
 * The type deliberately accepts no message or details: core supplies the public
 * wording and discards the module's stack at the hook boundary.
 */
export class ModuleEgressError extends Error {
  readonly kind: ModuleEgressFailureKind;

  constructor(kind: ModuleEgressFailureKind) {
    super(
      kind === "policy_blocked"
        ? "Outbound policy blocked the request."
        : "Outbound request timed out.",
    );
    this.name = "ModuleEgressError";
    this.kind = kind;
  }
}

export type ModulePlatformServices = {
  db: {
    withSession<T>(
      session: TrustedSessionContext,
      fn: (trx: Transaction<DB>) => Promise<T>,
    ): Promise<T>;
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
  mcp: {
    notifyToolsChanged(scope: { tenantId: string | null }): void;
    notifyResourcesChanged(scope: { tenantId: string | null }): void;
    authorize(
      session: TrustedSessionContext,
      request: { action: string; subject: ModuleAuthorizationSubject },
    ): Promise<ModuleAuthorizationDecision>;
    resolveInvocationSources(
      session: TrustedSessionContext,
      toolName: string,
      selector: ModuleInvocationSourceSelector,
      signal?: AbortSignal,
    ): Promise<readonly ModuleInvocationSource[]>;
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
export type ModuleSeed = {
  /** Reported under this key in the db:migrate output. */
  name: string;
  apply(db: Kysely<DB>): Promise<CatalogSeedResult>;
};

/**
 * The logger a worker writes to. Structurally the slice of Fastify's logger a
 * worker needs, declared here so a plugin's worker does not have to import
 * Fastify — or, worse, reach for `console` and land outside the process's log
 * stream.
 */
export type ModuleWorkerLogger = {
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
  error(payload: Record<string, unknown>, message: string): void;
};

/**
 * What a worker may read when it starts.
 *
 * `db` is REQUIRED here, unlike {@link ModuleRuntimeContext} where a module must
 * degrade without one. A GraphQL surface with no database can still answer with
 * DATABASE_NOT_CONFIGURED; a queue-draining worker with no database has nothing
 * to do at all, so the worker role refuses to start rather than idling.
 */
export type ModuleWorkerContext = {
  db: OpenShapeForgeDatabase;
  log: ModuleWorkerLogger;
};

export type ModuleWorkerHandle = {
  /**
   * Stop, and settle only AFTER the in-flight tick has finished.
   *
   * A `stop()` that returns while a command is still claimed leaves the row
   * `processing` until the visibility timeout reclaims it — a shutdown that
   * costs the next worker a delay and an attempt, every time, which is exactly
   * the sort of thing nobody notices until the retry bound is reached.
   */
  stop(): Promise<void>;
};

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
export type ModuleWorker = {
  start(context: ModuleWorkerContext): ModuleWorkerHandle | Promise<ModuleWorkerHandle>;
};

export type ModuleOperationResult = {
  value: unknown;
  status?: number;
  headers?: Record<string, string>;
  contentType?: string;
};

export type ModuleOperationContext = ModuleRuntimeContext & {
  transport: "rest" | "mcp" | "graphql";
  session?: TrustedSessionContext;
  request?: FastifyRequest;
  reply?: FastifyReply;
};

export type ModuleOperationHandler = (
  input: Record<string, unknown>,
  context: ModuleOperationContext,
) => ModuleOperationResult | Promise<ModuleOperationResult>;

export type RuntimeModule = {
  /** Must match the CompilerPlugin name of the same package. */
  name: string;
  /**
   * One-shot async setup, awaited before the process serves traffic.
   *
   * `graphql()` is synchronous — a schema cannot be built from a promise — so a
   * module that must read something before it can answer has nowhere else to do
   * it. The workflow module hydrates its node catalog here: without that, every
   * node type resolves to null and definition validation silently passes while
   * checking nothing, which is worse than failing.
   *
   * Throwing here is a load failure like any other: the module is recorded and
   * skipped rather than taking the process down.
   */
  init?(context: ModuleRuntimeContext): Promise<void>;
  graphql?(context: ModuleRuntimeContext): ModuleGraphqlContribution;
  /**
   * Register fastify routes. Called inside the same child plugin the core
   * routes use, so contributed routes are behind the rate limiter too.
   */
  restRoutes?(routes: FastifyInstance, context: ModuleRuntimeContext): void;
  /** Handlers for compiler-declared canonical operations, keyed by `handler`. */
  operationHandlers?: Record<string, ModuleOperationHandler>;
  /** Seed steps appended to the migration chain, in declaration order. */
  seeds?: ModuleSeed[];
  /**
   * Worker roles this module contributes, keyed by role name — the value
   * `OPENSHAPEFORGE_ROLE` selects. A role name colliding across two modules is
   * refused at boot rather than silently last-wins, exactly as a GraphQL field
   * name is.
   */
  workers?: Record<string, ModuleWorker>;
  /** Dynamic MCP projection and invocation hooks, evaluated per request. */
  mcp?: RuntimeMcpContribution;
  /** At most one loaded module may own final outbound request execution. */
  egress?: { fetch(request: ModuleEgressRequest): Promise<Response> };
};
