// SPDX-License-Identifier: BUSL-1.1
"use client";

import { CollectionEditor } from "@/features/renderer/components/renderer/collection-editor";
import {
  OptionVariablePickerField,
  type OptionVariablePickerSelection,
} from "@/features/renderer/edit/controls/complex/option-variable-picker-field";
import type { Field } from "@/generated/compiler/field-contract";
import {
  canMaterializeVariableSuggestionAsFieldDefinition,
  materializeVariableSuggestionAsFieldDefinition,
} from "@/features/renderer/runtime/collection-variable-rows";
import { filterVariableSuggestions } from "@/features/renderer/runtime/variable-compatibility";
import { getFieldAuthoringProfile } from "@/lib/field-authoring/profiles";
import { FieldSchemaCard } from "./field-schema-card";
import type { FieldSchemaEditorProps } from "./types";
import {
  fieldRowsForSiblingChecks,
  getEditableFieldFromEditorRow,
  getFieldFromEditorRow,
  isVariableFieldDefinitionRow,
  normalizeFieldDefinitionEditorRows,
  replaceFieldInEditorRow,
  variableSuggestionFromStoredFieldDefinitionRow,
} from "./editor-rows";
import { getEffectiveFieldRules } from "./rule-resolution";
import { buildSiblingKeyCounts, duplicateArrayItem, isRecord, translateText } from "./utils";
import { toFieldSchemaChromeLang } from "./language";

