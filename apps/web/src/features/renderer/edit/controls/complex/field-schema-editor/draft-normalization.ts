// SPDX-License-Identifier: BUSL-1.1
import type { Field, LocalizedText } from "@/generated/compiler/field-contract";
import type { FieldAuthoringProfile, FieldWithAuthoringMetadata } from "@/lib/field-authoring/profiles";
import { EMPTY_SELECT_VALUE } from "./constants";
import {
  cloneValue,
  isRecord,
  normalizeClassification,
  normalizeComputed,
  normalizeFieldCardinality,
  normalizeHints,
  normalizeOptions,
  normalizePermissions,
  normalizePersisted,
  normalizeRender,
  normalizeRetention,
  normalizeValidation,
  normalizeVisibility,
} from "./utils";

export function trimOptionalString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function normalizeSemanticTypeDraft(value: unknown) {
  const normalized = trimOptionalString(value);
  return normalized === EMPTY_SELECT_VALUE ? undefined : normalized;
}

function normalizeFieldAuthoringMetadata(
  value: unknown,
): FieldWithAuthoringMetadata["authoring"] {
  if (!isRecord(value)) {
    return undefined;
  }

  const visibleProperties = Array.isArray(value.visibleProperties)
    ? value.visibleProperties.filter((property): property is string =>
        typeof property === "string" && property.trim().length > 0,
      )
    : undefined;

  return {
    ...(trimOptionalString(value.profile) ? { profile: trimOptionalString(value.profile) } : {}),
    ...(value.pinned === true ? { pinned: true } : {}),
    ...(value.locked === true ? { locked: true } : {}),
    ...(value.singleton === true ? { singleton: true } : {}),
    ...(visibleProperties && visibleProperties.length > 0
      ? { visibleProperties }
      : {}),
  };
}

export function normalizeLocalizedTextDraft(value: unknown): LocalizedText | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const nl = trimOptionalString(record.nl);
  const en = trimOptionalString(record.en);
  const fr = trimOptionalString(record.fr);

  if (!nl && !en && !fr) {
    return undefined;
  }

  return {
    ...(nl ? { nl } : {}),
    ...(en ? { en } : {}),
    ...(fr ? { fr } : {}),
  };
}

