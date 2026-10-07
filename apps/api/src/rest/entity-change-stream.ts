// SPDX-License-Identifier: BUSL-1.1
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { FastifyInstance } from "fastify";
import { resolveSessionContext } from "../auth/identity.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { headersFromFastify } from "../http/headers.js";
import { encodeStreamFrame, parseStreamCursor, readChangeBatch } from "../platform/entity-change-stream.js";
import type { ResourceChangeAuthorizer } from "../platform/entity-change-stream.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";

/** Authenticated SSE. No credentials or business payloads are accepted in URLs. */
export function registerEntityChangeStream(app: FastifyInstance, options: { db?: OpenShapeForgeDatabase; authorizeResource?:(session: TrustedSessionContext, entity:string, id:string) => Promise<boolean> }) {
  const active = new Map<string, number>();
  const controllers = new Set<AbortController>();
  app.addHook("onClose", async () => { for (const controller of controllers) controller.abort(); });
  app.get("/api/events", async (request, reply) => {
    let cursor: string | undefined;
    try { cursor = parseStreamCursor(request.headers["last-event-id"]); }
    catch { return reply.code(400).send({ error: { code: "INVALID_STREAM_CURSOR", message: "Invalid stream cursor." } }); }
    const db = options.db;
    if (!db) return reply.code(503).send({ error: { code: "DATABASE_NOT_CONFIGURED" } });
    const headers = headersFromFastify(request.headers);
    const session = await resolveSessionContext(headers, { db, mcpAppResource: true });
    if (!session.tenantId || !session.userId) return reply.code(401).send({ error: { code: "UNAUTHENTICATED" } });
    const key = `${session.tenantId}:${session.userId}`;
    if ((active.get(key) ?? 0) >= 5) return reply.code(429).header("retry-after", "5").send({ error: { code: "STREAM_LIMIT" } });
    active.set(key, (active.get(key) ?? 0) + 1);
    const abort = new AbortController();
    controllers.add(abort);
    // Released once, by whichever comes first: the generator ending, or the
    // client leaving — also before the first frame was ever pulled, when the
    // generator never starts and its finally never runs.
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      reply.raw.off("close", close);
      request.raw.off("aborted", close);
      socket?.off("close", close);
      controllers.delete(abort);
      const remaining = (active.get(key) ?? 1) - 1;
      if (remaining) active.set(key, remaining); else active.delete(key);
    };
    const close = () => { abort.abort(); release(); };
    // A client that goes away must release its stream slot at once. Under Bun
    // the reply never emits "close" for a disconnected client — the request
    // emits "aborted" and its socket "close" — so a navigation left its stream
    // counted until rotation and the sixth one within a minute was refused
    // STREAM_LIMIT (#886). (The request's own "close" is avoided: some Node
    // versions emit it once the body is read, which would end every stream.)
    const socket = request.raw.socket;
    reply.raw.on("close", close);
    request.raw.on("aborted", close);
    socket?.on("close", close);
    async function* frames() {
      const started = Date.now();
      let validateCursor = true;
      try {
        // Rotate periodically so reauthentication/renewal cannot leave a stale stream.
        while (!abort.signal.aborted && Date.now() - started < 55_000) {
          const current = await resolveSessionContext(headers, { db, mcpAppResource: true });
          if (current.tenantId !== session.tenantId || current.userId !== session.userId) break;
          const authorize: ResourceChangeAuthorizer | undefined = options.authorizeResource
            ? (_dbSession, entity, id) => options.authorizeResource!(current, entity, id)
            : undefined;
          const batch = await readChangeBatch(db!, current, cursor, validateCursor, authorize);
          validateCursor = false;
          if (batch.reset) yield encodeStreamFrame(batch.cursor, "stream.reset", { reason: "cursor_expired" });
          for (const event of batch.changes) yield encodeStreamFrame(event.cursor, "resource.changed", event.data);
          cursor = batch.cursor;
          yield encodeStreamFrame(cursor);
          await delay(1000, undefined, { signal: abort.signal });
        }
      } catch (error) {
        if (!abort.signal.aborted) request.log.warn({ code: "STREAM_INTERRUPTED" }, "Entity stream interrupted; client may reconnect.");
      } finally {
        release();
      }
    }
    return reply.header("content-type", "text/event-stream; charset=utf-8")
      .header("cache-control", "no-cache, no-store").header("x-accel-buffering", "no")
      .send(Readable.from(frames()));
  });
}
