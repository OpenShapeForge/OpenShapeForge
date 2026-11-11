// SPDX-License-Identifier: BUSL-1.1
import type { WebAppEntriesV1, WebAppEntry } from "./contract.js";
import type { UiLocale } from "./localization.js";

/**
 * Pure MCP descriptors for application entries. Transport, admission, session
 * checks and dispatch stay with the host; nothing here grants or opens anything.
 */
export type WebAppEntryTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, never>; additionalProperties: false };
  annotations: { readOnlyHint: true; openWorldHint: false };
  _meta: Record<string, unknown> & { ui: { resourceUri: string } };
};

export type WebAppEntryToolOptions = {
  /** Opener names are `<prefix><entry id>`, hyphens as underscores. */
  namePrefix: string;
  /** One shared UI resource, or a logical URI per entry served from the same artifact. */
  resourceUri: string | ((entry: WebAppEntry) => string);
  locale: UiLocale;
  description: (entry: WebAppEntry, title: string) => string;
  /** Host-specific placement metadata, merged beside the portable `ui` link. */
  meta?: Record<string, unknown>;
};

export const WEB_APP_ENTRY_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** The stable opener name of an entry; reversible through {@link webAppEntryForTool}. */
export function webAppEntryToolName(namePrefix: string, entryId: string): string {
  if (!WEB_APP_ENTRY_ID.test(entryId)) throw new Error(`Application entry id "${entryId}" is not a lowercase hyphenated key.`);
  return `${namePrefix}${entryId.replaceAll("-", "_")}`;
}

/** Entries an MCP host may be offered, in navigation order, each at most once. */
export function mcpAppEntries(entries: WebAppEntriesV1): WebAppEntry[] {
  const seen = new Set<string>();
  const ordered: WebAppEntry[] = [];
  for (const id of [...entries.navigation.flatMap((group) => group.entries), ...Object.keys(entries.entries).sort()]) {
    const entry = entries.entries[id];
    if (!entry || seen.has(id)) continue;
    seen.add(id);
    if (entry.mcp.exposed) ordered.push(entry);
  }
  return ordered;
}

export function webAppEntryTool(entry: WebAppEntry, options: WebAppEntryToolOptions): WebAppEntryTool {
  const title = entry.label[options.locale] ?? entry.label.en;
  return {
    name: webAppEntryToolName(options.namePrefix, entry.id),
    title,
    description: options.description(entry, title),
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: {
      ...options.meta,
      ui: { resourceUri: typeof options.resourceUri === "string" ? options.resourceUri : options.resourceUri(entry) },
    },
  };
}

/** Opener descriptors for every MCP-exposed entry; eligibility per session is the host's to apply. */
export function webAppEntryTools(entries: WebAppEntriesV1, options: WebAppEntryToolOptions): WebAppEntryTool[] {
  return mcpAppEntries(entries).map((entry) => webAppEntryTool(entry, options));
}

/** The exposed entry an opener name designates; unknown and unexposed names resolve to nothing. */
export function webAppEntryForTool(entries: WebAppEntriesV1, namePrefix: string, toolName: unknown): WebAppEntry | null {
  if (typeof toolName !== "string" || !toolName.startsWith(namePrefix)) return null;
  return mcpAppEntries(entries).find((entry) => webAppEntryToolName(namePrefix, entry.id) === toolName) ?? null;
}

/** Operations to probe for discoverability, each once, across the given entries. */
export function webAppEntryDiscoverOperations(entries: readonly WebAppEntry[]): string[] {
  return [...new Set(entries.flatMap((entry) => entry.discoverOperations))].sort();
}

/** Whether a session that can discover exactly `discoverable` may be offered the entry. */
export function webAppEntryDiscoverable(entry: WebAppEntry, discoverable: ReadonlySet<string>): boolean {
  return entry.discoverOperations.some((operation) => discoverable.has(operation));
}
