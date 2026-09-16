// SPDX-License-Identifier: BUSL-1.1
import type { FastifyInstance, FastifyRequest } from "fastify";
import { resolveSessionContext } from "../auth/identity.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { DbSessionInput } from "../db/session.js";
import { headersFromFastify } from "../http/headers.js";
import { HttpError, toHttpError } from "../rest/http-error.js";
import {
  appendDocumentVersion,
  createDocumentWithFirstVersion,
  type DocumentInput,
  type DocumentVersionInput,
} from "./service.js";

export const DOCUMENT_COMMAND_PATH = "/api/documents";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DOCUMENT_KEYS = new Set([
  "code", "title", "description", "documentType", "status", "confidentiality",
  "source", "author", "isExternal", "registeredAt", "receivedAt", "publishedAt",
  "caseFileId", "caseId", "relationId",
]);
const VERSION_KEYS = new Set([
  "versionLabel", "status", "fileName", "mimeType", "storageLocation", "checksum",
  "isMajorVersion", "changeSummary", "accountId",
]);
const DOCUMENT_STRING_KEYS = [...DOCUMENT_KEYS].filter((key) => key !== "isExternal");
const VERSION_STRING_KEYS = [...VERSION_KEYS].filter((key) => key !== "isMajorVersion");
const DOCUMENT_UUID_KEYS = ["caseFileId", "caseId", "relationId"];
const VERSION_UUID_KEYS = ["accountId"];
const DOCUMENT_DATETIME_KEYS = ["registeredAt", "receivedAt", "publishedAt"];
const DOCUMENT_STRING_LIMITS: Readonly<Record<string, number>> = {
  code: 100,
  title: 300,
  description: 8000,
  source: 200,
  author: 200,
};
const VERSION_STRING_LIMITS: Readonly<Record<string, number>> = {
  versionLabel: 50,
  fileName: 255,
  mimeType: 150,
  storageLocation: 1000,
  checksum: 128,
  changeSummary: 4000,
};

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

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) {
    throw new HttpError(400, "BAD_USER_INPUT", `Unknown ${label} field "${unknown}".`);
  }
}

function assertNonEmptyString(value: Record<string, unknown>, key: string, label: string): void {
  if (typeof value[key] !== "string" || value[key].trim() === "") {
    throw new HttpError(400, "BAD_USER_INPUT", `${label}.${key} must be a non-empty string.`);
  }
}

function assertOptionalStrings(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  for (const key of keys) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      throw new HttpError(400, "BAD_USER_INPUT", `${label}.${key} must be a string.`);
    }
  }
}

function assertStringLimits(
  value: Record<string, unknown>,
  limits: Readonly<Record<string, number>>,
  label: string,
): void {
  for (const [key, maxLength] of Object.entries(limits)) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.length > maxLength) {
      throw new HttpError(
        400,
        "BAD_USER_INPUT",
        `${label}.${key} must be at most ${maxLength} characters.`,
      );
    }
  }
}

function assertOptionalUuids(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  for (const key of keys) {
    const candidate = value[key];
    if (candidate !== undefined && (typeof candidate !== "string" || !UUID_PATTERN.test(candidate))) {
      throw new HttpError(400, "BAD_USER_INPUT", `${label}.${key} must be a UUID.`);
    }
  }
}

function assertOptionalDateTimes(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  for (const key of keys) {
    const candidate = value[key];
    if (candidate !== undefined && (typeof candidate !== "string" || !Number.isFinite(Date.parse(candidate)))) {
      throw new HttpError(400, "BAD_USER_INPUT", `${label}.${key} must be a date-time.`);
    }
  }
}

export function parseDocumentCommandBody(body: unknown): {
  document: DocumentInput;
  version: DocumentVersionInput;
} {
  const parsed = parseBody(body);
  assertExactKeys(parsed, new Set(["document", "version"]), "request");
  const document = parseObject(parsed.document, "document");
  const version = parseObject(parsed.version, "version");
  assertExactKeys(document, DOCUMENT_KEYS, "document");
  assertExactKeys(version, VERSION_KEYS, "version");
  for (const key of ["title", "documentType", "status"]) {
    assertNonEmptyString(document, key, "document");
  }
  for (const key of ["versionLabel", "status"]) {
    assertNonEmptyString(version, key, "version");
  }
  assertOptionalStrings(document, DOCUMENT_STRING_KEYS, "document");
  assertOptionalStrings(version, VERSION_STRING_KEYS, "version");
  assertStringLimits(document, DOCUMENT_STRING_LIMITS, "document");
  assertStringLimits(version, VERSION_STRING_LIMITS, "version");
  assertOptionalUuids(document, DOCUMENT_UUID_KEYS, "document");
  assertOptionalUuids(version, VERSION_UUID_KEYS, "version");
  assertOptionalDateTimes(document, DOCUMENT_DATETIME_KEYS, "document");
  if (document.isExternal !== undefined && typeof document.isExternal !== "boolean") {
    throw new HttpError(400, "BAD_USER_INPUT", "document.isExternal must be a boolean.");
  }
  if (version.isMajorVersion !== undefined && typeof version.isMajorVersion !== "boolean") {
    throw new HttpError(400, "BAD_USER_INPUT", "version.isMajorVersion must be a boolean.");
  }
  return { document: document as DocumentInput, version: version as DocumentVersionInput };
}

