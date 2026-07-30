// SPDX-License-Identifier: BUSL-1.1
import type {
  DataClassification,
  Field,
  FieldOptions,
  FieldPersisted,
  LocalizedText,
  RetentionPolicy,
  SemanticTypeDefinition,
  VisibilityCondition,
} from "@/generated/compiler/field-contract";
import { COMPILER_SEMANTIC_TYPES } from "@/generated/compiler/semantic-types";

export const EMPTY_SELECT_VALUE = "__empty__";

export const SEMANTIC_TYPE_OPTIONS = Object.entries(COMPILER_SEMANTIC_TYPES).map(
  ([value, definition]) => {
    const typedDefinition = definition as SemanticTypeDefinition;
    return {
      value,
      label: typedDefinition.label,
      valueType: typedDefinition.valueType,
      cardinality: typedDefinition.cardinality ?? "single",
    };
  },
);

const FIELD_TYPE_TO_SEMANTIC_VALUE_TYPES: Record<string, readonly string[]> = {
  string: ["string"],
  date: ["date"],
  datetime: ["datetime"],
  integer: ["number"],
  number: ["number"],
  boolean: ["boolean"],
  object: ["object"],
  collection: [],
  fieldDefinition: [],
};

export function getSemanticTypeOptionsForFieldType(fieldType: string) {
  const allowed = FIELD_TYPE_TO_SEMANTIC_VALUE_TYPES[fieldType];
  if (!allowed || allowed.length === 0) return [];
  return SEMANTIC_TYPE_OPTIONS.filter((opt) => allowed.includes(opt.valueType));
}

export function getSemanticTypeOptionsForFieldShape(field: Field) {
  if ((field.cardinality ?? "single") === "collection") return [];
  return SEMANTIC_TYPE_OPTIONS.filter((opt) => opt.valueType === field.valueType);
}

export const FIELD_OPTIONS_TYPE_OPTIONS: Array<{
  value: NonNullable<FieldOptions["type"]>;
  label: LocalizedText;
}> = [
  { value: "static", label: { nl: "Statisch", en: "Static" } },
  {
    value: "referentiedata",
    label: { nl: "Referentiedata", en: "Reference data" },
  },
  { value: "remote", label: { nl: "Remote", en: "Remote" } },
];

export const VISIBILITY_LOGIC_OPTIONS = [
  { value: "and", label: { nl: "En", en: "And" } },
  { value: "or", label: { nl: "Of", en: "Or" } },
] as const;

export const VISIBILITY_OPERATOR_OPTIONS: Array<{
  value: VisibilityCondition["operator"];
  label: LocalizedText;
}> = [
  { value: "eq", label: { nl: "Is gelijk aan", en: "Equals" } },
  { value: "neq", label: { nl: "Is niet gelijk aan", en: "Not equal" } },
  { value: "in", label: { nl: "Zit in", en: "In" } },
  { value: "notIn", label: { nl: "Zit niet in", en: "Not in" } },
  { value: "gt", label: { nl: "Groter dan", en: "Greater than" } },
  { value: "lt", label: { nl: "Kleiner dan", en: "Less than" } },
  { value: "gte", label: { nl: "Groter dan of gelijk", en: "Greater or equal" } },
  { value: "lte", label: { nl: "Kleiner dan of gelijk", en: "Less or equal" } },
  { value: "isEmpty", label: { nl: "Is leeg", en: "Is empty" } },
  { value: "isNotEmpty", label: { nl: "Is niet leeg", en: "Is not empty" } },
];

export const CLASSIFICATION_SENSITIVITY_OPTIONS: Array<{
  value: DataClassification["sensitivity"];
  label: LocalizedText;
}> = [
  { value: "public", label: { nl: "Publiek", en: "Public" } },
  { value: "internal", label: { nl: "Intern", en: "Internal" } },
  { value: "confidential", label: { nl: "Vertrouwelijk", en: "Confidential" } },
  { value: "pii", label: { nl: "PII", en: "PII" } },
  { value: "bsn", label: { nl: "BSN", en: "BSN" } },
];

export const RETENTION_ACTION_OPTIONS: Array<{
  value: NonNullable<NonNullable<RetentionPolicy["disposition"]>["action"]>;
  label: LocalizedText;
}> = [
  { value: "keep", label: { nl: "Bewaren", en: "Keep" } },
  { value: "archive", label: { nl: "Archiveren", en: "Archive" } },
  { value: "delete", label: { nl: "Verwijderen", en: "Delete" } },
  { value: "anonymize", label: { nl: "Anonimiseren", en: "Anonymize" } },
  { value: "mask", label: { nl: "Maskeren", en: "Mask" } },
  { value: "review", label: { nl: "Beoordelen", en: "Review" } },
  { value: "cryptoDelete", label: { nl: "Cryptografisch verwijderen", en: "Crypto delete" } },
];

export const PERSISTED_STORAGE_CLASS_OPTIONS: Array<{
  value: FieldPersisted["storageClass"];
  label: LocalizedText;
}> = [
  { value: "core", label: { nl: "Core", en: "Core" } },
  { value: "profile", label: { nl: "Profiel", en: "Profile" } },
];

export const RAW_JSON_PROPERTIES = [
  {
    key: "value",
    label: { nl: "Waarde (JSON)", en: "Value (JSON)" },
  },
  {
    key: "validation",
    label: { nl: "Validatie (JSON)", en: "Validation (JSON)" },
  },
  {
    key: "visibility",
    label: { nl: "Zichtbaarheid (JSON)", en: "Visibility (JSON)" },
  },
  {
    key: "computed",
    label: { nl: "Computed (JSON)", en: "Computed (JSON)" },
  },
  {
    key: "options",
    label: { nl: "Opties (JSON)", en: "Options (JSON)" },
  },
  {
    key: "persisted",
    label: { nl: "Persisted (JSON)", en: "Persisted (JSON)" },
  },
  {
    key: "render",
    label: { nl: "Render (JSON)", en: "Render (JSON)" },
  },
  {
    key: "permissions",
    label: { nl: "Permissies (JSON)", en: "Permissions (JSON)" },
  },
  {
    key: "classification",
    label: { nl: "Classificatie (JSON)", en: "Classification (JSON)" },
  },
  {
    key: "retention",
    label: { nl: "Retention (JSON)", en: "Retention (JSON)" },
  },
  {
    key: "hints",
    label: { nl: "Hints (JSON)", en: "Hints (JSON)" },
  },
  {
    key: "relationship",
    label: { nl: "Relatie (JSON)", en: "Relationship (JSON)" },
  },
] as const satisfies ReadonlyArray<{
  key: keyof Field;
  label: LocalizedText;
}>;
