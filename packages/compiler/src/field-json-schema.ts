// SPDX-License-Identifier: BUSL-1.1
/**
 * Field → JSON Schema mappings shared by every surface that publishes a
 * schema.
 *
 * Connector operation fields use the structural constraint core. Compiled
 * entity fields additionally use the rich projector at the bottom of this
 * file, shared by MCP and OpenAPI. If either transport mapped `maxLength`,
 * nested shapes, or enumerations independently, their advertised contracts
 * would drift even though they came from the same authored field.
 *
 * The rich projector is still a projection, not a second semantic model. Its
 * only inputs are the existing `CompiledField` and the already-resolved core
 * reference-data snapshot.
 */

import type { CompiledField } from "./authoring/types.js";
import type { LocalizedText } from "./authoring/types/common.js";
import type { CoreReferentiedataSnapshot } from "./core-referentiedata-artifacts.js";
import fieldDefinitionAuthoringSchema from "../config/schemas/field-definition.schema.json" with {
  type: "json",
};
import workflowInspectorSchema from "../config/schemas/workflow-inspector.schema.json" with {
  type: "json",
};

export type JsonObject = Record<string, unknown>;

export const FIELD_DEFINITION_SEMANTIC_TYPE = "fieldDefinition";
export const FIELD_DEFINITION_SCHEMA_REF = "#/$defs/fieldDefinition";

const WORKFLOW_INSPECTOR_SCHEMA_ID =
  "https://openshapeforge.example/schema-common/workflow-inspector.schema.json";

const {
  $schema: _workflowDialect,
  $id: _workflowId,
  title: _workflowTitle,
  ...workflowInspector
} = workflowInspectorSchema;
const fieldDefinitionDefinitions = {
  ...(JSON.parse(
    JSON.stringify(fieldDefinitionAuthoringSchema.$defs).replaceAll(
      WORKFLOW_INSPECTOR_SCHEMA_ID,
      "#/$defs/workflowInspector",
    ),
  ) as JsonObject),
  workflowInspector,
};

/**
 * The structural minimum this mapping reads. Both `CompiledField` (compiled
 * entity model) and `FieldDefinition` (authored connector operation fields)
 * satisfy it, so neither consumer has to convert.
 */
export type SchemaSourceField = {
  key: string;
  valueType?: string;
  cardinality?: unknown;
  required?: boolean;
  defaultValue?: unknown;
  semanticType?: string;
  children?: SchemaSourceField[];
  item?: SchemaSourceField;
  validation?: {
    minLength?: unknown;
    maxLength?: unknown;
    min?: unknown;
    max?: unknown;
    pattern?: unknown;
    format?: string;
    minItems?: unknown;
  };
};

export function usesFieldDefinitionSchema(field: SchemaSourceField): boolean {
  return (
    field.semanticType === FIELD_DEFINITION_SEMANTIC_TYPE ||
    field.children?.some(usesFieldDefinitionSchema) === true ||
    (field.item !== undefined && usesFieldDefinitionSchema(field.item))
  );
}

export function fieldDefinitionValueSchema(): JsonObject {
  return { $ref: FIELD_DEFINITION_SCHEMA_REF };
}

export function bundleFieldDefinitionSchema(
  schema: JsonObject,
  fields: SchemaSourceField[],
): JsonObject {
  if (!fields.some(usesFieldDefinitionSchema)) return schema;
  const existingDefinitions =
    schema.$defs && typeof schema.$defs === "object" && !Array.isArray(schema.$defs)
      ? (schema.$defs as JsonObject)
      : {};
  return {
    ...schema,
    $defs: {
      ...existingDefinitions,
      ...structuredClone(fieldDefinitionDefinitions),
    },
  };
}

/** Rebase only JSON Schema references, leaving descriptions and values intact. */
export function rebaseJsonSchemaReferences(
  value: unknown,
  fromBase: string,
  toBase: string,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => rebaseJsonSchemaReferences(entry, fromBase, toBase));
  }
  if (!value || typeof value !== "object") return value;

  const rebased: JsonObject = {};
  for (const [key, entry] of Object.entries(value as JsonObject)) {
    rebased[key] =
      key === "$ref" && typeof entry === "string" && entry.startsWith(fromBase)
        ? `${toBase}${entry.slice(fromBase.length)}`
        : rebaseJsonSchemaReferences(entry, fromBase, toBase);
  }
  return rebased;
}

