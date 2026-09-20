// SPDX-License-Identifier: BUSL-1.1
/**
 * The shape one entity CRUD tool is advertised in, beyond its compiled
 * schema: the text in the session's language, the reminder every write
 * tool carries, the title mirrored into the annotations and the MCP App
 * link of a create that elicits. The runtime lists a tool with this; the
 * compiler measures the listing with it, so the bytes it budgets are the
 * bytes a client receives.
 */
import type { McpToolShape } from "./mcp-static-tools.js";

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

type LocalizedText = string | Readonly<Record<string, string>> | undefined;

function inLanguage(value: LocalizedText, language: string): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (!value) return undefined;
  const text = value[language] ?? value.en;
  return typeof text === "string" && text.trim() ? text.trim() : undefined;
}

/**
 * The title and description of an entity CRUD tool in one language. The
 * compiler collapses the canonical operation's `{ en, nl, … }` name and
 * description into English and appends its own advice; the canonical
 * operation still carries every language, so the localized sentence
 * replaces the English one the compiled description was composed from and
 * the advice is kept. Without a canonical operation, or when the compiled
 * text was not composed that way, the compiled text stands.
 */
export function localizedEntityToolText(
  compiled: { title?: string | undefined; description: string },
  canonical: { name?: LocalizedText; description?: LocalizedText } | undefined,
  language: string | undefined,
): { title: string | undefined; description: string } {
  if (!language || !canonical) return { title: compiled.title, description: compiled.description };
  const english = inLanguage(canonical.description, "en");
  const localized = inLanguage(canonical.description, language);
  return {
    title: inLanguage(canonical.name, language) ?? compiled.title,
    description:
      english && localized && compiled.description.startsWith(english)
        ? `${localized}${compiled.description.slice(english.length)}`
        : compiled.description,
  };
}

/** What an entity CRUD tool is advertised with, once its schemas are settled for the session. */
export type EntityToolAdvertisement = {
  name: string;
  operation: "list" | "get" | "create" | "update" | "delete";
  title: string | undefined;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown> | undefined;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean };
  /** Whether a create links the private configuration app (elicits, on an https origin). */
  linksConfigurationApp: boolean;
};

/** The listed tool: write reminder appended, title mirrored, app link attached. */
export function advertisedEntityTool(tool: EntityToolAdvertisement): McpToolShape {
  const write = tool.operation === "create" || tool.operation === "update";
  return {
    name: tool.name,
    ...(tool.title !== undefined ? { title: tool.title } : {}),
    description: write ? `${tool.description}${DATA_ACQUISITION_TOOL_FOOTER}` : tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    annotations: {
      ...(tool.title !== undefined ? { title: tool.title } : {}),
      ...tool.annotations,
    },
    ...(tool.operation === "create" && tool.linksConfigurationApp
      ? { _meta: { ui: { resourceUri: ENTITY_CONFIGURATION_APP_URI } } }
      : {}),
  };
}