export function parseVersionCommandBody(body: unknown): DocumentVersionInput {
  const parsed = parseBody(body);
  assertExactKeys(parsed, new Set(["version"]), "request");
  const version = parseObject(parsed.version, "version");
  assertExactKeys(version, VERSION_KEYS, "version");
  for (const key of ["versionLabel", "status"]) {
    assertNonEmptyString(version, key, "version");
  }
  assertOptionalStrings(version, VERSION_STRING_KEYS, "version");
  assertStringLimits(version, VERSION_STRING_LIMITS, "version");
  assertOptionalUuids(version, VERSION_UUID_KEYS, "version");
  if (version.isMajorVersion !== undefined && typeof version.isMajorVersion !== "boolean") {
    throw new HttpError(400, "BAD_USER_INPUT", "version.isMajorVersion must be a boolean.");
  }
  return version as DocumentVersionInput;
}

async function requireContext(
  request: FastifyRequest,
  db: OpenShapeForgeDatabase | undefined,
): Promise<{ db: OpenShapeForgeDatabase; session: DbSessionInput }> {
  const resolved = await resolveSessionContext(headersFromFastify(request.headers), { db });
  if (!resolved.tenantId || !resolved.userId) {
    throw new HttpError(401, "UNAUTHENTICATED", "Document commands require an authenticated session.");
  }
  if (!db) {
    throw new HttpError(503, "DATABASE_NOT_CONFIGURED", "Database is not configured for document commands.");
  }
  return {
    db,
    session: {
      tenantId: resolved.tenantId,
      userId: resolved.userId,
      roles: [...resolved.roles],
      groups: [...resolved.groups],
      scope: resolved.scope,
    },
  };
}

function documentError(error: unknown): HttpError | undefined {
  const postgres = error as { errno?: unknown; code?: unknown } | null;
  const sqlState = postgres?.errno ?? postgres?.code;
  if (sqlState === "23505") {
    return new HttpError(409, "DOCUMENT_VERSION_CONFLICT", "That version label already exists for this document.");
  }
  if (sqlState === "23503" || sqlState === "22P02" || sqlState === "22007") {
    return new HttpError(400, "BAD_USER_INPUT", "A document reference or value is invalid.");
  }
  if (sqlState === "P0001" && (error as Error).message.includes("Document not found")) {
    return new HttpError(404, "NOT_FOUND", "Document not found.");
  }
  return undefined;
}

export function registerDocumentRestRoutes(
  app: FastifyInstance,
  options: { db?: OpenShapeForgeDatabase | undefined } = {},
): void {
  void app.register(async (instance) => {
    instance.setErrorHandler((error, _request, reply) => {
      const mapped = documentError(error) ?? error;
      const { status, body } = toHttpError(mapped);
      if (status >= 500) instance.log.error({ err: error }, "Document command failed.");
      void reply.status(status).send(body);
    });

    instance.post(DOCUMENT_COMMAND_PATH, async (request, reply) => {
      const context = await requireContext(request, options.db);
      const input = parseDocumentCommandBody(request.body);
      const created = await createDocumentWithFirstVersion(context.db, context.session, input);
      return reply.status(201).send(created);
    });

    instance.post(`${DOCUMENT_COMMAND_PATH}/:documentId/versions`, async (request, reply) => {
      const context = await requireContext(request, options.db);
      const { documentId } = request.params as { documentId: string };
      if (!UUID_PATTERN.test(documentId)) {
        throw new HttpError(400, "BAD_USER_INPUT", "documentId must be a UUID.");
      }
      const version = parseVersionCommandBody(request.body);
      const created = await appendDocumentVersion(context.db, context.session, documentId, version);
      return reply.status(201).send(created);
    });
  });
}
