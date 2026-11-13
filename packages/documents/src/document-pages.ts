// SPDX-License-Identifier: BUSL-1.1
import type { ModuleOperationHandler } from "@openshapeforge/plugin-runtime";
import { contextServices, rows } from "./commands.js";
import type { MaterializedContentBlock, MaterializedDocumentContent, MaterializedTemplateContent } from "./content/types.js";
import { materializeDocument } from "./document-materialize.js";
import { buildPagedDocument, PagedDocumentError } from "./page/html.js";
import { pageDesignFromStored } from "./page-design.js";
import type { PageBlock } from "./page/types.js";
import { themeIdFromTemplateSnapshot, themeIdValue } from "./theme-resolution.js";
import { refuse, uuid } from "./validation.js";

function pageBlock(block: MaterializedContentBlock): PageBlock {
  const values = block.materialization?.result.kind === "block" ? block.materialization.result.value : block.values;
  return {
    id: block.id, definitionKey: block.definitionKey, values: values as Record<string, unknown>,
    region: block.region ?? "body", ...(block.layoutKey ? { layoutKey: block.layoutKey } : {}),
    // Every block an inclusion expands to carries the including blocks before its own id.
    ...(block.path.length > 1 ? { scope: block.path.slice(0, -1).join("/") } : {}),
  };
}

/**
 * Document.renderPages: the editable head of a document laid out as pages.
 *
 * Read-only. It materializes the document exactly as Document.materialize
 * does, reads the page design of the theme the document resolves to (the
 * pinned template version's theme, else the organization's default theme) and
 * returns one self-contained HTML document per section for a print engine.
 * Fonts are not included: the host that prints supplies them.
 */
export const renderDocumentPages: ModuleOperationHandler = async (input, context) => {
  const materialized = await materializeDocument(input, context);
  const content = (materialized as { value: MaterializedDocumentContent | MaterializedTemplateContent }).value;
  const { platform, session } = contextServices(context);
  const tenantId = session.tenantId!;
  const documentId = uuid(input.id, "id");
  const source = await platform.db.withSession(session, async (trx) => {
    const document = (await rows<{ title: string | null; template_version_id: string | null }>(trx,
      "select title, template_version_id from erp.documents where tenant_id = $1 and id = $2 for share", [tenantId, documentId]))[0];
    if (!document) refuse("NOT_FOUND", "The document does not exist.");
    let themeId: string | null = null;
    const versionId = themeIdValue(document!.template_version_id);
    if (versionId) {
      const version = (await rows<{ snapshot: unknown }>(trx,
        "select snapshot from erp.template_versions where tenant_id = $1 and id = $2 for share", [tenantId, versionId]))[0];
      if (!version) refuse("NOT_FOUND", "The document's template version no longer exists.");
      themeId = themeIdFromTemplateSnapshot(version!.snapshot);
    }
    const theme = (await rows<{ id: string; page_design: unknown }>(trx, themeId
      ? "select id, page_design from erp.document_themes where tenant_id = $1 and id = $2 for share"
      : "select id, page_design from erp.document_themes where tenant_id = $1 and is_default for share", themeId ? [tenantId, themeId] : [tenantId]))[0];
    if (!theme) refuse("INVALID_STATE", "The document has no theme, so it cannot be laid out as pages.");
    return { title: document!.title ?? "", themeId: theme!.id, pageDesign: theme!.page_design };
  });
  const design = pageDesignFromStored(source.pageDesign);
  if (!design) refuse("INVALID_STATE", "The document's theme has no page design, so it cannot be laid out as pages.");
  try {
    const paged = buildPagedDocument({
      title: source.title, locale: content.locale, blocks: content.blocks.map(pageBlock), design, fonts: [],
    });
    return { value: { documentId, themeId: source.themeId, compositionHash: content.compositionHash, ...paged } };
  } catch (error) {
    if (error instanceof PagedDocumentError) refuse("INVALID_STATE", error.message);
    throw error;
  }
};
