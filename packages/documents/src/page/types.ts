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
}>;

export type PageAsset = Readonly<{
  mediaType: "image/svg+xml" | "image/png" | "image/jpeg";
  /** Base64 of the asset bytes. Assets are inlined; a page never fetches. */
  data: string;
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

export type PagedDocumentInput = Readonly<{
  title: string;
  locale: string;
  blocks: readonly PageBlock[];
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
