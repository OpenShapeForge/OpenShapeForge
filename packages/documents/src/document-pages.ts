// SPDX-License-Identifier: BUSL-1.1
import type { ModuleOperationHandler } from "@openshapeforge/plugin-runtime";
import { contextServices, rows } from "./commands.js";
import type { MaterializedContentBlock, MaterializedDocumentContent, MaterializedTemplateContent } from "./content/types.js";
import { materializeDocument } from "./document-materialize.js";
import { buildPagedDocument, PagedDocumentError, withPaletteColors } from "./page/html.js";
import { pageDesignFromStored } from "./page-design.js";
import { DEFAULT_PAGE_DESIGN, type PageBlock, type PageLayouts } from "./page/types.js";
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
 * does and returns one self-contained HTML document per section for a print
 * engine. The page settings are the document's own (its variant's, else its
 * template's) and those of every included template that has pages of its own.
 * The theme the document resolves to (the pinned template version's, else the
 * organization's default) supplies only the look; without one the document
 * gets the default page. Fonts are not included: the host that prints
 * supplies them.
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
    return { title: document!.title ?? "", themeId: theme?.id ?? null, pageDesign: theme?.page_design };
  });
  const design = pageDesignFromStored(source.pageDesign) ?? DEFAULT_PAGE_DESIGN;
  const layouts: Record<string, Readonly<Record<string, unknown>>> = {};
  // A document that follows no template carries its own page settings.
  if ("page" in content && content.page) layouts[""] = content.page;
  // Every template the content was built from, the document's own first, under the scope its blocks carry.
  for (const template of content.templates) {
    const page = template.version.variants[0]?.page;
    if (page) layouts[template.path.join("/")] = page;
  }
  // A page's background is a color of the organization's palette or a standard one, read live like the theme's.
  if (Object.values(layouts).some((layout) => typeof layout.background === "string")) {
    const listed = await platform.operations.execute(session, { operation: { id: "colors.list", intent: "invoke" }, input: {} });
    if ("error" in listed) refuse("INVALID_STATE", "The document color palette is unavailable.");
    const palette = (listed.data as { colors: { reference: string; value: string }[] }).colors;
    for (const scope of Object.keys(layouts)) layouts[scope] = withPaletteColors(layouts[scope]!, palette);
  }
  try {
    const paged = buildPagedDocument({
      title: source.title, locale: content.locale, blocks: content.blocks.map(pageBlock), layouts: layouts as PageLayouts, design, fonts: [],
    });
    return { value: { documentId, themeId: source.themeId, compositionHash: content.compositionHash, ...paged } };
  } catch (error) {
    if (error instanceof PagedDocumentError) refuse("INVALID_STATE", error.message);
    throw error;
  }
};
