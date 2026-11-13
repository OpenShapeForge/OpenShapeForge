// SPDX-License-Identifier: BUSL-1.1
import type { ModuleOperationHandler } from "@openshapeforge/plugin-runtime";
import { contextServices, rows } from "./commands.js";
import type { MaterializedContentBlock, MaterializedDocumentContent, MaterializedTemplateContent } from "./content/types.js";
import { materializeDocument } from "./document-materialize.js";
import { buildPagedDocument, PagedDocumentError } from "./page/html.js";
import type { PageAsset, PageBlock, PageDesign, PageTextStyle } from "./page/types.js";
import { themeIdFromTemplateSnapshot, themeIdValue } from "./theme-resolution.js";
import { isObject, refuse, uuid } from "./validation.js";

const MAX_ASSET_BASE64 = 2_800_000;

function record(value: unknown, name: string): Record<string, unknown> {
  if (!isObject(value)) refuse("INVALID_STATE", `The document theme's page design has an invalid ${name}.`);
  return value as Record<string, unknown>;
}

function number(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) refuse("INVALID_STATE", `The document theme's page design has an invalid ${name}.`);
  return value as number;
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) refuse("INVALID_STATE", `The document theme's page design has an invalid ${name}.`);
  return value as string;
}

/**
 * Reads the stored `DocumentTheme.pageDesign` object into the closed shape the
 * page builder takes. The builder checks every key, color and asset again, so
 * this only establishes the structure.
 */
export function pageDesignFromTheme(stored: unknown): PageDesign {
  if (!isObject(stored) || !Object.keys(stored).length) refuse("INVALID_STATE", "The document's theme has no page design, so it cannot be laid out as pages.");
  const design = stored as Record<string, unknown>;
  const page = record(design.page, "page size");
  const colors: Record<string, string> = {};
  for (const [key, value] of Object.entries(record(design.colors ?? {}, "color list"))) colors[key] = string(value, `color "${key}"`);
  const textStyles: Record<string, PageTextStyle> = {};
  for (const [key, value] of Object.entries(record(design.textStyles ?? {}, "text style list"))) {
    const style = record(value, `text style "${key}"`);
    textStyles[key] = {
      fontFamily: string(style.fontFamily, `text style "${key}"`),
      fontSize: number(style.fontSize, `text style "${key}"`),
      lineHeight: number(style.lineHeight, `text style "${key}"`),
      fontWeight: number(style.fontWeight, `text style "${key}"`),
      color: string(style.color, `text style "${key}"`),
      ...(style.letterSpacing == null ? {} : { letterSpacing: number(style.letterSpacing, `text style "${key}"`) }),
    };
  }
  const assets: Record<string, PageAsset> = {};
  for (const [key, value] of Object.entries(record(design.assets ?? {}, "asset list"))) {
    const asset = record(value, `asset "${key}"`);
    const data = string(asset.data, `asset "${key}"`);
    if (data.length > MAX_ASSET_BASE64) refuse("INVALID_STATE", `The page design asset "${key}" is too large.`);
    assets[key] = { mediaType: string(asset.mediaType, `asset "${key}"`) as PageAsset["mediaType"], data };
  }
  return { page: { width: number(page.width, "page width"), height: number(page.height, "page height") }, colors, textStyles, assets };
}

function pageBlock(block: MaterializedContentBlock): PageBlock {
  const values = block.materialization?.result.kind === "block" ? block.materialization.result.value : block.values;
  return {
    id: block.id, definitionKey: block.definitionKey, values: values as Record<string, unknown>,
    region: block.region ?? "body", ...(block.layoutKey ? { layoutKey: block.layoutKey } : {}),
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
  try {
    const paged = buildPagedDocument({
      title: source.title, locale: content.locale, blocks: content.blocks.map(pageBlock), design: pageDesignFromTheme(source.pageDesign), fonts: [],
    });
    return { value: { documentId, themeId: source.themeId, compositionHash: content.compositionHash, ...paged } };
  } catch (error) {
    if (error instanceof PagedDocumentError) refuse("INVALID_STATE", error.message);
    throw error;
  }
};
