// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { buildPagedDocument, layoutPagedSections, pageBlockCss, variantPageValues, pageSettings, renderPageBlock, PagedDocumentError, PAGED_FONTS_MARKER } from "./html.js";
import type { PageBlock, PagedDocumentInput } from "./types.js";

const design: PagedDocumentInput["design"] = {
  page: { width: 720, height: 913 },
  colors: { foreground: "#0f1218", surface: "#becbd3" },
  textStyles: {
    body: { fontFamily: "DM Sans", fontSize: 14, lineHeight: 20, fontWeight: 400, color: "foreground" },
    title: { fontFamily: "DM Sans", fontSize: 36, lineHeight: 43.2, fontWeight: 300, letterSpacing: -1.08, color: "foreground" },
  },
  assets: { mark: { mediaType: "image/svg+xml", data: "PHN2Zy8+" } },
};

const block = (id: string, definitionKey: string, values: Record<string, unknown>, region: PageBlock["region"] = "body", layoutKey?: string): PageBlock =>
  ({ id, definitionKey, values, region, ...(layoutKey ? { layoutKey } : {}) });

const build = (blocks: PageBlock[], layouts?: PagedDocumentInput["layouts"]) => buildPagedDocument({ title: "Proposal", locale: "en", blocks, design, fonts: [], ...(layouts ? { layouts } : {}) });

