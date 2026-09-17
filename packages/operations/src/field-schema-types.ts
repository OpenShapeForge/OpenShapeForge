// SPDX-License-Identifier: BUSL-1.1
/** Input and registry types for the FieldDefinition to JSON Schema projection. */

export type OperationJsonSchema = Record<string, unknown>;
export type OperationLocalizedText = string | Readonly<{
  en?: string;
  nl?: string;
  fr?: string;
}>;

export type OperationFieldValidation = {
  minLength?: unknown;
  maxLength?: unknown;
  min?: unknown;
  max?: unknown;
  pattern?: unknown;
  format?: string;
  minItems?: unknown;
};

export type OperationFieldOptions = {
  type: "static" | "referentiedata" | "remote" | "dynamic";
  items?: readonly {
    value: string;
    label: OperationLocalizedText;
  }[];
  referentieGroep?: string;
};

export type OperationFieldBaseType = "string" | "integer" | "number" | "boolean" | "date" | "datetime" | "object";

export type OperationFieldDefinition = {
  key: string;
  /** A base type, a semantic-type catalog key, or an entity name. */
  osfType: string;
  cardinality?: "single" | "collection" | { min?: number; max?: number | "unbounded" };
  required?: boolean;
  label?: OperationLocalizedText;
  description?: OperationLocalizedText;
  help?: OperationLocalizedText;
  unit?: string;
  defaultValue?: unknown;
  validation?: OperationFieldValidation;
  options?: OperationFieldOptions;
  reference?: { kind?: string; group?: string };
  render?: { props?: Readonly<Record<string, unknown>> };
  relationship?: { entity?: string };
  computed?: { expression?: string };
  shape?: readonly OperationFieldDefinition[];
  children?: readonly OperationFieldDefinition[];
  item?: OperationFieldDefinition;
};

export type OperationFieldSemanticType = {
  kind?: string;
  entity?: string;
  valueType: OperationFieldBaseType;
  cardinality?: OperationFieldDefinition["cardinality"];
  label?: OperationLocalizedText;
  validation?: OperationFieldValidation;
  shape?: readonly OperationFieldDefinition[];
  children?: readonly OperationFieldDefinition[];
  item?: OperationFieldDefinition;
};

export type OperationFieldSchemaRegistry = {
  semanticTypes?: Readonly<Record<string, OperationFieldSemanticType>>;
  referentiedata?: Readonly<Record<string, readonly {
    value: string;
    label: OperationLocalizedText;
  }[]>>;
  /** Self-contained definitions used by the recursive fieldDefinition type. */
  fieldDefinitionDefinitions?: OperationJsonSchema;
};

export type OperationFieldSchemaOptions = {
  includeDefault?: boolean;
  requireNestedRequired?: boolean;
  defaultsAreMaterialized?: boolean;
};

export type ResolvedOperationField = {
  key: string;
  valueType: OperationFieldBaseType;
  cardinality: "single" | "collection";
  cardinalityBounds?: { min?: number; max?: number | "unbounded" };
  required: boolean;
  label: OperationLocalizedText;
  description?: OperationLocalizedText;
  help?: OperationLocalizedText;
  osfType: string;
  unit?: string;
  defaultValue?: unknown;
  validation?: OperationFieldValidation;
  options?: OperationFieldOptions;
  relationship?: { entity?: string };
  computed?: { expression?: string };
  children?: ResolvedOperationField[];
  item?: ResolvedOperationField;
};
