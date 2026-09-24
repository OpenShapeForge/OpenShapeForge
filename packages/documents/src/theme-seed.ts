// SPDX-License-Identifier: BUSL-1.1
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import {
  DOCUMENT_COLOR_ROLES,
  DOCUMENT_FONT_FAMILIES,
  DOCUMENT_THEME_COLOR,
  type DocumentColorRole,
  type DocumentFontFamily,
  type DocumentTextStyle,
  type DocumentTypography,
} from "./theme-tokens.js";

export const DOCUMENT_THEME_SEED_LOCALES = ["en", "nl", "fr"] as const;
export type DocumentThemeSeedLocale = (typeof DOCUMENT_THEME_SEED_LOCALES)[number];

export type DocumentThemeCatalogEntry = Readonly<{
  key: string;
  isDefault: boolean;
  names: Readonly<Record<DocumentThemeSeedLocale, string>>;
  surfaceColor: string;
  textColor: string;
  accentColor: string;
  fontFamily: DocumentFontFamily;
  typography: DocumentTypography;
}>;

export type DocumentThemeSeedRecord = Readonly<{
  key: string;
  name: string;
  isDefault: boolean;
  surfaceColor: string;
  textColor: string;
  accentColor: string;
  fontFamily: DocumentFontFamily;
  typography: DocumentTypography;
}>;

type Catalog = Readonly<{ version: 1; themes: readonly DocumentThemeCatalogEntry[] }>;

