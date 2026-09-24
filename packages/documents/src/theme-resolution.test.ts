// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { selectLiveThemeId, themeIdFromTemplateSnapshot, themeIdValue } from "./theme-resolution.js";

const theme = "10000000-0000-4000-8000-000000000001";
const other = "10000000-0000-4000-8000-000000000002";
const snapshot = (themeId: unknown) => ({
  schemaVersion: 1,
  entity: "Template",
  head: { table: "templates", row: { document_theme_id: themeId }, children: {} },
});

describe("live document theme selection", () => {
  test("reads the theme id frozen on a published template snapshot and ignores token-shaped extras", () => {
    expect(themeIdFromTemplateSnapshot(snapshot(theme))).toBe(theme);
    expect(themeIdFromTemplateSnapshot(snapshot(null))).toBeNull();
    expect(themeIdFromTemplateSnapshot({ schemaVersion: 1, entity: "Document", head: { row: { document_theme_id: theme } } })).toBeNull();
    expect(themeIdFromTemplateSnapshot(snapshot("not-a-uuid"))).toBeNull();
    expect(themeIdValue(theme)).toBe(theme);
    expect(themeIdValue("")).toBeNull();
  });

  test("a stored theme that still exists wins over the tenant default", () => {
    expect(selectLiveThemeId({ storedThemeId: theme, storedThemeExists: true, defaultThemeId: other })).toEqual({
      themeId: theme,
      usedDefault: false,
    });
  });

  test("a missing, deleted, or unpublished selection falls back to the tenant default without inventing an id", () => {
    expect(selectLiveThemeId({ storedThemeId: theme, storedThemeExists: false, defaultThemeId: other })).toEqual({
      themeId: other,
      usedDefault: true,
    });
    expect(selectLiveThemeId({ storedThemeId: null, storedThemeExists: false, defaultThemeId: other })).toEqual({
      themeId: other,
      usedDefault: true,
    });
    expect(selectLiveThemeId({ storedThemeId: null, storedThemeExists: false, defaultThemeId: null })).toEqual({
      themeId: null,
      usedDefault: false,
    });
  });
});
