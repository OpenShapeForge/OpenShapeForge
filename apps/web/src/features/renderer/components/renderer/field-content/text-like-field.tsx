// SPDX-License-Identifier: BUSL-1.1
import type { ChangeEvent, ReactNode } from "react";
import { NumberInput } from "@/features/renderer/edit/controls/basic/number-input";
import { DatePicker } from "@/features/renderer/edit/controls/complex/date-picker";
import { DateTimePicker } from "@/features/renderer/edit/controls/complex/date-time-picker";
import { ExpressionEditor } from "@/features/renderer/edit/controls/complex/expression-editor";
import { TextInput } from "@/features/renderer/edit/controls/complex/text-input";
import { isPhoneSemanticField } from "@/features/renderer/runtime/phone-normalization";
import { translateRendererText } from "@/features/renderer/runtime/field-utils";
import type { VariableSuggestion } from "@/features/renderer/runtime/variable-suggestions";
import { fieldAllowsVariableTokenInput } from "@/features/renderer/runtime/variable-token-fields";
import type { FieldControlProps } from "@/features/renderer/components/field";
import type { Field } from "@/generated/compiler/field-contract";
import { isFieldCollection } from "@/lib/field-contract/field-v2";
import { resolveFieldInputRender } from "@/lib/field-rendering/compiler-field-rendering";
import { InlineJsonField } from "./inline-json-field";
import {
  shouldRenderStaticCollectionSelect,
  StaticCollectionSelectField,
} from "./static-collection-select-field";

export function renderTextLikeField(
  field: Field,
  value: unknown,
  controlProps: FieldControlProps,
  onChange: (value: unknown) => void,
  onBlur: () => void,
  isSubmitting: boolean,
  lang: string,
  formatValue: (field: Field, value: unknown) => string,
  languageHint?: string,
  variableSuggestions?: VariableSuggestion[],
): ReactNode {
  const component = resolveFieldInputRender(field).component;
  const variableTokensEnabled =
    field.render?.props?.variableTokens === true &&
    fieldAllowsVariableTokenInput(field, component);
  const textInputSuggestions = fieldAllowsVariableTokenInput(field, component)
    ? (variableSuggestions ?? [])
    : undefined;
  const textInputBehavior = variableTokensEnabled ? "variable-token" : "plain";
  const isPhoneField = isPhoneSemanticField(field);
  const commonProps = {
    id: controlProps.id,
    "aria-describedby": controlProps["aria-describedby"],
    "aria-invalid": controlProps["aria-invalid"],
    name: field.key,
    disabled: isSubmitting,
    readOnly: false,
    value: formatValue(field, value),
    onBlur,
  } as const;

  if (component === "NumberInput") {
    return (
      <NumberInput
        {...commonProps}
        min={
          typeof field.render?.props?.min === "number"
            ? field.render.props.min
            : undefined
        }
        max={
          typeof field.render?.props?.max === "number"
            ? field.render.props.max
            : undefined
        }
        step="any"
        onChange={(event: ChangeEvent<HTMLInputElement>) =>
          onChange(event.currentTarget.value)
        }
      />
    );
  }

  if (component === "DatePicker") {
    return (
      <DatePicker
        {...commonProps}
        onChange={(event: ChangeEvent<HTMLInputElement>) =>
          onChange(event.currentTarget.value)
        }
      />
    );
  }

  if (component === "DateTimePicker") {
    return (
      <DateTimePicker
        {...commonProps}
        onChange={(event: ChangeEvent<HTMLInputElement>) =>
          onChange(event.currentTarget.value)
        }
      />
    );
  }

  if (component === "InputMultiline") {
    return (
      <TextInput
        {...commonProps}
        behavior={textInputBehavior}
        rows={
          typeof field.render?.props?.rows === "number"
            ? field.render.props.rows
            : undefined
        }
        multiline
        suggestions={textInputSuggestions}
        onValueChange={(nextValue) => onChange(nextValue)}
      />
    );
  }

  if (component === "ExpressionEditor") {
    return (
      <ExpressionEditor
        {...commonProps}
        rows={
          typeof field.render?.props?.rows === "number"
            ? field.render.props.rows
            : undefined
        }
        languageHint={languageHint}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    );
  }

  if (shouldRenderStaticCollectionSelect(field)) {
    return (
      <StaticCollectionSelectField
        field={field}
        value={value}
        controlProps={controlProps}
        onChange={onChange as (value: string[]) => void}
        isSubmitting={isSubmitting}
        lang={lang}
      />
    );
  }

  if (
    component === "JsonFieldEditor" ||
    field.valueType === "object" ||
    isFieldCollection(field)
  ) {
    return (
      <InlineJsonField
        field={field}
        value={value}
        controlProps={controlProps}
        onChange={onChange}
        onBlur={onBlur}
        isSubmitting={isSubmitting}
        lang={lang}
      />
    );
  }

  return (
    <TextInput
      {...commonProps}
      behavior={textInputBehavior}
      type={
        typeof field.render?.props?.type === "string"
          ? field.render.props.type
          : isPhoneField
            ? "tel"
            : "text"
      }
      placeholder={translateRendererText(field.placeholder, lang) || undefined}
      suggestions={textInputSuggestions}
      autoComplete={
        typeof field.render?.props?.autoComplete === "string"
          ? field.render.props.autoComplete
          : isPhoneField
            ? "tel"
            : undefined
      }
      maxLength={
        typeof field.render?.props?.maxLength === "number"
          ? field.render.props.maxLength
          : undefined
      }
      onValueChange={(nextValue) => onChange(nextValue)}
    />
  );
}