describe("buildPagedDocument", () => {
  test("a cover template included in a document gives each its own pages, header and footer", () => {
    const cover = (id: string, definitionKey: string, values: Record<string, unknown>, region: PageBlock["region"] = "body"): PageBlock =>
      ({ ...block(id, definitionKey, values, region), scope: "cover" });
    const paged = build([
      cover("h1", "ImageBlock", { asset: "mark", width: 120, height: 24 }, "header"),
      cover("f1", "TextColumns", { left: "left", center: "middle", right: "right", centerWidth: 140 }, "footer"),
      block("f2", "TextBlock", { markdown: "Confidential" }, "footer"),
      cover("b1", "TextBlock", { markdown: "Pentesting for Nova Harbor", style: "title" }),
      block("b2", "TextBlock", { markdown: "Dear reader" }),
    ], { cover: { background: "surface", backgroundImage: "mark" }, "": { margin: 32 } });
    expect(paged.page).toEqual({ width: 720, height: 913 });
    expect(paged.sections).toHaveLength(2);
    const [first, content] = paged.sections.map((section) => section.html);
    expect(first).toContain("@page{size:720px 913px;margin:0}");
    expect(first).toContain('data-osf-region="header"');
    expect(first).toContain("background:#becbd3");
    expect(first).toContain("Pentesting for Nova Harbor");
    expect(first).not.toContain("Confidential");
    expect(content).toContain("Confidential");
    expect(content).toContain("--m:32px");
    expect(content).not.toContain('data-osf-region="header"');
    expect(content).not.toContain("Pentesting");
    expect(first).toContain(PAGED_FONTS_MARKER);
  });

  test("a document without page settings lies on default pages with its header", () => {
    const paged = build([block("h", "TextBlock", { markdown: "Head" }, "header"), block("b", "TextBlock", { markdown: "Body" })]);
    expect(paged.sections).toHaveLength(1);
    expect(paged.sections[0]!.layout).toBe("default");
    expect(paged.sections[0]!.html).toContain("Head");
  });

  test("an included template keeps its own pages and the including document resumes on a new page", () => {
    const included = (id: string, definitionKey: string, values: Record<string, unknown>, region: PageBlock["region"] = "body"): PageBlock =>
      ({ ...block(id, definitionKey, values, region), scope: "include-1" });
    const paged = build([
      block("oh", "TextBlock", { markdown: "Outer header" }, "header"),
      included("ih", "TextBlock", { markdown: "Cover header" }, "header"),
      included("ib", "TextBlock", { markdown: "Cover title" }),
      { ...block("nested", "TextBlock", { markdown: "A clause the cover includes" }), scope: "include-1/clause" },
      block("ob", "TextBlock", { markdown: "Dear reader" }),
    ], { "": { margin: 32 }, "include-1": { background: "surface" } });
    expect(paged.sections).toHaveLength(2);
    const [cover, letter] = paged.sections.map((section) => section.html);
    expect(cover).toContain("Cover header");
    expect(cover).toContain("Cover title");
    // A continuous template inside the cover flows on the cover's pages.
    expect(cover).toContain("A clause the cover includes");
    expect(cover).toContain("background:#becbd3");
    expect(cover).not.toContain("Outer header");
    expect(letter).toContain("Outer header");
    expect(letter).toContain("Dear reader");
    expect(letter).toContain("--m:32px");
    expect(letter).not.toContain("Cover header");
  });

  test("the sections are available as zones for a preview that draws them itself", () => {
    const sections = layoutPagedSections([
      block("h", "TextBlock", { markdown: "Head" }, "header"),
      block("b", "TextBlock", { markdown: "Body" }),
      block("f", "TextBlock", { markdown: "Foot" }, "footer"),
    ], design, { "": { margin: 32 } });
    expect(sections).toHaveLength(1);
    expect(sections[0]!.settings).toMatchObject({ layout: "default", margin: 32 });
    expect([sections[0]!.header, sections[0]!.body, sections[0]!.footer].map((zone) => zone.map((entry) => entry.id))).toEqual([["h"], ["b"], ["f"]]);
  });

  test("a body above the middle ends one block gap above the middle of the page under the header", () => {
    const html = build([block("b", "TextBlock", { markdown: "Title" })], { "": { bodyAlignment: "aboveCenter" } }).sections[0]!.html;
    expect(html).toContain("justify-content:flex-end;min-height:calc((var(--h) - var(--top) - var(--m)) / 2 - var(--bg))");
  });

  test("an included template without page settings flows inside the including page", () => {
    const paged = build([block("a", "TextBlock", { markdown: "Before" }), { ...block("c", "TextBlock", { markdown: "Clause" }), scope: "include-1" }, block("b", "TextBlock", { markdown: "After" })]);
    expect(paged.sections).toHaveLength(1);
    expect(paged.sections[0]!.html).toMatch(/Before.*Clause.*After/s);
  });

  test("a document without blocks is one blank page", () => {
    expect(build([]).sections).toHaveLength(1);
  });

  test("block text is data, never markup", () => {
    const html = build([block("b", "TextBlock", { markdown: '<script>alert(1)</script> **bold** "q"' })]).sections[0]!.html;
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("<strong>bold</strong>");
  });

  test("an escaped mark in a resolved value is that mark, not markup", () => {
    const html = build([block("b", "TextBlock", { markdown: "11\\/05\\/2026 grey\\-box \\*not bold\\* \\<b\\>" })]).sections[0]!.html;
    expect(html).toContain("<p>11/05/2026 grey-box *not bold* &lt;b&gt;</p>");
  });

  test("the page never fetches: a strict policy and inlined assets only", () => {
    const html = build([block("i", "ImageBlock", { asset: "mark", width: 10, height: 10 })]).sections[0]!.html;
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('src="data:image/svg+xml;base64,PHN2Zy8+"');
    expect(html).not.toMatch(/https?:\/\//);
  });

  test.each([
    ["an unknown text style", [block("b", "TextBlock", { markdown: "x", style: "missing" })]],
    ["an unknown asset", [block("b", "ImageBlock", { asset: "missing", width: 1, height: 1 })]],
    ["an unsupported block type", [block("b", "YouTubeEmbed", { url: "x" })]],
    ["a style key that is not a key", [block("b", "TextBlock", { markdown: "x", style: 'x"}body{display:none' })]],
    ["a width that is not a number", [block("b", "TextBlock", { markdown: "x", maxWidth: "1px;position:fixed" })]],
  ] as const)("refuses %s", (_name, blocks) => {
    expect(() => build([...blocks])).toThrow(PagedDocumentError);
  });

  test("a page takes a theme color by name or a color code of its own, and a name the theme lacks leaves it white", () => {
    const page = (layout: Record<string, unknown>) => build([block("b", "TextBlock", { markdown: "x" })], { "": layout }).sections[0]!.html;
    expect(page({ background: "surface" })).toContain('class="bg" style="background:#becbd3"');
    expect(page({ background: "#112233" })).toContain('class="bg" style="background:#112233"');
    expect(page({ background: "missing", backgroundImage: "missing" })).toContain('<div class="bg"></div>');
    expect(page({ background: "red;position:fixed" })).toContain('<div class="bg"></div>');
  });

  test("a document sets its own page format; without one the page is the theme's", () => {
    const paged = build([{ ...block("c", "TextBlock", { markdown: "Cover" }), scope: "cover" }, block("b", "TextBlock", { markdown: "Body" })],
      { cover: {}, "": { format: "a4" } });
    expect(paged.page).toEqual({ width: 720, height: 913 });
    expect(paged.sections.map((section) => section.page)).toEqual([{ width: 720, height: 913 }, { width: 794, height: 1123 }]);
    expect(paged.sections[1]!.html).toContain("@page{size:794px 1123px;margin:0}");
    expect(pageSettings({ format: "custom", width: 600, height: 800 }, design).page).toEqual({ width: 600, height: 800 });
    expect(() => pageSettings({ format: "custom", width: 20 }, design)).toThrow(PagedDocumentError);
  });

  test("a variant's fields read as page settings", () => {
    expect(variantPageValues({ page_layout: "pages", page_margin: "32", page_background: "surface", page_body_alignment: null })).toEqual({ margin: 32, background: "surface" });
    expect(variantPageValues({ pageLayout: "pages", pageFormat: "custom", pageWidth: "600", pageBodyAlignment: "center" })).toEqual({ format: "custom", width: 600, bodyAlignment: "center" });
    expect(variantPageValues({ pageLayout: "continuous", pageMargin: 32 })).toBeUndefined();
    expect(variantPageValues({ page_layout: null })).toBeNull();
  });

  test("block styles can be scoped for an editor and one block rendered on its own", () => {
    const css = pageBlockCss(design, ".page ");
    expect(css).toContain(".page .s-title{");
    expect(css).toContain(".page .cols{display:flex}");
    expect(renderPageBlock(block("i", "ImageBlock", { asset: "mark", width: 10, height: 10 }), design)).toContain('src="data:image/svg+xml;base64,PHN2Zy8+"');
    expect(() => pageBlockCss(design, ".page{}body")).toThrow(PagedDocumentError);
    expect(pageSettings(undefined, design)).toEqual({ layout: "default", margin: 40, gap: 24, blockGap: 16, bodyAlignment: "top" });
  });

  test("refuses a design color that is not a color", () => {
    expect(() => buildPagedDocument({ title: "t", locale: "en", blocks: [], fonts: [], design: { ...design, colors: { foreground: "red;} body{display:none" } } })).toThrow(PagedDocumentError);
  });
});
