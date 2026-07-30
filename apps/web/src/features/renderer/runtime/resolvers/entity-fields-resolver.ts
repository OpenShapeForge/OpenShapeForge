// SPDX-License-Identifier: BUSL-1.1
/**
 * WEB-020 — entityFields resolver.
 *
 * Thin wrapper over `loadEntityFieldSuggestions(entityType, lang)`. The entity
 * type can come from either:
 *  - `params.sourceField`  — key of a form field whose current value is the
 *                             entity-type string (e.g. "Task")
 *  - `params.entityType`   — a literal entity type string when the form does
 *                             not make it user-selectable.
 *
 * Async: the suggestion data is fetched per entity from the API and cached. The
 * `useFormVariableSuggestions` hook awaits the returned promise (surfacing an
 * empty pool while loading) and guards against stale results.
 */
import { loadEntityFieldSuggestions } from "@/features/renderer/runtime/entity-field-suggestions";
import type {
  ResolverContext,
  VariableSuggestionResolver,
} from "@/features/renderer/runtime/variable-sources";
import type { VariableSuggestion } from "@/features/renderer/runtime/variable-suggestions";

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export const entityFieldsResolver: VariableSuggestionResolver = {
  id: "entityFields",
  getDependencyKey(
    params: Record<string, unknown> | undefined,
    ctx: ResolverContext,
  ): string {
    const sourceField = readString(params?.sourceField);
    const literalEntityType = readString(params?.entityType);
    return JSON.stringify({
      sourceField,
      literalEntityType,
      sourceValue: sourceField ? readString(ctx.formState[sourceField]) ?? null : null,
      lang: ctx.lang,
    });
  },
  resolve(
    params: Record<string, unknown> | undefined,
    ctx: ResolverContext,
  ): Promise<VariableSuggestion[]> {
    if (!params) {
      return Promise.resolve([]);
    }

    const sourceField = readString(params.sourceField);
    const literalEntityType = readString(params.entityType);

    const entityType = sourceField
      ? readString(ctx.formState[sourceField])
      : literalEntityType;

    return entityType ? loadEntityFieldSuggestions(entityType, ctx.lang) : Promise.resolve([]);
  },
};
