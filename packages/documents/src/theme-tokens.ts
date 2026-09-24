// SPDX-License-Identifier: BUSL-1.1
/** Closed document-theme tokens. Renderers map font tokens to files they actually have. */

export const DOCUMENT_FONT_FAMILIES = [
  "source-sans",
  "source-serif",
  "inter",
  "noto-sans",
  "noto-serif",
  "liberation-sans",
  "liberation-serif",
  "georgia",
  "times",
  "arial",
  "system",
] as const;

export type DocumentFontFamily = (typeof DOCUMENT_FONT_FAMILIES)[number];

export const DOCUMENT_COLOR_ROLES = ["surface", "text", "accent"] as const;
export type DocumentColorRole = (typeof DOCUMENT_COLOR_ROLES)[number];

export const DOCUMENT_THEME_COLOR = /^#[0-9A-Fa-f]{6}$/;

export type DocumentTextStyle = Readonly<{
  fontFamily?: DocumentFontFamily;
  fontSize: number;
  lineHeight: number;
  fontWeight: number;
  colorRole: DocumentColorRole;
  spaceBefore?: number;
  spaceAfter?: number;
}>;

export type DocumentTypography = Readonly<{
  body: DocumentTextStyle;
  heading1: DocumentTextStyle;
  heading2: DocumentTextStyle;
  heading3: DocumentTextStyle;
  quote: DocumentTextStyle;
  list: DocumentTextStyle;
}>;

export type ResolvedDocumentTheme = Readonly<{
  id: string;
  key: string;
  name: string;
  isDefault: boolean;
  surfaceColor: string;
  textColor: string;
  accentColor: string;
  fontFamily: DocumentFontFamily;
  typography: DocumentTypography;
  updatedAt: string;
}>;

export type DocumentThemeResolutionKind =
  | "template-version"
  | "template"
  | "document"
  | "tenant-default"
  | "none";

export type DocumentThemeResolution = Readonly<{
  kind: DocumentThemeResolutionKind;
  sourceId: string;
  themeId: string | null;
}>;
