// SPDX-License-Identifier: BUSL-1.1
import type { PageAsset, PageDesign, PageTextStyle } from "./page/types.js";
import { validatePageDesign } from "./page/html.js";
import { isObject, refuse } from "./validation.js";

const MAX_ASSET_BASE64 = 2_800_000;

function record(value: unknown, name: string): Record<string, unknown> {
  if (!isObject(value)) refuse("INVALID_STATE", `The document theme's page design has an invalid ${name}.`);
  return value as Record<string, unknown>;
}

function number(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) refuse("INVALID_STATE", `The document theme's page design has an invalid ${name}.`);
  return value as number;
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) refuse("INVALID_STATE", `The document theme's page design has an invalid ${name}.`);
  return value as string;
}

/**
 * Reads the stored `DocumentTheme.pageDesign` object into the closed shape the
 * page builder takes, or null when the theme has no page design. The builder checks every key, color and asset again, so
 * this only establishes the structure.
 */
export function pageDesignFromStored(stored: unknown): PageDesign | null {
  if (stored == null || (isObject(stored) && !Object.keys(stored).length)) return null;
  if (!isObject(stored)) refuse("INVALID_STATE", "The document theme's page design is not an object.");
  const design = stored as Record<string, unknown>;
  const page = record(design.page, "page size");
  const colors: Record<string, string> = {};
  for (const [key, value] of Object.entries(record(design.colors ?? {}, "color list"))) colors[key] = string(value, `color "${key}"`);
  const textStyles: Record<string, PageTextStyle> = {};
  for (const [key, value] of Object.entries(record(design.textStyles ?? {}, "text style list"))) {
    const style = record(value, `text style "${key}"`);
    textStyles[key] = {
      fontFamily: string(style.fontFamily, `text style "${key}"`),
      fontSize: number(style.fontSize, `text style "${key}"`),
      lineHeight: number(style.lineHeight, `text style "${key}"`),
      fontWeight: number(style.fontWeight, `text style "${key}"`),
      color: string(style.color, `text style "${key}"`),
      ...(style.letterSpacing == null ? {} : { letterSpacing: number(style.letterSpacing, `text style "${key}"`) }),
      ...(typeof style.label === "string" && style.label ? { label: style.label.slice(0, 120) } : {}),
    };
  }
  const assets: Record<string, PageAsset> = {};
  for (const [key, value] of Object.entries(record(design.assets ?? {}, "asset list"))) {
    const asset = record(value, `asset "${key}"`);
    const data = string(asset.data, `asset "${key}"`);
    if (data.length > MAX_ASSET_BASE64) refuse("INVALID_STATE", `The page design asset "${key}" is too large.`);
    assets[key] = {
      mediaType: string(asset.mediaType, `asset "${key}"`) as PageAsset["mediaType"], data,
      ...(typeof asset.label === "string" && asset.label ? { label: asset.label.slice(0, 120) } : {}),
    };
  }
  const parsed = { page: { width: number(page.width, "page width"), height: number(page.height, "page height") }, colors, textStyles, assets };
  try { validatePageDesign(parsed); } catch { refuse("INVALID_STATE", "The document theme's page design is invalid."); }
  return parsed;
}
