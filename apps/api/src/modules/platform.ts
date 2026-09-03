// SPDX-License-Identifier: BUSL-1.1
/** Core-owned services made available to reviewed runtime modules. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withDbSession } from "../db/session.js";
import { appendEntityEvent } from "../platform/entity-events.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import type { Json } from "../generated/db/types.js";
import type {
  McpInvocationContext,
  ModuleAuthorizationDecision,
  ModuleAuthorizationSubject,
  ModuleInvocationSource,
  ModuleInvocationSourceSelector,
  ModulePlatformServices,
  ModuleToolExecutionOptions,
  ModuleToolExecutionResult,
} from "./contract.js";
import { parseModuleToolExecutionOptions } from "./invocation-sources.js";

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
    selector: ModuleInvocationSourceSelector,
    invocationToken: object,
    signal?: AbortSignal,
  ): Promise<readonly ModuleInvocationSource[]>;
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
  return Object.freeze({
    ...session,
    roles: Object.freeze([...session.roles]),
    groups: Object.freeze([...session.groups]),
    ...(session.oauthScopes
      ? { oauthScopes: Object.freeze([...session.oauthScopes]) }
      : {}),
  }) as unknown as TrustedSessionContext;
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
  readonly #servers = new Map<Server, ModuleMcpServerBinding>();
  readonly #activeOperationSessions = new WeakSet<ActiveOperationSession>();
  readonly #activeInvocations = new WeakMap<McpInvocationContext, number>();
  readonly #invocationStorage = new AsyncLocalStorage<McpInvocationContext>();
  readonly #toolCallStack = new AsyncLocalStorage<readonly string[]>();
  readonly #pendingChildren = new WeakMap<
    McpInvocationContext,
    Set<Promise<unknown>>
  >();

  constructor(db: OpenShapeForgeDatabase) {
    this.#db = db;
    this.services = {
      db: {
        withSession: (session, fn) => {
          if (!this.#acceptsScopedSession(session)) {
            throw new Error("Module database work requires a live verified session.");
          }
          return withDbSession(this.#db, session, fn);
        },
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
        resolveInvocationSources: async (session, toolName, selector, signal) => {
          signal?.throwIfAborted();
          const ctx = this.#invocationStorage.getStore();
          const binding = ctx ? this.#servers.get(ctx.server) : undefined;
          if (
            !ctx ||
            !binding ||
            binding.session !== session ||
            !this.#activeInvocations.has(ctx)
          ) return [];
          return binding.resolveInvocationSources(toolName, selector, ctx, signal);
        },
        callTool: async (ctx, name, args, options, signal) =>
          this.#callTool(ctx, name, args, options, signal),
      },
    };
    platformRuntimes.set(this.services, this);
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

export const __assertSecretFreeModuleEventForTests = assertSecretFree;
export const __isSensitiveModuleEventKeyForTests = isSensitiveEventKey;
