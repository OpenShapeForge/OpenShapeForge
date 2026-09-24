// SPDX-License-Identifier: BUSL-1.1
/**
 * Live document-theme selection. Stored ids are selections; token values are
 * always read from the current theme row. A published template snapshot may
 * freeze the theme id, never the token values. New templates without a choice
 * receive the tenant default at insert; live views of a missing or deleted
 * selection also fall back to that default without writing it.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const THEME_ID_COLUMN = "document_theme_id";

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function themeIdValue(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value) ? value : null;
}

/** Theme id frozen on a published Template snapshot head, if the version carried one. */
export function themeIdFromTemplateSnapshot(snapshot: unknown): string | null {
  if (!isObject(snapshot) || snapshot.schemaVersion !== 1 || snapshot.entity !== "Template") return null;
  const head = snapshot.head;
  if (!isObject(head) || !isObject(head.row)) return null;
  return themeIdValue(head.row[THEME_ID_COLUMN]);
}

export type ThemeSelectionInput = Readonly<{
  storedThemeId: string | null;
  storedThemeExists: boolean;
  defaultThemeId: string | null;
}>;

/**
 * Pick the live theme id. A stored id that still exists wins; otherwise the
 * tenant default. Callers that have no stored id (a new template, a snapshot
 * published before themes, a deleted theme) share this fallback.
 */
export function selectLiveThemeId(input: ThemeSelectionInput): {
  themeId: string | null;
  usedDefault: boolean;
} {
  if (input.storedThemeId && input.storedThemeExists) {
    return { themeId: input.storedThemeId, usedDefault: false };
  }
  if (input.defaultThemeId) return { themeId: input.defaultThemeId, usedDefault: true };
  return { themeId: null, usedDefault: false };
}
