// SPDX-License-Identifier: BUSL-1.1
import type {
  Field,
  FieldOptions,
  FieldRender,
} from "@/generated/compiler/field-contract";
import {
  formatRendererDisplayValue,
} from "@/features/renderer/runtime/display-utils";
import { translateRendererText } from "@/features/renderer/runtime/field-utils";

export type LocalizedText = Record<string, string> | undefined;

type StaticOption = {
  value: string;
  label?: LocalizedText;
};

export type EntityFieldConfig = {
  key: string;
  label?: LocalizedText;
  description?: LocalizedText;
  required?: boolean;
  readOnly?: boolean;
  semanticType?: string;
  options?: Partial<FieldOptions> & {
    items?: StaticOption[];
    /** When `items` is empty, labels/options are resolved from the VERA snapshot (same Soort as CSV). */
    referentieGroep?: string;
  };
  render?: Partial<FieldRender> & {
    component?: string;
    props?: Record<string, unknown>;
  };
};

export function translateEntityText(
  text: LocalizedText | string | null,
  lang: string,
): string {
  return translateRendererText(text, lang);
}

export function getNestedEntityValue(
  source: Record<string, unknown> | undefined,
  key: string,
): unknown {
  if (!source) return undefined;
  return key.split(".").reduce<unknown>((value, part) => {
    if (value && typeof value === "object" && part in (value as Record<string, unknown>)) {
      return (value as Record<string, unknown>)[part];
    }
    return undefined;
  }, source);
}

export function formatEntityDisplayValue(
  field: EntityFieldConfig | undefined,
  value: unknown,
  lang: string,
): string {
  return formatRendererDisplayValue(toRendererField(field), value, lang);
}

function toRendererField(field: EntityFieldConfig | undefined): Field | undefined {
  if (!field) {
    return undefined;
  }

  return {
    key: field.key,
    valueType: "string",
    label: field.label,
    description: field.description,
    required: field.required,
    readOnly: field.readOnly,
    semanticType: field.semanticType,
    options: field.options as Field["options"],
    render: field.render as Field["render"],
  };
}
