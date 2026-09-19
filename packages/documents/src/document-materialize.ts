// SPDX-License-Identifier: BUSL-1.1
import type { ModuleOperationHandler } from "@openshapeforge/plugin-runtime";
import { contextServices, rows } from "./commands.js";
import { blockCollection, canonicalReader, compiledContentRegistry, contentCarrier, contentFailure, contentResolvers, DEFINITION_VERSION_COLUMN } from "./content-runtime.js";
import { contentBlockFromRow, type BlockRowSelection } from "./content-snapshot.js";
import { immutableContent, type JsonObject } from "./content/json.js";
import { materializeTemplateContent } from "./content/materialize.js";
import type { ContentResolvers, ContentTemplateVariant } from "./content/types.js";
import { object, refuse, text, uuid } from "./validation.js";

type DocumentRow = Readonly<{ id: string; template_version_id: string | null; parameters: unknown }>;
/** Owning foreign key of a document block (entities/core/block.yaml, `documentVariant`). */
const BLOCK_OWNER_COLUMN = "document_variant_id";

/**
 * The document head's variants for one channel and locale, with their live
 * blocks in collection order (owning position, then id). Rows are shared for
 * the transaction so an edit cannot slip in between reading the variants and
 * hashing their content.
 */
export async function documentContentVariants(trx: unknown, document: { readonly id: string; readonly channel: string; readonly locale: string },
  selection: BlockRowSelection, allowedDefinitions: readonly string[]): Promise<readonly ContentTemplateVariant[]> {
  const variants = await rows<{ id: string; channel: string; locale: string }>(trx,
    "select id, channel, locale from erp.document_variants where tenant_id = $1 and document_id = $2 and channel = $3 and locale = $4 order by id for share",
    [selection.tenantId, document.id, document.channel, document.locale]);
  const result: ContentTemplateVariant[] = [];
  for (const variant of variants) {
    const variantId = uuid(variant.id, "document variant");
    const found = await rows<{ row: Record<string, unknown> }>(trx,
      "select to_jsonb(b.*) as row from erp.blocks b where tenant_id = $1 and document_variant_id = $2 order by document_variant_id_position, id for share",
      [selection.tenantId, variantId]);
    const blocks = found.map((entry) => contentBlockFromRow(object(entry.row, "document block"), { column: BLOCK_OWNER_COLUMN, id: variantId }, selection, "stored"));
    result.push({ id: variantId, channel: document.channel, locale: document.locale, blocks, allowedDefinitions: [...allowedDefinitions] });
  }
  return result;
}

/**
 * Document.materialize: resolve the editable head of a document. The pinned
 * template version supplies its identity and parameter definitions; the
 * variants and blocks are the document's own live rows, so the composition
 * hash follows every edit. Any template version an inclusion names resolves
 * from its frozen snapshot exactly as for TemplateVersion.materialize.
 */
export const materializeDocument: ModuleOperationHandler = async (input, context) => {
  const { platform, session } = contextServices(context);
  if (!session.tenantId) refuse("UNAUTHENTICATED", "Document materialization requires a tenant session.");
  const tenantId = session.tenantId!;
  const documentId = uuid(input.id, "id");
  const channel = text(input.channel, "channel");
  const locale = text(input.locale, "locale");
  const carrier = contentCarrier(context);
  const templateCollection = blockCollection(context, carrier, "TemplateVariant");
  const documentCollection = blockCollection(context, carrier, "DocumentVariant");
  const registry = await compiledContentRegistry(context, carrier);
  const read = canonicalReader(context, await platform.operations.list(session));
  await platform.records.assertAccess(session, { entityName: "Document", id: documentId, intent: "get" });
  try {
    const snapshot = await platform.db.withSession(session, async (trx) => {
      const document = (await rows<DocumentRow>(trx,
        "select id, template_version_id, parameters from erp.documents where tenant_id = $1 and id = $2 for share", [tenantId, documentId]))[0];
      if (!document) refuse("NOT_FOUND", "The document does not exist.");
      if (!document!.template_version_id) refuse("INVALID_STATE", "The document has no linked template version.");
      const templateVersionId = uuid(document!.template_version_id, "template version");
      const parameters = immutableContent(document!.parameters == null ? {} : object(document!.parameters, "parameters")) as JsonObject;
      const frozen = contentResolvers(context, trx, { tenantId, channel, locale, carrier, allowedDefinitions: templateCollection.allowedDefinitions, read });
      const resolvers: ContentResolvers = {
        ...frozen,
        async resolveTemplateVersion(id, scope) {
          const version = await frozen.resolveTemplateVersion(id, scope);
          if (!version || id !== templateVersionId) return version;
          const selection: BlockRowSelection = { tenantId, carrier, definitionVersionColumn: DEFINITION_VERSION_COLUMN };
          return { ...version, variants: await documentContentVariants(trx, { id: documentId, channel, locale }, selection, documentCollection.allowedDefinitions) };
        },
      };
      return materializeTemplateContent({ tenantId, templateVersionId, channel, locale, parameters }, registry, resolvers);
    });
    return { value: snapshot };
  } catch (error) {
    contentFailure(error);
  }
};
