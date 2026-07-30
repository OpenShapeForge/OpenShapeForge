// SPDX-License-Identifier: BUSL-1.1
"use client";

import { type ReactNode } from "react";
import { InputMultiline } from "@openshapeforge/ui";
import { Input } from "@/components/ui/forms/input";
import { Field as FieldFrame } from "@/features/renderer/components/field";
import { getRendererFullWidthSpanClass } from "@/features/renderer/components/renderer/layout-policy";
import type { RendererCustomFieldRenderProps } from "@/features/renderer/components/renderer/field-renderers";
import { OptionVariablePickerField } from "@/features/renderer/edit/controls/complex/option-variable-picker-field";
import type { Field } from "@/generated/compiler/field-contract";
import type { FieldAuthoringProfile } from "@/lib/field-authoring/profiles";
import { StringListEditor } from "./controls";
import { FieldSchemaCardinalityEditor, FieldSchemaTypePicker } from "./field-type-controls";
import { FieldSchemaDefaultValueEditor } from "./field-default-value-editor";
import { FieldSchemaValueEditor } from "./field-value-editors";
import { FieldSchemaJsonValueEditor, FieldSchemaRawJsonEditor } from "./field-json-editors";
import { FieldSchemaReferenceGroupPicker, FieldSchemaStaticOptionsEditor, FieldSchemaVisibilityConditionsEditor } from "./field-option-editors";
import { ValidationSection } from "./validation-section";
import type { FieldSchemaEditorProps, LocalizedFieldProperty, RecursiveFieldSchemaEditorComponent } from "./types";
import { normalizeFieldSchemaDraft } from "./draft-normalization";
import { normalizeFieldSchemaLang, toFieldSchemaChromeLang } from "./language";
import { filterDynamicOptionSourceSuggestions } from "./rule-resolution";
import { isRecord, updateLocalizedFieldProperty } from "./utils";

function getFieldFromStructuredValues(props: RendererCustomFieldRenderProps, createEmptyField: () => Field) {
  const root = props.ctx.structuredValues.field;
  return normalizeFieldSchemaDraft(root, createEmptyField);
}

function wrapFieldSchemaWideContent(columns: 1 | 2 | 3 | 4, child: ReactNode) {
  const spanClass = getRendererFullWidthSpanClass(columns);
  return <div className={spanClass}>{child}</div>;
}

function isLocalizedFieldProperty(value: unknown): value is LocalizedFieldProperty {
  return (
    value === "label" ||
    value === "description" ||
    value === "placeholder" ||
    value === "help"
  );
}

function getFieldSchemaCustomProps(
  props: RendererCustomFieldRenderProps,
): Record<string, unknown> {
  return isRecord(props.field.render) && isRecord(props.field.render.props)
    ? props.field.render.props
    : {};
}

