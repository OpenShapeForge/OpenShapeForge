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

export type FieldDefinitionOsfTypeKind =
  | "scalar"
  | "entityId"
  | "entity"
  | "object";

export type FieldDefinitionEqualityConstraint = {
  eq: string | number | boolean;
};

/**
 * Deliberately bounded target-record predicate language. A field may require
 * exact scalar values and one related collection may require any matching
 * child. It is not a general expression language.
 */
export type FieldDefinitionRelationshipConstraints = Record<
  string,
  FieldDefinitionEqualityConstraint | {
    any: Record<string, FieldDefinitionEqualityConstraint>;
  }
>;

export type FieldDefinitionValidation = FieldValidation;

/**
 * How a single entity reference shapes the collection the compiler derives
 * for it on the target entity. Everything is optional: the key defaults to
 * the lower-camel plural of the referencing entity and the label to that
 * entity's plural labels (authored `pluralLabels`, else the English label
 * pluralised). Collection policy (ownership, ordering, owner-scoped
 * authorization, allowed value definitions) belongs to the collection and is
 * declared here because the collection itself is never authored.
 */
export interface FieldDefinitionInverseCollection {
  key?: string;
  label?: LocalizedText;
  ownership?: "owned" | "reference";
  sortable?: boolean;
  childAuthorization?: "owner";
  /** Boolean field of the referencing (owned) entity; the owner's update, move and remove refuse a child whose flag is set. */
  childLock?: string;
  allowedDefinitions?: string[];
}

export interface FieldDefinitionRelationship {
  /** Compiler-derived: `belongsTo` for a single reference, `hasMany` for a collection. */
  kind?: "belongsTo" | "hasMany";
  entity?: string;
  /**
   * On a single reference: the derived inverse collection (`false` declines
   * one). On a collection — derived, or an authored `via` traversal — the key
   * of the referencing field on the target entity.
   */
  inverse?: string | FieldDefinitionInverseCollection | false;
  /** Read-only inverse traversal through a local, single entity reference. */
  via?: string;
  /** Compiler-derived join source, not an authored SQL/storage choice. */
  through?: { field: string; column: string; target: string };
  ownership?: "owned" | "reference";
  /**
   * How a single reference relates to a versioned target: `current` (the
   * default, the target's editable head) or `pinned` (one immutable version,
   * moved only by an authored command). Metadata for readers of the manifest;
   * the foreign key itself already pins.
   */
  version?: "pinned" | "current";
  /** Compiler-derived identity; not authored twice beside osfType. */
  target?: string;
  fieldKey?: string;
  unique?: boolean;
  /** Compiler-derived from `persisted.column`; never authored. */
  foreignKey?: string;
  displayField?: string;
  /** Canonical validity rules for the referenced target record. */
  constraints?: FieldDefinitionRelationshipConstraints;
  /** Compiler-derived from the field's `provider`: the target's Operations resolve the reference. */
  provider?: FieldDefinitionProvider;
}

/**
 * A reference to a provider-backed entity (one declared by an Operation
 * catalog, without storage). The target's Operations resolve the related
 * records; `bindings` maps each Operation input field to the field of this
 * entity whose value fills it, so the caller never names the parent itself.
 */
export interface FieldDefinitionProvider {
  bindings: Record<string, string>;
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

/**
 * A persisted value owned by the entity runtime rather than by callers.
 *
 * The deliberately small vocabulary keeps this declarative: the source is
 * another field on the same entity, `slug` is the only transformation, and a
 * conflicting value is resolved under a compiler-verified unique index.
 */
export interface FieldDefinitionDeriveOnCreate {
  from: string;
  transform: "slug";
  onConflict: "suffix";
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
  /**
   * The one type axis. A base type (`string`, `integer`, `number`, `boolean`,
   * `date`, `datetime`, `object`), a osf-type catalog key, or an entity
   * name; the compiler derives the base type from the catalog.
   */
  osfType: string;
  cardinality?: FieldDefinitionCardinality;
  variables?: FieldDefinitionVariableMode;
  sortable?: boolean;
  /** A typed embedded entity value; relational leaves are lowered to real foreign keys. */
  entityValue?: { definitionField: string; parameterBindings?: boolean };
  /** Allowed entity-value definitions on this relationship collection. */
  allowedDefinitions?: string[];
  /**
   * `owner`: the owner's collection Operations on this field authorize its
   * owned children through the owner's update roles instead of requiring the
   * child entity's own roles. Explicit per collection; never implied.
   */
  childAuthorization?: "owner";
  /**
   * Key of a boolean field on the owned child. The owner's collection update,
   * move and remove Operations refuse a child whose flag is set.
   */
  childLock?: string;
  required?: boolean;
  /** Presentation only; selects the display component instead of the input. */
  readOnly?: boolean;
  /**
   * API contract: settable at create, refused on update by every generated
   * transport. Distinct from `readOnly`, which is a rendering choice (#177).
   */
  immutable?: boolean;
  /**
   * API contract: this field is written ONLY by the named operations, never
   * through generated create/update. Operation contract keys, e.g.
   * `["pentest.finding.review"]`.
   *
   * The third writability word next to `required` and `immutable`, and
   * deliberately not a fourth meaning for `readOnly` — that one picks a
   * display component and is enforced by nothing. A field carrying `writtenBy`
   * is absent from the generated create and update schemas on every transport,
   * and sending it anyway is refused with a message naming the operation that
   * may set it. Use it for fields that record that a process took place — a
   * review signed off, a scope approved, a retest concluded — where the
   * operation is the only place the preconditions are checked.
   *
   * A name that matches no compiled operation fails the build.
   */
  writtenBy?: string[];
  /** Server-owned, persisted value derived once when the entity is created. */
  deriveOnCreate?: FieldDefinitionDeriveOnCreate;
  label?: LocalizedText;
  description?: LocalizedText;
  placeholder?: LocalizedText;
  help?: LocalizedText;
  unit?: string;
  currency?: string;
  value?: unknown;
  defaultValue?: unknown;
  validation?: FieldDefinitionValidation;
  relationship?: FieldDefinitionRelationship;
  /** Authored only on a field whose osfType names a provider-backed entity. */
  provider?: FieldDefinitionProvider;
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

export interface FieldDefinitionOsfType {
  kind?: FieldDefinitionOsfTypeKind;
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
