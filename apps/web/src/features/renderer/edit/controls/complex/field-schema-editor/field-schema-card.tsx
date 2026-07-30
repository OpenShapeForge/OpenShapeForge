// SPDX-License-Identifier: BUSL-1.1
"use client";

import { ChevronDown, ChevronUp, Copy, Trash2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@openshapeforge/ui";
import { Renderer } from "@/features/renderer/components/renderer";
import type { Field } from "@/generated/compiler/field-contract";
import type { FieldSchemaCardProps, FieldSchemaEditorLang, LocalizedFieldProperty } from "./types";
import { buildFieldSchemaDefinition } from "./schema-definition";
import { renderFieldSchemaCustomField } from "./custom-field-renderer";
import { applyFieldAuthoringProfileRules, normalizeFieldSchemaDraft } from "./draft-normalization";
import { fieldRowsForSiblingChecks, normalizeFieldDefinitionEditorRows } from "./editor-rows";
import { reconcileDefaultValueForFieldChange } from "./default-value-helpers";
import { getFieldChildShape, isProfileControlEnabled } from "./rule-resolution";
import { FIELD_OPTIONS_TYPE_OPTIONS } from "./constants";
import { toFieldSchemaChromeLang } from "./language";
import { getFieldTypeKey, getFieldTypeOptions, isFieldCardinalityCollection, translateText } from "./utils";

const LOCALIZED_FIELD_PROPERTIES: LocalizedFieldProperty[] = [
  "label",
  "description",
  "placeholder",
  "help",
];

function preserveLocalizedFieldProperties(
  previousField: Field,
  nextField: Field,
): Field {
  const merged = { ...nextField };
  for (const property of LOCALIZED_FIELD_PROPERTIES) {
    if (previousField[property]) {
      merged[property] = previousField[property];
    } else {
      delete merged[property];
    }
  }
  return merged;
}

export function FieldSchemaCard({
  field,
  lang,
  profile,
  siblingKeyCounts,
  rules,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
  onDuplicate,
  itemSurface = "card",
  showMoveUpControl,
  showMoveDownControl,
  moveUpDisabled = false,
  moveDownDisabled = false,
  isNested = false,
  variableSuggestions,
  suppressDefaultValueControl = false,
  FieldSchemaEditorComponent,
}: FieldSchemaCardProps) {
  const latestFieldRef = useRef(field);

  useEffect(() => {
    latestFieldRef.current = field;
  }, [field]);

  const emitFieldChange = (nextField: Field) => {
    const previousField = latestFieldRef.current;
    const reconciledField = reconcileDefaultValueForFieldChange(
      previousField,
      nextField,
    );
    const appliedField = applyFieldAuthoringProfileRules(
      previousField,
      reconciledField,
      profile,
    );
    latestFieldRef.current = appliedField;
    onChange(appliedField);
  };

  const emitRendererChange = (nextValues: Record<string, unknown>) => {
    const normalizedField = normalizeFieldSchemaDraft(
      nextValues.field,
      profile.createEmptyField,
    );
    emitFieldChange(
      preserveLocalizedFieldProperties(latestFieldRef.current, normalizedField),
    );
  };

  const title = getFieldSchemaTitle(field, lang);
  const keyError =
    field.key.trim().length > 0 && siblingKeyCounts[field.key.trim()] > 1
      ? lang === "nl"
        ? "Er bestaat al een veld met dezelfde afgeleide naam binnen dit schema."
        : "A field with the same generated name already exists in this schema."
      : undefined;
  const definition = buildFieldSchemaDefinition(field, profile, lang, rules, {
    itemSurface,
    suppressDefaultValueControl,
  });
  const editorContent = (
    <>
      {itemSurface === "collection" && rules?.note ? (
        <p className="text-sm text-muted-foreground">
          {translateText(rules.note, lang)}
        </p>
      ) : null}

      <Renderer
        definition={definition}
        lang={lang}
        initialData={{ field }}
        showTitle={false}
        showDescription={false}
        onChange={emitRendererChange}
        renderCustomField={(props) =>
          renderFieldSchemaCustomField(
            props,
            profile,
            emitFieldChange,
            variableSuggestions,
            FieldSchemaEditorComponent,
          )}
      />

      {field.valueType === "object" &&
      field.semanticType !== "fieldDefinition" &&
      isProfileControlEnabled(profile, "shape") &&
      !rules?.locked ? (
        <details className="rounded-xl border border-border/70 bg-muted/10 p-4" open>
          <summary className="cursor-pointer text-sm font-medium">
            {lang === "nl" ? "Vorm" : "Shape"}
          </summary>
          <div className="mt-4">
            <FieldSchemaEditorComponent
              items={getFieldChildShape(field)}
              onChange={(children) => {
                if (!Array.isArray(children)) {
                  return;
                }
                const normalizedChildren = fieldRowsForSiblingChecks(
                  normalizeFieldDefinitionEditorRows(children, profile),
                  profile,
                );
                onChange({
                  ...field,
                  shape: normalizedChildren,
                  children: normalizedChildren,
                } as Field);
              }}
              profile={profile.id}
              mode="editor"
              lang={lang}
              variableSourceRows={false}
              variableSuggestions={variableSuggestions}
              suppressDefaultValueControl={suppressDefaultValueControl}
            />
          </div>
        </details>
      ) : null}
    </>
  );

  if (itemSurface === "collection") {
    return <div className="space-y-4">{editorContent}</div>;
  }

  return (
    <div
      className={`space-y-4 rounded-2xl border border-border/70 p-4 ${
        isNested ? "bg-muted/20" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="font-medium">{title}</p>
          <p className="text-sm text-muted-foreground">
            {getFieldSchemaSummary(field, lang)}
          </p>
          {rules?.note ? (
            <p className="text-sm text-muted-foreground">
              {translateText(rules.note, lang)}
            </p>
          ) : null}
          {keyError ? (
            <p className="text-sm text-destructive">{keyError}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {showMoveUpControl && !rules?.disableMove ? (
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              onClick={onMoveUp}
              disabled={moveUpDisabled}
              aria-label={lang === "nl" ? "Omhoog" : "Move up"}
              title={lang === "nl" ? "Omhoog" : "Move up"}
            >
              <ChevronUp className="size-4" />
            </Button>
          ) : null}
          {showMoveDownControl && !rules?.disableMove ? (
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              onClick={onMoveDown}
              disabled={moveDownDisabled}
              aria-label={lang === "nl" ? "Omlaag" : "Move down"}
              title={lang === "nl" ? "Omlaag" : "Move down"}
            >
              <ChevronDown className="size-4" />
            </Button>
          ) : null}
          {onDuplicate && !rules?.disableDuplicate ? (
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              onClick={onDuplicate}
              aria-label={lang === "nl" ? "Dupliceren" : "Duplicate"}
              title={lang === "nl" ? "Dupliceren" : "Duplicate"}
            >
              <Copy className="size-4" />
            </Button>
          ) : null}
          {onRemove && !rules?.disableRemove ? (
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              onClick={onRemove}
              aria-label={lang === "nl" ? "Verwijderen" : "Remove"}
              title={lang === "nl" ? "Verwijderen" : "Remove"}
            >
              <Trash2 className="size-4" />
            </Button>
          ) : null}
        </div>
      </div>

      {editorContent}
    </div>
  );
}

function getFieldSchemaTitle(field: Field, lang: FieldSchemaEditorLang) {
  return (
    translateText(field.label, lang) ||
    (lang === "nl" ? "Nieuw veld" : "New field")
  );
}

function getFieldSchemaTypeLabel(field: Field, lang: FieldSchemaEditorLang) {
  const fieldTypeKey = getFieldTypeKey(field);
  const typeOption = getFieldTypeOptions([], fieldTypeKey).find(
    (option) => option.value === fieldTypeKey,
  );
  return translateText(typeOption?.label, lang) || fieldTypeKey;
}

function getFieldSchemaInputLabel(field: Field, lang: FieldSchemaEditorLang) {
  const component = field.render?.component;
  const labels: Record<string, { nl: string; en: string }> = {
    Input: { nl: "Invoerveld", en: "Input" },
    InputMultiline: { nl: "Tekstgebied", en: "Textarea" },
    NumberInput: { nl: "Getalveld", en: "Number input" },
    Select: { nl: "Dropdown", en: "Dropdown" },
    ListSelect: { nl: "Zoekbare keuzelijst", en: "Searchable list" },
    ReferenceSelect: { nl: "Referentieselectie", en: "Reference select" },
    Switch: { nl: "Schakelaar", en: "Switch" },
    Checkbox: { nl: "Checkbox", en: "Checkbox" },
    DatePicker: { nl: "Datumkiezer", en: "Date picker" },
    FileUpload: { nl: "Bestandsupload", en: "File upload" },
  };

  if (component && labels[component]) {
    return labels[component][toFieldSchemaChromeLang(lang)];
  }

  if (field.options?.type) {
    return lang === "nl" ? "Keuzelijst" : "Choice input";
  }

  return "";
}

function getFieldSchemaOptionsSummary(field: Field, lang: FieldSchemaEditorLang) {
  if (!field.options?.type) {
    return "";
  }

  if (field.options.type === "static") {
    const count = Array.isArray(field.options.items) ? field.options.items.length : 0;
    return lang === "nl"
      ? `${count} ${count === 1 ? "optie" : "opties"}`
      : `${count} ${count === 1 ? "option" : "options"}`;
  }

  const option = FIELD_OPTIONS_TYPE_OPTIONS.find(
    (candidate) => candidate.value === field.options?.type,
  );
  return translateText(option?.label, lang) || field.options.type;
}

function getFieldSchemaSummary(field: Field, lang: FieldSchemaEditorLang) {
  return [
    getFieldSchemaTypeLabel(field, lang),
    getFieldSchemaInputLabel(field, lang),
    getFieldSchemaOptionsSummary(field, lang),
  ].filter(Boolean).join(" · ");
}
