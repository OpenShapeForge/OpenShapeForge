// SPDX-License-Identifier: BUSL-1.1
/** Form fields from an authorized record; execution still validates its canonical definition. */
export const operationInputFieldsKeyword = {
  keyword: "x-osf-inputFields",
  schemaType: "string" as const,
  valid: true,
  metaSchema: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
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
    },
  },
};

const bilingualText = {
  type: "object", required: ["en", "nl"], additionalProperties: false,
  properties: { en: { type: "string", minLength: 1 }, nl: { type: "string", minLength: 1 } },
};
/** Translation metadata never changes accepted values or authorization. */
export const operationI18nKeyword = {
  keyword: "x-osf-i18n", schemaType: "object" as const, valid: true,
  metaSchema: {
    type: "object", additionalProperties: false,
    properties: {
      title: bilingualText, description: bilingualText,
      enum: { type: "object", additionalProperties: bilingualText },
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
  metaSchema: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_.-]*$" },
};
