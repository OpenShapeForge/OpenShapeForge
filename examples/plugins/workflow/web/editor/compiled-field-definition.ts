// SPDX-License-Identifier: BUSL-1.1
/**
 * The boundary between the compiled field contract and the field definitions
 * a workflow document stores.
 *
 * A catalog's `configFields`/`outputFields` are compiler output and carry
 * `osfType` plus its derived `baseType`. Everything else the designer reads as
 * a field — a node's own `outputParameters` and `inputParameters`, process
 * variables — is a field definition an author stored in the document, and that
 * runtime vocabulary is `valueType` plus an optional `semanticType`. A compiled
 * field is translated here, once, so a reader downstream sees one vocabulary.
 */

/** A compiled field as the runtime field-definition vocabulary spells it. */
export function compiledFieldAsDefinition(value: unknown): Record<string, unknown> {
  const field = asRecord(value);
  const osfType = asString(field.osfType);
  const baseType = asString(field.baseType);
  const { osfType: _osfType, baseType: _baseType, ...rest } = field;
  return {
    ...rest,
    ...(baseType ? { valueType: baseType } : {}),
    ...(osfType && osfType !== baseType ? { semanticType: osfType } : {}),
    ...(Array.isArray(field.children)
      ? { children: field.children.map(compiledFieldAsDefinition) }
      : {}),
    ...(field.item && typeof field.item === "object" && !Array.isArray(field.item)
      ? { item: compiledFieldAsDefinition(field.item) }
      : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
