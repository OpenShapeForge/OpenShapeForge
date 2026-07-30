// SPDX-License-Identifier: BUSL-1.1
/**
 * Display value formatting and masking helpers for read-only field rendering.
 *
 * Converts raw field values into human-readable strings based on the field's
 * resolved display component (e.g. DatePicker, BsnDisplay, ReferenceSelect).
 * Handles locale-aware number/date formatting, boolean labels, reference
 * option label lookup, and BSN formatting.
 *
 * Also provides `maskRendererDisplayValue` for partially or fully masking
 * sensitive values (e.g. BSN, email) according to a field's masking config.
 *
 * @input  Canonical Field, optional renderer field config, raw value, language
 * @output Formatted display string or masked string
 */
import type { Field } from "@/generated/compiler/field-contract";
import { resolveFieldDisplayRender } from "@/lib/field-rendering/compiler-field-rendering";
import { formatBsn } from "@/features/renderer/display/bsn-display";
import type { RendererFieldConfig } from "@/features/renderer/form-definition";
import { translateRendererText } from "@/features/renderer/runtime/field-utils";
import { resolveRendererReferenceItems } from "@/features/renderer/runtime/options-utils";

function humanizeReferenceValue(value: string): string {
  const normalized = value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  if (normalized.length === 0) {
    return value;
  }

  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

export function formatRendererDisplayValue(
  field: Field | undefined,
  value: unknown,
  lang: string,
): string {
  const component = field
    ? resolveFieldDisplayRender({ ...field, readOnly: true }).component
    : "TextDisplay";

  if (value == null || value === "") return "-";

  if (component === "ReferenceSelect" && typeof value === "string") {
    const items = field ? resolveRendererReferenceItems(field) : [];
    const option = items.find((item) => item.value === value);
    if (option) {
      return translateRendererText(option.label, lang) || option.value;
    }

    return humanizeReferenceValue(value);
  }

  if (component === "BsnDisplay" && typeof value === "string") {
    return formatBsn(value);
  }

  if (component === "DatePicker" && typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date.toLocaleDateString(lang === "nl" ? "nl-NL" : "en-US");
    }
  }

  if (component === "DateTimePicker" && typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date.toLocaleString(lang === "nl" ? "nl-NL" : "en-US");
    }
  }

  if (typeof value === "number") {
    return new Intl.NumberFormat(lang === "nl" ? "nl-NL" : "en-US").format(value);
  }

  if (typeof value === "boolean") {
    return lang === "nl" ? (value ? "Ja" : "Nee") : (value ? "Yes" : "No");
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => formatRendererDisplayValue(undefined, item, lang))
      .join(", ");
  }

  if (value instanceof Date) {
    return value.toLocaleString(lang === "nl" ? "nl-NL" : "en-US");
  }

  return String(value);
}

export function maskRendererDisplayValue(
  value: string,
  options: RendererFieldConfig["masking"],
): string {
  if (!options || options.strategy === "full") {
    return options?.replacement ?? "••••••";
  }

  const preserveStart = options.preserveStart ?? 0;
  const preserveEnd = options.preserveEnd ?? 4;
  const replacement = options.replacement ?? "•";
  const visibleLength = preserveStart + preserveEnd;

  if (value.length <= visibleLength) {
    return replacement.repeat(Math.max(value.length, 4));
  }

  return `${value.slice(0, preserveStart)}${replacement.repeat(value.length - visibleLength)}${value.slice(value.length - preserveEnd)}`;
}
