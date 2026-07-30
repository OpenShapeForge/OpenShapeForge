// SPDX-License-Identifier: BUSL-1.1
import type { Field } from "@/generated/compiler/field-contract";
import { buildStructuredValues } from "@/features/renderer/components/renderer/state";
import type {
  RendererFieldConfig,
  RendererFieldDisplayMode,
  RendererFormDefinition,
} from "@/features/renderer/form-definition";
import type { RendererFieldEntry } from "@/features/renderer/runtime/definition-utils";
import {
  getRendererFieldPath,
  resolveRendererFieldDisplayMode,
  resolveRendererVisibilityScope,
  validateRendererFieldValue,
} from "@/features/renderer/runtime/field-utils";
import {
  getValueAtPath,
  stringifyRendererPath,
  type RendererPathPart,
} from "@/features/renderer/runtime/path-utils";
import { isFieldCollection, isFieldObject } from "@/lib/field-contract/field-v2";
import { unwrapLocalizedValue } from "./localized-value";

type FieldModeResolverInput = {
  field: Field;
  fieldConfigByKey: ReadonlyMap<string, RendererFieldConfig>;
  definitionMode: RendererFormDefinition["mode"];
  structuredValues: Record<string, unknown>;
  grantedPermissions?: readonly string[];
  visibilityScope?: Record<string, unknown> | null;
};

export function resolveEffectiveRendererFieldMode({
  field,
  fieldConfigByKey,
  definitionMode,
  structuredValues,
  grantedPermissions,
  visibilityScope,
}: FieldModeResolverInput): RendererFieldDisplayMode {
  return resolveRendererFieldDisplayMode(
    field,
    fieldConfigByKey.get(field.key),
    definitionMode,
    structuredValues,
    grantedPermissions,
    visibilityScope,
  );
}

type BuildLeafFieldErrorsInput = {
  definition: RendererFormDefinition;
  fieldConfigByKey: ReadonlyMap<string, RendererFieldConfig>;
  leafFieldEntries: readonly RendererFieldEntry[];
  nextFlatValues: Record<string, unknown>;
  nextCollectionValues: Record<string, unknown>;
  initialData?: Record<string, unknown> | null;
  grantedPermissions?: readonly string[];
  lang: string;
};

export function buildLeafFieldErrors({
  definition,
  fieldConfigByKey,
  leafFieldEntries,
  nextFlatValues,
  nextCollectionValues,
  initialData,
  grantedPermissions,
  lang,
}: BuildLeafFieldErrorsInput) {
  const nextStructuredValues = buildStructuredValues(
    definition,
    nextFlatValues,
    nextCollectionValues,
    initialData,
  );
  const nextErrors: Record<string, string | undefined> = {};

  for (const entry of leafFieldEntries) {
    const leafScope = resolveRendererVisibilityScope(
      nextStructuredValues,
      entry.path,
      undefined,
    );
    const fieldMode = resolveEffectiveRendererFieldMode({
      field: entry.field,
      fieldConfigByKey,
      definitionMode: definition.mode,
      structuredValues: nextStructuredValues,
      grantedPermissions,
      visibilityScope: leafScope,
    });

    if (fieldMode !== "edit" || entry.field.computed) {
      nextErrors[entry.key] = undefined;
      continue;
    }

    const value = getValueAtPath(nextStructuredValues, entry.path);
    nextErrors[entry.key] = validateRendererFieldValue(
      entry.field,
      unwrapLocalizedValue(entry.field, value, lang),
      nextStructuredValues,
      lang,
    );
  }

  return nextErrors;
}

type ValidateFieldTreeInput = {
  fields: readonly Field[];
  fieldConfigByKey: ReadonlyMap<string, RendererFieldConfig>;
  definitionMode: RendererFormDefinition["mode"];
  structuredValues: Record<string, unknown>;
  grantedPermissions?: readonly string[];
  lang: string;
  parentPath?: readonly RendererPathPart[];
  visibilityScope?: Record<string, unknown> | null;
};

