// SPDX-License-Identifier: BUSL-1.1
import { operationFailure } from "@openshapeforge/operations";
import type { ModuleOperationHandler } from "@openshapeforge/plugin-runtime";
import { contextServices, rows } from "./commands.js";
import { appendRecordEvent, blockColumns, deleteDocumentVariants, readTemplateVersion, templateParameterFields, withDocumentCommand } from "./document-blocks.js";
import { applyTemplateVersion, type ApplyContext } from "./document-follow.js";
import { object, refuse, uuid } from "./validation.js";

type DocumentRow = Readonly<{ id: string; template_version_id: string | null; updated_at: string; follow_error: string | null }>;

const DOCUMENT_COLUMNS: Readonly<Record<string, string>> = {
  id: "id", template_version_id: "templateVersionId", follow_error: "followError", parameters: "parameters",
  lifecycle_status: "lifecycleStatus", updated_at: "updatedAt",
};

/** The logical Document fields this command reports, from the physical row. */
export function projectDocument(row: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const [column, field] of Object.entries(DOCUMENT_COLUMNS)) {
    if (Object.hasOwn(row, column)) projected[field] = row[column] ?? null;
  }
  return projected;
}

/**
 * Document.linkTemplate: seed or re-seed the document's variants from a
 * published template version. The same template (any version) is followed
 * with the follow rule, so local edits survive; another template replaces
 * the content, and only when `replace` is set or nothing local exists.
 * Blocks are copied from the frozen snapshot, never from the live template.
 */
export const linkTemplate: ModuleOperationHandler = async (input, context) => {
  const { platform, session } = contextServices(context);
  if (!session.tenantId) refuse("UNAUTHENTICATED", "Linking a template requires a tenant session.");
  const allowed = new Set(["id", "templateVersionId", "parameters", "replace"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) refuse("VALIDATION", "Unknown link input.");
  const documentId = uuid(input.id, "id");
  const templateVersionId = uuid(input.templateVersionId, "templateVersionId");
  const parameters = input.parameters === undefined ? undefined : object(input.parameters, "parameters");
  if (input.replace !== undefined && typeof input.replace !== "boolean") refuse("VALIDATION", "replace must be a boolean.");
  const replace = input.replace === true;

  const value = await platform.db.withSession(session, async (trx) => {
    // A document editor picks a published template without holding a template
    // role: the Operation's own roles and the document's update access decide,
    // and the version is read here, server-side, from its frozen snapshot.
    await platform.records.assertAccess(session, { entityName: "Document", id: documentId, intent: "update" });
    const document = (await rows<DocumentRow>(trx,
      "select id, template_version_id, updated_at, follow_error from erp.documents where tenant_id = app.current_tenant() and id = $1::uuid for update", [documentId]))[0];
    if (!document) refuse("NOT_FOUND", "The document does not exist.");
    const next = await readTemplateVersion(trx, templateVersionId);
    if (!next) refuse("NOT_FOUND", "The template version does not exist.");
    if (next!.status !== "published") refuse("INVALID_STATE", "Only a published template version can be linked.");
    const fields = templateParameterFields(next!.snapshot);
    if (parameters && fields.length) {
      const valid = platform.schemas.fields.validateObject(fields, parameters);
      if (!valid.valid) throw operationFailure(valid.error);
    }
    const tracked = document!.template_version_id ? await readTemplateVersion(trx, document!.template_version_id) : undefined;
    const sameTemplate = !document!.template_version_id || tracked?.template_id === next!.template_id;
    const apply: ApplyContext = {
      trx, columns: await blockColumns(trx), tracked: new Map(tracked ? [[tracked.id, tracked]] : []),
      permitted: new Set(platform.schemas.entityValues?.collection("DocumentVariant", "blocks")?.allowedDefinitions ?? []),
    };
    await withDocumentCommand(trx, "link", async () => {
      if (!sameTemplate) {
        const local = await rows<{ count: number }>(trx, `select count(*)::int as count from erp.blocks b
          join erp.document_variants v on v.tenant_id = b.tenant_id and v.id = b.document_variant_id
          where b.tenant_id = app.current_tenant() and v.document_id = $1::uuid and (b.origin = 'local' or b.diverged)`, [documentId]);
        if ((local[0]?.count ?? 0) > 0 && !replace) refuse("INVALID_STATE", "Another template is linked and this document has local blocks; set replace to discard them.");
        await deleteDocumentVariants(trx, documentId);
      }
      // A tracked version that is no longer readable is followed as if nothing was tracked: template blocks it seeded then count as local edits.
      await applyTemplateVersion(apply, { id: documentId, template_version_id: sameTemplate && tracked ? document!.template_version_id : null }, next!);
      if (parameters) await rows(trx, "update erp.documents set parameters = $2::text::jsonb where tenant_id = app.current_tenant() and id = $1::uuid", [documentId, JSON.stringify(parameters)]);
    });
    await appendRecordEvent(platform, session, { aggregateType: "document", table: "documents", id: documentId, operation: "updated" });
    const stored = (await rows<{ row: Record<string, unknown> }>(trx, "select to_jsonb(d.*) as row from erp.documents d where tenant_id = app.current_tenant() and id = $1::uuid", [documentId]))[0]?.row;
    return projectDocument(stored ?? {});
  });
  return { value };
};
