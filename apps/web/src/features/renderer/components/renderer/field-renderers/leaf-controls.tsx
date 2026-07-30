// SPDX-License-Identifier: BUSL-1.1
import type { Field as CompilerField } from "../../../../../generated/compiler/field-contract";
import type { FieldControlProps } from "../../field";
import {
  ConditionBuilder,
  type ConditionBuilderProps,
} from "../condition-builder";
import {
  renderBooleanField,
  renderDisplayField,
  renderSelectField,
  renderTextLikeField,
} from "../field-content";
import { PolicyConditionBuilder } from "../policy-condition-builder";
import { formatRendererValue } from "../state";
import { FileUpload } from "../../../edit/controls/complex/file-upload";
import { OptionVariablePickerField } from "../../../edit/controls/complex/option-variable-picker-field";
import { TextInput } from "../../../edit/controls/complex/text-input";
import type {
  RendererFieldConfig,
  RendererFieldDisplayMode,
} from "../../../form-definition";
import {
  getRendererFieldLanguageHint,
  resolveComputedRendererFieldValue,
  translateRendererText,
} from "../../../runtime/field-utils";
import { buildEntityReferencePickerField } from "../../../runtime/semantic-lookup-options";
import type { SupportedLocale } from "./shared";
import type { FieldRenderContext } from "./types";
import { getLegacySourceFieldStructuredValue } from "../legacy-source-field";
import {
  getConditionFieldVariableSuggestions,
  getFieldVariableSuggestions,
  getTextFieldVariableSuggestions,
} from "./variable-suggestions";

type LeafFieldControlArgs = {
  ctx: FieldRenderContext;
  field: CompilerField;
  fieldConfig: RendererFieldConfig | undefined;
  component: string;
  value: unknown;
  label: string | null;
  description: string | undefined;
  helpText: string | undefined;
  error: string | undefined;
  required: boolean;
  effectiveMode: RendererFieldDisplayMode;
  localizedActiveLocale: SupportedLocale | null;
  controlProps: FieldControlProps;
  handleChange: (nextValue: unknown) => void;
  handleBlur: () => void;
};