/** Move reusable definitions when a complete schema is nested in another root. */
export function splitBundledDefinitions(schema: JsonObject): {
  schema: JsonObject;
  definitions: JsonObject;
} {
  const { $defs, ...unbundled } = schema;
  return {
    schema: unbundled,
    definitions:
      $defs && typeof $defs === "object" && !Array.isArray($defs)
        ? ($defs as JsonObject)
        : {},
  };
}

/** Unwrap `x` or `{ value: x }` — validation rules carry either. */
export function ruleValue(
  rule: unknown,
): number | string | boolean | undefined {
  if (rule === undefined || rule === null) return undefined;
  if (typeof rule === "object" && "value" in (rule as JsonObject)) {
    const inner = (rule as { value: unknown }).value;
    return typeof inner === "number" ||
      typeof inner === "string" ||
      typeof inner === "boolean"
      ? inner
      : undefined;
  }
  return typeof rule === "number" ||
    typeof rule === "string" ||
    typeof rule === "boolean"
    ? rule
    : undefined;
}

export function numericRule(rule: unknown): number | undefined {
  const value = ruleValue(rule);
  return typeof value === "number" ? value : undefined;
}

export function stringRule(rule: unknown): string | undefined {
  const value = ruleValue(rule);
  return typeof value === "string" ? value : undefined;
}

export function baseTypeFor(field: SchemaSourceField): JsonObject {
  switch (field.valueType) {
    case "boolean":
      return { type: "boolean" };
    case "integer":
      return { type: "integer" };
    case "number":
      return { type: "number" };
    case "date":
      return { type: "string", format: "date" };
    case "datetime":
      return { type: "string", format: "date-time" };
    case "object":
      return { type: "object" };
    case "string":
    default:
      return { type: "string" };
  }
}

/**
 * Base type plus every authored validation bound. Deliberately does NOT add
 * `enum`, `description` or `default` — see the file header on key order.
 */
export function constraintsForField(field: SchemaSourceField): JsonObject {
  const scalar: JsonObject = baseTypeFor(field);
  const validation = field.validation;
  if (!validation) return scalar;

  const minLength = numericRule(validation.minLength);
  const maxLength = numericRule(validation.maxLength);
  const min = numericRule(validation.min);
  const max = numericRule(validation.max);
  const pattern = stringRule(validation.pattern);

  if (minLength !== undefined) scalar.minLength = minLength;
  if (maxLength !== undefined) scalar.maxLength = maxLength;
  if (min !== undefined) scalar.minimum = min;
  if (max !== undefined) scalar.maximum = max;
  if (pattern !== undefined) scalar.pattern = pattern;
  // `format: uuid` is both a JSON Schema format and the signal the storage
  // layer uses to pick a uuid column, so it carries through unchanged.
  if (validation.format !== undefined) scalar.format = validation.format;

  return scalar;
}

export function isCollection(field: SchemaSourceField): boolean {
  return field.cardinality === "collection";
}

/**
 * Wrap a finished scalar schema as an array. The scalar shape becomes the item
 * shape; a description on the array itself is more useful than one buried in
 * `items`.
 */
export function applyCollectionShape(
  scalar: JsonObject,
  field: SchemaSourceField,
): JsonObject {
  const { description, ...items } = scalar;
  const array: JsonObject = { type: "array", items };
  if (description !== undefined) array.description = description;
  const minItems = numericRule(field.validation?.minItems);
  if (minItems !== undefined) array.minItems = minItems;
  return array;
}

/**
 * Assemble an object schema from per-field schemas. `additionalProperties` is
 * always false: an unknown property is a caller error worth surfacing, not
 * something to drop silently.
 */
