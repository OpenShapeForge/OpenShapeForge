// SPDX-License-Identifier: BUSL-1.1
"use client";

import { Field as FieldFrame } from "@/features/renderer/components/field";
import { FieldSchemaEditor } from "@/features/renderer/edit/controls/complex/field-schema-editor";
import type { FieldSchemaEditorLang } from "@/features/renderer/edit/controls/complex/field-schema-editor/types";
import type { Field } from "@/generated/compiler/field-contract";
import type { FieldAuthoringProfileId } from "@/lib/field-authoring/profiles";
import type { VariableSuggestion } from "@/features/renderer/runtime/variable-suggestions";

type FieldSchemaFieldProps = {
  id?: string;
  field: Field;
  value: unknown;
  lang?: FieldSchemaEditorLang;
  label: string;
  description?: string;
  helpText?: string;
  error?: string;
  required?: boolean;
  /**
   * Grid-span class from `getRendererFieldSpanClass(field, columns)`.
   * Applied to the outer FieldFrame so compiler-emitted `layoutFraction`
   * (e.g. full-width via `layoutFraction: 1`) takes effect for fields
   * that render via FieldSchemaEditor.
   */
  className?: string;
  renderProps?: Record<string, unknown>;
  variableSuggestions?: VariableSuggestion[];
  onChange: (nextItems: unknown[] | string) => void;
};

type FieldWithAuthoringMetadata = Field & {
  authoring?: {
    profile?: unknown;
  };
};

function resolveFieldAuthoringProfileId(value: unknown): FieldAuthoringProfileId {
  return value === "fullFieldDefinition"
    || value === "workflowInputField"
    || value === "runtimeNotificationParameter"
    || value === "templateParameter"
    || value === "workflowStartVariable"
    || value === "workflowOutputField"
    || value === "workflowProcessVariable"
    || value === "formDefinitionField"
    ? value
    : "fullFieldDefinition";
}

function resolveFieldSchemaReorderable(value: unknown): boolean {
  return value !== false;
}

function resolveDefaultExpandedItems(
  value: unknown,
): "first" | "all" | "none" {
  return value === "all" || value === "none" ? value : "first";
}

export function FieldSchemaField({
  id,
  field,
  value,
  lang = "nl",
  label,
  description,
  helpText,
  error,
  required,
  className,
  renderProps,
  variableSuggestions,
  onChange,
}: FieldSchemaFieldProps) {
  const authoredProfile = (field as FieldWithAuthoringMetadata).authoring?.profile;
  const profile = resolveFieldAuthoringProfileId(authoredProfile ?? renderProps?.profile);
  const reorderable = resolveFieldSchemaReorderable(renderProps?.reorderable);
  const defaultExpandedItems = resolveDefaultExpandedItems(
    renderProps?.defaultExpandedItems,
  );
  const variableSourceRows = renderProps?.variableSourceRows !== false;
  const items = Array.isArray(value) || typeof value === "string" ? value : [];
  const chromeLang = lang === "nl" ? "nl" : "en";

  return (
    <FieldFrame
      id={id}
      className={className}
      label={null}
      error={error}
      required={required}
      lang={chromeLang}
    >
      {(controlProps) => (
        <div id={controlProps.id} tabIndex={-1}>
          <FieldSchemaEditor
            items={items}
            onChange={onChange}
            profile={profile}
            mode="workspace"
            collectionLabel={label}
            collectionDescription={description}
            collectionHelpText={helpText}
            lang={lang}
            reorderable={reorderable}
            variableSourceRows={variableSourceRows}
            variableSuggestions={variableSuggestions}
            defaultExpandedItems={defaultExpandedItems}
          />
        </div>
      )}
    </FieldFrame>
  );
}
