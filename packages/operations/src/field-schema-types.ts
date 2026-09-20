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
  type: "static" | "referentiedata" | "remote" | "dynamic" | "entity";
  items?: readonly {
    value: string;
    label?: OperationLocalizedText;
  }[];
  referentieGroep?: string;
  /** `type: entity` — the entity whose records are the choices. */
  source?: string;
  valueField?: string;
};

export type OperationFieldBaseType = "string" | "integer" | "number" | "boolean" | "date" | "datetime" | "object";

/** `single`, `collection`, or exact bounds; `max` above one (or unbounded) makes a collection. */
export type OperationFieldCardinality = "single" | "collection" | { min?: number; max?: number | "unbounded" };

/** Bounded validity rules for a referenced record: per target field an equality, or `any` over a related collection. */
export type OperationReferenceConstraints = Readonly<Record<string, unknown>>;

export type OperationFieldRelationship = {
  kind?: "belongsTo" | "hasMany";
  /** Kebab-case slug of the target, the spelling the compiler derives. */
  entity?: string;
  /** The target entity name. */
  target?: string;
  constraints?: OperationReferenceConstraints;
};

export type OperationFieldDefinition = {
  key: string;
  /** A base type, a osf-type catalog key, or an entity name. */
  osfType: string;
  cardinality?: OperationFieldCardinality;
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
  relationship?: OperationFieldRelationship;
  computed?: { expression?: string };
  shape?: readonly OperationFieldDefinition[];
  children?: readonly OperationFieldDefinition[];
  item?: OperationFieldDefinition;
};

export type OperationFieldOsfType = {
  kind?: string;
  entity?: string;
  baseType: OperationFieldBaseType;
  /**
   * The complete value schema of this type, as a `$ref` into the bundled
   * definitions (`fieldDefinitionDefinitions`). A type that declares one is
   * projected through it instead of through its base type and shape, so a
   * recursive contract needs no engine code that knows its name.
   */
  schema?: OperationJsonSchema;
  cardinality?: OperationFieldCardinality;
  label?: OperationLocalizedText;
  validation?: OperationFieldValidation;
  options?: OperationFieldOptions;
  /** Where a value of this type is picked from when the field authors no options (a derived identity alias names its entity). */
  optionSource?: OperationFieldOptions;
  shape?: readonly OperationFieldDefinition[];
  children?: readonly OperationFieldDefinition[];
  item?: OperationFieldDefinition;
};

export type OperationFieldSchemaRegistry = {
  osfTypes?: Readonly<Record<string, OperationFieldOsfType>>;
  referentiedata?: Readonly<Record<string, readonly {
    value: string;
    label?: OperationLocalizedText;
  }[]>>;
  /**
   * The `$defs` a catalog type's `schema` may refer to (the authoring
   * field-definition schema's own definitions), bundled at the root of any
   * projected schema that refers to one of them.
   */
  fieldDefinitionDefinitions?: OperationJsonSchema;
};

export type OperationFieldSchemaOptions = {
  /** PATCH and filter schemas must never materialize authored defaults. */
  includeDefault?: boolean;
  /** Whether required children are structural inside nested object values. */
  requireNestedRequired?: boolean;
  /** Whether this transport applies defaults when the caller omits a value. */
  defaultsAreMaterialized?: boolean;
  /** Transport-specific prose; the default is `describeField`. */
  describeField?: (field: ResolvedOperationField) => string | undefined;
};

/**
 * A field with its type axis resolved: the base type every transport maps
 * to, the normalized cardinality, and every catalog default merged in. The
 * compiler's `CompiledField` satisfies it structurally; the runtime resolves
 * a stored definition into it through the host registry.
 */
export type ResolvedOperationField = {
  key: string;
  osfType: string;
  baseType: OperationFieldBaseType;
  cardinality: "single" | "collection";
  /** Exact authored collection bounds retained after cardinality normalization. */
  cardinalityBounds?: { min?: number; max?: number | "unbounded" };
  required: boolean;
  label: OperationLocalizedText;
  description?: OperationLocalizedText;
  help?: OperationLocalizedText;
  unit?: string;
  defaultValue?: unknown;
  validation?: OperationFieldValidation;
  options?: OperationFieldOptions;
  render?: { props?: Readonly<Record<string, unknown>> };
  relationship?: OperationFieldRelationship;
  computed?: { expression?: string };
  /** The catalog-declared value schema of the field's type, when it has one. */
  schema?: OperationJsonSchema;
  children?: readonly ResolvedOperationField[];
  item?: ResolvedOperationField;
};
