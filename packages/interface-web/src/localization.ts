// SPDX-License-Identifier: BUSL-1.1
import type { LocalizedText } from "./contract.js";

export type UiLocale = "en" | "nl";
export const UI_LOCALES = ["en", "nl"] as const;

/** The verified session chooses the language. Unsupported UI languages use English. */
export function normalizeUiLocale(value: unknown): UiLocale {
  if (typeof value !== "string") return "en";
  try { return new Intl.Locale(value.trim().replace(/_/g, "-")).language === "nl" ? "nl" : "en"; }
  catch { return "en"; }
}

export function uiText(value: Partial<LocalizedText> | string | undefined, locale: UiLocale, fallback = ""): string {
  if (typeof value === "string") return value;
  return value?.[locale] || value?.en || value?.nl || fallback;
}

/** Standard JSON Schema title/description stay strings; this annotation retains both languages. */
export type SchemaUiText = {
  title?: LocalizedText;
  description?: LocalizedText;
  enum?: Record<string, LocalizedText>;
};

/** Only schema presentation is resolved. Defaults, constants and customer values are untouched. */
export function localizeInputSchema<T extends Record<string, unknown>>(schema: T, locale: UiLocale): T {
  const result: Record<string, unknown> = { ...schema };
  const copy = schema["x-osf-i18n"] as SchemaUiText | undefined;
  if (copy?.title) result.title = uiText(copy.title, locale);
  if (copy) {
    if (copy.description) result.description = uiText(copy.description, locale);
    else delete result.description; // Transport documentation is not UI help.
  }
  if (schema.properties && typeof schema.properties === "object") result.properties = Object.fromEntries(
    Object.entries(schema.properties).map(([key, field]) => [key, localizeInputSchema(field, locale)]),
  );
  if (schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) result.items = localizeInputSchema(schema.items as Record<string, unknown>, locale);
  for (const key of ["oneOf", "anyOf", "allOf"] as const) if (Array.isArray(schema[key])) {
    result[key] = schema[key].map((branch) => localizeInputSchema(branch, locale));
  }
  return result as T;
}

/** Build diagnostic for every authored annotation, including nested operation fields and choices. */
export function missingUiTranslations(value: unknown, path = ""): string[] {
  if (!value || typeof value !== "object") return [];
  const errors: string[] = [];
  if (Array.isArray(value)) return value.flatMap((entry, index) => missingUiTranslations(entry, `${path}[${index}]`));
  for (const [key, child] of Object.entries(value)) {
    const next = path ? `${path}.${key}` : key;
    if (key === "x-osf-i18n" && child && typeof child === "object") {
      const annotation = child as SchemaUiText;
      const texts = { ...(annotation.title ? { title: annotation.title } : {}), ...(annotation.description ? { description: annotation.description } : {}),
        ...Object.fromEntries(Object.entries(annotation.enum ?? {}).map(([key, text]) => [`enum.${key}`, text])) };
      for (const [name, text] of Object.entries(texts)) for (const language of UI_LOCALES) {
        if (typeof text[language] !== "string" || !text[language].trim()) errors.push(`${next}.${name}.${language}`);
      }
    }
    errors.push(...missingUiTranslations(child, next));
  }
  return errors;
}

/** Strict hosts require labels for every visible operation input, including array items and variants. */
export function missingSchemaUiTranslations(schema: Record<string, unknown>, path: string): string[] {
  const missing = missingUiTranslations(schema, path);
  function visit(node: Record<string, unknown>, at: string) {
    for (const [key, field] of Object.entries(node.properties ?? {}) as Array<[string, Record<string, unknown>]>) {
      const next = `${at}.properties.${key}`;
      if (field.const === undefined && !(field["x-osf-i18n"] as SchemaUiText | undefined)?.title) missing.push(`${next}.x-osf-i18n.title`);
      visit(field, next);
    }
    if (node.items && typeof node.items === "object" && !Array.isArray(node.items)) visit(node.items as Record<string, unknown>, `${at}.items`);
    for (const key of ["oneOf", "anyOf", "allOf"]) if (Array.isArray(node[key])) node[key].forEach((branch, index) => visit(branch, `${at}.${key}[${index}]`));
    if (Array.isArray(node.enum)) for (const value of node.enum) {
      if (typeof value === "string" && !(node["x-osf-i18n"] as SchemaUiText | undefined)?.enum?.[value]) missing.push(`${at}.x-osf-i18n.enum.${value}`);
    }
  }
  visit(schema, path);
  return [...new Set(missing)];
}

/** Check authored language maps before a projection can fill a missing language. */
export function missingLocalizedMetadata(value: unknown, path = ""): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((entry, index) => missingLocalizedMetadata(entry, `${path}[${index}]`));
  const missing: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const next = path ? `${path}.${key}` : key;
    if (["label", "labels", "name", "title", "description", "help"].includes(key) && child && typeof child === "object" && !Array.isArray(child) && ("en" in child || "nl" in child)) {
      for (const language of UI_LOCALES) {
        const text = (child as Record<string, unknown>)[language];
        if (typeof text !== "string" || !text.trim()) missing.push(`${next}.${language}`);
      }
    }
    // JSON Schema transport descriptions and customer defaults are not UI metadata.
    if (!["input", "output", "default", "defaultValue", "schema"].includes(key)) missing.push(...missingLocalizedMetadata(child, next));
  }
  return missing;
}
