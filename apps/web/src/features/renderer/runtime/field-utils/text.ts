// SPDX-License-Identifier: BUSL-1.1
import type { LocalizedText } from "@/generated/compiler/field-contract";

export function translateRendererText(
  text:
    | string
    | LocalizedText
    | Record<string, string>
    | null
    | undefined,
  lang: string,
) {
  if (!text) return "";
  if (typeof text === "string") return text;
  const localized = text as Record<string, string | undefined>;
  return localized[lang] ?? localized.en ?? Object.values(localized)[0] ?? "";
}