export function FieldSchemaEditor({
  items,
  onChange,
  profile,
  collectionLabel,
  collectionDescription,
  collectionHelpText,
  lang = "nl",
  mode = "editor",
  reorderable = true,
  variableSourceRows = true,
  variableSuggestions,
  singleItem = false,
  suppressDefaultValueControl = false,
  defaultExpandedItems = "none",
}: FieldSchemaEditorProps) {
  const chromeLang = toFieldSchemaChromeLang(lang);
  const authoringProfile = getFieldAuthoringProfile(profile);
  const collectionValue = Array.isArray(items) ? items : [];
  const normalizedItems = normalizeFieldDefinitionEditorRows(collectionValue, authoringProfile);
  const editorValue = typeof items === "string" ? items : normalizedItems;
  const fieldRows = fieldRowsForSiblingChecks(normalizedItems, authoringProfile);
  const siblingKeyCounts = buildSiblingKeyCounts(fieldRows);

  const emitItems = (nextItems: unknown[] | string) => {
    if (typeof nextItems === "string") {
      onChange(nextItems);
      return;
    }
    onChange(normalizeFieldDefinitionEditorRows(nextItems, authoringProfile));
  };

  const collectionField: Field = {
    key: "fieldDefinitions",
    valueType: "object",
    cardinality: { min: 0, max: "unbounded" },
    ...(variableSourceRows ? { semanticType: "fieldDefinition" } : {}),
    label: { nl: "Velden", en: "Fields" },
  };
  const variableSourceField: Field = {
    key: "source",
    valueType: "string",
    label: { nl: "Veldbron", en: "Field source" },
    placeholder: { nl: "Kies veld...", en: "Choose field..." },
    render: {
      component: "OptionVariablePicker",
      props: {
        clearable: true,
        valueMode: "insertText",
        variableSectionLabel: lang === "nl" ? "Beschikbare variabelen" : "Available variables",
        emptyMessage: lang === "nl" ? "Geen geschikte velden gevonden." : "No suitable fields found.",
      },
    },
  };
  const variableSourceSuggestions = filterVariableSuggestions(variableSuggestions ?? [], { fieldDefinitionSource: true });
  const variableRowSuggestions = (variableSuggestions ?? []).filter(canMaterializeVariableSuggestionAsFieldDefinition);
  const getItemRules = (row: unknown, index: number) => {
    const field = getFieldFromEditorRow(row, authoringProfile.createEmptyField);
    if (!field) return undefined;
    return getEffectiveFieldRules(field, index, fieldRows, authoringProfile);
  };

  return (
    <CollectionEditor
      field={collectionField}
      value={editorValue}
      lang={lang}
      label={collectionLabel ?? (lang === "nl" ? "Velden" : "Fields")}
      description={collectionDescription}
      helpText={collectionHelpText}
      reorderable={reorderable}
      readOnly={singleItem}
      defaultExpandedItems={defaultExpandedItems}
      surfaceMode={mode}
      variableSuggestions={variableRowSuggestions}
      variableSourceSuggestions={variableSourceSuggestions}
      createItem={authoringProfile.createEmptyField}
      createManualRow={authoringProfile.createEmptyField}
      canRemoveItem={(item, index) => !getItemRules(item, index)?.disableRemove}
      canReorderItem={(item, index) => !getItemRules(item, index)?.disableMove}
      canDuplicateItem={(item, index) => !getItemRules(item, index)?.disableDuplicate}
      onDuplicateItem={(index) => emitItems(duplicateArrayItem(normalizedItems, index))}
      onChange={(nextItems) => emitItems(nextItems)}
      renderItem={(index) => {
        const row = normalizedItems[index];
        if (isVariableFieldDefinitionRow(row)) {
          const props = variableSourceField.render?.props ?? {};
          const storedSuggestion = variableSuggestionFromStoredFieldDefinitionRow(isRecord(row) ? row : null, lang);
          const rowSuggestions = storedSuggestion && !variableRowSuggestions.some((suggestion) => suggestion.path === storedSuggestion.path)
            ? [storedSuggestion, ...variableRowSuggestions]
            : variableRowSuggestions;
          const handleVariableRowChange = (nextValue: string, selection: OptionVariablePickerSelection) => {
            const materialized = selection?.kind === "variable" && canMaterializeVariableSuggestionAsFieldDefinition(selection.suggestion)
              ? materializeVariableSuggestionAsFieldDefinition(selection.suggestion)
              : {};
            emitItems(normalizedItems.map((item, itemIndex) => itemIndex === index
              ? { ...(isRecord(row) ? row : {}), ...materialized, kind: "variable", source: nextValue }
              : item));
          };

          return (
            <OptionVariablePickerField
              field={variableSourceField}
              value={typeof row.source === "string" ? row.source : ""}
              label={translateText(variableSourceField.label, lang)}
              clearable={props.clearable === true}
              suggestions={rowSuggestions}
              lang={chromeLang}
              placeholder={translateText(variableSourceField.placeholder, lang)}
              emptyMessage={typeof props.emptyMessage === "string" ? props.emptyMessage : undefined}
              variableSectionLabel={typeof props.variableSectionLabel === "string" ? props.variableSectionLabel : undefined}
              valueMode={props.valueMode === "path" || props.valueMode === "insertText" ? props.valueMode : "insertText"}
              onChange={handleVariableRowChange}
            />
          );
        }

        const field = getEditableFieldFromEditorRow(row, authoringProfile.createEmptyField);
        if (!field) return null;
        const itemRules = getItemRules(row, index);

        return (
          <FieldSchemaCard
            field={field}
            lang={lang}
            profile={authoringProfile}
            siblingKeyCounts={siblingKeyCounts}
            rules={itemRules}
            onChange={(nextItem) => emitItems(normalizedItems.map((item, itemIndex) => itemIndex === index ? replaceFieldInEditorRow(item, nextItem) : item))}
            onDuplicate={() => emitItems(duplicateArrayItem(normalizedItems, index))}
            itemSurface="collection"
            showMoveUpControl={false}
            showMoveDownControl={false}
            variableSuggestions={variableSuggestions}
            suppressDefaultValueControl={suppressDefaultValueControl}
            FieldSchemaEditorComponent={FieldSchemaEditor}
          />
        );
      }}
    />
  );
}
