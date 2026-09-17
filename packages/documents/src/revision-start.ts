// SPDX-License-Identifier: BUSL-1.1
import { operationFailure } from "@openshapeforge/operations";
import type { ModuleOperationHandler } from "@openshapeforge/plugin-runtime";
import { rowId } from "@openshapeforge/versioning/snapshot";
import { contextServices, rows } from "./commands.js";
import { blockColumns, blockContent, insertRevisionBlock, readTemplateVersion, templateParameterFields, templateVariantBlocks } from "./revision-blocks.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const REVISION_CHANNELS = ["document", "email", "whatsapp"] as const;
export const LOCALE = /^[a-z]{2}(-[A-Z]{2})?$/;

export function fail(code: string, message: string): never {
  throw operationFailure({ code, message, retryable: false });
}
export function uuid(value: unknown, name: string): string {
  if (typeof value !== "string" || !UUID.test(value)) fail("VALIDATION", `${name} must be a UUID.`);
  return value as string;
}
export function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("VALIDATION", `${name} must be an object.`);
  return value as Record<string, unknown>;
}

const REVISION_COLUMNS: Readonly<Record<string, string>> = {
  id: "id", tenant_id: "tenantId", created_at: "createdAt", updated_at: "updatedAt", document_id: "document",
  template_version_id: "templateVersion", channel: "channel", locale: "locale", status: "status", parameters: "parameters",
  published_version_id: "publishedVersionId",
};

/** The logical DocumentRevision record from its physical row. */
export function projectRevision(row: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const [column, field] of Object.entries(REVISION_COLUMNS)) {
    if (Object.hasOwn(row, column)) projected[field] = row[column] ?? null;
  }
  return projected;
}

export type RevisionRow = Readonly<Record<string, unknown>> & {
  readonly id: string; readonly document_id: string; readonly template_version_id: string | null;
  readonly channel: string; readonly locale: string; readonly status: string; readonly parameters: Record<string, unknown> | null;
};

export async function readRevision(trx: unknown, id: string, lock: "update" | "share" = "share"): Promise<RevisionRow | undefined> {
  return (await rows<{ row: RevisionRow }>(trx,
    `select to_jsonb(r.*) as row from erp.document_revisions r where tenant_id = app.current_tenant() and id = $1::uuid for ${lock}`, [id]))[0]?.row;
}

/**
 * Document.startRevision: a draft revision seeded from the selected template
 * version's variant for this channel and locale. Blocks are copied from the
 * frozen snapshot, never from the live template.
 */
export const startRevision: ModuleOperationHandler = async (input, context) => {
  const { platform, session } = contextServices(context);
  if (!session.tenantId) fail("UNAUTHENTICATED", "Starting a revision requires a tenant session.");
  const allowed = new Set(["documentId", "templateVersionId", "channel", "locale", "parameters"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) fail("VALIDATION", "Unknown revision input.");
  const documentId = uuid(input.documentId, "documentId");
  const templateVersionId = input.templateVersionId === undefined || input.templateVersionId === null ? null : uuid(input.templateVersionId, "templateVersionId");
  const channel = input.channel;
  if (typeof channel !== "string" || !(REVISION_CHANNELS as readonly string[]).includes(channel)) fail("VALIDATION", "Unsupported revision channel.");
  const locale = input.locale;
  if (typeof locale !== "string" || !LOCALE.test(locale)) fail("VALIDATION", "Invalid revision locale.");
  const parameters = input.parameters === undefined ? {} : object(input.parameters, "parameters");

  const value = await platform.db.withSession(session, async (trx) => {
    await platform.records.assertAccess(session, { entityName: "Document", id: documentId, intent: "update" });
    let seed: readonly { templateBlockId: string; row: Readonly<Record<string, unknown>> }[] = [];
    if (templateVersionId) {
      await platform.records.assertAccess(session, { entityName: "TemplateVersion", id: templateVersionId, intent: "get" });
      const version = await readTemplateVersion(trx, templateVersionId);
      if (!version) fail("NOT_FOUND", "The template version does not exist.");
      const blocks = templateVariantBlocks(version!.snapshot, channel as string, locale as string);
      if (!blocks) fail("DEPENDENCY_UNRESOLVED", "The template version has no variant for this channel and locale.");
      const fields = templateParameterFields(version!.snapshot);
      if (fields.length) {
        const valid = platform.schemas.fields.validateObject(fields, parameters);
        if (!valid.valid) throw operationFailure(valid.error);
      }
      seed = blocks!.map((node) => ({ templateBlockId: rowId(node), row: node.row }));
    }
    const revision = (await rows<{ row: RevisionRow }>(trx, `insert into erp.document_revisions
        (id, tenant_id, document_id, template_version_id, channel, locale, status, parameters)
      values (gen_random_uuid(), app.current_tenant(), $1::uuid, $2::uuid, $3::text, $4::text, 'draft', $5::text::jsonb)
      returning to_jsonb(document_revisions.*) as row`, [documentId, templateVersionId, channel, locale, JSON.stringify(parameters)]))[0]?.row;
    if (!revision) fail("OPERATION_UNAVAILABLE", "The revision could not be stored.");
    const columns = await blockColumns(trx);
    for (const [index, block] of seed.entries()) {
      await insertRevisionBlock(trx, { revisionId: revision!.id, position: index, origin: "template", templateBlockId: block.templateBlockId, content: blockContent(block.row, columns), columns });
    }
    await platform.events.append(session, {
      aggregateType: "DocumentRevision", aggregateId: revision!.id, eventType: "created",
      payload: { documentId, templateVersionId, channel, locale, blockCount: seed.length },
    });
    return projectRevision(revision!);
  });
  return { value, status: 201 };
};
