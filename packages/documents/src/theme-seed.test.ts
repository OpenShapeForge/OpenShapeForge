// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import {
  DOCUMENT_THEME_SEED_LOCALES,
  loadDocumentThemeCatalog,
  loadDocumentThemeSeedRecords,
} from "./theme-seed.js";

describe("DocumentTheme seed", () => {
  test("ships one default theme with closed tokens and no tenant identity", async () => {
    const catalog = await loadDocumentThemeCatalog();
    expect(catalog).toHaveLength(1);
    expect(catalog.filter((entry) => entry.isDefault)).toHaveLength(1);
    expect(catalog[0]).toMatchObject({
      key: "default",
      isDefault: true,
      fontFamily: "source-sans",
      surfaceColor: "#ffffff",
      textColor: "#111827",
      accentColor: "#2563eb",
    });
    expect(catalog[0]?.typography.body.colorRole).toBe("text");
    expect(catalog[0]?.typography.heading1.fontSize).toBe(22);
    expect(catalog[0]?.typography.quote.spaceBefore).toBe(8);
  });

  test("projects localized insert rows without ids so a host can upsert per tenant", async () => {
    const records = await loadDocumentThemeSeedRecords();
    expect(records).toEqual([
      expect.objectContaining({
        key: "default",
        name: "Default",
        isDefault: true,
        fontFamily: "source-sans",
      }),
    ]);
    expect(records[0]).not.toHaveProperty("id");
    expect(records[0]).not.toHaveProperty("tenantId");
    expect((await loadDocumentThemeSeedRecords("nl"))[0]?.name).toBe("Standaard");
    for (const locale of DOCUMENT_THEME_SEED_LOCALES) {
      expect((await loadDocumentThemeSeedRecords(locale))[0]?.name.length).toBeGreaterThan(0);
    }
    await expect(loadDocumentThemeSeedRecords("de" as never)).rejects.toThrow("Unsupported DocumentTheme seed locale");
    const first = await loadDocumentThemeCatalog();
    (first[0] as { names: { en: string } }).names.en = "Changed by caller";
    expect((await loadDocumentThemeCatalog())[0]?.names.en).toBe("Default");
  });
});
