// SPDX-License-Identifier: BUSL-1.1
/**
 * Builds the self-contained HTML a print engine turns into pages.
 *
 * One HTML document per section. Header, footer and background are fixed to
 * the page box so they repeat on every page the section's body flows onto; a
 * table head and foot reserve their space on each of those pages. The print
 * engine measures the two regions and sets `--osf-header-height` and
 * `--osf-footer-height` before printing (see `PAGED_MEASURE_SCRIPT`).
 *
 * Nothing here trusts block content: text is escaped, keys are checked against
 * the design, and every asset and font is inlined so the page never fetches.
 */
import { DEFAULT_PAGE_LAYOUT, type PageAsset, type PageBlock, type PageDesign, type PageFont, type PageLayouts, type PageSettings, type PagedDocument, type PagedDocumentInput, type PagedSection } from "./types.js";

const KEY = /^[a-z][A-Za-z0-9-]{0,63}$/;
const FONT_FAMILY = /^[A-Za-z][A-Za-z0-9 -]{0,63}$/;
const FONT_WEIGHT = /^[1-9]\d{2,3}( [1-9]\d{2,3})?$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const COLOR = /^(#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\))$/;
const ASSET_TYPES = new Set(["image/svg+xml", "image/png", "image/jpeg"]);
const MAX_BLOCKS = 2000;

export class PagedDocumentError extends Error {
  readonly code = "PAGED_DOCUMENT_INVALID";
}

function fail(message: string): never {
  throw new PagedDocumentError(message);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function px(value: unknown, name: string, min: number, max: number, fallback?: number): number {
  if (value === undefined || value === null) {
    if (fallback === undefined) fail(`${name} is required.`);
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) fail(`${name} must be a number between ${min} and ${max}.`);
  return Math.round(value * 100) / 100;
}

function option<T extends string>(value: unknown, name: string, allowed: readonly T[], fallback: T): T {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || !allowed.includes(value as T)) fail(`${name} must be one of ${allowed.join(", ")}.`);
  return value as T;
}

function optionalKey(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !KEY.test(value)) fail(`${name} is not a valid key.`);
  return value;
}

function text(value: unknown, name: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") fail(`${name} must be text.`);
  if (value.length > 20000) fail(`${name} is too long.`);
  return value;
}

/**
 * Inline emphasis only. Everything else in the source stays literal text. A
 * backslash-escaped punctuation mark is that mark, never markup: resolved
 * variable values arrive escaped this way so they cannot become emphasis.
 */
