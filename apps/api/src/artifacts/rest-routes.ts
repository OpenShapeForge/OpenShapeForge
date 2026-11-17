// SPDX-License-Identifier: BUSL-1.1
let activeDownloads = 0;
const activeDownloadsByTenant = new Map<string, number>();
// Four 64 MiB buffers bound process-wide memory; no one tenant may occupy all.
const MAX_ACTIVE_DOWNLOADS = 4;
const MAX_TENANT_DOWNLOADS = 2;
/** Core-owned HTTP adapter for provider-neutral artifact services. */
import type { RuntimeArtifactServices } from "@openshapeforge/plugin-runtime";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { resolveSessionContext } from "../auth/identity.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { headersFromFastify } from "../http/headers.js";
import { HttpError, toHttpError } from "../rest/http-error.js";
import { ARTIFACT_UPLOAD_LIMIT_BYTES, assertUploadFileName, limitUploadBody } from "./upload-input.js";

export const ARTIFACT_STAGE_PATH = "/api/artifacts";
export const ARTIFACT_CONTENTS_PATH = "/api/artifacts/:artifactId/contents";

function header(request: FastifyRequest, name: string): string {
  const value = request.headers[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, "BAD_USER_INPUT", `Header ${name} is required.`);
  }
  return value;
}

function fileName(request: FastifyRequest): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(header(request, "x-file-name"));
  } catch {
    throw new HttpError(400, "BAD_USER_INPUT", "The file name is not valid UTF-8.");
  }
  assertUploadFileName(decoded);
  return decoded;
}

function queryString(request: FastifyRequest, name: string): string {
  const value = (request.query as Record<string, unknown> | null)?.[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, "BAD_USER_INPUT", `Query parameter ${name} is required.`);
  }
  return value;
}

async function session(
  request: FastifyRequest,
  db: OpenShapeForgeDatabase | undefined,
): Promise<TrustedSessionContext> {
  const resolved = await resolveSessionContext(headersFromFastify(request.headers), { db });
  if (!resolved.tenantId || !resolved.userId) {
    throw new HttpError(401, "UNAUTHENTICATED", "File access requires an authenticated session.");
  }
  return resolved;
}

function contentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "document";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Apply the same active-session boundary to every artifact call, preserving cancellation. */
export function activeArtifactServices<Session>(
  services: RuntimeArtifactServices<Session>,
  withActive: <T>(session: Session, work: (active: Session) => Promise<T>) => Promise<T>,
): RuntimeArtifactServices<Session> {
  return {
    stage: (session, input) => withActive(session, (active) => services.stage(active, input)),
    bind: (session, input) => withActive(session, (active) => services.bind(active, input)),
    read: (session, input, options) => withActive(session, (active) => services.read(active, input, options)),
  };
}

export function registerArtifactRestRoutes(
  app: FastifyInstance,
  options: {
    artifacts: RuntimeArtifactServices<TrustedSessionContext>;
    db?: OpenShapeForgeDatabase | undefined;
    /** Server-owned bound for cooperative provider cancellation. */
    downloadTimeoutMs?: number;
  },
): void {
  void app.register(async (instance) => {
    // Browsers send the File unchanged. The provider streams, limits and sniffs
    // the bytes; no client-declared MIME type or hash becomes authority.
    instance.addContentTypeParser(
      "application/octet-stream",
      (request, payload, done) => done(null, payload),
    );
    instance.setErrorHandler((error, _request, reply) => {
      const projected = toHttpError(error);
      if (projected.status >= 500) instance.log.error({ err: error }, "Artifact request failed.");
      void reply.status(projected.status).send(projected.body);
    });

    instance.post(ARTIFACT_STAGE_PATH, { bodyLimit: ARTIFACT_UPLOAD_LIMIT_BYTES }, async (request, reply) => {
      const verified = await session(request, options.db);
      const source = request.body as AsyncIterable<Uint8Array> | undefined;
      if (!source || typeof source[Symbol.asyncIterator] !== "function") {
        throw new HttpError(400, "BAD_USER_INPUT", "A file body is required.");
      }
      const descriptor = await options.artifacts.stage(verified, {
        purpose: "record-upload",
        fileName: fileName(request),
        source: limitUploadBody(source, request.headers["content-length"]),
      });
      return reply.status(201).send({ data: descriptor, operations: [] });
    });

    instance.get(ARTIFACT_CONTENTS_PATH, async (request, reply) => {
      const verified = await session(request, options.db);
      if (reply.raw.destroyed || reply.raw.writableEnded) return;
      const { artifactId } = request.params as { artifactId: string };
      const tenantId = verified.tenantId!.toLowerCase();
      const tenantDownloads = activeDownloadsByTenant.get(tenantId) ?? 0;
      if (activeDownloads >= MAX_ACTIVE_DOWNLOADS || tenantDownloads >= MAX_TENANT_DOWNLOADS) {
        throw new HttpError(429, "ARTIFACT_DOWNLOAD_LIMIT", "Download capacity reached; retry later.");
      }
      activeDownloads++;
      activeDownloadsByTenant.set(tenantId, tenantDownloads + 1);
      let released = false, readSettled = false, responseSettled = false;
      const abort = new AbortController();
      const deadline = setTimeout(() => {
        if (readSettled) reply.raw.destroy();
        else abort.abort();
      }, options.downloadTimeoutMs ?? 30_000);
      deadline.unref();
      const release = () => {
        if (!released && readSettled && responseSettled) {
          released = true;
          activeDownloads--;
          const remaining = activeDownloadsByTenant.get(tenantId)! - 1;
          if (remaining) activeDownloadsByTenant.set(tenantId, remaining);
          else activeDownloadsByTenant.delete(tenantId);
        }
      };
      const responseDone = () => { clearTimeout(deadline); if (!readSettled) abort.abort(); responseSettled = true; release(); };
      reply.raw.once("finish", responseDone);
      reply.raw.once("close", responseDone);
      if (reply.raw.destroyed || reply.raw.writableEnded) {
        readSettled = true;
        responseDone();
        return;
      }
      try {
      const result = await options.artifacts.read(verified, {
        artifactId,
        owner: { entity: queryString(request, "ownerEntity"), id: queryString(request, "ownerId") },
      }, { signal: abort.signal });
      if (abort.signal.aborted) throw new HttpError(504, "ARTIFACT_DOWNLOAD_TIMEOUT", "File download timed out.");
      readSettled = true;
      release();
      return reply
        .header("content-type", result.descriptor.mediaType)
        .header("content-length", String(result.bytes.byteLength))
        .header("content-disposition", contentDisposition(result.descriptor.fileName))
        // Stored bytes are served as the declared type and never cached:
        // a later permission change must not be answered from a cache.
        .header("x-content-type-options", "nosniff")
        .header("cache-control", "private, no-store")
        .send(Buffer.from(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength));
      } catch (error) {
        readSettled = true;
        const cancellation = error === abort.signal.reason || (error instanceof Error && error.name === "AbortError");
        const timedOut = abort.signal.aborted && !responseSettled && cancellation;
        responseDone();
        if (timedOut) throw new HttpError(504, "ARTIFACT_DOWNLOAD_TIMEOUT", "File download timed out.");
        throw error;
      }
    });
  });
}
