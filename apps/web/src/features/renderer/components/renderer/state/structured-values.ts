// SPDX-License-Identifier: BUSL-1.1
import type { Field } from "@/generated/compiler/field-contract";
import type { RendererFormDefinition } from "@/features/renderer/form-definition";
import {
  collectRendererCollectionFields,
  collectRendererComputedFields,
  collectRendererLeafFields,
} from "@/features/renderer/runtime/definition-utils";
import {
  resolveComputedRendererFieldValue,
  resolveRendererFieldDisplayMode,
} from "@/features/renderer/runtime/field-utils";
import { normalizePhoneSemanticValue } from "@/features/renderer/runtime/phone-normalization";
import { getValueAtPath, setValueAtPath } from "@/features/renderer/runtime/path-utils";

export type BuildStructuredValuesOptions = {
  /**
   * Skip leaf fields marked `readOnly` on the field contract (legacy; prefer
   * `excludeByEffectiveDisplayMode` for submission).
   */
  excludeReadOnly?: boolean;
  /**
   * Skip fields the renderer would not let the user edit (read-only, display,
   * hidden, masked). Uses the same rules as `resolveRendererFieldDisplayMode`.
   * Requires `rootValuesForResolve` (typically full `structuredValues` including
   * `initialData`) for visibility and permission checks.
   */
  excludeByEffectiveDisplayMode?: boolean;
  rootValuesForResolve?: Record<string, unknown>;
  grantedPermissions?: readonly string[];
};

export function initializeCollectionFieldValues(
  definition: RendererFormDefinition,
  initialData?: Record<string, unknown> | null,
) {
  return Object.fromEntries(
    collectRendererCollectionFields(definition.fields, definition.fieldConfig).map((entry) => {
      const value = getValueAtPath(initialData, entry.path);
      return [entry.key, Array.isArray(value) || typeof value === "string" ? value : []];
    }),
  ) as Record<string, unknown>;
}

/**
 * Rehydrates the flat form state back into the authored nested shape right
 * before validation, display-mode reads, and submission.
 */
export function buildStructuredValues(
  definition: RendererFormDefinition,
  flatValues: Record<string, unknown>,
  collectionValues: Record<string, unknown>,
  initialData?: Record<string, unknown> | null,
  options?: BuildStructuredValuesOptions,
) {
  let values: Record<string, unknown> = initialData
    ? ({ ...initialData } as Record<string, unknown>)
    : {};

  function leafExcludedFromSubmission(entry: { field: Field; key: string }) {
    if (options?.excludeByEffectiveDisplayMode && options.rootValuesForResolve) {
      const displayMode = resolveRendererFieldDisplayMode(
        entry.field,
        definition.fieldConfig?.[entry.field.key],
        definition.mode,
        options.rootValuesForResolve,
        options.grantedPermissions,
      );
      return displayMode !== "edit";
    }
    if (options?.excludeReadOnly && entry.field.readOnly) {
      return true;
    }
    return false;
  }

  for (const entry of collectRendererLeafFields(
    definition.fields,
    definition.fieldConfig,
  )) {
    if (entry.field.computed) {
      continue;
    }

    if (leafExcludedFromSubmission(entry)) {
      // Preserve the current value (initialized from initialData) so conditionally
      // hidden fields don't lose their data on submission.
      if (options?.excludeByEffectiveDisplayMode) {
        const currentValue = flatValues[entry.key];
        if (currentValue !== undefined) {
          values = setValueAtPath(
            values,
            entry.path,
            normalizePhoneSemanticValue(entry.field, currentValue),
          ) as Record<string, unknown>;
        }
      }
      continue;
    }

    values = setValueAtPath(
      values,
      entry.path,
      normalizePhoneSemanticValue(entry.field, flatValues[entry.key]),
    ) as Record<string, unknown>;
  }

  for (const entry of collectRendererCollectionFields(
    definition.fields,
    definition.fieldConfig,
  )) {
    if (options?.excludeByEffectiveDisplayMode && options.rootValuesForResolve) {
      const displayMode = resolveRendererFieldDisplayMode(
        entry.field,
        definition.fieldConfig?.[entry.field.key],
        definition.mode,
        options.rootValuesForResolve,
        options.grantedPermissions,
      );
      if (displayMode !== "edit") {
        continue;
      }
    }

    const value = collectionValues[entry.key];
    const structuredValue = Array.isArray(value) || typeof value === "string" ? value : [];
    values = setValueAtPath(values, entry.path, structuredValue) as Record<string, unknown>;
  }

  for (const entry of collectRendererComputedFields(
    definition.fields,
    definition.fieldConfig,
  )) {
    values = setValueAtPath(
      values,
      entry.path,
      resolveComputedRendererFieldValue(entry.field, values),
    ) as Record<string, unknown>;
  }

  return pruneUndefinedStructure(values) as Record<string, unknown>;
}

function pruneUndefinedStructure(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => pruneUndefinedStructure(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .map(([key, childValue]) => [key, pruneUndefinedStructure(childValue)] as const)
    .filter(([, childValue]) => {
      if (childValue === undefined) {
        return false;
      }

      if (
        childValue &&
        typeof childValue === "object" &&
        !Array.isArray(childValue) &&
        Object.keys(childValue as Record<string, unknown>).length === 0
      ) {
        return false;
      }

      return true;
    });

  return Object.fromEntries(entries);
}
