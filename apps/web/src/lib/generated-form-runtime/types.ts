// SPDX-License-Identifier: BUSL-1.1
export type LocalizedText = Record<string, string> | undefined;

type ValidationPrimitive = boolean | number | string;

export type ValidationRuleValue =
  | ValidationPrimitive
  | {
      value: ValidationPrimitive;
      message?: LocalizedText;
    };

export type GeneratedCustomValidationRule = {
  name: string;
  message?: LocalizedText;
  params?: Record<string, unknown>;
};

export type GeneratedFieldOptions = {
  type?: string;
  items?: Array<{
    value: string;
    label?: LocalizedText;
  }>;
  referentieGroep?: string;
  [key: string]: unknown;
};

export type GeneratedFormFieldValidation = {
  required?: ValidationRuleValue;
  minLength?: ValidationRuleValue;
  maxLength?: ValidationRuleValue;
  minItems?: ValidationRuleValue;
  min?: ValidationRuleValue;
  max?: ValidationRuleValue;
  pattern?: ValidationRuleValue;
  format?: string;
  custom?: GeneratedCustomValidationRule[];
};

export type GeneratedFieldSuggestionsFilter = {
  valueType?: "string" | "number" | "boolean" | "object" | "array";
  fieldType?: "string" | "integer" | "number" | "boolean" | "date" | "datetime" | "object" | "uuid" | "array" | "fieldArray";
  semanticType?: string;
  itemSemanticType?: string;
  fieldDefinitionSource?: boolean;
  anyOf?: GeneratedFieldSuggestionsFilter[];
};

/**
 * WEB-020 — Mirror of the compiler's `GeneratedFieldSuggestions` shape. Kept
 * in sync with `packages/compiler/src/authoring/generators/pages.ts`.
 */
export type GeneratedFieldSuggestions = {
  /** Legacy: sibling field whose value names the entity type. */
  sourceField?: string;
  /** WEB-020: opt-in key of a form-level `variableSources` entry. */
  sourceKey?: string;
  /** Compatibility filter applied to the selected variable-source pool. */
  filter?: GeneratedFieldSuggestionsFilter;
};

/**
 * WEB-020 — Mirror of the compiler's `FormVariableSource` shape so the
 * generated JSON flows into `RendererFormDefinition.variableSources` with no
 * additional coercion.
 */
export type GeneratedFormVariableSource = {
  key: string;
  resolver: "chips" | "entityFields" | "templateParameters" | "workflowGraphVariables";
  params?: Record<string, unknown>;
};

export type GeneratedFormFieldConfig = {
  key: string;
  dataPath: string;
  valueType: "string" | "integer" | "number" | "boolean" | "date" | "datetime" | "object";
  cardinality?: "single" | "collection";
  variables?: "none" | "whole" | "template" | "both";
  searchable?: boolean;
  filterable?: boolean;
  sortable?: boolean;
  semanticType?: string;
  label?: LocalizedText;
  description?: LocalizedText;
  /** Longer guidance; shown in the field help dialog (not inline with description). */
  help?: LocalizedText;
  required?: boolean;
  readOnly?: boolean;
  defaultValue?: unknown;
  /**
   * Column-span hint for renderer grid layout.
   * - undefined / <= 0 → single column (default)
   * - >= 1 → full width
   * - fractional (e.g. 0.5) → proportional span
   */
  layoutFraction?: number;
  visibility?: Record<string, unknown>;
  validation?: GeneratedFormFieldValidation;
  options?: GeneratedFieldOptions;
  suggestions?: GeneratedFieldSuggestions;
  render: {
    component?: string;
    import?: string;
    props?: Record<string, unknown>;
  };
  children?: GeneratedFormFieldConfig[];
  item?: GeneratedFormFieldConfig;
};

export type GeneratedFormGroupConfig = {
  id: string;
  title?: LocalizedText;
  label?: LocalizedText;
  render?: string;
  fields?: string[];
  groups?: GeneratedFormGroupConfig[];
  relationship?: Record<string, unknown>;
  relationships?: Record<string, unknown>[];
};

export type GeneratedFormConfig = {
  mode: "create" | "edit";
  title?: LocalizedText;
  submitLabel?: LocalizedText;
  successRoute: string;
  actions?: Record<string, unknown>[];
  routes?: Record<string, LocalizedText | string>;
  groups?: GeneratedFormGroupConfig[];
  sections?: Array<{
    title?: LocalizedText;
    fields: string[];
  }>;
  fields: GeneratedFormFieldConfig[];
  /**
   * WEB-020 — Form-level variable sources consumed by the renderer. Emitted
   * by the compiler from the authoring `form.variableSources` block; the
   * runtime casts this array to `RendererFormDefinition.variableSources`
   * verbatim.
   */
  variableSources?: GeneratedFormVariableSource[];
};

export type GeneratedFormFieldErrors = Partial<Record<string, string>>;