export function validateRendererFieldTree({
  fields,
  fieldConfigByKey,
  definitionMode,
  structuredValues,
  grantedPermissions,
  lang,
  parentPath = [],
  visibilityScope,
}: ValidateFieldTreeInput): Record<string, string> {
  const nextErrors: Record<string, string> = {};

  for (const field of fields) {
    const path = getRendererFieldPath(
      field,
      parentPath,
      fieldConfigByKey.get(field.key),
    );
    const pathKey = stringifyRendererPath(path);
    const fieldMode = resolveEffectiveRendererFieldMode({
      field,
      fieldConfigByKey,
      definitionMode,
      structuredValues,
      grantedPermissions,
      visibilityScope,
    });

    if (fieldMode === "hidden" || fieldMode !== "edit") {
      continue;
    }

    if (isFieldObject(field) && field.children?.length) {
      const objectScopeRaw = getValueAtPath(structuredValues, path);
      const objectScope =
        objectScopeRaw &&
        typeof objectScopeRaw === "object" &&
        !Array.isArray(objectScopeRaw)
          ? (objectScopeRaw as Record<string, unknown>)
          : visibilityScope;
      Object.assign(
        nextErrors,
        validateRendererFieldTree({
          fields: field.children,
          fieldConfigByKey,
          definitionMode,
          structuredValues,
          grantedPermissions,
          lang,
          parentPath: path,
          visibilityScope: objectScope ?? null,
        }),
      );
      continue;
    }

    const value = getValueAtPath(structuredValues, path);

    if (isFieldCollection(field)) {
      const message = validateRendererFieldValue(field, value, structuredValues, lang);
      if (message) {
        nextErrors[pathKey] = message;
      }

      const itemField = field.item;
      if (Array.isArray(value) && itemField) {
        value.forEach((itemValue, index) => {
          const itemPath = [...path, index];
          validateCollectionItem({
            errors: nextErrors,
            field: itemField,
            itemValue,
            itemPath,
            fieldConfigByKey,
            definitionMode,
            structuredValues,
            grantedPermissions,
            lang,
          });
        });
      }

      continue;
    }

    if (field.computed) {
      continue;
    }

    const message = validateRendererFieldValue(
      field,
      unwrapLocalizedValue(field, value, lang),
      structuredValues,
      lang,
    );
    if (message) {
      nextErrors[pathKey] = message;
    }
  }

  return nextErrors;
}

type ValidateCollectionItemInput = {
  errors: Record<string, string>;
  field: Field;
  itemValue: unknown;
  itemPath: readonly RendererPathPart[];
  fieldConfigByKey: ReadonlyMap<string, RendererFieldConfig>;
  definitionMode: RendererFormDefinition["mode"];
  structuredValues: Record<string, unknown>;
  grantedPermissions?: readonly string[];
  lang: string;
};

function validateCollectionItem({
  errors,
  field,
  itemValue,
  itemPath,
  fieldConfigByKey,
  definitionMode,
  structuredValues,
  grantedPermissions,
  lang,
}: ValidateCollectionItemInput) {
  if (isFieldObject(field) && field.children?.length) {
    const rowScope =
      itemValue &&
      typeof itemValue === "object" &&
      !Array.isArray(itemValue)
        ? (itemValue as Record<string, unknown>)
        : null;
    Object.assign(
      errors,
      validateRendererFieldTree({
        fields: field.children,
        fieldConfigByKey,
        definitionMode,
        structuredValues,
        grantedPermissions,
        lang,
        parentPath: itemPath,
        visibilityScope: rowScope,
      }),
    );
    return;
  }

  const itemMessage = validateRendererFieldValue(
    field,
    itemValue,
    structuredValues,
    lang,
  );

  if (itemMessage) {
    errors[stringifyRendererPath(itemPath)] = itemMessage;
  }
}