export function renderLeafFieldControl({
  ctx,
  field,
  fieldConfig,
  component,
  value,
  label,
  description,
  helpText,
  error,
  required,
  effectiveMode,
  localizedActiveLocale,
  controlProps,
  handleChange,
  handleBlur,
}: LeafFieldControlArgs) {
  const computedValue = field.computed
    ? resolveComputedRendererFieldValue(field, ctx.structuredValues)
    : null;
  const resolvedValue = field.computed
    ? localizedActiveLocale !== null &&
      computedValue &&
      typeof computedValue === "object" &&
      !Array.isArray(computedValue)
      ? ((computedValue as Record<string, unknown>)[localizedActiveLocale] ??
        "")
      : computedValue
    : value;

  if (effectiveMode !== "edit") {
    return renderDisplayField(
      field,
      fieldConfig,
      resolvedValue,
      effectiveMode,
      ctx.lang,
      ctx.structuredValues,
    );
  }

  if (
    component === "ReferenceSelect" ||
    component === "Select" ||
    component === "ListSelect"
  ) {
    return renderSelectField(
      field,
      value,
      controlProps,
      (nextValue) => handleChange(nextValue),
      ctx.isSubmitting,
      ctx.lang,
    );
  }

  if (
    component === "EntityReferenceSelect" ||
    component === "OptionVariablePicker"
  ) {
    const pickerField =
      component === "EntityReferenceSelect"
        ? (buildEntityReferencePickerField(field) ?? field)
        : field;
    const pickerProps = pickerField.render?.props ?? {};

    return (
      <OptionVariablePickerField
        id={controlProps.id}
        field={pickerField}
        value={value}
        label={label ?? ""}
        description={description}
        helpText={helpText}
        error={error}
        required={required}
        clearable={pickerProps.clearable === true}
        hideVariables={pickerProps.hideVariables === true}
        lang={ctx.lang === "en" ? "en" : "nl"}
        placeholder={translateRendererText(pickerField.placeholder, ctx.lang)}
        searchPlaceholder={
          typeof pickerProps.searchPlaceholder === "string"
            ? pickerProps.searchPlaceholder
            : undefined
        }
        emptyMessage={
          typeof pickerProps.emptyMessage === "string"
            ? pickerProps.emptyMessage
            : undefined
        }
        optionSectionLabel={
          typeof pickerProps.optionSectionLabel === "string"
            ? pickerProps.optionSectionLabel
            : undefined
        }
        variableSectionLabel={
          typeof pickerProps.variableSectionLabel === "string"
            ? pickerProps.variableSectionLabel
            : undefined
        }
        valueMode={pickerProps.valueMode === "path" ? "path" : "insertText"}
        suggestions={
          pickerProps.hideVariables === true
            ? undefined
            : getTextFieldVariableSuggestions(field, ctx)
        }
        onChange={(nextValue) => handleChange(nextValue)}
      />
    );
  }

  if (
    component === "Switch" ||
    component === "Checkbox" ||
    field.valueType === "boolean"
  ) {
    return renderBooleanField(
      field,
      value,
      controlProps,
      (nextValue) => handleChange(nextValue),
      handleBlur,
      ctx.isSubmitting,
    );
  }

  if (component === "FileUpload") {
    return (
      <FileUpload
        id={controlProps.id}
        aria-describedby={controlProps["aria-describedby"]}
        aria-invalid={controlProps["aria-invalid"]}
        value={typeof value === "string" ? value : ""}
        disabled={ctx.isSubmitting}
        fileNameField={
          typeof field.render?.props?.fileNameField === "string"
            ? field.render.props.fileNameField
            : undefined
        }
        mimeTypeField={
          typeof field.render?.props?.mimeTypeField === "string"
            ? field.render.props.mimeTypeField
            : undefined
        }
        checksumField={
          typeof field.render?.props?.checksumField === "string"
            ? field.render.props.checksumField
            : undefined
        }
        onValueChange={(v) => handleChange(v)}
        onSiblingChange={(key, val) => ctx.form.changeField(key, val)}
      />
    );
  }

  if (component === "ConditionBuilder") {
    const suggestions = getConditionFieldVariableSuggestions(field, ctx);
    // `value` is `unknown` (dynamic form state). The condition builder expects
    // a `{ kind: ... }` object and tolerates `undefined`; anything non-object
    // cannot be a valid condition.
    const conditionValue =
      typeof value === "object" && value !== null
        ? (value as ConditionBuilderProps["value"])
        : undefined;
    return (
      <ConditionBuilder
        id={controlProps.id}
        aria-describedby={controlProps["aria-describedby"]}
        aria-invalid={controlProps["aria-invalid"]}
        value={conditionValue}
        onChange={(nextValue) => handleChange(nextValue)}
        lang={ctx.lang as "nl" | "en"}
        variableSuggestions={suggestions}
        disabled={ctx.isSubmitting}
      />
    );
  }

  if (component === "PolicyConditionBuilder") {
    const suggestions = getFieldVariableSuggestions(field, ctx);
    const scopedEntityType =
      getLegacySourceFieldStructuredValue(field, ctx.structuredValues) ??
      ctx.structuredValues.entityType;
    return (
      <PolicyConditionBuilder
        id={controlProps.id}
        aria-describedby={controlProps["aria-describedby"]}
        aria-invalid={controlProps["aria-invalid"]}
        value={value}
        onChange={(nextValue) => handleChange(nextValue)}
        lang={ctx.lang === "en" ? "en" : "nl"}
        entityType={
          typeof scopedEntityType === "string" ? scopedEntityType : null
        }
        variableSuggestions={suggestions}
        disabled={ctx.isSubmitting}
      />
    );
  }

  if (component === "VariableTemplateInput") {
    const suggestions = getFieldVariableSuggestions(field, ctx);
    return (
      <TextInput
        id={controlProps.id}
        aria-describedby={controlProps["aria-describedby"]}
        aria-invalid={controlProps["aria-invalid"]}
        behavior="variable-token"
        multiline
        rows={
          typeof field.render?.props?.rows === "number"
            ? field.render.props.rows
            : 4
        }
        value={typeof resolvedValue === "string" ? resolvedValue : ""}
        suggestions={suggestions}
        disabled={ctx.isSubmitting}
        onValueChange={(nextValue) => handleChange(nextValue)}
      />
    );
  }

  return renderTextLikeField(
    field,
    resolvedValue,
    controlProps,
    handleChange,
    handleBlur,
    ctx.isSubmitting,
    ctx.lang,
    formatRendererValue,
    getRendererFieldLanguageHint(field, ctx.lang, field.render?.props),
    getTextFieldVariableSuggestions(field, ctx),
  );
}
