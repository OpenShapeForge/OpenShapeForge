// SPDX-License-Identifier: BUSL-1.1
import { OperationFailure, operationFailure } from "@openshapeforge/operations";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { resolveSessionContext } from "../auth/identity.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { headersFromFastify } from "../http/headers.js";
import {
  type EntityOperationRef,
  type EntityOperationResult,
  entityOperationContract,
  executeEntityOperation,
  tableForEntityOperation,
} from "../operations/entity/index.js";
import { pluginEntityTransportInput } from "../operations/entity/transport-input.js";
import { HttpError, toHttpError } from "../rest/http-error.js";
import { serializeGeneratedRestRow } from "../rest/serialize-generated-row.js";

export const DOCUMENT_COMMAND_PATH = "/api/documents";

const DOCUMENT_CREATE_OPERATION = {
  id: "Document.create",
  intent: "create",
} as const satisfies EntityOperationRef;
const DOCUMENT_VERSION_CREATE_OPERATION = {
  id: "DocumentVersion.create",
  intent: "create",
} as const satisfies EntityOperationRef;

function parseObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "BAD_USER_INPUT", `${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function parseBody(body: unknown): Record<string, unknown> {
  let value = body;
  try {
    if (typeof body === "string") value = JSON.parse(body);
    if (body instanceof Uint8Array) value = JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    throw new HttpError(400, "BAD_USER_INPUT", "Request body is not valid JSON.");
  }
  return parseObject(value, "Request body");
}

function legacyEnvelope(body: unknown, required: readonly string[]): Record<string, unknown> {
  const parsed = parseBody(body);
  const allowed = new Set(required);
  const unknown = Object.keys(parsed).find((key) => !allowed.has(key));
  if (unknown) {
    throw new HttpError(400, "BAD_USER_INPUT", `Unknown request field "${unknown}".`);
  }
  for (const field of required) {
    if (!Object.hasOwn(parsed, field)) {
      throw new HttpError(400, "BAD_USER_INPUT", `Request field "${field}" is required.`);
    }
  }
  return parsed;
}

/**
 * Parse only the historical transport envelope. The canonical Document
 * Operation owns every nested field, type, enum, reference and binary-field
 * decision.
 */
export function parseDocumentCommandBody(body: unknown): {
  document: unknown;
  version: unknown;
} {
  const parsed = legacyEnvelope(body, ["document", "version"]);
  return { document: parsed.document, version: parsed.version };
}

/** Parse only the historical `{ version }` transport envelope. */
export function parseVersionCommandBody(body: unknown): unknown {
  return legacyEnvelope(body, ["version"]).version;
}

async function requireContext(
  request: FastifyRequest,
  db: OpenShapeForgeDatabase | undefined,
): Promise<{ db: OpenShapeForgeDatabase; session: TrustedSessionContext }> {
  const resolved = await resolveSessionContext(headersFromFastify(request.headers), { db });
  if (!resolved.tenantId || !resolved.userId) {
    throw new HttpError(
      401,
      "UNAUTHENTICATED",
      "Document commands require an authenticated session.",
    );
  }
  if (!db) {
    throw new HttpError(
      503,
      "DATABASE_NOT_CONFIGURED",
      "Database is not configured for document commands.",
    );
  }
  return { db, session: resolved };
}

function requiredIdempotencyKey(request: FastifyRequest): string {
  const value = request.headers["idempotency-key"];
  if (value !== undefined && typeof value !== "string") {
    throw new HttpError(400, "BAD_USER_INPUT", "Idempotency-Key must have exactly one value.");
  }
  if (value === undefined || value.trim() === "") {
    throw operationFailure({
      code: "IDEMPOTENCY_KEY_REQUIRED",
      message: "This Operation requires a non-empty idempotency key.",
      retryable: false,
    });
  }
  return value;
}

function createdRecord(
  result: EntityOperationResult,
  operationId: string,
): Readonly<Record<string, unknown>> {
  if (result.intent !== "create") {
    throw new Error(`${operationId} returned an unexpected Operation intent.`);
  }
  if ("error" in result) throw new OperationFailure(result.error);
  if (!result.data) throw new Error(`${operationId} returned no created record.`);
  return result.data;
}

function requiredResultId(
  row: Readonly<Record<string, unknown>>,
  field: string,
  operationId: string,
): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${operationId} returned no ${field}.`);
  }
  return value;
}

export function registerDocumentRestRoutes(
  app: FastifyInstance,
  options: { db?: OpenShapeForgeDatabase | undefined } = {},
): void {
  void app.register(async (instance) => {
    instance.setErrorHandler((error, _request, reply) => {
      const { status, body } = toHttpError(error);
      if (status >= 500) instance.log.error({ err: error }, "Document command failed.");
      void reply.status(status).send(body);
    });

    instance.post(DOCUMENT_COMMAND_PATH, async (request, reply) => {
      const context = await requireContext(request, options.db);
      const legacyInput = parseDocumentCommandBody(request.body);
      const operation = entityOperationContract(DOCUMENT_CREATE_OPERATION.id);
      const input = pluginEntityTransportInput(
        operation,
        legacyInput,
        undefined,
        requiredIdempotencyKey(request),
      );
      const result = await executeEntityOperation(context.db, context.session, {
        operation: DOCUMENT_CREATE_OPERATION,
        input,
      });
      const row = serializeGeneratedRestRow(
        tableForEntityOperation(DOCUMENT_CREATE_OPERATION),
        createdRecord(result, operation.id),
      );
      return reply.status(201).send({
        documentId: requiredResultId(row, "id", operation.id),
        documentVersionId: requiredResultId(row, "currentVersionId", operation.id),
      });
    });

    instance.post(`${DOCUMENT_COMMAND_PATH}/:documentId/versions`, async (request, reply) => {
      const context = await requireContext(request, options.db);
      const { documentId } = request.params as { documentId: string };
      const operation = entityOperationContract(DOCUMENT_VERSION_CREATE_OPERATION.id);
      const input = pluginEntityTransportInput(
        operation,
        { documentId, version: parseVersionCommandBody(request.body) },
        undefined,
        requiredIdempotencyKey(request),
      );
      const result = await executeEntityOperation(context.db, context.session, {
        operation: DOCUMENT_VERSION_CREATE_OPERATION,
        input,
      });
      const row = serializeGeneratedRestRow(
        tableForEntityOperation(DOCUMENT_VERSION_CREATE_OPERATION),
        createdRecord(result, operation.id),
      );
      return reply.status(201).send({
        documentId: requiredResultId(row, "documentId", operation.id),
        documentVersionId: requiredResultId(row, "id", operation.id),
      });
    });
  });
}