export function renderFieldSchemaCustomField(
  props: RendererCustomFieldRenderProps,
  profile: FieldAuthoringProfile,
  onFieldChange: (nextField: Field) => void,
  variableSuggestions: FieldSchemaEditorProps["variableSuggestions"],
  FieldSchemaEditorComponent: RecursiveFieldSchemaEditorComponent,
): ReactNode | null {
  const activeLang = normalizeFieldSchemaLang(props.ctx.lang);
  const lang = toFieldSchemaChromeLang(activeLang);
  const editorField = getFieldFromStructuredValues(props, profile.createEmptyField);

  switch (props.component) {
    case "FieldSchemaLocalizedTextInput": {
      const renderProps = getFieldSchemaCustomProps(props);
      const property = renderProps.property;
      if (!isLocalizedFieldProperty(property)) {
        return null;
      }

      const value = editorField[property]?.[activeLang] ?? "";
      const disabled = props.field.readOnly === true;
      const commitValue = (nextText: string) => {
        onFieldChange(
          updateLocalizedFieldProperty(editorField, property, activeLang, nextText),
        );
      };

      return (
        <FieldFrame
          label={props.label}
          description={props.description}
          helpText={props.helpText}
          error={props.error}
          required={props.required}
        >
          {(controlProps) =>
            renderProps.multiline === true ? (
              <InputMultiline
                {...controlProps}
                name={props.field.key}
                rows={typeof renderProps.rows === "number" ? renderProps.rows : 3}
                value={value}
                disabled={disabled}
                onBlur={props.onBlur}
                onChange={(event) => commitValue(event.currentTarget.value)}
              />
            ) : (
              <Input
                {...controlProps}
                name={props.field.key}
                value={value}
                disabled={disabled}
                onBlur={props.onBlur}
                onChange={(event) => commitValue(event.currentTarget.value)}
              />
            )
          }
        </FieldFrame>
      );
    }
    case "FieldSchemaTypePicker":
      return (
        <FieldSchemaTypePicker
          field={editorField}
          profile={profile}
          lang={lang}
          disabled={props.field.readOnly === true}
          onChange={onFieldChange}
        />
      );
    case "FieldSchemaCardinalityEditor":
      return (
        <FieldSchemaCardinalityEditor
          field={editorField}
          lang={lang}
          disabled={props.field.readOnly === true}
          onChange={onFieldChange}
        />
      );
    case "FieldSchemaDefaultValueEditor":
      return wrapFieldSchemaWideContent(
        props.columns,
        <FieldSchemaDefaultValueEditor
          field={editorField}
          lang={lang}
          value={props.value}
          FieldSchemaEditorComponent={FieldSchemaEditorComponent}
          onChange={(nextValue) => {
            if (nextValue === undefined) {
              const { defaultValue: _defaultValue, ...nextField } = editorField;
              onFieldChange(nextField);
              return;
            }

            onFieldChange({
              ...editorField,
              defaultValue: nextValue,
            });
          }}
        />,
      );
    case "FieldSchemaValueEditor":
      return wrapFieldSchemaWideContent(
        props.columns,
        <FieldSchemaValueEditor
          field={editorField}
          profile={profile}
          lang={lang}
          value={props.value}
          onChange={props.onChange}
        />,
      );
    case "FieldSchemaValidationEditor":
      return wrapFieldSchemaWideContent(
        props.columns,
        <ValidationSection
          field={editorField}
          lang={lang}
          onChange={(nextField) => props.onChange(nextField.validation)}
          framed={false}
        />,
      );
    case "FieldSchemaStaticOptionsEditor":
      return wrapFieldSchemaWideContent(
        props.columns,
        <FieldSchemaStaticOptionsEditor
          value={props.value}
          lang={lang}
          onChange={props.onChange}
        />,
      );
    case "FieldSchemaReferenceGroupPicker":
      return wrapFieldSchemaWideContent(
        props.columns,
        <FieldSchemaReferenceGroupPicker
          value={props.value}
          label={props.label}
          description={props.description}
          helpText={props.helpText}
          error={props.error}
          required={props.required}
          lang={lang}
          onChange={props.onChange}
        />,
      );
    case "OptionVariablePicker": {
      const optionSourceForSemanticType =
        props.field.render?.props?.optionSourceForSemanticType === true;
      const suggestions = optionSourceForSemanticType
        ? filterDynamicOptionSourceSuggestions(variableSuggestions, editorField.semanticType)
        : variableSuggestions ?? [];

      return wrapFieldSchemaWideContent(
        props.columns,
        <OptionVariablePickerField
          value={props.value}
          label={props.label}
          description={props.description}
          helpText={props.helpText}
          error={props.error}
          required={props.required}
          field={props.field}
          suggestions={suggestions}
          lang={lang}
          placeholder={
            optionSourceForSemanticType
              ? lang === "nl"
                ? "Kies lijstvariabele..."
                : "Choose list variable..."
              : undefined
          }
          searchPlaceholder={
            optionSourceForSemanticType
              ? lang === "nl"
                ? "Zoek lijstvariabele..."
                : "Search list variable..."
              : undefined
          }
          emptyMessage={
            optionSourceForSemanticType
              ? lang === "nl"
                ? "Geen passende lijstvariabelen gevonden."
                : "No matching list variables found."
              : undefined
          }
          variableSectionLabel={
            optionSourceForSemanticType
              ? lang === "nl"
                ? "Lijstvariabelen"
                : "List variables"
              : undefined
          }
          valueMode={props.field.render?.props?.valueMode === "path" ? "path" : "insertText"}
          onChange={(nextValue) => props.onChange(nextValue)}
        />,
      );
    }
    case "FieldSchemaVisibilityConditionsEditor":
      return wrapFieldSchemaWideContent(
        props.columns,
        <FieldSchemaVisibilityConditionsEditor
          value={props.value}
          lang={lang}
          onChange={props.onChange}
        />,
      );
    case "FieldSchemaDependenciesEditor":
      return wrapFieldSchemaWideContent(
        props.columns,
        <StringListEditor
          label={lang === "nl" ? "Afhankelijkheden" : "Dependencies"}
          values={Array.isArray(props.value) ? props.value.filter((item): item is string => typeof item === "string") : []}
          onChange={props.onChange}
          lang={lang}
          itemLabel={lang === "nl" ? "Pad" : "Path"}
          emptyText={lang === "nl" ? "Nog geen afhankelijkheden." : "No dependencies yet."}
          addLabel={lang === "nl" ? "Afhankelijkheid toevoegen" : "Add dependency"}
          placeholder="applicant.name"
        />,
      );
    case "FieldSchemaReadRolesEditor":
      return wrapFieldSchemaWideContent(
        props.columns,
        <StringListEditor
          label={lang === "nl" ? "Read-rollen" : "Read roles"}
          values={Array.isArray(props.value) ? props.value.filter((item): item is string => typeof item === "string") : []}
          onChange={props.onChange}
          lang={lang}
          itemLabel={lang === "nl" ? "Read-rol" : "Read role"}
          emptyText={lang === "nl" ? "Nog geen read-rollen." : "No read roles yet."}
          addLabel={lang === "nl" ? "Read-rol toevoegen" : "Add read role"}
        />,
      );
    case "FieldSchemaWriteRolesEditor":
      return wrapFieldSchemaWideContent(
        props.columns,
        <StringListEditor
          label={lang === "nl" ? "Write-rollen" : "Write roles"}
          values={Array.isArray(props.value) ? props.value.filter((item): item is string => typeof item === "string") : []}
          onChange={props.onChange}
          lang={lang}
          itemLabel={lang === "nl" ? "Write-rol" : "Write role"}
          emptyText={lang === "nl" ? "Nog geen write-rollen." : "No write roles yet."}
          addLabel={lang === "nl" ? "Write-rol toevoegen" : "Add write role"}
        />,
      );
    case "FieldSchemaJsonValueEditor":
      return wrapFieldSchemaWideContent(
        props.columns,
        <FieldSchemaJsonValueEditor
          label={props.label}
          description={props.description}
          value={props.value}
          lang={lang}
          onChange={props.onChange}
          rows={typeof props.field.render?.props?.rows === "number" ? props.field.render.props.rows : 4}
        />,
      );
    case "FieldSchemaRawJsonEditor":
      return wrapFieldSchemaWideContent(
        props.columns,
        <FieldSchemaRawJsonEditor
          field={editorField}
          lang={lang}
          onChange={onFieldChange}
        />,
      );
    default:
      return undefined;
  }
}
