// SPDX-License-Identifier: BUSL-1.1
/**
 * Live document-theme selection. Stored ids are selections; token values are
 * always read from the current theme row. A published template snapshot may
 * freeze the theme id, never the token values. New templates without a choice
 * receive the tenant default at insert. Existing selections are never
 * silently replaced by a different tenant default during a live read.
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