export function objectSchemaFrom(
  fields: SchemaSourceField[],
  schemaForField: (field: SchemaSourceField) => JsonObject,
  options: { requireRequired: boolean; defaultsAreMaterialized?: boolean },
): JsonObject {
  const properties: JsonObject = {};
  const required: string[] = [];
  for (const field of fields) {
    properties[field.key] = schemaForField(field);
    // A default makes a required field omittable only on transports that
    // actually materialize it. Connector contract validators deliberately do
    // not, so their callers keep the stricter boundary.
    if (
      options.requireRequired &&
      field.required &&
      (!options.defaultsAreMaterialized || field.defaultValue === undefined)
    ) {
      required.push(field.key);
    }
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

export function localizedText(
  value: LocalizedText | string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value.trim() || undefined;
  return (value.en ?? value.nl ?? value.fr)?.trim() || undefined;
}

/**
 * Compose the stable, human-facing description shared by generated transport
 * schemas. Transport-specific instructions are deliberately added by the
 * consumer instead of leaking into every projection.
 */
export type CompiledFieldDescriptionOptions = {
  relationshipInstruction?: string;
};

export function describeCompiledField(
  field: CompiledField,
  options: CompiledFieldDescriptionOptions = {},
): string | undefined {
  const parts: string[] = [];
  const label = localizedText(field.label);
  const description = localizedText(field.description);
  const help = localizedText(field.help);

  if (description) {
    parts.push(description);
  } else if (label) {
    parts.push(label);
  }
  if (help) parts.push(help);
  if (field.unit) parts.push(`Unit: ${field.unit}.`);
  if (field.relationship?.entity) {
    const reference = `References the ${field.relationship.entity} entity`;
    parts.push(
      options.relationshipInstruction
        ? `${reference} — ${options.relationshipInstruction}`
        : `${reference}.`,
    );
  }
  if (field.computed?.expression) {
    parts.push("Derived server-side; any supplied value is ignored.");
  }

  return parts.length > 0 ? parts.join(" ") : undefined;
}

export type CompiledFieldDescription = (
  field: CompiledField,
) => string | undefined;

export type CompiledFieldSchemaOptions = {
  describeField?: CompiledFieldDescription;
  /** PATCH and filter schemas must never materialize authored defaults. */
  includeDefault?: boolean;
  /** Whether required children are structural inside nested object values. */
  requireNestedRequired?: boolean;
  /** Whether this transport applies defaults when the caller omits a value. */
  defaultsAreMaterialized?: boolean;
};

export type CompiledFieldEnumeration = {
  values: string[];
  labels: Map<string, string>;
};

/**
 * Resolve the two authoring spellings currently in the corpus. `options` is
 * canonical; `render.props.referentieGroep` remains a compatibility fallback
 * until those fields are normalized without changing unrelated generated UI.
 */
export function resolveCompiledFieldEnumeration(
  field: CompiledField,
  referentiedata: CoreReferentiedataSnapshot,
): CompiledFieldEnumeration | undefined {
  const options = field.options;
  const renderGroep = field.render?.props?.referentieGroep;

  if (options?.type === "static" && options.items && options.items.length > 0) {
    return {
      values: options.items.map((item) => item.value),
      labels: new Map(
        options.items.flatMap((item) => {
          const label = localizedText(item.label);
          return label ? [[item.value, label] as const] : [];
        }),
      ),
    };
  }

  const groep =
    options?.type === "referentiedata" && options.referentieGroep
      ? options.referentieGroep
      : typeof renderGroep === "string"
        ? renderGroep
        : undefined;
  if (!groep) return undefined;

  const items = referentiedata[groep] ?? [];
  if (items.length === 0) return undefined;
  return {
    values: items.map((item) => item.value),
    labels: new Map(
      items.flatMap((item) => {
        const label = localizedText(item.label);
        return label ? [[item.value, label] as const] : [];
      }),
    ),
  };
}

function compiledValueSchema(
  field: CompiledField,
  referentiedata: CoreReferentiedataSnapshot,
  options: CompiledFieldSchemaOptions,
): JsonObject {
  if (field.semanticType === FIELD_DEFINITION_SEMANTIC_TYPE) {
    return fieldDefinitionValueSchema();
  }
  if (
    field.valueType === "object" &&
    field.children &&
    field.children.length > 0
  ) {
    return compiledObjectSchemaWithoutDefinitions(field.children, referentiedata, {
      ...options,
      requireRequired: options.requireNestedRequired ?? true,
    });
  }
  return constraintsForField(field);
}

function addCompiledFieldMetadata(
  schema: JsonObject,
  field: CompiledField,
  enumeration: CompiledFieldEnumeration | undefined,
  describeField: CompiledFieldDescription,
  options: CompiledFieldSchemaOptions,
): JsonObject {
  const title = localizedText(field.label);
  if (title) {
    schema.title = title;
  }
  if (enumeration) {
    schema.enum = enumeration.values;
  }

  const descriptionParts: string[] = [];
  const fieldDescription = describeField(field);
  if (fieldDescription) descriptionParts.push(fieldDescription);
  if (enumeration && enumeration.labels.size > 0) {
    const rendered = enumeration.values
      .map((value) => {
        const label = enumeration.labels.get(value);
        return label ? `${value} (${label})` : value;
      })
      .join(", ");
    descriptionParts.push(`Allowed values: ${rendered}.`);
  }
  if (descriptionParts.length > 0) {
    schema.description = descriptionParts.join(" ");
  }

  if (field.defaultValue !== undefined && options.includeDefault !== false) {
    schema.default = field.defaultValue;
  }
  return schema;
}

/** Project one resolved entity field into deterministic JSON Schema. */
function compiledFieldSchemaWithoutDefinitions(
  field: CompiledField,
  referentiedata: CoreReferentiedataSnapshot = {},
  options: CompiledFieldSchemaOptions = {},
): JsonObject {
  const describeField = options.describeField ?? describeCompiledField;
  const enumeration = resolveCompiledFieldEnumeration(field, referentiedata);
  const valueSchema = addCompiledFieldMetadata(
    compiledValueSchema(field, referentiedata, options),
    field,
    enumeration,
    describeField,
    options,
  );

  if (!isCollection(field)) {
    return valueSchema;
  }

  const {
    title,
    description,
    default: defaultValue,
    ...outerItemSchema
  } = valueSchema;
  let items: JsonObject = field.item
    ? {
        allOf: [
          outerItemSchema,
          compiledFieldSchemaWithoutDefinitions(field.item, referentiedata, options),
        ],
      }
    : outerItemSchema;
  const array: JsonObject = { type: "array", items };
  if (title !== undefined) array.title = title;
  if (description !== undefined) array.description = description;
  if (defaultValue !== undefined) {
    if (Array.isArray(defaultValue)) {
      array.default = defaultValue;
    } else {
      items = { ...items, default: defaultValue };
      array.items = items;
    }
  }
  const minItems = numericRule(field.validation?.minItems);
  if (minItems !== undefined) array.minItems = minItems;
  return array;
}

/** Project one resolved entity field and bundle reusable definitions at the schema root. */
export function compiledFieldSchema(
  field: CompiledField,
  referentiedata: CoreReferentiedataSnapshot = {},
  options: CompiledFieldSchemaOptions = {},
): JsonObject {
  return bundleFieldDefinitionSchema(
    compiledFieldSchemaWithoutDefinitions(field, referentiedata, options),
    [field],
  );
}

function compiledObjectSchemaWithoutDefinitions(
  fields: CompiledField[],
  referentiedata: CoreReferentiedataSnapshot,
  options: { requireRequired: boolean } & CompiledFieldSchemaOptions,
): JsonObject {
  return objectSchemaFrom(
    fields,
    (field) =>
      compiledFieldSchemaWithoutDefinitions(field as CompiledField, referentiedata, options),
    options,
  );
}

/** Project a resolved field list into an object request/value schema. */
export function compiledObjectSchema(
  fields: CompiledField[],
  referentiedata: CoreReferentiedataSnapshot = {},
  options: { requireRequired: boolean } & CompiledFieldSchemaOptions,
): JsonObject {
  return bundleFieldDefinitionSchema(
    compiledObjectSchemaWithoutDefinitions(fields, referentiedata, options),
    fields,
  );
}
