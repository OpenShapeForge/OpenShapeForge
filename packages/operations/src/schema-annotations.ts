// SPDX-License-Identifier: BUSL-1.1
import { exactNumericViolation, type ExactNumericBounds, type ExactNumericViolation } from "./exact-numeric.js";

/**
 * Form fields from an authorized record; execution still validates its
 * canonical definition. `field` is a FieldDefinition collection on the
 * Operation's target record; `input.field` is that collection on the record
 * chosen in the sibling input `input` (through its `x-osf-reference`).
 */
export const operationInputFieldsKeyword = {
  keyword: "x-osf-inputFields",
  schemaType: "string" as const,
  valid: true,
  metaSchema: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*(\\.[A-Za-z_][A-Za-z0-9_]*)?$" },
};

const equalityConstraint = {
  type: "object", required: ["eq"], additionalProperties: false,
  properties: { eq: { type: ["string", "number", "boolean"] } },
};
/**
 * The bounded constraints a field-owned relationship may carry, as the
 * compiler emits them (field-json-schema.ts) and interface-web types them
 * (WebRelationshipConstraints): per target field an equality, or `any` over
 * a related collection's fields.
 */
const relationshipConstraints = {
  type: "object",
  additionalProperties: {
    oneOf: [
      equalityConstraint,
      { type: "object", required: ["any"], additionalProperties: false,
        properties: { any: { type: "object", additionalProperties: equalityConstraint } } },
    ],
  },
};

/** Presentation metadata only: reading a choice never grants authority to use it. */
export const operationReferenceKeyword = {
  keyword: "x-osf-reference",
  schemaType: "object" as const,
  valid: true,
  metaSchema: {
    type: "object",
    required: ["entity"],
    additionalProperties: false,
    properties: {
      entity: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9._-]*$" },
      valueField: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
      recordIdSourceField: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
      constraints: relationshipConstraints,
      bindings: {
        type: "object",
        propertyNames: { pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
        additionalProperties: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
      },
    },
  },
};

/**
 * Authored copy in any of the supported languages. Completeness (both `en`
 * and `nl`) is a build-time lint (`missingUiTranslations` in interface-web);
 * a stored definition with one language must still validate at runtime.
 */
const localizedText = {
  type: "object", minProperties: 1, additionalProperties: false,
  properties: { en: { type: "string", minLength: 1 }, nl: { type: "string", minLength: 1 }, fr: { type: "string", minLength: 1 } },
};
/** Translation metadata never changes accepted values or authorization. */
export const operationI18nKeyword = {
  keyword: "x-osf-i18n", schemaType: "object" as const, valid: true,
  metaSchema: {
    type: "object", additionalProperties: false,
    properties: {
      title: localizedText, description: localizedText,
      enum: { type: "object", additionalProperties: localizedText },
    },
  },
};

/**
 * Editor metadata: which catalogue a closed choice is filled from (a field,
 * a sortable field, a relationship, an operation with its scope, a renderer or
 * a component). Never validated against the value; a consumer that cannot
 * fill the choice treats the node as free text.
 */
export const operationChoiceKeyword = {
  keyword: "x-osf-choice", valid: true,
  metaSchema: {
    anyOf: [
      { type: "string", enum: ["field", "sortableField", "relationship", "operation", "renderer", "component"] },
      {
        type: "object", additionalProperties: false, required: ["kind", "scope"],
        properties: {
          kind: { type: "string", enum: ["operation"] },
          scope: { type: "string", enum: ["collection", "record"] },
        },
      },
    ],
  },
};


/**
 * The OSF type behind a generated property (`currency`, `Relation`,
 * `fieldDefinition`, a plugin's own type). A form renders the property through
 * the renderer registered for that type; the JSON type beside it stays the
 * only thing validated.
 */
export const operationTypeKeyword = {
  keyword: "x-osf-type",
  schemaType: "string" as const,
  valid: true,
  // A camelCase catalog or base key, or a PascalCase entity name; never a path or a dashed name.
  metaSchema: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9]*$" },
};

