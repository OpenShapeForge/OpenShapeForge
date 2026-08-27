// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withDbSession, type DbSessionInput } from "../db/session.js";
import { HttpError } from "../rest/http-error.js";

const DOCUMENT_WRITE_ROLE = "CaseFile.All.ReadWrite";

export type DocumentInput = {
  code?: string;
  title: string;
  description?: string;
  documentType: string;
  status: string;
  confidentiality?: string;
  source?: string;
  author?: string;
  isExternal?: boolean;
  registeredAt?: string;
  receivedAt?: string;
  publishedAt?: string;
  caseFileId?: string;
  caseId?: string;
  relationId?: string;
};

export type DocumentVersionInput = {
  versionLabel: string;
  status: string;
  fileName?: string;
  mimeType?: string;
  storageLocation?: string;
  checksum?: string;
  isMajorVersion?: boolean;
  changeSummary?: string;
  accountId?: string;
};

export type DocumentCommandResult = {
  documentId: string;
  documentVersionId: string;
};

function requireDocumentWriteRole(session: DbSessionInput): void {
  if (!(session.roles ?? []).includes(DOCUMENT_WRITE_ROLE)) {
    throw new HttpError(403, "FORBIDDEN", "Not authorized to write Document.");
  }
}

export async function createDocumentWithFirstVersion(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  input: { document: DocumentInput; version: DocumentVersionInput },
): Promise<DocumentCommandResult> {
  requireDocumentWriteRole(session);
  return withDbSession(db, session, async (trx) => {
    const result = await sql<{ document_id: string; document_version_id: string }>`
      select document_id, document_version_id
      from app.create_document_with_first_version(
        ${JSON.stringify(input.document)}::text::jsonb,
        ${JSON.stringify(input.version)}::text::jsonb
      )
    `.execute(trx);
    const created = result.rows[0];
    if (!created) throw new Error("Document command returned no result.");
    return {
      documentId: created.document_id,
      documentVersionId: created.document_version_id,
    };
  });
}

export async function appendDocumentVersion(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  documentId: string,
  version: DocumentVersionInput,
): Promise<DocumentCommandResult> {
  requireDocumentWriteRole(session);
  return withDbSession(db, session, async (trx) => {
    const result = await sql<{ document_version_id: string }>`
      select app.append_document_version(
        ${documentId}::uuid,
        ${JSON.stringify(version)}::text::jsonb
      ) as document_version_id
    `.execute(trx);
    const created = result.rows[0];
    if (!created) throw new Error("Document version command returned no result.");
    return { documentId, documentVersionId: created.document_version_id };
  });
}
