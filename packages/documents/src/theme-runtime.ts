// SPDX-License-Identifier: BUSL-1.1
import type { ModuleOperationHandler } from "@openshapeforge/plugin-runtime";
import { contextServices, rows } from "./commands.js";
import {
  DOCUMENT_COLOR_ROLES,
  DOCUMENT_FONT_FAMILIES,
  DOCUMENT_FONT_WEIGHTS,
  DOCUMENT_THEME_COLOR,
  type DocumentColorRole,
  type DocumentFontFamily,
  type DocumentTextStyle,
  type DocumentThemeResolutionKind,
  type DocumentTypography,
  type ResolvedDocumentTheme,
} from "./theme-tokens.js";
import { themeIdFromTemplateSnapshot, themeIdValue } from "./theme-resolution.js";
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
  if (value === undefined) return fallback;
  if (!DOCUMENT_FONT_FAMILIES.includes(value as DocumentFontFamily)) refuse("INVALID_STATE", "Stored document theme uses an unavailable font.");
  return value as DocumentFontFamily;
}

function colorRole(value: unknown): DocumentColorRole {
  return DOCUMENT_COLOR_ROLES.includes(value as DocumentColorRole) ? (value as DocumentColorRole) : "text";
}

function finiteNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function fontWeight(value: unknown): 400 | 700 {
  if (!DOCUMENT_FONT_WEIGHTS.includes(value as 400 | 700)) refuse("INVALID_STATE", "Stored document theme uses an unavailable font weight.");
  return value as 400 | 700;
}

function textStyle(value: unknown, fallbackFamily: DocumentFontFamily): DocumentTextStyle {
  const row = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const style: DocumentTextStyle = {
    fontSize: finiteNumber(row.fontSize, 11, 6, 72),
    lineHeight: finiteNumber(row.lineHeight, 1.5, 1, 3),
    fontWeight: fontWeight(row.fontWeight),
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
  const family = fontFamily(row.fontFamily, "dm-sans");
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
    const theme = storedThemeId ? await themeById(trx, tenantId, storedThemeId) : null;
    if (storedThemeId && !theme) refuse("NOT_FOUND", "The selected document theme no longer exists.");
    if (!theme) kind = "none";
    return {
      theme: theme ? projectTheme(theme) : null,
      resolution: { kind, sourceId, themeId: theme?.id ?? null },
    };
  });
  return { value: resolved };
};

/** Select the only tenant default before any row is written, so competing
 * selections serialize without relying on a unique-index failure. */
export const setDefaultDocumentTheme: ModuleOperationHandler = async (input, context) => {
  const { platform, session } = contextServices(context);
  if (!session.tenantId) refuse("UNAUTHENTICATED", "Changing the default document theme requires a tenant session.");
  const themeId = uuid(object(input, "input").id, "id");
  await platform.records.assertAccess(session, { entityName: "DocumentTheme", id: themeId, intent: "update" });
  const tenantId = session.tenantId;
  const value = await platform.db.withSession(session, async (trx) => {
    await rows(trx, "select pg_advisory_xact_lock(683165, hashtext($1::text))", [tenantId]);
    const target = await themeById(trx, tenantId, themeId);
    if (!target) refuse("NOT_FOUND", "The document theme does not exist.");
    if (!target.isDefault) {
      await rows(trx, "select set_config('app.document_theme_switching', '1', true)", []);
      try {
        await rows(trx, "update erp.document_themes set is_default = false where tenant_id = $1 and is_default", [tenantId]);
        await rows(trx, "update erp.document_themes set is_default = true where tenant_id = $1 and id = $2", [tenantId, themeId]);
      } finally {
        await rows(trx, "select set_config('app.document_theme_switching', '', true)", []);
      }
    }
    return { id: themeId, isDefault: true };
  });
  return { value };
};
