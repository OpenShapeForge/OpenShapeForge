// SPDX-License-Identifier: BUSL-1.1
/**
 * Discovery of the external catalogs a session may see, inside the live
 * request that is allowed to see them.
 *
 * An upstream MCP server is reached with the caller's own credentials, and
 * which upstreams exist for a caller is the caller's own Relation, its
 * RelationGroup memberships and its roles — all of which a stateful MCP
 * transport resolves per HTTP request and exposes only for the duration of
 * that request (mcp/stateful-session-authorization.ts). A refresh started
 * from the session and left to finish on its own therefore runs as nobody:
 * it reads no personal Connection, and whatever authority it did retain
 * would outlive the request that proved it.
 *
 * So discovery is awaited where that authority is live, and nowhere else:
 *
 *   - on authenticated `initialize` or `server/discover`, before the
 *     client's first `tools/list` (transport-sessions.ts);
 *   - after an authenticated `tools/call`, which is where a connection this
 *     session may use is established, replaced or re-authorized
 *     (generated-mcp-server.ts).
 *
 * `tools/list` itself never reaches upstream: it answers from the snapshot
 * the providers already hold, so an unreachable upstream costs a session
 * nothing but the tools it would have added.
 *
 * The session handed to the platform is the transport's session, NOT the
 * capability the session's server registered. The platform mints an
 * invocation-scoped capability for it, which stops being accepted the moment
 * the refresh returns — so a provider continuation that outlived the bound
 * can no longer open a secret, a database session or an egress connection.
 */
import type { Server } from "@modelcontextprotocol/server";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AsyncLocalStorage } from "node:async_hooks";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import type { ModulePlatformRuntime } from "../modules/platform.js";

/**
 * What one live request waits for every upstream catalog together.
 *
 * It is a client-visible delay — on `initialize` before the session answers,
 * on a `tools/call` before its result. It exceeds the upstream per-connection
 * timeout so a slow but valid server can complete. Providers throttle their own upstream
 * traffic and answer from their snapshot otherwise, so the common request
 * pays nothing; the one that pays is the first connect of a session and the
 * call that changed a connection, which is exactly where the person is
 * waiting for the new tools.
 */
export const LIVE_DISCOVERY_BUDGET_MS = 12_000;

export type ExternalDiscovery = {
  /**
   * Discover now, bounded, and never throw: the session keeps the catalog it
   * already had when an upstream fails, stalls or is cancelled. Answers
   * whether anything changed.
   */
  discover(options?: {
    signal?: AbortSignal | undefined;
    notify?: boolean | undefined;
  }): Promise<boolean>;
};

/**
 * One discovery per session server. The transport needs the discovery of the
 * server it just built for `initialize`, and keying it on that server keeps
 * two sessions — two identities — from ever sharing one.
 */
const bySessionServer = new WeakMap<Server, ExternalDiscovery>();

export function createExternalDiscovery(input: {
  server: Server;
  session: TrustedSessionContext;
  modulePlatform: ModulePlatformRuntime | undefined;
  budgetMs?: number;
}): ExternalDiscovery {
  const { modulePlatform, server, session } = input;
  const budgetMs = input.budgetMs ?? LIVE_DISCOVERY_BUDGET_MS;
  // Serialize per server, but let a still-live later request perform its own
  // refresh: an earlier sweep may have read the catalog before its change.
  let running: Promise<void> | undefined;
  const discovery: ExternalDiscovery = {
    discover: async (options = {}) => {
      if (!modulePlatform || options.signal?.aborted) return false;
      const timeout = AbortSignal.timeout(budgetMs);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      while (running && !signal.aborted) {
        const previous = running;
        await new Promise<void>(resolve => {
          const done = () => { signal.removeEventListener("abort", done); resolve(); };
          signal.addEventListener("abort", done, { once: true });
          void previous.then(done);
        });
      }
      if (signal.aborted) return false;
      const finished = Promise.withResolvers<void>();
      running = finished.promise;
      try {
        return await modulePlatform.refreshExternalCatalogs(session, {
          signal,
          budgetMs,
          notify: options.notify !== false,
        });
      } catch {
        // Discovery improves the snapshot the session already has; it never
        // decides whether the request it ran inside succeeds.
        return false;
      } finally {
        running = undefined;
        finished.resolve();
      }
    },
  };
  bySessionServer.set(server, discovery);
  return discovery;
}

export function externalDiscoveryOf(server: Server): ExternalDiscovery | undefined {
  return bySessionServer.get(server);
}

/**
 * The live request, as a signal. A client that disconnects or cancels ends
 * the authority its request carried, so discovery stops with it rather than
 * continuing as a job nobody is waiting for.
 */
const requestSignal = new AsyncLocalStorage<AbortSignal>();

export function currentLiveRequestSignal(): AbortSignal | undefined {
  return requestSignal.getStore();
}

export async function withLiveRequestSignal<T>(request: FastifyRequest, reply: FastifyReply, work: () => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const close = () => controller.abort();
  if (reply.raw.destroyed || reply.raw.writableEnded) controller.abort();
  else {
    reply.raw.once("close", close);
    request.raw.socket.once("close", close);
  }
  try {
    return await requestSignal.run(controller.signal, work);
  } finally {
    controller.abort();
    reply.raw.removeListener("close", close);
    request.raw.socket.removeListener("close", close);
  }
}