function deriveGeneratedFieldKey(value: string, fallback = "") {
  const parts = value
    .trim()
    .replace(/[^a-zA-Z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  if (parts.length === 0) return fallback;

  const camel = parts
    .map((part, i) =>
      i === 0
        ? part.toLowerCase()
        : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase(),
    )
    .join("");

  return camel.length > 0 ? camel : fallback;
}

function getFieldLabelSeed(field: Pick<Field, "label">) {
  const label = normalizeLocalizedTextDraft(field.label);
  return label?.nl ?? label?.en ?? label?.fr ?? "";
}

export function normalizeRelationshipDraft(
  value: Field["relationship"] | undefined,
): Field["relationship"] {
  if (!value) {
    return undefined;
  }

  const kind = value.kind === "hasMany" ? "hasMany" : "belongsTo";
  const entity = trimOptionalString(value.entity);
  if (!entity) {
    return undefined;
  }

  return {
    kind,
    entity,
    ...(trimOptionalString(value.foreignKey) ? { foreignKey: value.foreignKey?.trim() } : {}),
    ...(trimOptionalString(value.displayField) ? { displayField: value.displayField?.trim() } : {}),
  };
}


export function applyFieldAuthoringProfileRules(
  previousField: Field | undefined,
  nextField: Field,
  profile: FieldAuthoringProfile,
) {
  if (profile.keyBehavior !== "generatedFromLabel") {
    return nextField;
  }

  const nextDerivedKey = deriveGeneratedFieldKey(getFieldLabelSeed(nextField));
  if (nextDerivedKey.length === 0) {
    return nextField;
  }

  const previousKey = trimOptionalString(previousField?.key) ?? "";
  const previousDerivedKey = previousField
    ? deriveGeneratedFieldKey(getFieldLabelSeed(previousField))
    : "";
  const nextKey = trimOptionalString(nextField.key) ?? "";

  if (nextKey.length === 0) {
    return {
      ...nextField,
      key: nextDerivedKey,
    };
  }

  if (previousKey.length > 0 && previousKey === nextKey && previousKey === previousDerivedKey) {
    return {
      ...nextField,
      key: nextDerivedKey,
    };
  }

  return nextField;
}

export function normalizeFieldSchemaDraft(
  value: unknown,
  createEmptyField: () => Field,
): Field {
  const field = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Field)
    : createEmptyField();

  const fallback = createEmptyField();
  const valueType = field.valueType ?? fallback.valueType;
  const fieldWithShape = field as FieldWithAuthoringMetadata;
  const structuredCardinality = normalizeFieldCardinality(
    field.cardinality,
    field.required === true,
  );
  const rawShape = Array.isArray(fieldWithShape.shape)
    ? fieldWithShape.shape
    : Array.isArray(field.children)
      ? field.children
      : field.item && Array.isArray(field.item.children)
        ? field.item.children
      : undefined;
  const children = valueType === "object" && rawShape
    ? rawShape.map((child) =>
        normalizeFieldSchemaDraft(child, createEmptyField))
    : undefined;
  const authoring = normalizeFieldAuthoringMetadata(fieldWithShape.authoring);

  return {
    key: typeof field.key === "string" ? field.key : "",
    valueType,
    cardinality: structuredCardinality,
    ...(field.variables ? { variables: field.variables } : {}),
    ...(field.sortable === true ? { sortable: true } : {}),
    required: structuredCardinality.min > 0,
    ...(field.readOnly === true ? { readOnly: true } : {}),
    ...(normalizeLocalizedTextDraft(field.label)
      ? { label: normalizeLocalizedTextDraft(field.label) }
      : {}),
    ...(normalizeLocalizedTextDraft(field.description)
      ? { description: normalizeLocalizedTextDraft(field.description) }
      : {}),
    ...(normalizeLocalizedTextDraft(field.placeholder)
      ? { placeholder: normalizeLocalizedTextDraft(field.placeholder) }
      : {}),
    ...(normalizeLocalizedTextDraft(field.help)
      ? { help: normalizeLocalizedTextDraft(field.help) }
      : {}),
    ...(normalizeSemanticTypeDraft(field.semanticType)
      ? { semanticType: normalizeSemanticTypeDraft(field.semanticType) }
      : {}),
    ...(trimOptionalString(field.unit) ? { unit: trimOptionalString(field.unit) } : {}),
    ...(trimOptionalString(field.currency)
      ? { currency: trimOptionalString(field.currency) }
      : {}),
    ...(field.defaultValue !== undefined ? { defaultValue: field.defaultValue } : {}),
    ...(field.value !== undefined ? { value: cloneValue(field.value) } : {}),
    ...(normalizeValidation(field.validation)
      ? { validation: normalizeValidation(field.validation) }
      : {}),
    ...(normalizeVisibility(field.visibility)
      ? { visibility: normalizeVisibility(field.visibility) }
      : {}),
    ...(normalizeComputed(field.computed)
      ? { computed: normalizeComputed(field.computed) }
      : {}),
    ...(normalizeOptions(field.options)
      ? { options: normalizeOptions(field.options) }
      : {}),
    ...(normalizeRender(field.render)
      ? { render: normalizeRender(field.render) }
      : {}),
    ...(normalizePermissions(field.permissions)
      ? { permissions: normalizePermissions(field.permissions) }
      : {}),
    ...(normalizeClassification(field.classification)
      ? { classification: normalizeClassification(field.classification) }
      : {}),
    ...(normalizeRetention(field.retention)
      ? { retention: normalizeRetention(field.retention) }
      : {}),
    ...(typeof field.audit === "boolean" && field.audit ? { audit: true } : {}),
    ...(normalizeHints(field.hints ?? {})
      ? { hints: normalizeHints(field.hints ?? {}) }
      : {}),
    ...(normalizeRelationshipDraft(field.relationship)
      ? { relationship: normalizeRelationshipDraft(field.relationship) }
      : {}),
    ...(typeof field.layoutFraction === "number" &&
    Number.isFinite(field.layoutFraction)
      ? { layoutFraction: field.layoutFraction }
      : {}),
    ...(field.localized ? { localized: true } : {}),
    ...(children ? { shape: children, children } : {}),
    ...(authoring ? { authoring } : {}),
    ...(normalizePersisted(field.persisted)
      ? { persisted: normalizePersisted(field.persisted) }
      : {}),
  } as Field;
}
