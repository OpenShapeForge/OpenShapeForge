// SPDX-License-Identifier: BUSL-1.1
import { randomUUID } from "node:crypto";
import { operationErrorOf, operationFailure } from "@openshapeforge/operations";
import type {
  ModuleOperationContext,
  ModuleOperationHandler,
  PluginPlatformServices,
  PluginSessionContext,
  RuntimeArtifactDescriptor,
} from "@openshapeforge/plugin-runtime";

type JsonObject = Readonly<Record<string, unknown>>;
type QueryResult<Row> = Readonly<{ rows: readonly Row[] }>;
type RawQuery = Readonly<{
  sql: string;
  parameters: readonly unknown[];
  query: Readonly<{
    kind: "RawNode";
    sqlFragments: readonly string[];
    parameters: readonly unknown[];
  }>;
  queryId: Readonly<{ queryId: string }>;
}>;
type RawTransaction = {
  executeQuery<Row>(query: RawQuery): Promise<QueryResult<Row>>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ARTIFACT_DESCRIPTOR_FIELDS = [
  "fileName",
  "mimeType",
  "mediaType",
  "storageLocation",
  "checksum",
  "sha256",
  "byteSize",
] as const;

const CREATE_DOCUMENT_SQL = `
  select document_id as "documentId", document_version_id as "documentVersionId"
  from document_internal.create_with_first_version($1::jsonb, $2::jsonb)
`;

const APPEND_DOCUMENT_VERSION_SQL = `
  select document_internal.append_version($1::uuid, $2::jsonb) as "documentVersionId"
`;

const CREATE_DOCUMENT_WITH_ARTIFACT_SQL = `
  select document_id as "documentId", document_version_id as "documentVersionId"
  from document_internal.create_with_first_version_and_artifact(
    $1::jsonb, $2::jsonb, $3::uuid, $4::bigint
  )
`;

const APPEND_DOCUMENT_VERSION_WITH_ARTIFACT_SQL = `
  select document_internal.append_version_with_artifact(
    $1::uuid, $2::jsonb, $3::uuid, $4::bigint
  ) as "documentVersionId"
`;

const FINALIZE_ARTIFACT_BINDING_SQL = `
  select document_internal.finalize_artifact_binding(
    $1::uuid, $2::uuid, $3::bigint, $4::bigint,
    $5::text, $6::text, $7::text, $8::bigint
  )
`;

const READ_DOCUMENT_SQL = `
  select
    id, tenant_id as "tenantId", created_at as "createdAt", updated_at as "updatedAt",
    external_id as "externalId", source_authority as "sourceAuthority",
    source_organization as "sourceOrganization", source_administration as "sourceAdministration",
    code, title, description, document_type as "documentType", status, confidentiality,
    source, author, is_external as "isExternal", registered_at as "registeredAt",
    received_at as "receivedAt", published_at as "publishedAt",
    current_version_id as "currentVersionId", case_file_id as "caseFileId",
    case_id as "caseId", relation_id as "relationId"
  from erp.documents
  where tenant_id = app.current_tenant() and id = $1::uuid
`;

const READ_DOCUMENT_VERSION_SQL = `
  select
    id, tenant_id as "tenantId", created_at as "createdAt", updated_at as "updatedAt",
    external_id as "externalId", source_authority as "sourceAuthority",
    source_organization as "sourceOrganization", source_administration as "sourceAdministration",
    version_label as "versionLabel", status, created_by as "createdBy",
    file_name as "fileName", mime_type as "mimeType", storage_location as "storageLocation",
    checksum, artifact_id as "artifactId", artifact_version as "artifactVersion",
    byte_size as "byteSize", is_major_version as "isMajorVersion", change_summary as "changeSummary",
    document_id as "documentId", account_id as "accountId"
  from erp.document_versions
  where tenant_id = app.current_tenant() and id = $1::uuid
`;

function query(sql: string, parameters: readonly unknown[]): RawQuery {
  return {
    sql,
    parameters,
    query: { kind: "RawNode", sqlFragments: [sql], parameters },
    queryId: { queryId: randomUUID() },
  };
}

async function rows<Row>(
  transaction: unknown,
  sql: string,
  parameters: readonly unknown[],
): Promise<readonly Row[]> {
  return (await (transaction as RawTransaction).executeQuery<Row>(query(sql, parameters))).rows;
}

function inputObject(input: JsonObject, field: string): JsonObject {
  const value = input[field];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw operationFailure({
      code: "VALIDATION",
      message: `${field} must be an object.`,
      retryable: false,
    });
  }
  return value as JsonObject;
}

