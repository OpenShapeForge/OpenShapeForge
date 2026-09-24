// SPDX-License-Identifier: BUSL-1.1
import type { ModuleOperationHandler } from "@openshapeforge/plugin-runtime";
import { contextServices, rows } from "./commands.js";
import {
  DOCUMENT_COLOR_ROLES,
  DOCUMENT_FONT_FAMILIES,
  DOCUMENT_THEME_COLOR,
  type DocumentColorRole,
  type DocumentFontFamily,
  type DocumentTextStyle,
  type DocumentThemeResolutionKind,
  type DocumentTypography,
  type ResolvedDocumentTheme,
} from "./theme-tokens.js";
import { selectLiveThemeId, themeIdFromTemplateSnapshot, themeIdValue } from "./theme-resolution.js";
import { object, refuse, uuid } from "./validation.js";

type ThemeRow = Readonly<{
  id: string;
  key: string;
  name: string;
  isDefault: boolean;
  surfaceColor: string;
  textColor: string;
  accentColor: string;
  fontFamily: string;
  typography: unknown;
  updatedAt: string;
}>;

const SOURCE_FIELDS = ["documentId", "templateId", "templateVersionId"] as const;
const THEME_SELECT = `id, key, name, is_default as "isDefault", surface_color as "surfaceColor", text_color as "textColor",
  accent_color as "accentColor", font_family as "fontFamily", typography, updated_at::text as "updatedAt"`;

function sourceField(input: Record<string, unknown>): (typeof SOURCE_FIELDS)[number] {
  const present = SOURCE_FIELDS.filter((field) => input[field] != null);
  if (present.length !== 1) refuse("VALIDATION", "Resolve a document theme from exactly one of documentId, templateId, or templateVersionId.");
  return present[0]!;
}

function fontFamily(value: unknown, fallback: DocumentFontFamily): DocumentFontFamily {
  return DOCUMENT_FONT_FAMILIES.includes(value as DocumentFontFamily) ? (value as DocumentFontFamily) : fallback;
}

function colorRole(value: unknown): DocumentColorRole {
  return DOCUMENT_COLOR_ROLES.includes(value as DocumentColorRole) ? (value as DocumentColorRole) : "text";
}

function finiteNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function textStyle(value: unknown, fallbackFamily: DocumentFontFamily): DocumentTextStyle {
  const row = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const style: DocumentTextStyle = {
    fontSize: finiteNumber(row.fontSize, 11, 6, 72),
    lineHeight: finiteNumber(row.lineHeight, 1.5, 1, 3),
    fontWeight: Math.round(finiteNumber(row.fontWeight, 400, 100, 900)),
    colorRole: colorRole(row.colorRole),
  };
  const family = row.fontFamily === undefined ? undefined : fontFamily(row.fontFamily, fallbackFamily);
  const spaceBefore = row.spaceBefore === undefined ? undefined : finiteNumber(row.spaceBefore, 0, 0, 96);
  const spaceAfter = row.spaceAfter === undefined ? undefined : finiteNumber(row.spaceAfter, 0, 0, 96);
  return {
    ...style,
    ...(family ? { fontFamily: family } : {}),
    ...(spaceBefore !== undefined ? { spaceBefore } : {}),
    ...(spaceAfter !== undefined ? { spaceAfter } : {}),
  };
}

function typography(value: unknown, fallbackFamily: DocumentFontFamily): DocumentTypography {
  const row = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return {
    body: textStyle(row.body, fallbackFamily),
    heading1: textStyle(row.heading1, fallbackFamily),
    heading2: textStyle(row.heading2, fallbackFamily),
    heading3: textStyle(row.heading3, fallbackFamily),
    quote: textStyle(row.quote, fallbackFamily),
    list: textStyle(row.list, fallbackFamily),
  };
}

function hexColor(value: unknown, fallback: string): string {
  return typeof value === "string" && DOCUMENT_THEME_COLOR.test(value) ? value : fallback;
}

