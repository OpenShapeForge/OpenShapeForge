// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { buildPagedDocument, pageBlockCss, pageSettings, renderPageBlock, PagedDocumentError, PAGED_FONTS_MARKER } from "./html.js";
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

const build = (blocks: PageBlock[]) => buildPagedDocument({ title: "Proposal", locale: "en", blocks, design, fonts: [] });

describe("buildPagedDocument", () => {
  test("a cover section and an empty section give two pages with their own header and footer", () => {
    const paged = build([
      block("h1", "ImageBlock", { asset: "mark", width: 120, height: 24 }, "header", "cover"),
      block("f1", "TextColumns", { left: "left", center: "middle", right: "right", centerWidth: 140 }, "footer", "cover"),
      block("f2", "TextBlock", { markdown: "Confidential" }, "footer", "content"),
      block("s1", "SectionBreak", { layout: "cover", background: "surface", backgroundImage: "mark" }),
      block("b1", "TextBlock", { markdown: "Pentesting for Nova Harbor", style: "title" }),
      block("s2", "SectionBreak", { layout: "content", margin: 32 }),
    ]);
    expect(paged.page).toEqual({ width: 720, height: 913 });
    expect(paged.sections.map((section) => section.layout)).toEqual(["cover", "content"]);
    const [cover, content] = paged.sections.map((section) => section.html);
    expect(cover).toContain("@page{size:720px 913px;margin:0}");
    expect(cover).toContain('data-osf-region="header"');
    expect(cover).toContain("background:#becbd3");
    expect(cover).toContain("Pentesting for Nova Harbor");
    expect(cover).not.toContain("Confidential");
    expect(content).toContain("Confidential");
    expect(content).not.toContain('data-osf-region="header"');
    expect(content).not.toContain("Pentesting");
    expect(cover).toContain(PAGED_FONTS_MARKER);
  });

  test("blocks before the first break use the default layout and its header", () => {
    const paged = build([block("h", "TextBlock", { markdown: "Head" }, "header"), block("b", "TextBlock", { markdown: "Body" })]);
    expect(paged.sections).toHaveLength(1);
    expect(paged.sections[0]!.layout).toBe("default");
    expect(paged.sections[0]!.html).toContain("Head");
  });

  test("an included template keeps its own layout and the including template resumes on a new page", () => {
    const included = (id: string, definitionKey: string, values: Record<string, unknown>, region: PageBlock["region"] = "body", layoutKey?: string): PageBlock =>
      ({ ...block(id, definitionKey, values, region, layoutKey), scope: "include-1" });
    const paged = build([
      block("oh", "TextBlock", { markdown: "Outer header" }, "header"),
      block("os", "SectionBreak", { layout: "default", margin: 32 }),
      included("ih", "TextBlock", { markdown: "Cover header" }, "header"),
      included("is", "SectionBreak", { layout: "default", background: "surface" }),
      included("ib", "TextBlock", { markdown: "Cover title" }),
      block("ob", "TextBlock", { markdown: "Dear reader" }),
    ]);
    // The outer template's first section has no content of its own, so it adds no page.
    expect(paged.sections).toHaveLength(2);
    const [cover, letter] = paged.sections.map((section) => section.html);
    expect(cover).toContain("Cover header");
    expect(cover).toContain("Cover title");
    expect(cover).toContain("background:#becbd3");
    expect(cover).not.toContain("Outer header");
    expect(letter).toContain("Outer header");
    expect(letter).toContain("Dear reader");
    expect(letter).toContain("--m:32px");
    expect(letter).not.toContain("Cover header");
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
    ["an unknown background color", [block("s", "SectionBreak", { layout: "cover", background: "missing" })]],
    ["an unsupported block type", [block("b", "YouTubeEmbed", { url: "x" })]],
    ["a section break in a header", [block("s", "SectionBreak", { layout: "cover" }, "header", "cover")]],
    ["a style key that is not a key", [block("b", "TextBlock", { markdown: "x", style: 'x"}body{display:none' })]],
    ["a width that is not a number", [block("b", "TextBlock", { markdown: "x", maxWidth: "1px;position:fixed" })]],
  ] as const)("refuses %s", (_name, blocks) => {
    expect(() => build([...blocks])).toThrow(PagedDocumentError);
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