function inputUuid(input: JsonObject, field: string): string {
  const value = input[field];
  if (typeof value !== "string" || !UUID.test(value)) {
    throw operationFailure({
      code: "VALIDATION",
      message: `${field} must be a UUID.`,
      retryable: false,
    });
  }
  return value;
}

type ArtifactBinding = Readonly<{
  artifactId: string;
  expectedArtifactVersion: number;
}>;

function validation(message: string): never {
  throw operationFailure({ code: "VALIDATION", message, retryable: false });
}

function artifactInput(input: JsonObject, version: JsonObject): {
  logicalVersion: JsonObject;
  binding?: ArtifactBinding;
} {
  if (
    ARTIFACT_DESCRIPTOR_FIELDS.some(
      (field) => Object.hasOwn(input, field) || Object.hasOwn(version, field),
    ) ||
    Object.hasOwn(input, "artifactId") ||
    Object.hasOwn(input, "expectedArtifactVersion") ||
    Object.hasOwn(version, "artifactId") ||
    Object.hasOwn(version, "expectedArtifactVersion") ||
    Object.hasOwn(version, "artifact")
  ) {
    throw operationFailure({
      code: "VALIDATION",
      message: "Artifact descriptors are storage-managed and cannot be supplied by callers.",
      retryable: false,
    });
  }

  if (!Object.hasOwn(input, "artifact")) return { logicalVersion: version };
  const artifact = inputObject(input, "artifact");
  const invalidField = Object.keys(artifact).find(
    (field) => field !== "artifactId" && field !== "expectedArtifactVersion",
  );
  if (invalidField) validation(`artifact.${invalidField} is not accepted.`);
  if (!Object.hasOwn(artifact, "artifactId") || !Object.hasOwn(artifact, "expectedArtifactVersion")) {
    validation("artifactId and expectedArtifactVersion must be supplied together.");
  }

  const artifactId = artifact.artifactId;
  const expectedArtifactVersion = artifact.expectedArtifactVersion;
  if (typeof artifactId !== "string" || !UUID.test(artifactId)) {
    validation("artifact.artifactId must be a UUID.");
  }
  if (
    typeof expectedArtifactVersion !== "number" ||
    !Number.isSafeInteger(expectedArtifactVersion) ||
    expectedArtifactVersion < 1
  ) {
    validation("artifact.expectedArtifactVersion must be a positive safe integer.");
  }

  return {
    logicalVersion: version,
    binding: { artifactId, expectedArtifactVersion },
  };
}

async function finalizeArtifactBinding(
  transaction: unknown,
  platform: PluginPlatformServices,
  session: PluginSessionContext,
  documentVersionId: string,
  binding: ArtifactBinding,
): Promise<RuntimeArtifactDescriptor> {
  const descriptor = await platform.artifacts.bind(session, {
    artifactId: binding.artifactId,
    documentVersionId,
    expectedArtifactVersion: binding.expectedArtifactVersion,
  });
  await rows(transaction, FINALIZE_ARTIFACT_BINDING_SQL, [
    documentVersionId,
    binding.artifactId,
    binding.expectedArtifactVersion,
    descriptor.version,
    descriptor.fileName,
    descriptor.mediaType,
    descriptor.sha256,
    descriptor.byteSize,
  ]);
  return descriptor;
}

function contextServices(context: ModuleOperationContext): {
  platform: PluginPlatformServices;
  session: PluginSessionContext;
} {
  if (!context.session) {
    throw operationFailure({
      code: "UNAUTHENTICATED",
      message: "Document commands require a verified session.",
      retryable: false,
    });
  }
  if (!context.platform) {
    throw operationFailure({
      code: "OPERATION_UNAVAILABLE",
      message: "Document services are unavailable.",
      retryable: false,
    });
  }
  return { platform: context.platform, session: context.session };
}

