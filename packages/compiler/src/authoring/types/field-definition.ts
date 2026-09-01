// SPDX-License-Identifier: BUSL-1.1
import type {
  ComputedField,
  ContextHints,
  DataClassification,
  FieldAuthorizationConfig,
  FieldOptions,
  FieldPersisted,
  FieldPermissions,
  FieldRender,
  FieldValidation,
  LocalizedText,
  RetentionPolicy,
  VisibilityConfig,
} from "./common.js";

export type FieldDefinitionValueType =
  | "string"
  | "integer"
  | "number"
  | "boolean"
  | "date"
  | "datetime"
  | "object";

export type FieldDefinitionCardinality =
  | "single"
  | "collection"
  | {
      min?: number;
      max?: number | "unbounded";
    };

export type FieldDefinitionVariableMode = "none" | "whole" | "template" | "both";

export type FieldDefinitionSemanticTypeKind =
  | "scalar"
  | "entityId"
  | "entity"
  | "object";

export type FieldDefinitionValidation = FieldValidation;

export interface FieldDefinitionRelationship {
  kind: "belongsTo" | "hasMany";
  entity: string;
  foreignKey?: string;
  displayField?: string;
}

export interface FieldDefinitionSuggestions {
  /** Key of a sibling field whose value determines the available suggestions. */
  sourceField?: string;
  /**
   * WEB-020 — Key of a form-level `FormVariableSource` the field opts into for
   * its `$`-triggered variable picker. Replaces the per-field `sourceField`
   * indirection for forms that declare their own variable sources.
   */
  sourceKey?: string;
}

export interface FieldDefinitionRuntimeMetadata {
  aliases?: string[];
  required?: boolean;
}

export interface FieldDefinitionAuthoringMetadata {
  profile?: string;
  pinned?: boolean;
  locked?: boolean;
  singleton?: boolean;
  visibleProperties?: string[];
}

/**
 * Canonical authored definition of one data field.
 *
 * `children` and `item` deliberately recurse into this same contract. Keep
 * transport schemas as projections of this type instead of copying a reduced
 * field shape into each surface.
 */
export interface FieldDefinition {
  key: string;
  valueType: FieldDefinitionValueType;
  cardinality?: FieldDefinitionCardinality;
  variables?: FieldDefinitionVariableMode;
  /** May participate in free-text list search when the active transport supports it. */
  searchable?: boolean;
  /** May be named in a structured list filter. */
  filterable?: boolean;
  /** May be named as a list sort key. */
  sortable?: boolean;
  required?: boolean;
  /** Presentation only; selects the display component instead of the input. */
  readOnly?: boolean;
  /**
   * API contract: settable at create, refused on update by every generated
   * transport. Distinct from `readOnly`, which is a rendering choice (#177).
   */
  immutable?: boolean;
  label?: LocalizedText;
  description?: LocalizedText;
  placeholder?: LocalizedText;
  help?: LocalizedText;
  semanticType?: string;
  unit?: string;
  currency?: string;
  value?: unknown;
  defaultValue?: unknown;
  validation?: FieldDefinitionValidation;
  relationship?: FieldDefinitionRelationship;
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
  suggestions?: FieldDefinitionSuggestions;
  runtime?: FieldDefinitionRuntimeMetadata;
  workflowInspector?: FieldDefinitionWorkflowInspector;
  layoutFraction?: number;
  /**
   * When `true`, the field's *value* is `LocalizedText`-shaped
   * (`{ nl?, en?, fr? }`) and the renderer scopes reads/writes to the active
   * `ctx.lang`. Use for any scalar leaf whose content needs to differ per
   * language (labels, descriptions, button text, …).
   */
  localized?: boolean;
  shape?: FieldDefinition[];
  authoring?: FieldDefinitionAuthoringMetadata;
  children?: FieldDefinition[];
  item?: FieldDefinition;
}

export interface FieldDefinitionWorkflowInspector {
  objectPresentation?: "inlineChildren";
  displayMode?: "hidden" | "display" | "readOnly";
}

export interface FieldDefinitionSemanticType {
  kind?: FieldDefinitionSemanticTypeKind;
  label: LocalizedText;
  pluralLabel?: LocalizedText;
  valueType: FieldDefinitionValueType;
  cardinality?: FieldDefinitionCardinality;
  validation?: FieldDefinitionValidation;
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
  shape?: FieldDefinition[];
  children?: FieldDefinition[];
}
