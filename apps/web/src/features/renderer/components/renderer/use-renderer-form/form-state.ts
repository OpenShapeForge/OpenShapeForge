// SPDX-License-Identifier: BUSL-1.1
import type { RendererFieldEntry } from "@/features/renderer/runtime/definition-utils";
import { getValueAtPath } from "@/features/renderer/runtime/path-utils";
import { normalizePhoneSemanticValue } from "@/features/renderer/runtime/phone-normalization";
import type { RendererFormSubmissionResult } from "@/features/renderer/components/renderer/state";
import type { RendererFieldState, RendererFormUiState } from "./types";

export function createRendererFormUiState(
  leafFieldEntries: readonly RendererFieldEntry[],
  initialData?: Record<string, unknown> | null,
): RendererFormUiState {
  return {
    fields: Object.fromEntries(
      leafFieldEntries.map((entry) => {
        const initialValue = getValueAtPath(initialData, entry.path);
        return [
          entry.key,
          {
            value: normalizePhoneSemanticValue(
              entry.field,
              initialValue === undefined ? entry.field.defaultValue : initialValue,
            ),
            touched: false,
            error: undefined,
          } satisfies RendererFieldState,
        ];
      }),
    ) as Record<string, RendererFieldState>,
    formError: undefined,
    submitAttempted: false,
  };
}

export function getRendererFlatValues(
  fields: Record<string, RendererFieldState>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([fieldKey, fieldState]) => [fieldKey, fieldState.value]),
  );
}

export function getVisibleFieldErrors(
  formState: RendererFormUiState,
  externalFieldErrors?: Record<string, string | undefined>,
) {
  const nativeErrors = Object.fromEntries(
    Object.entries(formState.fields).map(([fieldKey, fieldState]) => [
      fieldKey,
      formState.submitAttempted || fieldState.touched ? fieldState.error : undefined,
    ]),
  ) as Record<string, string | undefined>;

  if (!externalFieldErrors) {
    return nativeErrors;
  }

  return Object.fromEntries(
    Object.entries({
      ...nativeErrors,
      ...externalFieldErrors,
    }).map(([fieldKey, message]) => [
      fieldKey,
      message ?? nativeErrors[fieldKey],
    ]),
  ) as Record<string, string | undefined>;
}

export function applyLeafErrorsToSubmitState(
  currentState: RendererFormUiState,
  nextLeafErrors: Record<string, string | undefined>,
): RendererFormUiState {
  return {
    ...currentState,
    formError: undefined,
    submitAttempted: true,
    fields: Object.fromEntries(
      Object.entries(currentState.fields).map(([fieldKey, fieldState]) => [
        fieldKey,
        {
          ...fieldState,
          error: nextLeafErrors[fieldKey],
        } satisfies RendererFieldState,
      ]),
    ) as Record<string, RendererFieldState>,
  };
}

export function applySubmissionResultToState(
  currentState: RendererFormUiState,
  result: RendererFormSubmissionResult,
): RendererFormUiState {
  return {
    ...currentState,
    submitAttempted: true,
    formError: result.formError,
    fields: Object.fromEntries(
      Object.entries(currentState.fields).map(([fieldKey, fieldState]) => [
        fieldKey,
        {
          ...fieldState,
          error: result.fieldErrors?.[fieldKey],
        } satisfies RendererFieldState,
      ]),
    ) as Record<string, RendererFieldState>,
  };
}