function inline(source: string): string {
  const literal = source.replace(/\\([!-/:-@[-`{-~])/g, (_match, char: string) => String.fromCharCode(0xe000 + char.charCodeAt(0)));
  return escapeHtml(literal)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/[\ue021-\ue07e]/g, (char) => escapeHtml(String.fromCharCode(char.charCodeAt(0) - 0xe000)));
}

/** Blank line separates paragraphs; a single line break stays a line break. */
function paragraphs(markdown: string): string {
  return markdown.replace(/\r\n?/g, "\n").split(/\n{2,}/).map((part) => part.trim()).filter(Boolean)
    .map((part) => `<p>${part.split("\n").map((line) => inline(line.trim())).join("<br>")}</p>`).join("");
}

/** The `data:` URL of a page design image. */
export function pageAssetUrl(design: PageDesign, key: string, name = "The page"): string {
  return assetUrl(design, key, name);
}

function assetUrl(design: PageDesign, key: string, name: string): string {
  const asset: PageAsset | undefined = Object.hasOwn(design.assets, key) ? design.assets[key] : undefined;
  if (!asset) fail(`${name} names the unknown asset "${key}".`);
  return `data:${asset.mediaType};base64,${asset.data}`;
}

function styleClass(design: PageDesign, value: unknown, name: string): string {
  const key = optionalKey(value, name) ?? "body";
  if (!Object.hasOwn(design.textStyles, key)) fail(`${name} names the unknown text style "${key}".`);
  return `s-${key}`;
}

const ALIGN = ["left", "center", "right"] as const;

function textBlock(block: PageBlock, design: PageDesign): string {
  const v = block.values;
  const maxWidth = v.maxWidth === undefined || v.maxWidth === null ? "" : `max-width:${px(v.maxWidth, "TextBlock.maxWidth", 1, 4000)}px;`;
  const align = option(v.align, "TextBlock.align", ALIGN, "left");
  return `<div class="b text ${styleClass(design, v.style, "TextBlock.style")}" style="${maxWidth}text-align:${align}">${paragraphs(text(v.markdown, "TextBlock.markdown"))}</div>`;
}

function textColumns(block: PageBlock, design: PageDesign): string {
  const v = block.values;
  const distribution = option(v.distribution, "TextColumns.distribution", ["fill", "fit"] as const, "fill");
  const vertical = option(v.verticalAlign, "TextColumns.verticalAlign", ["top", "center", "bottom"] as const, "top");
  const items = { top: "flex-start", center: "center", bottom: "flex-end" }[vertical];
  const slots: string[] = [];
  for (const slot of ["left", "center", "right"] as const) {
    const markdown = text(v[slot], `TextColumns.${slot}`);
    if (!markdown.trim()) continue;
    const width = v[`${slot}Width`] === undefined || v[`${slot}Width`] === null ? undefined : px(v[`${slot}Width`], `TextColumns.${slot}Width`, 1, 4000);
    const grows = width === undefined && (distribution === "fill" || slot === "left");
    const flex = width !== undefined ? `flex:0 0 ${width}px;` : grows ? "flex:1 1 0;min-width:0;" : "flex:0 0 auto;white-space:nowrap;";
    const cell = `<div class="text ${styleClass(design, v[`${slot}Style`], `TextColumns.${slot}Style`)}"${slot === "right" ? ' style="white-space:nowrap"' : ""}>${paragraphs(markdown)}</div>`;
    slots.push(`<div class="col${slot === "right" ? " end" : ""}" style="${flex}">${cell}</div>`);
  }
  return `<div class="b cols" style="align-items:${items};gap:${distribution === "fit" ? 16 : 0}px">${slots.join("")}</div>`;
}

function imageBlock(block: PageBlock, design: PageDesign): string {
  const v = block.values;
  const key = optionalKey(v.asset, "Image.asset") ?? fail("Image.asset is required.");
  const width = px(v.width, "Image.width", 1, 4000);
  const height = px(v.height, "Image.height", 1, 4000);
  const align = option(v.align, "Image.align", ALIGN, "left");
  const justify = { left: "flex-start", center: "center", right: "flex-end" }[align];
  return `<div class="b image" style="justify-content:${justify}"><img alt="" src="${assetUrl(design, key, "Image.asset")}" style="width:${width}px;height:${height}px"></div>`;
}

function spacerBlock(block: PageBlock): string {
  return `<div class="b" style="height:${px(block.values.height, "Spacer.height", 0, 4000)}px;flex:none"></div>`;
}

/** Block types the paged renderer lays out itself. A section break is not one: it decides the page, it is not on it. */
export const PAGE_BLOCK_KEYS = ["TextBlock", "TextColumns", "ImageBlock", "SpacerBlock"] as const;

/**
 * One block as the HTML both the print engine and an editor preview show.
 * Text is escaped and every key is checked, so the result is safe to insert.
 */
export function renderPageBlock(block: PageBlock, design: PageDesign): string {
  return renderBlock(block, design);
}

function renderBlock(block: PageBlock, design: PageDesign): string {
  switch (block.definitionKey) {
    case "TextBlock": return textBlock(block, design);
    case "TextColumns": return textColumns(block, design);
    case "ImageBlock": return imageBlock(block, design);
    case "SpacerBlock": return spacerBlock(block);
    default: return fail(`The paged renderer does not support the block type "${block.definitionKey}".`);
  }
}

/**
 * The page fields of a template or document variant, from a record (camel
 * case) or a stored row (snake case): the values `pageSettings` reads when the
 * variant is laid out as pages, `undefined` when it is continuous, and `null`
 * when it does not say, which for a document means "as its template".
 */
export function variantPageValues(source: Readonly<Record<string, unknown>> | null | undefined): Record<string, unknown> | undefined | null {
  const read = (camel: string, snake: string) => source?.[camel] ?? source?.[snake];
  const layout = read("pageLayout", "page_layout");
  if (layout == null || layout === "") return null;
  if (layout !== "pages") return undefined;
  const number = (value: unknown) => typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : value;
  const values: Record<string, unknown> = {};
  for (const [key, camel, snake] of [["margin", "pageMargin", "page_margin"], ["gap", "pageGap", "page_gap"], ["blockGap", "pageBlockGap", "page_block_gap"],
    ["background", "pageBackground", "page_background"], ["backgroundImage", "pageBackgroundImage", "page_background_image"], ["bodyAlignment", "pageBodyAlignment", "page_body_alignment"]] as const) {
    const value = read(camel, snake);
    if (value != null && value !== "") values[key] = number(value);
  }
  return values;
}

type Section = PageSettings & { scope: string; body: PageBlock[] };

/**
 * Reads a variant's page fields into page settings, with the defaults a
 * document without page settings gets.
 */
export function pageSettings(values: Readonly<Record<string, unknown>> | undefined, design: PageDesign): PageSettings {
  const v = values ?? {};
  const background = optionalKey(v.background, "Page.background");
  if (background && !Object.hasOwn(design.colors, background)) fail(`Page.background names the unknown color "${background}".`);
  const backgroundImage = optionalKey(v.backgroundImage, "Page.backgroundImage");
  if (backgroundImage && !Object.hasOwn(design.assets, backgroundImage)) fail(`Page.backgroundImage names the unknown asset "${backgroundImage}".`);
  return {
    layout: optionalKey(v.layout, "Page.layout") ?? DEFAULT_PAGE_LAYOUT,
    margin: px(v.margin, "Page.margin", 0, 400, 40),
    gap: px(v.gap, "Page.gap", 0, 400, 24),
    blockGap: px(v.blockGap, "Page.blockGap", 0, 400, 16),
    ...(background ? { background } : {}),
    ...(backgroundImage ? { backgroundImage } : {}),
    bodyAlignment: option(v.bodyAlignment, "Page.bodyAlignment", ["top", "center", "bottom", "aboveCenter"] as const, "top"),
  };
}

function validateDesign(design: PageDesign, fonts: readonly PageFont[]): void {
  px(design.page.width, "page.width", 100, 5000);
  px(design.page.height, "page.height", 100, 5000);
  for (const [key, color] of Object.entries(design.colors)) if (!KEY.test(key) || typeof color !== "string" || !COLOR.test(color)) fail(`The color "${key}" is not valid.`);
  for (const [key, style] of Object.entries(design.textStyles)) {
    if (!KEY.test(key) || !FONT_FAMILY.test(style.fontFamily)) fail(`The text style "${key}" is not valid.`);
    if (!Object.hasOwn(design.colors, style.color)) fail(`The text style "${key}" names the unknown color "${style.color}".`);
  }
  for (const [key, asset] of Object.entries(design.assets)) if (!KEY.test(key) || !ASSET_TYPES.has(asset.mediaType) || !BASE64.test(asset.data)) fail(`The asset "${key}" is not valid.`);
  for (const font of fonts) if (!FONT_FAMILY.test(font.family) || !FONT_WEIGHT.test(font.weight) || !BASE64.test(font.data) || !["woff2", "truetype"].includes(font.format)) fail(`The font "${font.family}" is not valid.`);
}

/**
 * Stands where the font faces go when the caller supplies no fonts. The host
 * that owns the print engine owns the font files and replaces the marker with
 * its own `@font-face` rules.
 */
export const PAGED_FONTS_MARKER = "/*osf-paged-fonts*/";

function textStyleRules(design: PageDesign, scope: string): string {
  return Object.entries(design.textStyles).map(([key, style]) => `${scope}.s-${key}{font-family:"${style.fontFamily}",sans-serif;font-size:${px(style.fontSize, `${key}.fontSize`, 4, 400)}px;line-height:${px(style.lineHeight, `${key}.lineHeight`, 4, 600)}px;font-weight:${px(style.fontWeight, `${key}.fontWeight`, 100, 1000)};letter-spacing:${px(style.letterSpacing, `${key}.letterSpacing`, -20, 20, 0)}px;color:${design.colors[style.color]}}`).join("");
}

function blockRules(scope: string): string {
  return [
    ".b{flex:none;width:100%}", ".cols{display:flex}", ".col{display:flex}", ".col.end{justify-content:flex-end}", ".image{display:flex}", ".image img{display:block}",
    ".text{overflow-wrap:break-word}", ".text p{margin:0}", ".text p+p{margin-top:1em}",
  ].map((rule) => scope + rule).join("");
}

/**
 * The style rules of the blocks and of the design's text styles, each
 * selector prefixed with `scope` (for example ".page "), so an editor can show
 * blocks inside its own page exactly as the print engine lays them out.
 */
export function pageBlockCss(design: PageDesign, scope: string): string {
  if (!/^[A-Za-z0-9 ._#>-]*$/.test(scope)) fail("The style scope is not a plain selector.");
  validateDesign(design, []);
  return blockRules(scope) + textStyleRules(design, scope);
}

function designCss(design: PageDesign, fonts: readonly PageFont[]): string {
  const faces = fonts.map((font) => `@font-face{font-family:"${font.family}";font-weight:${font.weight};font-style:normal;src:url(data:font/${font.format === "woff2" ? "woff2" : "ttf"};base64,${font.data}) format("${font.format}")}`).join("");
  return (fonts.length ? faces : PAGED_FONTS_MARKER) + blockRules("") + textStyleRules(design, "");
}

const BASE_CSS = [
  "*{box-sizing:border-box}",
  "html,body{margin:0;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}",
  ".bg{position:fixed;left:0;top:0;width:var(--w);height:var(--h);overflow:hidden}",
  ".bg img{position:absolute;left:0;top:0;width:100%;height:100%}",
  ".region{position:fixed;left:var(--m);width:calc(var(--w) - 2*var(--m));display:flex;flex-direction:column;gap:var(--bg)}",
  ".region.header{top:var(--m)}.region.footer{top:calc(var(--h) - var(--m) - var(--osf-footer-height,0px))}",
  "table.flow{width:var(--w);border-collapse:collapse;border-spacing:0}table.flow td{padding:0;vertical-align:top}",
  ".space-top{height:var(--top)}.space-bottom{height:var(--bottom)}",
  ".body{position:relative;display:flex;flex-direction:column;gap:var(--bg);padding:0 var(--m);min-height:calc(var(--h) - var(--top) - var(--bottom))}",
].join("");

/** The print engine evaluates this once, after fonts load and before printing. */
export const PAGED_MEASURE_SCRIPT = `(() => { for (const region of ["header", "footer"]) { const node = document.querySelector('[data-osf-region="' + region + '"]'); document.documentElement.style.setProperty("--osf-" + region + "-height", (node ? node.getBoundingClientRect().height : 0) + "px"); } })()`;

function sectionHtml(input: PagedDocumentInput, section: PageSettings, header: readonly PageBlock[], body: readonly PageBlock[], footer: readonly PageBlock[], css: string): string {
  const { design } = input;
  const { width, height } = design.page;
  const vars = [
    `--w:${width}px`, `--h:${height}px`, `--m:${section.margin}px`, `--bg:${section.blockGap}px`,
    `--top:calc(${section.margin}px + var(--osf-header-height,0px) + ${header.length ? section.gap : 0}px)`,
    `--bottom:calc(${section.margin}px + var(--osf-footer-height,0px) + ${footer.length ? section.gap : 0}px)`,
  ].join(";");
  const justify = { top: "flex-start", center: "center", bottom: "flex-end", aboveCenter: "flex-end" }[section.bodyAlignment];
  // Above the middle: the body is as tall as half the page under the header, less one block gap, and its content sits at its foot.
  const bodyHeight = section.bodyAlignment === "aboveCenter" ? ";min-height:calc((var(--h) - var(--top) - var(--m)) / 2 - var(--bg))" : "";
  const background = `<div class="bg"${section.background ? ` style="background:${design.colors[section.background]}"` : ""}>${section.backgroundImage ? `<img alt="" src="${assetUrl(design, section.backgroundImage, "Page.backgroundImage")}">` : ""}</div>`;
  const region = (name: "header" | "footer", blocks: readonly PageBlock[]) => blocks.length ? `<div class="region ${name}" data-osf-region="${name}">${blocks.map((block) => renderBlock(block, design)).join("")}</div>` : "";
  return [
    `<!doctype html><html lang="${escapeHtml(input.locale)}"><head><meta charset="utf-8">`,
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">`,
    `<title>${escapeHtml(input.title)}</title>`,
    `<style>@page{size:${width}px ${height}px;margin:0}:root{${vars}}${BASE_CSS}${css}</style></head><body>`,
    background, region("header", header), region("footer", footer),
    `<table class="flow"><thead><tr><td><div class="space-top"></div></td></tr></thead>`,
    `<tfoot><tr><td><div class="space-bottom"></div></td></tr></tfoot>`,
    `<tbody><tr><td><div class="body" style="justify-content:${justify}${bodyHeight}">${body.map((block) => renderBlock(block, design)).join("")}</div></td></tr></tbody></table>`,
    `</body></html>`,
  ].join("");
}

const scopedKey = (scope: string, layout: string) => `${scope}\n${layout}`;

/** One section of a paged document: its page settings and the blocks of its three zones. */
export type PagedSectionLayout = Readonly<{ settings: PageSettings; header: readonly PageBlock[]; body: readonly PageBlock[]; footer: readonly PageBlock[] }>;

/**
 * Splits the ordered blocks into sections.
 *
 * Page settings belong to the document, not to a block: `layouts` gives the
 * settings of each template whose content is laid out as pages, keyed by the
 * scope its blocks arrive with ("" is the document itself). A block follows
 * the nearest enclosing scope that has settings, so an included template with
 * pages of its own (a cover) gets its own pages with its own header and
 * footer, an included continuous template flows on the pages around it, and
 * when the including document's blocks resume they continue on a new page
 * with the document's settings. A document without settings gets the default
 * page. A section without body blocks is left out unless it is the last one,
 * which still yields a page.
 */
export function layoutPagedSections(blocks: readonly PageBlock[], design: PageDesign, layouts: PageLayouts = {}): PagedSectionLayout[] {
  if (blocks.length > MAX_BLOCKS) fail(`A paged document holds at most ${MAX_BLOCKS} blocks.`);
  const regions = { header: new Map<string, PageBlock[]>(), footer: new Map<string, PageBlock[]>() };
  const sections: Section[] = [];
  const owners = new Map<string, string>();
  const owner = (scope: string): string => {
    const known = owners.get(scope);
    if (known !== undefined) return known;
    let at = scope;
    while (at && !Object.hasOwn(layouts, at)) at = at.includes("/") ? at.slice(0, at.lastIndexOf("/")) : "";
    owners.set(scope, at);
    return at;
  };
  const settings = new Map<string, PageSettings>();
  const settingsOf = (scope: string): PageSettings => {
    const known = settings.get(scope);
    if (known) return known;
    const made = pageSettings(Object.hasOwn(layouts, scope) ? layouts[scope] : undefined, design);
    settings.set(scope, made);
    return made;
  };
  const open = (scope: string) => { sections.push({ ...settingsOf(scope), scope, body: [] }); };
  for (const block of blocks) {
    const scope = block.scope ?? "";
    if (scope.length > 4000 || /[\n]/.test(scope)) fail("A block scope is not valid.");
    // A section break is a block of documents made before page settings moved to the document; it places nothing.
    if (block.definitionKey === "SectionBreak") continue;
    const owned = owner(scope);
    if (block.region === "body") {
      if (sections.at(-1)?.scope !== owned) open(owned);
      sections.at(-1)!.body.push(block);
      continue;
    }
    const key = scopedKey(owned, optionalKey(block.layoutKey, "Block.layoutKey") ?? DEFAULT_PAGE_LAYOUT);
    const list = regions[block.region].get(key) ?? [];
    list.push(block);
    regions[block.region].set(key, list);
  }
  if (!sections.length) open("");
  return sections.filter((section, index) => section.body.length || index === sections.length - 1).map(({ scope, body, ...rest }) => ({
    settings: rest, body, header: regions.header.get(scopedKey(scope, rest.layout)) ?? [], footer: regions.footer.get(scopedKey(scope, rest.layout)) ?? [],
  }));
}

/** Renders one self-contained HTML document per section of `layoutPagedSections`, for a print engine. */
export function buildPagedDocument(input: PagedDocumentInput): PagedDocument {
  if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(input.locale)) fail("The locale is not valid.");
  validateDesign(input.design, input.fonts);
  const css = designCss(input.design, input.fonts);
  const rendered: PagedSection[] = layoutPagedSections(input.blocks, input.design, input.layouts).map((section) => ({
    layout: section.settings.layout, html: sectionHtml(input, section.settings, section.header, section.body, section.footer, css),
  }));
  return { renderingVersion: "osf-paged-html-v1", page: { ...input.design.page }, sections: rendered };
}
