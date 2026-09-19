// SPDX-License-Identifier: BUSL-1.1
import { randomUUID } from "node:crypto";
import type {
  PluginSessionContext,
  RuntimeRecordAccessServices,
} from "@openshapeforge/plugin-runtime";

type CompiledDocumentArtifactQuery = Readonly<{
  sql: string;
  parameters: readonly unknown[];
  query: Readonly<{
    kind: "RawNode";
    sqlFragments: readonly string[];
    parameters: readonly unknown[];
  }>;
  queryId: Readonly<{ queryId: string }>;
}>;

/** Minimal SQL surface structurally implemented by the storage transaction. */
export type DocumentArtifactSqlExecutor = Readonly<{
  executeQuery(
    query: CompiledDocumentArtifactQuery,
  ): Promise<{ rows: readonly Record<string, unknown>[] }>;
}>;

/**
 * A Document owns the files of its versions: the owner the artifact port
 * carries is the Document, and the version is the association row that names
 * the artifact. This is what lets a session — a capability grant included —
 * read a version created after it was issued: what it reaches is the
 * Document, and a version is the Document's content.
 */
export type DocumentArtifactOwner = Readonly<{
  entity: "Document";
  id: string;
}>;

export type DocumentArtifactAccessInput<ArtifactId extends string> = Readonly<{
  action: "bind" | "open";
  artifactId: ArtifactId;
  owner: DocumentArtifactOwner;
  /** Optional stronger association-version proof. The current storage contribution does not supply it. */
  expectedArtifactVersion?: number;
}>;

export type ResolvedDocumentArtifactAccess<ArtifactId extends string> = Readonly<{
  tenantId: string;
  artifactId: ArtifactId;
  owner: DocumentArtifactOwner;
  /** The version row that names the artifact — the association the access was proven against. */
  documentVersionId: string;
}>;

export type DocumentArtifactAuthorization = Readonly<{
  resolveDocumentArtifactAccess<ArtifactId extends string>(
    transaction: DocumentArtifactSqlExecutor,
    input: DocumentArtifactAccessInput<ArtifactId>,
  ): Promise<ResolvedDocumentArtifactAccess<ArtifactId> | undefined>;
  /** Physical deletion has no canonical Document policy yet and remains disabled. */
  resolvePhysicalDeleteDecision(
    transaction: DocumentArtifactSqlExecutor,
    workId: string,
  ): Promise<undefined>;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const BIND_ACCESS_SQL = `
  select document_version.id::text as "documentVersionId"
  from erp.document_versions document_version
  join erp.documents document
    on document.tenant_id = document_version.tenant_id
   and document.id = document_version.document_id
  where document_version.tenant_id = app.current_tenant()
    and app.current_tenant() = $1::uuid
    and app.current_user_id() = $2::uuid
    and document.id = $3::uuid
    and document_version.artifact_id = $4::uuid
    and document_version.created_by = $2::text
    and document_version.artifact_version between 1 and 9007199254740991
    and ($5::bigint is null or document_version.artifact_version = $5::bigint)
    and document_version.file_name is null
    and document_version.mime_type is null
    and document_version.checksum is null
    and document_version.byte_size is null
    and document_version.storage_location is null
    and document.current_version_id = document_version.id
`;

const OPEN_ACCESS_SQL = `
  select document_version.id::text as "documentVersionId"
  from erp.document_versions document_version
  join erp.documents document
    on document.tenant_id = document_version.tenant_id
   and document.id = document_version.document_id
  where document_version.tenant_id = app.current_tenant()
    and app.current_tenant() = $1::uuid
    and app.current_user_id() = $2::uuid
    and document.id = $3::uuid
    and document_version.artifact_id = $4::uuid
    and document_version.artifact_version between 1 and 9007199254740991
    and ($5::bigint is null or document_version.artifact_version = $5::bigint)
    and document_version.file_name is not null
    and document_version.mime_type is not null
    and document_version.checksum is not null
    and document_version.byte_size is not null
    and document_version.storage_location is null
`;

function query(
  sql: string,
  parameters: readonly unknown[],
): CompiledDocumentArtifactQuery {
  return {
    sql,
    parameters,
    query: { kind: "RawNode", sqlFragments: [sql], parameters },
    queryId: { queryId: randomUUID() },
  };
}

function exactSession(
  session: PluginSessionContext,
): { tenantId: string; userId: string } | undefined {
  if (
    typeof session.tenantId !== "string" ||
    !UUID.test(session.tenantId) ||
    typeof session.userId !== "string" ||
    !UUID.test(session.userId)
  ) {
    return undefined;
  }
  return { tenantId: session.tenantId, userId: session.userId };
}

function validInput<ArtifactId extends string>(
  input: DocumentArtifactAccessInput<ArtifactId>,
): boolean {
  return Boolean(
    input &&
      (input.action === "bind" || input.action === "open") &&
      typeof input.artifactId === "string" &&
      UUID.test(input.artifactId) &&
      input.owner?.entity === "Document" &&
      typeof input.owner.id === "string" &&
      UUID.test(input.owner.id) &&
      (input.expectedArtifactVersion === undefined ||
        (Number.isSafeInteger(input.expectedArtifactVersion) &&
          input.expectedArtifactVersion > 0)),
  );
}

/**
 * Canonical Document policy adapter for the provider-neutral artifact runtime.
 *
 * Bind proves only the provisional association authored by the active
 * Document create/append transaction. It deliberately does not require a
 * Document read or update permission: first-create authority may be narrower,
 * while append has already checked Document.update before creating the row.
 * Open proves the artifact is one of the Document's stored versions and
 * requires the Document's `get` — the same check core makes before the
 * provider is asked; storage repeats it so the port cannot be the only fence.
 */
export function createDocumentArtifactAuthorization(
  context: Readonly<{
    session: PluginSessionContext;
    records: RuntimeRecordAccessServices<PluginSessionContext>;
  }>,
): DocumentArtifactAuthorization {
  return Object.freeze({
    async resolveDocumentArtifactAccess<ArtifactId extends string>(
      transaction: DocumentArtifactSqlExecutor,
      input: DocumentArtifactAccessInput<ArtifactId>,
    ): Promise<ResolvedDocumentArtifactAccess<ArtifactId> | undefined> {
      const session = exactSession(context.session);
      if (!session || !validInput(input)) return undefined;

      const result = await transaction.executeQuery(
        query(input.action === "bind" ? BIND_ACCESS_SQL : OPEN_ACCESS_SQL, [
          session.tenantId,
          session.userId,
          input.owner.id,
          input.artifactId,
          input.expectedArtifactVersion ?? null,
        ]),
      );
      const documentVersionId = result.rows.length === 1
        ? result.rows[0]?.documentVersionId
        : undefined;
      if (typeof documentVersionId !== "string" || !UUID.test(documentVersionId)) {
        return undefined;
      }
      if (input.action === "open") {
        // A version's bytes are the Document's content: the Document's `get`
        // decides, for a bearer session and for a capability grant alike. A
        // grant names the records it reaches when it is issued; a version
        // created afterwards — a signed copy, a certificate — is on no such
        // list, and does not need to be, because the Document is.
        await context.records.assertAccess(context.session, {
          entityName: "Document",
          id: input.owner.id,
          intent: "get",
        });
      }

      return Object.freeze({
        tenantId: session.tenantId,
        artifactId: input.artifactId,
        owner: Object.freeze({ ...input.owner }),
        documentVersionId,
      });
    },
    async resolvePhysicalDeleteDecision(): Promise<undefined> {
      return undefined;
    },
  });
}