function projectTheme(row: ThemeRow): ResolvedDocumentTheme {
  const family = fontFamily(row.fontFamily, "source-sans");
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    isDefault: row.isDefault === true,
    surfaceColor: hexColor(row.surfaceColor, "#ffffff"),
    textColor: hexColor(row.textColor, "#111827"),
    accentColor: hexColor(row.accentColor, "#2563eb"),
    fontFamily: family,
    typography: typography(row.typography, family),
    updatedAt: row.updatedAt,
  };
}

async function themeById(trx: unknown, tenantId: string, id: string): Promise<ThemeRow | null> {
  return (await rows<ThemeRow>(trx, `select ${THEME_SELECT} from erp.document_themes where tenant_id = $1 and id = $2 for share`, [tenantId, id]))[0] ?? null;
}

async function defaultTheme(trx: unknown, tenantId: string): Promise<ThemeRow | null> {
  return (await rows<ThemeRow>(trx, `select ${THEME_SELECT} from erp.document_themes where tenant_id = $1 and is_default for share`, [tenantId]))[0] ?? null;
}

async function liveTheme(
  trx: unknown,
  tenantId: string,
  storedThemeId: string | null,
): Promise<{ row: ThemeRow | null; usedDefault: boolean }> {
  const stored = storedThemeId ? await themeById(trx, tenantId, storedThemeId) : null;
  const fallback = stored ? null : await defaultTheme(trx, tenantId);
  const selected = selectLiveThemeId({
    storedThemeId,
    storedThemeExists: stored != null,
    defaultThemeId: fallback?.id ?? null,
  });
  if (selected.themeId && stored && !selected.usedDefault) return { row: stored, usedDefault: false };
  return { row: fallback, usedDefault: fallback != null };
}

export const resolveDocumentTheme: ModuleOperationHandler = async (input, context) => {
  const { platform, session } = contextServices(context);
  if (!session.tenantId) refuse("UNAUTHENTICATED", "Document theme resolution requires a tenant session.");
  const tenantId = session.tenantId;
  const field = sourceField(object(input, "input"));
  const sourceId = uuid(input[field], field);
  const entityName = field === "documentId" ? "Document" : field === "templateId" ? "Template" : "TemplateVersion";
  await platform.records.assertAccess(session, { entityName, id: sourceId, intent: "get" });
  const resolved = await platform.db.withSession(session, async (trx) => {
    let storedThemeId: string | null = null;
    let kind: DocumentThemeResolutionKind = field === "documentId" ? "document" : field === "templateId" ? "template" : "template-version";
    if (field === "templateId") {
      const template = (await rows<{ document_theme_id: string | null }>(trx,
        "select document_theme_id from erp.templates where tenant_id = $1 and id = $2 for share", [tenantId, sourceId]))[0];
      if (!template) refuse("NOT_FOUND", "The template does not exist.");
      storedThemeId = themeIdValue(template.document_theme_id);
    } else if (field === "templateVersionId") {
      const version = (await rows<{ snapshot: unknown }>(trx,
        "select snapshot from erp.template_versions where tenant_id = $1 and id = $2 for share", [tenantId, sourceId]))[0];
      if (!version) refuse("NOT_FOUND", "The template version does not exist.");
      storedThemeId = themeIdFromTemplateSnapshot(version.snapshot);
    } else {
      const document = (await rows<{ template_version_id: string | null }>(trx,
        "select template_version_id from erp.documents where tenant_id = $1 and id = $2 for share", [tenantId, sourceId]))[0];
      if (!document) refuse("NOT_FOUND", "The document does not exist.");
      const versionId = themeIdValue(document.template_version_id);
      if (versionId) {
        const version = (await rows<{ snapshot: unknown }>(trx,
          "select snapshot from erp.template_versions where tenant_id = $1 and id = $2 for share", [tenantId, versionId]))[0];
        storedThemeId = themeIdFromTemplateSnapshot(version?.snapshot);
        kind = storedThemeId ? "template-version" : "document";
      }
    }
    const live = await liveTheme(trx, tenantId, storedThemeId);
    if (live.usedDefault) kind = live.row ? "tenant-default" : "none";
    else if (!live.row) kind = "none";
    return {
      theme: live.row ? projectTheme(live.row) : null,
      resolution: { kind, sourceId, themeId: live.row?.id ?? null },
    };
  });
  return { value: resolved };
};
