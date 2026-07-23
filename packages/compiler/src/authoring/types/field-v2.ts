import type {
  ComputedField,
  ContextHints,
  DataClassification,
  FieldAuthorizationConfig,
  FieldOptions,
  FieldPersisted,
  FieldPermissions,
  FieldRender,
  LocalizedText,
  RetentionPolicy,
  ValidationRule,
  VisibilityConfig,
} from "./common.js";

export type FieldV2ValueType =
  | "string"
  | "integer"
  | "number"
  | "boolean"
  | "date"
  | "datetime"
  | "object";

export type FieldV2Cardinality =
  | "single"
  | "collection"
  | {
      min?: number;
      max?: number | "unbounded";
    };

export type FieldV2VariableMode = "none" | "whole" | "template" | "both";

export type FieldV2SemanticTypeKind =
  | "scalar"
  | "entityId"
  | "entity"
  | "object";

export interface FieldV2Validation {
  required?: boolean | ValidationRule;
  minLength?: number | ValidationRule;
  maxLength?: number | ValidationRule;
  minItems?: number | ValidationRule;
  min?: number | ValidationRule;
  max?: number | ValidationRule;
  pattern?: string | ValidationRule;
  format?: string;
  custom?: {
    name: string;
    message?: LocalizedText;
    params?: Record<string, unknown>;
  }[];
}

export interface FieldV2Relationship {
  kind: "belongsTo" | "hasMany";
  entity: string;
  foreignKey?: string;
  displayField?: string;
}

export interface FieldV2Suggestions {
  sourceField?: string;
  sourceKey?: string;
}

export interface FieldV2RuntimeMetadata {
  aliases?: string[];
  required?: boolean;
}

export interface FieldV2AuthoringMetadata {
  profile?: string;
  pinned?: boolean;
  locked?: boolean;
  singleton?: boolean;
  visibleProperties?: string[];
}

export interface FieldV2 {
  key: string;
  valueType: FieldV2ValueType;
  cardinality?: FieldV2Cardinality;
  variables?: FieldV2VariableMode;
  sortable?: boolean;
  required?: boolean;
  readOnly?: boolean;
  label?: LocalizedText;
  description?: LocalizedText;
  placeholder?: LocalizedText;
  help?: LocalizedText;
  semanticType?: string;
  unit?: string;
  currency?: string;
  value?: unknown;
  defaultValue?: unknown;
  validation?: FieldV2Validation;
  relationship?: FieldV2Relationship;
  options?: FieldOptions;
  persisted?: FieldPersisted;
  render?: FieldRender;
  permissions?: FieldPermissions;
  authorization?: FieldAuthorizationConfig;
  classification?: DataClassification;
  retention?: RetentionPolicy;
  audit?: boolean;
  hints?: ContextHints;
  visibility?: VisibilityConfig;
  computed?: ComputedField;
  suggestions?: FieldV2Suggestions;
  runtime?: FieldV2RuntimeMetadata;
  workflowInspector?: FieldV2WorkflowInspector;
  layoutFraction?: number;
  localized?: boolean;
  shape?: FieldV2[];
  authoring?: FieldV2AuthoringMetadata;
  children?: FieldV2[];
  item?: FieldV2;
}

export interface FieldV2WorkflowInspector {
  objectPresentation?: "inlineChildren";
  displayMode?: "hidden" | "display" | "readOnly";
}

export interface SemanticTypeDefinitionV2 {
  kind?: FieldV2SemanticTypeKind;
  label: LocalizedText;
  pluralLabel?: LocalizedText;
  valueType: FieldV2ValueType;
  cardinality?: FieldV2Cardinality;
  validation?: FieldV2Validation;
  options?: FieldOptions;
  render?: {
    display?: string;
    input?: string;
  };
  format?: string;
  icon?: string;
  props?: Record<string, unknown>;
  classification?: DataClassification;
  retention?: RetentionPolicy;
  audit?: boolean;
  hints?: ContextHints;
  entity?: string;
  listUrl?: string;
  displayTemplate?: string;
  filterField?: string;
  shape?: FieldV2[];
  children?: FieldV2[];
}
