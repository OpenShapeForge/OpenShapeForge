// SPDX-License-Identifier: BUSL-1.1
/**
 * Live document-theme selection. Stored ids are selections; token values are
 * always read from the current theme row. A published template snapshot may
 * freeze the theme id, never the token values. New templates without a choice
 * receive the tenant default at insert. Existing selections are never
 * silently replaced by a different tenant default during a live read.
 */
import { refuse } from "./validation.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const THEME_ID_COLUMN = "document_theme_id";

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function themeIdValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && UUID.test(value)) return value;
  refuse("INVALID_STATE", "The stored document-theme selection is malformed.");
}

/** Theme id frozen on a published Template snapshot head, if the version carried one. */
export function themeIdFromTemplateSnapshot(snapshot: unknown): string | null {
  if (!isObject(snapshot) || snapshot.schemaVersion !== 1 || snapshot.entity !== "Template") {
    refuse("INVALID_STATE", "The published template snapshot is malformed.");
  }
  const head = snapshot.head;
  if (!isObject(head) || !isObject(head.row)) refuse("INVALID_STATE", "The published template snapshot has no head row.");
  return themeIdValue(head.row[THEME_ID_COLUMN]);
}

/**
 * The page settings a published template froze for its variants, by
 * `channel/locale`, for the variants laid out as pages. A document that does
 * not say how it is laid out reads its own here.
 */
export function pagesFromTemplateSnapshot(snapshot: unknown, read: (row: Readonly<Record<string, unknown>>) => Record<string, unknown> | null | undefined): Record<string, Record<string, unknown>> {
  const pages: Record<string, Record<string, unknown>> = {};
  if (!isObject(snapshot) || !isObject(snapshot.head) || !isObject(snapshot.head.children)) return pages;
  const variants = snapshot.head.children.template_variants;
  if (!Array.isArray(variants)) return pages;
  for (const variant of variants) {
    const row = isObject(variant) && isObject(variant.row) ? variant.row : undefined;
    if (!row || typeof row.channel !== "string" || typeof row.locale !== "string") continue;
    const values = read(row);
    if (values) pages[`${row.channel}/${row.locale}`] = values;
  }
  return pages;
}
