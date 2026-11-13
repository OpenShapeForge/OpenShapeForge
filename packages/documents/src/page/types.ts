// SPDX-License-Identifier: BUSL-1.1
/**
 * Paged document rendering: the closed vocabulary a print engine receives.
 *
 * A document is one flat, ordered list of blocks. A block sits in a region:
 * `body` blocks flow through the pages, `header` and `footer` blocks belong to
 * the named page layout in `layoutKey` and repeat on every page of a section
 * that uses that layout. A `SectionBreak` body block starts a new page and
 * selects the layout for everything up to the next break.
 */

export const PAGE_REGIONS = ["body", "header", "footer"] as const;
export type PageRegion = (typeof PAGE_REGIONS)[number];

export const DEFAULT_PAGE_LAYOUT = "default";

export type PageBlock = Readonly<{
  id: string;
  definitionKey: string;
  values: Readonly<Record<string, unknown>>;
  region: PageRegion;
  /** Layout a header or footer block belongs to. Body blocks carry none. */
  layoutKey?: string;
  /**
   * The template inclusion this block arrived through: the path of including
   * blocks, joined by "/", and empty for the document's own blocks. Layout keys
   * are names inside one template, so they are matched within a scope.
   */
  scope?: string;
}>;

/** Sizes are CSS pixels; the page box itself is declared in the same unit. */
export type PageTextStyle = Readonly<{
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  fontWeight: number;
  letterSpacing?: number;
  /** Key into `PageDesign.colors`. */
  color: string;
  spaceBefore?: number;
  /** Name an author sees when choosing this style. */
  label?: string;
}>;

export type PageAsset = Readonly<{
  mediaType: "image/svg+xml" | "image/png" | "image/jpeg";
  /** Base64 of the asset bytes. Assets are inlined; a page never fetches. */
  data: string;
  /** Name an author sees when choosing this image. */
  label?: string;
}>;

/** What a document's page settings decide for its pages. */
export type PageSettings = Readonly<{
  layout: string;
  margin: number;
  gap: number;
  blockGap: number;
  /** Key into `PageDesign.colors`. */
  background?: string;
  /** Key into `PageDesign.assets`. */
  backgroundImage?: string;
  /** `aboveCenter` ends the body one block gap above the middle of the page under the header. */
  bodyAlignment: "top" | "center" | "bottom" | "aboveCenter";
}>;

export type PageDesign = Readonly<{
  page: Readonly<{ width: number; height: number }>;
  colors: Readonly<Record<string, string>>;
  textStyles: Readonly<Record<string, PageTextStyle>>;
  assets: Readonly<Record<string, PageAsset>>;
}>;

/** Font bytes are supplied by the host that owns the print engine. */
export type PageFont = Readonly<{
  family: string;
  /** A single weight ("500") or a variable range ("100 1000"). */
  weight: string;
  format: "woff2" | "truetype";
  data: string;
}>;

/**
 * The page settings of every template laid out as pages, keyed by the scope
 * its blocks arrive with; "" is the document itself. The values are the page
 * fields of the document's or template's variant: margin, gap, blockGap,
 * background, backgroundImage and bodyAlignment.
 */
export type PageLayouts = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

export type PagedDocumentInput = Readonly<{
  title: string;
  locale: string;
  blocks: readonly PageBlock[];
  /** Absent: every block lies on default pages. */
  layouts?: PageLayouts;
  design: PageDesign;
  fonts: readonly PageFont[];
}>;

export type PagedSection = Readonly<{
  layout: string;
  /** A complete, self-contained HTML document for one section. */
  html: string;
}>;

export type PagedDocument = Readonly<{
  renderingVersion: "osf-paged-html-v1";
  page: Readonly<{ width: number; height: number }>;
  sections: readonly PagedSection[];
}>;

/**
 * The page a document gets without a theme: A4 at 96 dpi, black on white, in
 * four text styles. A theme replaces all of it; it only ever supplies the
 * look, never whether a document has pages.
 */
export const DEFAULT_PAGE_DESIGN: PageDesign = {
  page: { width: 794, height: 1123 },
  colors: { text: "#16181d", muted: "#5f6b7c" },
  textStyles: {
    title: { fontFamily: "DM Sans", fontSize: 32, lineHeight: 38, fontWeight: 600, color: "text", label: "Titel" },
    heading: { fontFamily: "DM Sans", fontSize: 20, lineHeight: 26, fontWeight: 600, color: "text", label: "Kop" },
    body: { fontFamily: "DM Sans", fontSize: 14, lineHeight: 21, fontWeight: 400, color: "text", label: "Tekst" },
    small: { fontFamily: "DM Sans", fontSize: 11, lineHeight: 15, fontWeight: 400, color: "muted", label: "Klein" },
  },
  assets: {},
};
