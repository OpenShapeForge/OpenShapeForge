// SPDX-License-Identifier: BUSL-1.1
import type { Dispatch, ReactNode, SetStateAction } from "react";

import type { Field as CompilerField } from "../../../../../generated/compiler/field-contract";
import type {
  RendererFieldConfig,
  RendererFieldDisplayMode,
} from "../../../form-definition";
import type { RendererPathPart } from "../../../runtime/path-utils";
import type { VariableSuggestion } from "../../../runtime/variable-suggestions";

export interface FieldRenderContext {
  lang: string;
  surface?:
    | "page"
    | "sheet"
    | "dialog"
    | "inspector"
    | "workspace"
    | "embedded";
  structuredValues: Record<string, unknown>;
  manualErrors: Record<string, string>;
  isSubmitting: boolean;
  fieldsByKey: Map<string, CompilerField>;
  fieldConfigByKey: Map<string, RendererFieldConfig>;
  validationFieldsByKey: Map<string, CompilerField>;
  /**
   * WEB-020 — form-level variable-source lookup, keyed by
   * `FormVariableSource.key`. Populated by `useFormVariableSuggestions` in
   * `Renderer`. Optional so tests and hand-written callers that construct a
   * context directly keep compiling; missing/unknown keys resolve to `[]`
   * inside `getFieldVariableSuggestions`.
   */
  resolvedVariableSources?: Record<string, VariableSuggestion[]>;
  form: {
    visibleFieldErrors: Record<string, string | undefined>;
    blurField: (key: string) => void;
    changeField: (key: string, value: unknown) => void;
  };
  resolveEffectiveFieldMode: (
    field: CompilerField,
    visibilityScope?: Record<string, unknown> | null,
  ) => RendererFieldDisplayMode;
  clearManualErrorsForPrefix: (prefix: string) => void;
  updateCollectionPathValue: (
    collectionPath: readonly RendererPathPart[],
    targetPath: readonly RendererPathPart[],
    field: CompilerField,
    rawValue: unknown,
  ) => void;
  optionalSectionOverrides: Record<string, boolean | undefined>;
  setOptionalSectionOverride: (
    pathKey: string,
    enabled: boolean | undefined,
  ) => void;
  setManualErrors: Dispatch<SetStateAction<Record<string, string>>>;
  setCollectionValues: Dispatch<SetStateAction<Record<string, unknown>>>;
  renderCustomField?: (
    props: RendererCustomFieldRenderProps,
  ) => ReactNode | null | undefined;
  /**
   * Default direction for every Field rendered through this Renderer.
   * Per-field `RendererFieldConfig.direction` overrides this. Set by the
   * workflow inspector to `"horizontal"`; entity forms leave it unset and
   * fall back to the Field component's default of `"vertical"`.
   */
  fieldDirection?: "horizontal" | "vertical";
}

export interface RendererCustomFieldRenderProps {
  ctx: FieldRenderContext;
  field: CompilerField;
  path: readonly RendererPathPart[];
  collectionRootPath?: readonly RendererPathPart[];
  columns: 1 | 2 | 3 | 4;
  component: string;
  value: unknown;
  label: string;
  description?: string;
  helpText?: string;
  error?: string;
  required: boolean;
  effectiveMode: RendererFieldDisplayMode;
  onChange: (nextValue: unknown) => void;
  onBlur: () => void;
}
