// SPDX-License-Identifier: BUSL-1.1
/**
 * A value typed by the FieldDefinition stored beside it.
 *
 * An authored `typedBy` (see `field-definition.schema.json`) names a sibling
 * field that holds a canonical FieldDefinition; this is where that definition
 * becomes the value's contract at runtime. The pair is resolved from the
 * manifest column, the definition is compiled through the one field-schema
 * service every stored definition goes through, and the value is validated
 * against the result — on create and on update, for every interface, in the
 * shared write path rather than per entity.
 *
 * What this is NOT: a validator with knowledge of any particular entity. A
 * Chip's value is checked here because Chip authors the pair, not because the
 * code knows what a Chip is.
 *
 * `null`, `0`, `false` and `[]` are values: the stored definition decides
 * whether they are permitted, exactly as it would for an authored field — with
 * one storage reading beside it, that a NOT NULL column holds no null.
 *
 * ## The policy boundary, and why it is a refusal
 *
 * A FieldDefinition may carry policy: a `classification`, an `authorization`
 * or `permissions` block, `secureInput`, `writtenBy`, `immutable` — authored
 * on the field or inherited from its osf-type. The runtime enforces those on
 * COLUMNS: `projectGeneratedEntityRow` redacts a classified column, the
 * protected-field writer owns an `immutable` one. A definition that arrives at
 * runtime types a value inside ONE json column, so none of that machinery can
 * reach it: redacting "the confidential half" of a json value is not something
 * the static projection can do, and a guarded value in a column the reader may
 * see would simply be handed over.
 *
 * So a typed value fails closed on exactly the policies the entity-value
 * runtime already fails closed on, through that same shared guard
 * (`assertEntityValueFieldPolicy`): no policy metadata at any depth, no
 * relationship or entity-typed value, nothing the osf-type registry does not
 * know. An entity reference is refused here rather than accepted on UUID
 * shape — authorizing a reference means reading the target through its own
 * canonical read, which the entity-value carriers do because they lower each
 * reference to a real column; a value typed at runtime has no such column.
 * A variable that must carry a guarded or referencing value needs a field of
 * its own, with the column the runtime can protect.
 */

import { operationFailure } from "@openshapeforge/operations";
import { generatedRuntimeFieldSchemas, runtimeJsonSchemas } from "../../modules/field-schemas.js";
import { fieldNameForColumn } from "./columns.js";
import { generatedCrudError } from "./catalog.js";
import { assertEntityValueFieldPolicy } from "./entity-value-io.js";
import type { GeneratedCrudColumn, GeneratedCrudTable, GeneratedEntityRow } from "./types.js";