function authoredRow(
  row: Readonly<Record<string, unknown>> | undefined,
  expected: {
    id: string;
    documentId?: string;
  },
): Record<string, unknown> {
  if (
    !row ||
    row.id !== expected.id ||
    (expected.documentId !== undefined && row.documentId !== expected.documentId)
  ) {
    throw operationFailure({
      code: "HANDLER_CONTRACT_VIOLATION",
      message: "The Document command did not return its created record.",
      retryable: false,
    });
  }
  const projected: Record<string, unknown> = { ...row };
  for (const field of ["createdAt", "updatedAt", "registeredAt", "receivedAt", "publishedAt"]) {
    const value = projected[field];
    if (value instanceof Date) projected[field] = value.toISOString();
  }
  for (const field of ["artifactVersion", "byteSize"]) {
    const value = projected[field];
    if (typeof value === "string") {
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number < 0) {
        throw operationFailure({
          code: "HANDLER_CONTRACT_VIOLATION",
          message: "The Document command returned invalid artifact facts.",
          retryable: false,
        });
      }
      projected[field] = number;
    }
  }
  return projected;
}

async function translateDatabaseError<T>(
  platform: PluginPlatformServices,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (operationErrorOf(error)) throw error;
    const classified = platform.errors.classifyDatabase(error);
    if (classified) throw operationFailure(classified);
    throw error;
  }
}

export const createDocument: ModuleOperationHandler = async (input, context) => {
  const { platform, session } = contextServices(context);
  const document = inputObject(input, "document");
  const version = inputObject(input, "version");
  const { logicalVersion, binding } = artifactInput(input, version);

  const value = await translateDatabaseError(platform, () =>
    platform.db.withSession(session, async (transaction) => {
      const created = (
        await rows<{ documentId: string; documentVersionId: string }>(
          transaction,
          binding ? CREATE_DOCUMENT_WITH_ARTIFACT_SQL : CREATE_DOCUMENT_SQL,
          binding
            ? [document, logicalVersion, binding.artifactId, binding.expectedArtifactVersion]
            : [document, logicalVersion],
        )
      )[0];
      if (!created || !UUID.test(created.documentId) || !UUID.test(created.documentVersionId)) {
        throw operationFailure({
          code: "HANDLER_CONTRACT_VIOLATION",
          message: "The Document create command returned invalid record identities.",
          retryable: false,
        });
      }
      if (binding) {
        await finalizeArtifactBinding(
          transaction,
          platform,
          session,
          created.documentVersionId,
          binding,
        );
      }
      const row = (
        await rows<Record<string, unknown>>(transaction, READ_DOCUMENT_SQL, [created.documentId])
      )[0];
      return authoredRow(row, { id: created.documentId });
    }),
  );
  return { value, status: 201 };
};

export const createDocumentVersion: ModuleOperationHandler = async (input, context) => {
  const { platform, session } = contextServices(context);
  const documentId = inputUuid(input, "documentId");
  const version = inputObject(input, "version");
  const { logicalVersion, binding } = artifactInput(input, version);

  const value = await translateDatabaseError(platform, () =>
    platform.db.withSession(session, async (transaction) => {
      await platform.records.assertAccess(session, {
        entityName: "Document",
        id: documentId,
        intent: "update",
      });
      const created = (
        await rows<{ documentVersionId: string }>(
          transaction,
          binding ? APPEND_DOCUMENT_VERSION_WITH_ARTIFACT_SQL : APPEND_DOCUMENT_VERSION_SQL,
          binding
            ? [
                documentId,
                logicalVersion,
                binding.artifactId,
                binding.expectedArtifactVersion,
              ]
            : [documentId, logicalVersion],
        )
      )[0];
      if (!created || !UUID.test(created.documentVersionId)) {
        throw operationFailure({
          code: "HANDLER_CONTRACT_VIOLATION",
          message: "The DocumentVersion create command returned an invalid record identity.",
          retryable: false,
        });
      }
      if (binding) {
        await finalizeArtifactBinding(
          transaction,
          platform,
          session,
          created.documentVersionId,
          binding,
        );
      }
      const row = (
        await rows<Record<string, unknown>>(transaction, READ_DOCUMENT_VERSION_SQL, [
          created.documentVersionId,
        ])
      )[0];
      return authoredRow(row, { id: created.documentVersionId, documentId });
    }),
  );
  return { value, status: 201 };
};
