// SPDX-License-Identifier: BUSL-1.1
/**
 * WEB-020 — templateParameters resolver.
 *
 * Async. Reads a `templateId` out of the current form state, calls the generated
 * `getTemplate(id)` server action, extracts `parameters: Field[]`, and maps them
 * to `VariableSuggestion[]` so the renderer's variable picker can show template
 * placeholder keys like `{{actualMinutes}}`.
 *
 * Risk-register mitigation #1: if `templateId` is missing or looks like a
 * runtime expression token (`{{...}}`), the resolver returns `[]` with a dev
 * warning rather than issuing a GraphQL request that cannot succeed.
 *
 * Design doc section 3.1 (templateParameters signature) and risk register.
 */
import { getTemplate } from "@/features/renderer/runtime/resolvers/get-template";
import { fetchChipVariableSuggestions } from "@/features/renderer/runtime/chip-variable-suggestions";
import type { Field } from "@/generated/compiler/field-contract";
import type {
  ResolverContext,
  VariableSuggestionResolver,
} from "@/features/renderer/runtime/variable-sources";
import type { VariableSuggestion } from "@/features/renderer/runtime/variable-suggestions";
import { fieldRuntimeKind, isFieldCollection, isFieldObject } from "@/lib/field-contract/field-v2";

type NormalizedLang = "en" | "nl";

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function resolveLabel(
  label: { en?: string; nl?: string } | undefined,
  fallbackKey: string,
  lang: NormalizedLang,
): string {
  if (lang === "en") {
    return label?.en ?? label?.nl ?? fallbackKey;
  }
  return label?.nl ?? label?.en ?? fallbackKey;
}

function fieldValueType(field: Field): VariableSuggestion["valueType"] {
  if (isFieldCollection(field)) return "array";
  switch (field.valueType) {
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return "object";
    default:
      return "string";
  }
}

/**
 * Flatten a list of template parameter fields into VariableSuggestion rows.
 * The mapping mirrors `flattenFieldsToSuggestions` in entity-field-suggestions.ts
 * — same shape, different sourceNodeId ("template") and different label path
 * prefix semantics. Templates don't have aggregate hints or reference-data
 * options the way entity fields do, so the mapping is simpler.
 */
function flattenTemplateFields(
  fields: readonly Field[],
  templateLabel: string,
  lang: NormalizedLang,
  prefix = "",
  labelPrefix = "",
): VariableSuggestion[] {
  const out: VariableSuggestion[] = [];

  for (const field of fields) {
    const path = prefix ? `${prefix}.${field.key}` : field.key;
    const label = resolveLabel(field.label, field.key, lang);
    const displayLabel = labelPrefix ? `${labelPrefix} > ${label}` : label;

    out.push({
      path,
      displayPath: path,
      fieldPath: path,
      insertText: `{{${path}}}`,
      label,
      displayLabel: displayLabel !== label ? displayLabel : undefined,
      sourceNodeId: "template",
      sourceNodeLabel: templateLabel,
      fieldType: fieldRuntimeKind(field),
      valueType: fieldValueType(field),
      semanticType:
        typeof field.semanticType === "string" && field.semanticType.trim().length > 0
          ? field.semanticType.trim()
          : undefined,
    });

    // Recurse for nested object fields the same way entity-field-suggestions does.
    if (isFieldObject(field) && field.children?.length) {
      out.push(
        ...flattenTemplateFields(field.children, templateLabel, lang, path, displayLabel),
      );
    }
  }

  return out;
}

function looksLikeRuntimeExpression(value: string): boolean {
  return value.trimStart().startsWith("{{");
}

export const templateParametersResolver: VariableSuggestionResolver = {
  id: "templateParameters",
  getDependencyKey(
    params: Record<string, unknown> | undefined,
    ctx: ResolverContext,
  ): string {
    const templateIdField = readString(params?.templateIdField);
    return JSON.stringify({
      templateIdField,
      templateId: templateIdField ? readString(ctx.formState[templateIdField]) ?? null : null,
      lang: ctx.lang,
    });
  },
  async resolve(
    params: Record<string, unknown> | undefined,
    ctx: ResolverContext,
  ): Promise<VariableSuggestion[]> {
    const templateIdField = readString(params?.templateIdField);
    if (!templateIdField) {
      return [];
    }

    const templateIdRaw = ctx.formState[templateIdField];
    const templateId = readString(templateIdRaw);

    if (!templateId) {
      return [];
    }

    // Risk #1: the TemplateVariant form exposes `templateId` through
    // OptionVariablePicker, which can emit runtime expression tokens like
    // `{{nodes.x.output.templateId}}`. Those never resolve to a real row.
    if (looksLikeRuntimeExpression(templateId)) {
      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.warn(
          `[templateParametersResolver] templateId looks like a runtime expression (${templateId}); returning no suggestions. Select a literal template to see parameters.`,
        );
      }
      return [];
    }

    const template = await getTemplate(templateId);
    if (!template) {
      return [];
    }

    const rawParameters = (template as { parameters?: unknown }).parameters;
    if (!Array.isArray(rawParameters)) {
      return [];
    }

    const parameters = rawParameters as Field[];
    const templateName = readString((template as { name?: unknown }).name) ?? templateId;
    const normalizedLang: NormalizedLang = ctx.lang === "en" ? "en" : "nl";

    const templateSuggestions = flattenTemplateFields(parameters, templateName, normalizedLang);
    const chipSuggestions = await fetchChipVariableSuggestions().catch(() => []);
    return [...templateSuggestions, ...chipSuggestions];
  },
};