/** The typed-value columns of a table, each with the column its definition lives in. */
export function typedValueColumns(
  table: GeneratedCrudTable,
): Array<{ value: GeneratedCrudColumn; definition: GeneratedCrudColumn }> {
  return table.columns.flatMap((value) => {
    if (!value.typedBy) return [];
    const definition = table.columns.find((candidate) => candidate.name === value.typedBy!.definitionColumn);
    if (!definition || fieldNameForColumn(definition) !== value.typedBy.definitionField) {
      throw generatedCrudError("Typed-value definition metadata does not match its table.", "INVALID_DEFINITION");
    }
    return [{ value, definition }];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** A stored definition must describe a concrete value, not defer to another sibling. */
function hasDeferredValueDefinition(definition: Readonly<Record<string, unknown>>): boolean {
  if (definition.osfType === "typedValue" || definition.typedBy !== undefined) return true;
  for (const key of ["children", "shape"]) {
    const children = definition[key];
    if (Array.isArray(children) && children.some((child) => isRecord(child) && hasDeferredValueDefinition(child))) return true;
  }
  return isRecord(definition.item) && hasDeferredValueDefinition(definition.item);
}

/**
 * The supported shape of a definition that types a value at runtime, through
 * the guard the entity-value runtime uses for the same position. The stored
 * definition is passed as a CHILD on purpose: the nested reading of that guard
 * is the one that holds here, because the typed value has no column of its own
 * for a reference or a policy to be enforced against (see the file header).
 *
 * The refusal names the field and nothing else — never the value, and never
 * which policy was found, which would answer a question about a definition the
 * caller may not read.
 */
export function assertTypedDefinitionSupported(
  definition: Readonly<Record<string, unknown>>,
  field: string,
  origin: "submitted" | "stored",
): void {
  try {
    assertEntityValueFieldPolicy({ key: field, osfType: "object", children: [definition] });
    if (hasDeferredValueDefinition(definition)) throw new Error("A concrete value definition is required.");
  } catch {
    throw origin === "submitted"
      ? generatedCrudError(
          `${field} cannot be typed by this definition.`,
          "BAD_USER_INPUT",
          {
            detail:
              "A value typed by a stored definition is kept in one JSON column, so the definition may not carry " +
              "a classification, an authorization or permissions block, secureInput, writtenBy or immutable, " +
              "at any depth, and may not be a relationship, an entity-typed value, or another deferred typedBy value. Use a field of its own " +
              "for a value that needs one of those.",
          },
        )
      : generatedCrudError(
          `The stored type of ${field} is not a value type this runtime can protect.`,
          "INVALID_DEFINITION",
        );
  }
}

/**
 * Validate every typed value the write touches against the definition that
 * types it. On create both halves come from the submitted values; on update
 * either half may be absent, and what the row already holds is the other
 * half of the pair — so a new value is checked against the stored definition
 * and a new definition against the stored value. A definition that does not
 * describe this field, does not compile, or carries policy this runtime cannot
 * enforce inside a json column is refused rather than skipped.
 */
export function assertTypedValuesValid(
  table: GeneratedCrudTable,
  values: Readonly<Record<string, unknown>>,
  current: GeneratedEntityRow | undefined,
): void {
  for (const { value, definition } of typedValueColumns(table)) {
    const valueField = fieldNameForColumn(value);
    const definitionField = fieldNameForColumn(definition);
    const hasValue = Object.hasOwn(values, valueField);
    const hasDefinition = Object.hasOwn(values, definitionField);
    if (!hasValue && !hasDefinition) continue;
    const stored = hasDefinition ? values[definitionField] : current?.[definition.name];
    if (!isRecord(stored)) {
      throw operationFailure({
        code: "VALIDATION",
        message: `${definitionField} must be a field definition.`,
        detail: `${valueField} is typed by ${definitionField}, so a write of either needs that definition.`,
        violations: [{ field: definitionField, code: "INVALID_TYPE", message: `${definitionField} must be a field definition.` }],
        retryable: false,
      });
    }
    if (stored.key !== valueField) {
      throw operationFailure({
        code: "VALIDATION",
        message: `${definitionField} must describe ${valueField}.`,
        detail: `Its key must be ${JSON.stringify(valueField)}.`,
        violations: [{ field: definitionField, code: "INVALID_VALUE", message: `${definitionField} must describe ${valueField}.` }],
        retryable: false,
      });
    }
    let schema: Record<string, unknown>;
    try {
      schema = generatedRuntimeFieldSchemas.object([stored]);
    } catch {
      throw operationFailure({ code: "VALIDATION", message: `${definitionField} must be a valid field definition.`,
        violations: [{ field: definitionField, code: "INVALID_TYPE", message: `${definitionField} must be a valid field definition.` }], retryable: false });
    }
    assertTypedDefinitionSupported(stored, definitionField, hasDefinition ? "submitted" : "stored");
    const candidate = hasValue ? values[valueField] : current?.[value.name];
    // A NOT NULL column holds no null, whatever the definition says about its
    // own `required`: the write would otherwise be refused by the database
    // after the contract said it was acceptable.
    if ((candidate === null || candidate === undefined) && value.required) {
      throw operationFailure({
        code: "VALIDATION",
        message: `${valueField} is required.`,
        violations: [{ field: valueField, code: "REQUIRED", message: `${valueField} is required.` }],
        retryable: false,
      });
    }
    // The stored definition is the contract; the service compiles it and
    // refuses one that is not a canonical FieldDefinition. A null is the
    // absence of a value, so it is validated as an absent property — which
    // the definition's own `required` then accepts or refuses.
    const result = candidate === null || candidate === undefined
      ? runtimeJsonSchemas.validate(schema, {})
      : runtimeJsonSchemas.validate(schema, { [valueField]: candidate });
    if (!result.valid) {
      throw operationFailure({
        ...result.error,
        code: "VALIDATION",
        message: `${valueField} does not satisfy the type its definition declares.`,
        ...(result.error.violations ? { violations: result.error.violations.map((violation) => ({ ...violation, field: valueField })) } : {}),
      });
    }
  }
}

/**
 * The read half of the same boundary, on every projected row: a stored
 * definition this runtime cannot protect is a refusal, not a value handed
 * over. Called from `projectGeneratedEntityRow`, so it holds for every
 * interface and for the binding runtime's own source reads, exactly where the
 * entity-value carriers' definitions are checked on the same projection.
 *
 * A value whose definition is not in the row cannot be protected either: the
 * contract that says what the value is would be missing, so the pair is
 * refused rather than projected half-way.
 */
export function assertStoredTypedValuesSupported(
  table: GeneratedCrudTable,
  row: Readonly<GeneratedEntityRow>,
): void {
  for (const { value, definition } of typedValueColumns(table)) {
    if (!Object.hasOwn(row, value.name) && !Object.hasOwn(row, definition.name)) continue;
    const stored = row[definition.name];
    const valueField = fieldNameForColumn(value);
    if (!isRecord(stored)) {
      throw generatedCrudError(
        `The stored type of ${valueField} is not available.`,
        "INVALID_DEFINITION",
      );
    }
    assertTypedDefinitionSupported(stored, fieldNameForColumn(definition), "stored");
  }
}
