// SPDX-License-Identifier: BUSL-1.1
/**
 * The one-type-axis rewrite for field definitions stored as data.
 *
 * Deployments persist FieldDefinition documents in JSON columns: values of
 * `osfType: fieldDefinition` fields (Case.fieldDefinitions, CaseTemplate
 * .fieldDefinitions, Template.parameters, Task.formDefinition.fields) and
 * workflow definition versions whose node configuration carries field
 * lists. Those rows were written in the old vocabulary and are validated
 * against the compiler's field-definition schema, so they get the same
 * rename the authoring YAML got: `semanticType` becomes `osfType`, a bare
 * `valueType` becomes the `osfType`, an authored `valueType` beside a
 * semantic type is dropped. Recursive over children, item and shape.
 */

export interface DataRewriteReport {
  renamed: number;
  derivedFromValueType: number;
  valueTypesDropped: number;
}

const BASE_TYPES = new Set(["string", "integer", "number", "boolean", "date", "datetime", "object"]);
const NESTED = ["children", "item", "shape"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** A map with a `key` and one of the type properties is a field definition. */
function isFieldDefinition(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value.key === "string" &&
    ("semanticType" in value || "valueType" in value || "osfType" in value);
}

/** Rewrites one field definition in place; nested definitions follow. Returns the same object. */
export function rewriteFieldDefinition(field: Record<string, unknown>, report: DataRewriteReport): Record<string, unknown> {
  const { semanticType, valueType } = field;
  if (typeof semanticType === "string") {
    field.osfType = semanticType;
    delete field.semanticType;
    report.renamed += 1;
    if ("valueType" in field) {
      delete field.valueType;
      report.valueTypesDropped += 1;
    }
  } else if ("osfType" in field) {
    if ("valueType" in field) {
      delete field.valueType;
      report.valueTypesDropped += 1;
    }
  } else if (typeof valueType === "string") {
    if (!BASE_TYPES.has(valueType)) throw new Error(`field ${String(field.key)}: valueType ${valueType} is not a base type.`);
    field.osfType = valueType;
    delete field.valueType;
    report.derivedFromValueType += 1;
    report.valueTypesDropped += 1;
  }
  for (const nested of NESTED) rewriteFieldDefinitions(field[nested], report);
  return field;
}

/**
 * Walks any JSON value and rewrites every field definition it contains: a
 * `fieldDefinition[]` column value, a single definition, or a larger document
 * (a workflow definition) in which definitions are nested. Mutates in place.
 */
export function rewriteFieldDefinitions(value: unknown, report: DataRewriteReport): unknown {
  if (Array.isArray(value)) {
    for (const item of value) rewriteFieldDefinitions(item, report);
    return value;
  }
  if (!isRecord(value)) return value;
  if (isFieldDefinition(value)) return rewriteFieldDefinition(value, report);
  for (const nested of Object.values(value)) rewriteFieldDefinitions(nested, report);
  return value;
}

export function emptyDataRewriteReport(): DataRewriteReport {
  return { renamed: 0, derivedFromValueType: 0, valueTypesDropped: 0 };
}

/** JSON text in, rewritten JSON text out (same indentation as `JSON.stringify(value)`); unchanged text when nothing applies. */
export function rewriteFieldDefinitionJson(text: string, report: DataRewriteReport = emptyDataRewriteReport()): { text: string; report: DataRewriteReport } {
  const before = { ...report };
  const value = JSON.parse(text) as unknown;
  rewriteFieldDefinitions(value, report);
  const changed = report.renamed !== before.renamed || report.derivedFromValueType !== before.derivedFromValueType || report.valueTypesDropped !== before.valueTypesDropped;
  return { text: changed ? JSON.stringify(value) : text, report };
}
