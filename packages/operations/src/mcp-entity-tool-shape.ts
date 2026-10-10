// SPDX-License-Identifier: BUSL-1.1
/**
 * The shape one entity CRUD tool is advertised in, beyond its compiled
 * schema: the text in the session's language, the reminder every write
 * tool carries, the title mirrored into the annotations and the MCP App
 * link of a create that elicits. The runtime lists a tool with this; the
 * compiler measures the listing with it, so the bytes it budgets are the
 * bytes a client receives.
 */
import type { McpToolShape } from "./mcp-tool-shape.js";

/** The URI of the private configuration app a create that elicits links to. */
export const ENTITY_CONFIGURATION_APP_URI = "ui://openshapeforge/configuration";

/**
 * The short reminder every generated `create`/`update` tool carries in its
 * own description — the full data-acquisition order lives once in the
 * server's `instructions` rather than being repeated on every tool.
 */
export const DATA_ACQUISITION_TOOL_FOOTER =
  " Filling this in: derive values from existing records, defaults and " +
  "server-issued fields before asking; propose one complete draft rather " +
  "than asking field-by-field. See this server's instructions for the full " +
  "order.";

const DATA_ACQUISITION_TOOL_FOOTER_BY_LANGUAGE: Readonly<Record<string, string>> = {
  en: DATA_ACQUISITION_TOOL_FOOTER,
  nl:
    " Invullen: leid waarden af uit bestaande records, standaardwaarden en " +
    "door de server uitgegeven velden voordat je iets vraagt; stel één volledig " +
    "concept voor in plaats van veld voor veld te vragen. De volledige volgorde " +
    "staat in de instructies van deze server.",
};

type LocalizedText = string | Readonly<Record<string, string>> | undefined;

function inLanguage(value: LocalizedText, language: string): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (!value) return undefined;
  const text = value[language] ?? value.en;
  return typeof text === "string" && text.trim() ? text.trim() : undefined;
}

/**
 * The title and description of an entity CRUD tool in one language. The
 * compiler composes the description in every language its authored parts
 * carry (`descriptionI18n`); a language it has none for has nothing authored
 * beyond English and gets the compiled text. The title is the canonical
 * operation's name in that language.
 */
export function localizedEntityToolText(
  compiled: { title?: string | undefined; description: string; descriptionI18n?: Readonly<Record<string, string>> | undefined },
  canonical: { name?: LocalizedText } | undefined,
  language: string | undefined,
): { title: string | undefined; description: string; descriptionLanguage: string } {
  const composed = language === undefined ? undefined : compiled.descriptionI18n?.[language];
  return {
    title: (language && canonical && inLanguage(canonical.name, language)) || compiled.title,
    description: composed ?? compiled.description,
    // The compiled description is English: what the write footer must match.
    descriptionLanguage: composed !== undefined ? language! : "en",
  };
}

/** What an entity CRUD tool is advertised with, once its schemas are settled for the session. */
export type EntityToolAdvertisement = {
  name: string;
  operation: "list" | "get" | "create" | "update" | "delete";
  title: string | undefined;
  description: string;
  /** The language `description` is in, which the write footer follows (default: `language`). */
  descriptionLanguage?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown> | undefined;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean };
  /** Whether a create links the private configuration app (elicits, on an https origin). */
  linksConfigurationApp: boolean;
};

/**
 * A schema in one language: every property's `title` and `description`
 * become the `x-osf-i18n` text for `language` (English when that language
 * has none, the compiled text when neither exists) and the per-language copy
 * itself is dropped. The listing and osf_describe both send this: a model
 * reads one language at a time, and the copy was a third of every dedicated
 * tool on the wire. The compiled catalogue keeps every language.
 */
export function schemaInLanguage(schema: unknown, language: string): unknown {
  if (Array.isArray(schema)) return schema.map((entry) => schemaInLanguage(entry, language));
  if (!schema || typeof schema !== "object") return schema;
  const copy = (schema as Record<string, unknown>)["x-osf-i18n"] as
    | Record<string, LocalizedText>
    | undefined;
  const localized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === "x-osf-i18n") continue;
    localized[key] = schemaInLanguage(value, language);
  }
  if (copy && typeof copy === "object") {
    for (const key of ["title", "description"] as const) {
      const text = inLanguage(copy[key], language);
      if (text !== undefined) localized[key] = text;
    }
  }
  return localized;
}

/** The listed tool: write reminder appended, title mirrored, app link attached, schemas in one language. */
export function advertisedEntityTool(tool: EntityToolAdvertisement, language = "en"): McpToolShape {
  const write = tool.operation === "create" || tool.operation === "update";
  return {
    name: tool.name,
    ...(tool.title !== undefined ? { title: tool.title } : {}),
    description: write
      ? `${tool.description}${DATA_ACQUISITION_TOOL_FOOTER_BY_LANGUAGE[tool.descriptionLanguage ?? language] ?? DATA_ACQUISITION_TOOL_FOOTER}`
      : tool.description,
    inputSchema: schemaInLanguage(tool.inputSchema, language) as Record<string, unknown>,
    ...(tool.outputSchema
      ? { outputSchema: schemaInLanguage(tool.outputSchema, language) as Record<string, unknown> }
      : {}),
    annotations: {
      ...(tool.title !== undefined ? { title: tool.title } : {}),
      ...tool.annotations,
    },
    ...(tool.operation === "create" && tool.linksConfigurationApp
      ? { _meta: { ui: { resourceUri: ENTITY_CONFIGURATION_APP_URI } } }
      : {}),
  };
}
