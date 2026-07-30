// SPDX-License-Identifier: BUSL-1.1
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { Field } from "@/generated/compiler/field-contract";
import {
  buildStructuredValues,
  coerceRendererValue,
  buildSuccessRoute,
  getRendererSubmissionResultFromError,
  initializeCollectionFieldValues,
  isSubmissionResult,
  type RendererFormSubmissionResult,
} from "@/features/renderer/components/renderer/state";
import type {
  RendererFieldConfig,
  RendererFieldDisplayMode,
} from "@/features/renderer/form-definition";
import { collectRendererLeafFields } from "@/features/renderer/runtime/definition-utils";
import type { RendererPathPart } from "@/features/renderer/runtime/path-utils";
import { buildNextCollectionPathValues } from "./collection-values";
import {
  applyLeafErrorsToSubmitState,
  applySubmissionResultToState,
  createRendererFormUiState,
  getRendererFlatValues,
  getVisibleFieldErrors,
} from "./form-state";
import type { UseRendererFormOptions } from "./types";
import {
  buildLeafFieldErrors,
  resolveEffectiveRendererFieldMode,
  validateRendererFieldTree,
} from "./validation";

export function useRendererForm({
  definition,
  lang,
  initialData,
  action,
  id,
  grantedPermissions,
  validationMode = "submit",
  externalFieldErrors,
  onSubmit,
}: UseRendererFormOptions) {
  const router = useRouter();

  const fieldsByKey = useMemo(() => {
    const entries = definition.fields.map((field) => [field.key, field] as const);
    return new Map(entries);
  }, [definition.fields]);
  const fieldConfigByKey = useMemo(() => {
    const entries = Object.entries(definition.fieldConfig ?? {});
    return new Map(entries as [string, RendererFieldConfig][]);
  }, [definition.fieldConfig]);
  const leafFieldEntries = useMemo(
    () => collectRendererLeafFields(definition.fields, definition.fieldConfig),
    [definition.fieldConfig, definition.fields],
  );
  const validationFieldsByKey = useMemo(
    () => new Map(leafFieldEntries.map((entry) => [entry.key, entry.field] as const)),
    [leafFieldEntries],
  );
  const leafFieldEntriesByKey = useMemo(
    () => new Map(leafFieldEntries.map((entry) => [entry.key, entry] as const)),
    [leafFieldEntries],
  );
  const [formState, setFormState] = useState(() =>
    createRendererFormUiState(leafFieldEntries, initialData),
  );
  const [collectionValues, setCollectionValues] = useState<Record<string, unknown>>(() =>
    initializeCollectionFieldValues(definition, initialData),
  );
  const [manualErrors, setManualErrors] = useState<Record<string, string>>({});
  const [optionalSectionOverrides, setOptionalSectionOverrides] = useState<
    Record<string, boolean | undefined>
  >({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const initialDataSnapshot = useMemo(
    () => JSON.stringify(initialData ?? null),
    [initialData],
  );
  const definitionShapeSnapshot = useMemo(
    () => JSON.stringify(leafFieldEntries.map((entry) => entry.key)),
    [leafFieldEntries],
  );
  const previousInitialDataSnapshot = useRef(initialDataSnapshot);
  const previousDefinitionShapeSnapshot = useRef(definitionShapeSnapshot);
  const flatValues = useMemo(
    () => getRendererFlatValues(formState.fields),
    [formState.fields],
  );
  const visibleFieldErrors = useMemo(
    () => getVisibleFieldErrors(formState, externalFieldErrors),
    [externalFieldErrors, formState],
  );

  const structuredValues = useMemo(
    () => buildStructuredValues(definition, flatValues, collectionValues, initialData),
    [collectionValues, definition, flatValues, initialData],
  );
  const submissionValues = useMemo(
    () =>
      buildStructuredValues(definition, flatValues, collectionValues, null, {
        excludeByEffectiveDisplayMode: true,
        rootValuesForResolve: structuredValues,
        grantedPermissions,
      }),
    [collectionValues, definition, flatValues, grantedPermissions, structuredValues],
  );

  function clearManualErrorsForPrefix(prefix: string) {
    setManualErrors((previous) => Object.fromEntries(
      Object.entries(previous).filter(([key]) => !(key === prefix || key.startsWith(`${prefix}.`))),
    ));
  }

  function getLeafFieldErrors(
    nextFlatValues: Record<string, unknown>,
    nextCollectionValues: Record<string, unknown>,
  ) {
    return buildLeafFieldErrors({
      definition,
      fieldConfigByKey,
      leafFieldEntries,
      nextFlatValues,
      nextCollectionValues,
      initialData,
      grantedPermissions,
      lang,
    });
  }

  function resolveEffectiveFieldMode(
    field: Field,
    visibilityScope?: Record<string, unknown> | null,
  ): RendererFieldDisplayMode {
    return resolveEffectiveRendererFieldMode({
      field,
      fieldConfigByKey,
      definitionMode: definition.mode,
      structuredValues,
      grantedPermissions,
      visibilityScope,
    });
  }

  function changeField(fieldKey: string, rawValue: unknown) {
    const entry = leafFieldEntriesByKey.get(fieldKey);
    if (!entry) {
      return;
    }

    setFormState((currentState) => {
      const currentField = currentState.fields[fieldKey];
      const nextValue = coerceRendererValue(entry.field, rawValue);
      const nextFlatValues = {
        ...getRendererFlatValues(currentState.fields),
        [fieldKey]: nextValue,
      };
      const shouldValidate = currentState.submitAttempted || Boolean(currentField?.error);
      const nextLeafErrors = shouldValidate
        ? getLeafFieldErrors(nextFlatValues, collectionValues)
        : {};

      return {
        ...currentState,
        formError: undefined,
        fields: {
          ...currentState.fields,
          [fieldKey]: {
            value: nextValue,
            touched: currentField?.touched ?? false,
            error: shouldValidate ? nextLeafErrors[fieldKey] : undefined,
          },
        },
      };
    });
  }

  function blurField(fieldKey: string) {
    const entry = leafFieldEntriesByKey.get(fieldKey);
    if (!entry) {
      return;
    }

    setFormState((currentState) => {
      const currentField = currentState.fields[fieldKey];
      const nextFlatValues = getRendererFlatValues(currentState.fields);
      const nextLeafErrors = getLeafFieldErrors(nextFlatValues, collectionValues);

      return {
        ...currentState,
        fields: {
          ...currentState.fields,
          [fieldKey]: {
            value: currentField?.value,
            touched: true,
            error: nextLeafErrors[fieldKey],
          },
        },
      };
    });
  }

  function validateForSubmit() {
    const nextLeafErrors = getLeafFieldErrors(flatValues, collectionValues);
    const hasErrors = Object.values(nextLeafErrors).some(Boolean);

    setFormState((currentState) =>
      applyLeafErrorsToSubmitState(currentState, nextLeafErrors),
    );

    return !hasErrors;
  }

  function applySubmissionResult(result: RendererFormSubmissionResult) {
    setFormState((currentState) => applySubmissionResultToState(currentState, result));
  }

  function applyUnexpectedError(error: unknown) {
    applySubmissionResult(
      getRendererSubmissionResultFromError(
        error,
        leafFieldEntries.map((entry) => entry.key),
        lang,
      ),
    );
  }

  function reset(initialValues?: Record<string, unknown> | null) {
    setFormState(createRendererFormUiState(leafFieldEntries, initialValues));
  }

  function validateFieldTree(
    fields: readonly Field[],
    parentPath: readonly RendererPathPart[] = [],
    visibilityScope?: Record<string, unknown> | null,
  ): Record<string, string> {
    return validateRendererFieldTree({
      fields,
      fieldConfigByKey,
      definitionMode: definition.mode,
      structuredValues,
      grantedPermissions,
      lang,
      parentPath,
      visibilityScope,
    });
  }

  useEffect(() => {
    if (validationMode !== "eager") {
      return;
    }

    setManualErrors(validateFieldTree(definition.fields));
  }, [definition.fields, structuredValues, validationMode]);

  useEffect(() => {
    const definitionChanged =
      previousDefinitionShapeSnapshot.current !== definitionShapeSnapshot;
    const initialDataChanged =
      previousInitialDataSnapshot.current !== initialDataSnapshot;

    if (!definitionChanged && !initialDataChanged) {
      return;
    }

    previousDefinitionShapeSnapshot.current = definitionShapeSnapshot;
    previousInitialDataSnapshot.current = initialDataSnapshot;
    reset(initialData);
    setCollectionValues(initializeCollectionFieldValues(definition, initialData));
    setManualErrors({});
  }, [definition, definitionShapeSnapshot, initialData, initialDataSnapshot, leafFieldEntries]);

  useEffect(() => {
    setOptionalSectionOverrides({});
  }, [definition, initialData]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    validateForSubmit();

    const nextErrors = validateFieldTree(definition.fields);
    setManualErrors(nextErrors);

    if (Object.keys(nextErrors).length > 0) {
      return;
    }

    if (!onSubmit && !action) {
      return;
    }

    setIsSubmitting(true);

    try {
      if (onSubmit) {
        const result = await onSubmit(submissionValues);
        if (result) {
          applySubmissionResult(result);
        }
        return;
      }

      if (!action) {
        return;
      }

      const payload = id ? { id, ...submissionValues } : submissionValues;
      const result = await action(payload);

      if (isSubmissionResult(result)) {
        applySubmissionResult(result);
        return;
      }

      const nextId = result?.id ?? id;
      const successRoute = definition.submission?.successRoute ?? definition.successRoute;
      const successBehavior =
        definition.submission?.successBehavior ??
        (successRoute ? "redirect" : "refresh");

      if (successBehavior === "redirect" && successRoute && nextId) {
        router.push(buildSuccessRoute(successRoute, String(nextId)));
        return;
      }

      router.refresh();
    } catch (error) {
      applyUnexpectedError(error);
    } finally {
      setIsSubmitting(false);
    }
  }

  function updateCollectionPathValue(
    collectionPath: readonly RendererPathPart[],
    targetPath: readonly RendererPathPart[],
    field: Field,
    rawValue: unknown,
  ) {
    const { collectionKey, nextCollection, targetPathKey } = buildNextCollectionPathValues(
      collectionValues,
      collectionPath,
      targetPath,
      field,
      rawValue,
    );

    setCollectionValues((previous) => ({
      ...previous,
      [collectionKey]: nextCollection,
    }));
    clearManualErrorsForPrefix(targetPathKey);
  }

  return {
    fieldsByKey,
    fieldConfigByKey,
    validationFieldsByKey,
    form: {
      values: flatValues,
      formError: formState.formError,
      submitAttempted: formState.submitAttempted,
      fieldStates: formState.fields,
      visibleFieldErrors,
      changeField,
      blurField,
      validateForSubmit,
      applySubmissionResult,
      applyUnexpectedError,
      reset,
    },
    collectionValues,
    setCollectionValues,
    manualErrors,
    setManualErrors,
    optionalSectionOverrides,
    setOptionalSectionOverride: (pathKey: string, enabled: boolean | undefined) =>
      setOptionalSectionOverrides((previous) => ({
        ...previous,
        [pathKey]: enabled,
      })),
    isSubmitting,
    structuredValues,
    clearManualErrorsForPrefix,
    validateFieldTree,
    handleSubmit,
    updateCollectionPathValue,
    resolveEffectiveFieldMode,
  };
}
