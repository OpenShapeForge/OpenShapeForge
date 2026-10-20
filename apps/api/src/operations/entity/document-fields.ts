// SPDX-License-Identifier: BUSL-1.1
import { operationFailure } from "@openshapeforge/operations";
import { sql, type Transaction } from "kysely";
import type { DB } from "../../generated/db/types.js";
import type { DbSessionInput } from "../../db/session.js";
import type { GeneratedCrudColumn, GeneratedCrudTable } from "./types.js";

export function documentPolicyViolation(policy: NonNullable<GeneratedCrudColumn["document"]>, document: {
  documentType: string; artifactId: string | null; mimeType: string | null; byteSize: number | null; hasBlocks: boolean;
}): string | undefined {
  if (policy.documentType && policy.documentType !== document.documentType) return "Select the required document type.";
  if (policy.content === "blocks") return document.artifactId ? "This field requires a blocks document." : undefined;
  if (!document.artifactId || document.hasBlocks) return "This field requires a file document.";
  if (policy.mimeTypes && !policy.mimeTypes.includes(document.mimeType ?? "")) return "This file type is not allowed.";
  if (policy.maxBytes && (document.byteSize == null || document.byteSize > policy.maxBytes)) return "This file is too large.";
}

/** Read under the same tenant/session RLS and transaction as the property write. */
export async function assertDocumentFieldsInTransaction(trx: Transaction<DB>, session: DbSessionInput, table: GeneratedCrudTable, values: ReadonlyMap<GeneratedCrudColumn, unknown>) {
  for (const [column, value] of values) {
    if (!column.document || value == null) continue;
    const result = await sql<{ documentType: string; artifactId: string | null; mimeType: string | null; byteSize: number | null; hasBlocks: boolean }>`
      select d.document_type as "documentType", v.artifact_id as "artifactId", v.mime_type as "mimeType", v.byte_size::float8 as "byteSize",
        exists(select 1 from erp.document_variants dv where dv.document_id=d.id and dv.tenant_id=d.tenant_id) as "hasBlocks"
      from erp.documents d left join erp.document_versions v on v.id=d.current_version_id and v.tenant_id=d.tenant_id
      where d.id::text=${String(value)} and d.tenant_id=${session.tenantId}::uuid
      for share of d
    `.execute(trx);
    const document = result.rows[0];
    const reason = document ? documentPolicyViolation(column.document, document) : "The document is unavailable.";
    if (reason) throw operationFailure({ code: "VALIDATION", message: reason, retryable: false,
      violations: [{ field: column.sourceField ?? column.name, code: "DOCUMENT_POLICY", message: reason }] });
  }
}
