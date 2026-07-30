// SPDX-License-Identifier: BUSL-1.1
import type { Field, LocalizedText } from "@/generated/compiler/field-contract";
import type { FieldAuthoringProfile } from "@/lib/field-authoring/profiles";
import type { VariableSuggestion } from "@/features/renderer/runtime/variable-suggestions";
import type { FieldSchemaEditorLang } from "./types";
import { normalizeFieldSchemaDraft } from "./draft-normalization";
import { isFieldCardinalityCollection, isRecord, translateText } from "./utils";

export function isVariableFieldDefinitionRow(value: unknown): value is Record<string, unknown> & {
  kind: "variable";
} {
  return isRecord(value) && value.kind === "variable";
}

export function isManualFieldDefinitionRow(value: unknown): value is Record<string, unknown> & {
  kind: "manual";
} {
  return isRecord(value) && value.kind === "manual";
}

export function isFieldDefinitionSourceRow(value: unknown) {
  return isVariableFieldDefinitionRow(value) || isManualFieldDefinitionRow(value);
}

export function variableSuggestionFromStoredFieldDefinitionRow(
  row: Record<string, unknown> | null,
  lang: FieldSchemaEditorLang,
): VariableSuggestion | null {
  if (!row || row.kind !== "variable" || typeof row.source !== "string") {
    return null;
  }

  const label =
    translateText(row.label as LocalizedText | undefined, lang) ??
    (typeof row.key === "string" ? row.key : "");
  if (!label.trim()) {
    return null;
  }

  const source = row.source.trim();
  return {
    path: source.replace(/^\{\{\s*([^{}]+?)\s*\}\}$/, "$1"),
    displayPath: source,
    fieldPath: typeof row.key === "string" ? row.key : source,
    insertText: source,
    label,
    sourceNodeId: "stored-field-definition",
    sourceNodeLabel: lang === "nl" ? "Opgeslagen variabele" : "Stored variable",
    valueType:
      isFieldCardinalityCollection(row.cardinality)
        ? "array"
        : row.valueType === "number" || row.valueType === "integer"
          ? "number"
          : row.valueType === "boolean"
            ? "boolean"
            : row.valueType === "object"
              ? "object"
              : "string",
    fieldType:
      typeof row.valueType === "string"
        ? row.valueType as VariableSuggestion["fieldType"]
        : "string",
    ...(typeof row.semanticType === "string" ? { semanticType: row.semanticType } : {}),
  };
}

function normalizeFieldDefinitionEditorRow(
  value: unknown,
  createEmptyField: () => Field,
): unknown {
  if (isVariableFieldDefinitionRow(value)) {
    const source = typeof value.source === "string" ? value.source : "";
    return {
      ...value,
      kind: "variable" as const,
      source,
    };
  }

  if (isManualFieldDefinitionRow(value)) {
    return {
      ...value,
      kind: "manual" as const,
      field: normalizeFieldSchemaDraft(value.field, createEmptyField),
    };
  }

  return normalizeFieldSchemaDraft(value, createEmptyField);
}

export function normalizeFieldDefinitionEditorRows(
  values: unknown[],
  profile: FieldAuthoringProfile,
): unknown[] {
  const rows = values.map((value) =>
    normalizeFieldDefinitionEditorRow(value, profile.createEmptyField),
  );
  if (rows.some(isFieldDefinitionSourceRow)) {
    return rows;
  }
  return profile.normalizeItems?.(rows as Field[]) ?? rows;
}

export function getFieldFromEditorRow(
  row: unknown,
  createEmptyField: () => Field,
): Field | null {
  if (isVariableFieldDefinitionRow(row)) {
    return normalizeFieldSchemaDraft(row, createEmptyField);
  }
  if (isManualFieldDefinitionRow(row)) {
    return normalizeFieldSchemaDraft(row.field, createEmptyField);
  }
  return normalizeFieldSchemaDraft(row, createEmptyField);
}

export function getEditableFieldFromEditorRow(
  row: unknown,
  createEmptyField: () => Field,
): Field | null {
  if (isVariableFieldDefinitionRow(row)) {
    return null;
  }
  return getFieldFromEditorRow(row, createEmptyField);
}

export function replaceFieldInEditorRow(row: unknown, nextField: Field): unknown {
  if (isManualFieldDefinitionRow(row)) {
    return {
      ...row,
      field: nextField,
    };
  }
  return nextField;
}

export function fieldRowsForSiblingChecks(
  rows: unknown[],
  profile: FieldAuthoringProfile,
): Field[] {
  return rows.flatMap((row) => {
    const field = getFieldFromEditorRow(row, profile.createEmptyField);
    return field ? [field] : [];
  });
}
