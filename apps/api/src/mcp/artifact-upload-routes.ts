// SPDX-License-Identifier: BUSL-1.1
/**
 * The browser routes of the private document upload: the page a person opens
 * and the endpoint the bytes go to, never through the model.
 *
 * Split out of generated-mcp-server.ts.
 */
import { randomBytes } from "node:crypto";
import {
  ARTIFACT_UPLOAD_PATH,
  ARTIFACT_UPLOAD_PRIVACY_HEADERS,
  artifactUploadPagePolicy,
  artifactUploadSession,
  claimArtifactUpload,
  renderArtifactUploadPage,
} from "./artifact-upload.js";
import { HttpError } from "../rest/http-error.js";
import { ARTIFACT_UPLOAD_LIMIT_BYTES, assertUploadFileName, limitUploadBody } from "../artifacts/upload-input.js";
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
    const privateLink = async (_request: unknown, reply: { headers(values: Record<string, string>): unknown }) => {
      reply.headers(ARTIFACT_UPLOAD_PRIVACY_HEADERS);
    };
    instance.get(`${ARTIFACT_UPLOAD_PATH}/:token`, { onRequest: privateLink }, async (request, reply) => {
      const token = (request.params as { token?: string }).token;
      const origin = callbackOrigin();
      const uploadUrl = `${origin}${ARTIFACT_UPLOAD_PATH}/${encodeURIComponent(token ?? "")}`;
      const scriptNonce = randomBytes(16).toString("base64");
      return reply
        .header("content-security-policy", artifactUploadPagePolicy(origin, scriptNonce))
        .type("text/html")
        .send(renderArtifactUploadPage(uploadUrl, scriptNonce));
    });
    instance.post(
      `${ARTIFACT_UPLOAD_PATH}/:token`,
      { bodyLimit: ARTIFACT_UPLOAD_LIMIT_BYTES, onRequest: privateLink },
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
        assertUploadFileName(fileName);
        const body = request.body as AsyncIterable<Uint8Array> | undefined;
        if (!body || typeof body[Symbol.asyncIterator] !== "function") {
          throw new HttpError(400, "BAD_USER_INPUT", "A file body is required.");
        }
        const source = limitUploadBody(body, request.headers["content-length"]);
        const uploadSession = artifactUploadSession(pending);
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