const CATALOG_URL = new URL("./document-themes.seed.yaml", import.meta.url);
const KEY = /^[a-z][a-z0-9.-]{0,99}$/;
const STYLE_KEYS = ["body", "heading1", "heading2", "heading3", "quote", "list"] as const;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`DocumentTheme seed ${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const expected = new Set(keys);
  const unexpected = Object.keys(value).find((key) => !expected.has(key));
  if (unexpected) throw new Error(`DocumentTheme seed ${label} has unknown field ${unexpected}.`);
  const missing = keys.find((key) => !Object.hasOwn(value, key));
  if (missing) throw new Error(`DocumentTheme seed ${label} is missing field ${missing}.`);
}

function hex(value: unknown, label: string): string {
  if (typeof value !== "string" || !DOCUMENT_THEME_COLOR.test(value)) {
    throw new Error(`DocumentTheme seed ${label} must be a six-digit hex color.`);
  }
  return value;
}

function finite(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`DocumentTheme seed ${label} is out of range.`);
  }
  return value;
}

function textStyle(value: unknown, label: string): DocumentTextStyle {
  const row = object(value, label);
  const optional = ["fontFamily", "spaceBefore", "spaceAfter"] as const;
  const required = ["fontSize", "lineHeight", "fontWeight", "colorRole"] as const;
  for (const key of Object.keys(row)) {
    if (![...required, ...optional].includes(key as (typeof required)[number])) {
      throw new Error(`DocumentTheme seed ${label} has unknown field ${key}.`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(row, key)) throw new Error(`DocumentTheme seed ${label} is missing field ${key}.`);
  }
  if (!DOCUMENT_COLOR_ROLES.includes(row.colorRole as DocumentColorRole)) {
    throw new Error(`DocumentTheme seed ${label}.colorRole is not a semantic color role.`);
  }
  if (row.fontFamily !== undefined && !DOCUMENT_FONT_FAMILIES.includes(row.fontFamily as DocumentFontFamily)) {
    throw new Error(`DocumentTheme seed ${label}.fontFamily is not a known font token.`);
  }
  return {
    fontSize: finite(row.fontSize, `${label}.fontSize`, 6, 72),
    lineHeight: finite(row.lineHeight, `${label}.lineHeight`, 1, 3),
    fontWeight: finite(row.fontWeight, `${label}.fontWeight`, 100, 900),
    colorRole: row.colorRole as DocumentColorRole,
    ...(row.fontFamily !== undefined ? { fontFamily: row.fontFamily as DocumentFontFamily } : {}),
    ...(row.spaceBefore !== undefined ? { spaceBefore: finite(row.spaceBefore, `${label}.spaceBefore`, 0, 96) } : {}),
    ...(row.spaceAfter !== undefined ? { spaceAfter: finite(row.spaceAfter, `${label}.spaceAfter`, 0, 96) } : {}),
  };
}

function typography(value: unknown, label: string): DocumentTypography {
  const row = object(value, label);
  exactKeys(row, STYLE_KEYS, label);
  return {
    body: textStyle(row.body, `${label}.body`),
    heading1: textStyle(row.heading1, `${label}.heading1`),
    heading2: textStyle(row.heading2, `${label}.heading2`),
    heading3: textStyle(row.heading3, `${label}.heading3`),
    quote: textStyle(row.quote, `${label}.quote`),
    list: textStyle(row.list, `${label}.list`),
  };
}

function parseCatalog(source: string): Catalog {
  const root = object(parseYaml(source), "catalog");
  exactKeys(root, ["version", "themes"], "catalog");
  if (root.version !== 1) throw new Error("DocumentTheme seed version must be 1.");
  if (!Array.isArray(root.themes) || root.themes.length === 0) {
    throw new Error("DocumentTheme seed themes must be a non-empty array.");
  }
  const keys = new Set<string>();
  let defaults = 0;
  const themes = root.themes.map((raw, index) => {
    const entry = object(raw, `themes[${index}]`);
    exactKeys(entry, ["key", "isDefault", "names", "surfaceColor", "textColor", "accentColor", "fontFamily", "typography"], `themes[${index}]`);
    if (typeof entry.key !== "string" || !KEY.test(entry.key) || keys.has(entry.key)) {
      throw new Error(`DocumentTheme seed themes[${index}].key is invalid or duplicated.`);
    }
    keys.add(entry.key);
    if (typeof entry.isDefault !== "boolean") throw new Error(`DocumentTheme seed themes[${index}].isDefault must be a boolean.`);
    if (entry.isDefault) defaults += 1;
    if (!DOCUMENT_FONT_FAMILIES.includes(entry.fontFamily as DocumentFontFamily)) {
      throw new Error(`DocumentTheme seed themes[${index}].fontFamily is not a known font token.`);
    }
    const names = object(entry.names, `themes[${index}].names`);
    exactKeys(names, DOCUMENT_THEME_SEED_LOCALES, `themes[${index}].names`);
    for (const locale of DOCUMENT_THEME_SEED_LOCALES) {
      const name = names[locale];
      if (typeof name !== "string" || name.trim() === "" || name.length > 200) {
        throw new Error(`DocumentTheme seed themes[${index}].names.${locale} is invalid.`);
      }
    }
    return {
      key: entry.key,
      isDefault: entry.isDefault,
      names: { en: names.en as string, nl: names.nl as string, fr: names.fr as string },
      surfaceColor: hex(entry.surfaceColor, `themes[${index}].surfaceColor`),
      textColor: hex(entry.textColor, `themes[${index}].textColor`),
      accentColor: hex(entry.accentColor, `themes[${index}].accentColor`),
      fontFamily: entry.fontFamily as DocumentFontFamily,
      typography: typography(entry.typography, `themes[${index}].typography`),
    } satisfies DocumentThemeCatalogEntry;
  });
  if (defaults !== 1) throw new Error("DocumentTheme seed must mark exactly one theme as the tenant default.");
  return { version: 1, themes };
}

export async function loadDocumentThemeCatalog(): Promise<readonly DocumentThemeCatalogEntry[]> {
  const catalog = parseCatalog(await readFile(CATALOG_URL, "utf8"));
  return catalog.themes.map((entry) => ({ ...entry, names: { ...entry.names }, typography: { ...entry.typography } }));
}

/**
 * Initial managed records for a host tenant. IDs and tenant identity are
 * absent: the host inserts with its trusted tenant and lets the database mint
 * IDs, using `(tenant_id, key) DO NOTHING` for idempotency.
 */
export async function loadDocumentThemeSeedRecords(
  locale: DocumentThemeSeedLocale = "en",
): Promise<readonly DocumentThemeSeedRecord[]> {
  if (!DOCUMENT_THEME_SEED_LOCALES.includes(locale)) {
    throw new Error(`Unsupported DocumentTheme seed locale: ${String(locale)}.`);
  }
  const catalog = parseCatalog(await readFile(CATALOG_URL, "utf8"));
  return catalog.themes.map((entry) => ({
    key: entry.key,
    name: entry.names[locale],
    isDefault: entry.isDefault,
    surfaceColor: entry.surfaceColor,
    textColor: entry.textColor,
    accentColor: entry.accentColor,
    fontFamily: entry.fontFamily,
    typography: entry.typography,
  }));
}
