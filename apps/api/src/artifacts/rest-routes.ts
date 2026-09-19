// SPDX-License-Identifier: BUSL-1.1
/** Core-owned HTTP adapter for provider-neutral artifact services. */
import type { RuntimeArtifactServices } from "@openshapeforge/plugin-runtime";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { resolveSessionContext } from "../auth/identity.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { headersFromFastify } from "../http/headers.js";
import { HttpError, toHttpError } from "../rest/http-error.js";

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
  if (!decoded || decoded.length > 255 || /[\r\n\0/\\]/.test(decoded)) {
    throw new HttpError(400, "BAD_USER_INPUT", "The file name is invalid.");
  }
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

export function registerArtifactRestRoutes(
  app: FastifyInstance,
  options: {
    artifacts: RuntimeArtifactServices<TrustedSessionContext>;
    db?: OpenShapeForgeDatabase | undefined;
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

    instance.post(ARTIFACT_STAGE_PATH, { bodyLimit: 64 * 1024 * 1024 }, async (request, reply) => {
      const verified = await session(request, options.db);
      const source = request.body as AsyncIterable<Uint8Array> | undefined;
      if (!source || typeof source[Symbol.asyncIterator] !== "function") {
        throw new HttpError(400, "BAD_USER_INPUT", "A file body is required.");
      }
      const descriptor = await options.artifacts.stage(verified, {
        purpose: "record-upload",
        fileName: fileName(request),
        source,
      });
      return reply.status(201).send({ data: descriptor, operations: [] });
    });

    instance.get(ARTIFACT_CONTENTS_PATH, async (request, reply) => {
      const verified = await session(request, options.db);
      const { artifactId } = request.params as { artifactId: string };
      const result = await options.artifacts.read(verified, {
        artifactId,
        owner: { entity: queryString(request, "ownerEntity"), id: queryString(request, "ownerId") },
      });
      return reply
        .header("content-type", result.descriptor.mediaType)
        .header("content-length", String(result.bytes.byteLength))
        .header("content-disposition", contentDisposition(result.descriptor.fileName))
        .send(Buffer.from(result.bytes));
    });
  });
}
