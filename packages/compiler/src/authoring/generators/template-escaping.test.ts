import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderTemplate } from "./helpers.js";

const templatesDir = join(dirname(fileURLToPath(import.meta.url)), "templates");

function capitalizeFirst(s: string): string {
  return s.length ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

describe("entity-manifest-shard.ts.ejs metadata escaping", () => {
  it("JS-escapes string metadata rather than HTML-escaping it", () => {
    const output = renderTemplate("app/entity-manifest-shard.ts.ejs", {
      entry: {
        entityLower: "thing",
        typeName: "Thing",
        listQueryName: "things",
        entityName: 'Fish & <Chips> "special"',
        entitySlug: "fish-and-chips",
        entityType: "core.thing",
        realtimeResourceType: "getThing",
        domains: [],
        routes: {},
      },
      capitalizeFirst,
    });
    // The literal round-trips exactly, no HTML entities leak in.
    expect(output).toContain('entityName: "Fish & <Chips> \\"special\\""');
    expect(output).not.toContain("&amp;");
    expect(output).not.toContain("&lt;");
    expect(output).not.toContain("&quot;");
  });
});

describe("layout.tsx.ejs title escaping", () => {
  it("JS-escapes the app title rather than HTML-escaping it", () => {
    const output = renderTemplate("app/layout.tsx.ejs", {
      title: "Acme & Co <Beta>",
      shellComponent: "AppShell",
      navItems: [],
      settingsPanelItems: [],
      hasMultipleContexts: false,
      contextLabels: {},
    });
    expect(output).toContain('title: "Acme & Co <Beta>"');
    expect(output).not.toContain("&amp;");
    expect(output).not.toContain("&lt;");
  });
});

describe("dynamic-detail-page.tsx.ejs pathname substitution", () => {
  it("replaces every :id via a function replacement to avoid $-sequence handling", () => {
    const source = readFileSync(
      join(templatesDir, "app/dynamic-detail-page.tsx.ejs"),
      "utf-8",
    );
    expect(source).toContain("pathnameTemplate.replace(/:id/g, () => id)");
    expect(source).not.toContain('pathnameTemplate.replace(":id", id)');
  });
});