/**
 * The exact-comparison half of a numeric property's contract.
 *
 * A `numeric` or `bigint` value crosses every transport as decimal text, so a
 * numeric property accepts either the JSON number a form sends or that exact
 * text (`field-schema-metadata.ts`). `minimum`/`maximum` beside it constrain
 * the number form — JSON Schema ignores them for a string — and this keyword
 * applies the same authored bounds to the text form, by exact decimal
 * comparison rather than through an IEEE double.
 *
 * The closed numeric DOMAIN lives here for BOTH forms, and in `enum` for
 * neither: strict equality reads `1` and `"1"` as different values, so an
 * `enum` of numbers rejects the exact text the platform projects a numeric
 * value as, and an `enum` of both spellings publishes every member twice.
 *
 * Unlike every other `x-osf-*` keyword this one validates: it is the only
 * place an exact bound on the text form, or a numeric domain in either form,
 * is enforced, so an annotation-only reading would drop the constraint
 * instead of documenting it.
 */
export const operationExactNumericKeyword = {
  keyword: "x-osf-exact",
  schemaType: "object" as const,
  errors: true as const,
  metaSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      integer: { type: "boolean" },
      minimum: { type: ["number", "string"] },
      maximum: { type: ["number", "string"] },
      enum: { type: "array", items: { type: ["number", "string"] } },
    },
  },
  validate: exactNumericKeywordValidator(),
};

const EXACT_NUMERIC_MESSAGES: Record<ExactNumericViolation, string> = {
  notNumeric: "must be a number, as a JSON number or as exact decimal text",
  notInteger: "must be a whole number",
  belowMinimum: "must be at least the authored minimum",
  aboveMaximum: "must be at most the authored maximum",
  notInEnum: "must be one of the allowed values",
};

/**
 * The keyword's own validator. `unknown` parameters and a validator that
 * carries its error list on itself are the shape ajv's schema-validate
 * contract expects, without this package depending on ajv's types.
 */
function exactNumericKeywordValidator(): (schema: unknown, data: unknown, parentSchema?: unknown) => boolean {
  const validate = (schema: unknown, data: unknown, parentSchema?: unknown): boolean => {
    if (typeof data !== "string" && typeof data !== "number") return true;
    const bounds: ExactNumericBounds = schema && typeof schema === "object" && !Array.isArray(schema)
      ? (schema as ExactNumericBounds)
      : {};
    // The text form is held to the whole contract here, because JSON Schema
    // ignores `minimum`, `maximum` and `type: integer` for a string.
    //
    // The number form keeps ordinary numeric bounds beside this keyword;
    // text-authored bounds have no numeric-keyword equivalent, so validate
    // them here too. Its closed DOMAIN is only here: `enum` cannot admit both
    // forms of a number at once, so the
    // exact comparison decides membership — `1`, `1.0` and `"1"` are one
    // member of the same domain.
    const parent = parentSchema && typeof parentSchema === "object" ? parentSchema as Record<string, unknown> : {};
    const integerType = parent.type === "integer" || Array.isArray(parent.type) && parent.type.includes("integer") && !parent.type.includes("number");
    const violation = typeof data === "number"
      ? exactNumericViolation(data, {
          ...(bounds.minimum !== undefined && parent.minimum !== bounds.minimum ? { minimum: bounds.minimum } : {}),
          ...(bounds.maximum !== undefined && parent.maximum !== bounds.maximum ? { maximum: bounds.maximum } : {}),
          ...(bounds.integer && !integerType ? { integer: true } : {}),
          ...(bounds.enum === undefined ? {} : { enum: bounds.enum }),
        })
      : exactNumericViolation(data, bounds);
    if (!violation) return true;
    (validate as { errors?: unknown }).errors = [
      { keyword: "x-osf-exact", message: EXACT_NUMERIC_MESSAGES[violation], params: { violation } },
    ];
    return false;
  };
  return validate;
}

/**
 * Whether the property accepts a variable instead of a literal, and in which
 * shape (`./field-variables.ts`). Stamped only where the field authors a mode:
 * a property without it takes literals alone, so `{{…}}` in its value is text.
 * The keyword documents the contract; the binding itself is accepted and
 * resolved server-side, never by the transport that advertises it.
 */
export const operationVariablesKeyword = {
  keyword: "x-osf-variables",
  schemaType: "string" as const,
  valid: true,
  metaSchema: { type: "string", enum: ["whole", "template", "both"] },
};

/** Server-owned field metadata used by generated forms and typed-value readers. */
export const operationFieldMetadataKeywords = [
  { keyword: "x-osf-presentation", schemaType: "object" as const, valid: true },
  { keyword: "x-osf-value-context", schemaType: "object" as const, valid: true },
  { keyword: "x-osf-typed-by", schemaType: "object" as const, valid: true },
] as const;
