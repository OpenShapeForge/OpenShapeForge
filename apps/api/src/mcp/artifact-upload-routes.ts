// SPDX-License-Identifier: BUSL-1.1
/**
 * The browser routes of the private document upload: the page a person opens
 * and the endpoint the bytes go to, never through the model.
 *
 * Split out of generated-mcp-server.ts.
 */
import {
  ARTIFACT_UPLOAD_PATH,
  claimArtifactUpload,
  renderArtifactUploadPage,
} from "./artifact-upload.js";
import { HttpError } from "../rest/http-error.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import { callbackOrigin, elicitedKeyring } from "./handoff-config.js";
import { type McpRouteContext } from "./route-context.js";

/**
 * The private upload page and its POST target, present only when a module
 * provides artifact storage.
 */
export async function registerArtifactUploadRoutes(
  ctx: McpRouteContext,
): Promise<void> {
  const {
    instance,
    options,
  } = ctx;
  if (options.modulePlatform && options.modules?.some((module) => module.artifactStorage !== undefined)) {
    instance.addContentTypeParser(
      "application/octet-stream",
      (_request, payload, done) => done(null, payload),
    );
    instance.get(`${ARTIFACT_UPLOAD_PATH}/:token`, async (request, reply) => {
      const token = (request.params as { token?: string }).token;
      const uploadUrl = `${callbackOrigin()}${ARTIFACT_UPLOAD_PATH}/${encodeURIComponent(token ?? "")}`;
      return reply.type("text/html").send(renderArtifactUploadPage(uploadUrl));
    });
    instance.post(
      `${ARTIFACT_UPLOAD_PATH}/:token`,
      { bodyLimit: 64 * 1024 * 1024 },
      async (request, reply) => {
        const keyring = elicitedKeyring();
        if (!keyring) {
          throw new HttpError(
            503,
            "SECRET_STORAGE_NOT_CONFIGURED",
            "Secure upload handoffs are not configured.",
          );
        }
        const pending = await claimArtifactUpload({
          db: options.db!,
          keyring,
          token: (request.params as { token?: string }).token,
        });
        if (!pending) {
          throw new HttpError(404, "NOT_FOUND", "This upload is unavailable, expired, or already used.");
        }
        const rawName = request.headers["x-file-name"];
        if (typeof rawName !== "string") {
          throw new HttpError(400, "BAD_USER_INPUT", "Header x-file-name is required.");
        }
        let fileName: string;
        try {
          fileName = decodeURIComponent(rawName);
        } catch {
          throw new HttpError(400, "BAD_USER_INPUT", "The file name is not valid UTF-8.");
        }
        if (!fileName || fileName.length > 255 || /[\r\n\0/\\]/.test(fileName)) {
          throw new HttpError(400, "BAD_USER_INPUT", "The file name is invalid.");
        }
        const source = request.body as AsyncIterable<Uint8Array> | undefined;
        if (!source || typeof source[Symbol.asyncIterator] !== "function") {
          throw new HttpError(400, "BAD_USER_INPUT", "A file body is required.");
        }
        const uploadSession: TrustedSessionContext = {
          tenantId: pending.tenantId,
          userId: pending.userId,
          roles: pending.roles,
          groups: pending.groups,
          scope: pending.scope,
          credential: pending.credential,
        };
        const descriptor = await options.modulePlatform!.withActiveOperationSession(
          uploadSession,
          (activeSession) => options.modulePlatform!.services.artifacts.stage(
            activeSession,
            { purpose: "record-upload", fileName, source },
          ),
        );
        return reply.status(201).send({ data: descriptor, operations: [] });
      },
    );
  }
}
