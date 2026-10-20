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
 * Ordinary pairs retain the fail-closed policy boundary. Explicit compiled
 * adapters may additionally route a root Document through a real FK, or seal
 * a confidential root string before storage. Neither option admits nested
 * guarded fields or arbitrary runtime relationships.

 */

import { applyDocumentContentDraft } from "./document-drafts.js";
import { randomUUID } from "node:crypto";
import { sql, type Transaction } from "kysely";
import type { DB } from "../../generated/db/types.js";
import type { DbSessionInput } from "../../db/session.js";
import { encryptSecret, decryptSecret, keyringFromEnv, type StoredSecret } from "@openshapeforge/plugin-runtime/secrets";
import { redactElicitedValues, SECRET_SET_SENTINEL } from "../../connectors/secrets.js";
import { assertDocumentFieldsInTransaction } from "./document-fields.js";
import { getGeneratedCrudTables, requireEntityOperation } from "./catalog.js";
import { assertRecordPermissionInTransaction } from "./record-permissions.js";
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
  policy?: GeneratedCrudColumn["typedBy"],
): void {
  try {
    let checked = definition;
    if (definition.osfType === "Document" && policy?.documentColumn) {
      if (!isRecord(definition.document) || !["file", "blocks"].includes(String(definition.document.content))) throw new Error("A Document content policy is required.");
      for (const key of ["classification", "authorization", "permissions", "writtenBy", "secureInput", "immutable", "children", "item", "shape"]) {
        if (definition[key] !== undefined) throw new Error("Unsupported Document policy.");
      }
      if (hasDeferredValueDefinition(definition)) throw new Error("Concrete definition required.");
      return;
    }
    if (policy?.encrypted && definition.osfType === "string" && isRecord(definition.classification) && definition.classification.sensitivity === "confidential") {
      const { classification: _classification, ...plain } = definition;
      checked = plain;
    }
    assertEntityValueFieldPolicy({ key: field, osfType: "object", children: [checked] });
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
    assertTypedDefinitionSupported(stored, definitionField, hasDefinition ? "submitted" : "stored", value.typedBy);
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
    assertTypedDefinitionSupported(stored, fieldNameForColumn(definition), "stored", value.typedBy);
  }
}


function secretDefinition(definition: unknown): boolean {
  return isRecord(definition) && isRecord(definition.classification) && definition.classification.sensitivity === "confidential";
}
function secretKeys() {
  const keys = keyringFromEnv(process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS);
  if (!keys) throw generatedCrudError("Secure value storage is not configured.", "INVALID_DEFINITION");
  return keys;
}
function secretScope(table: GeneratedCrudTable, session: DbSessionInput, id: string): string {
  return `${session.tenantId}:${table.schema}.${table.table}:${id}`;
}

/** Validate plaintext first, then route references to real FKs and seal secrets before SQL/events. */
export async function prepareTypedValueWrite(
  trx: Transaction<DB>, session: DbSessionInput, table: GeneratedCrudTable,
  input: ReadonlyMap<GeneratedCrudColumn, unknown>, current?: GeneratedEntityRow,
): Promise<Map<GeneratedCrudColumn, unknown>> {
  const output = new Map(input);
  const pairs = typedValueColumns(table);
  if (!pairs.length) return output;
  for (const {value} of pairs) {
    const carrier=table.columns.find(column=>column.name===value.typedBy?.documentColumn);
    if(carrier && input.has(carrier)) throw generatedCrudError("A typed Document carrier is server-owned; write the public value instead.", "BAD_USER_INPUT");
  }
  const idColumn = table.columns.find(c => c.name === table.primaryKey);
  let id = current?.[table.primaryKey!] ?? (idColumn && output.get(idColumn));
  if (pairs.some(p => p.value.typedBy?.encrypted)) {
    if (!table.tenantScoped || !idColumn || idColumn.type !== "uuid") throw generatedCrudError("Secure typed values require tenant-scoped UUID records.", "INVALID_DEFINITION");
    if (!id) { id = randomUUID(); output.set(idColumn, id); }
  }
  const validationCurrent = current ? {...current} : undefined;
  for (const {value, definition} of pairs) {
    const metadata = value.typedBy!;
    const stored = output.has(definition) ? output.get(definition) : current?.[definition.name];
    if (metadata.documentColumn && isRecord(stored) && stored.osfType === "Document" && isRecord(output.get(value))) {
      if (!isRecord(stored.document) || stored.document.content !== "blocks" || !current) throw generatedCrudError("This field does not accept a blocks draft.", "BAD_USER_INPUT");
      output.set(value, await applyDocumentContentDraft(trx,session,current[metadata.documentColumn],output.get(value)));
    }
    if (metadata.documentColumn && validationCurrent && isRecord(stored) && stored.osfType === "Document") {
      validationCurrent[value.name] = current?.[metadata.documentColumn] ?? null;
    }
    if (metadata.encrypted && secretDefinition(stored)) {
      const existing = current?.[value.name];
      if (validationCurrent && isRecord(existing)) validationCurrent[value.name] = decryptSecret(secretKeys(), secretScope(table,session,String(id)), value.name, existing as StoredSecret);
      if (output.get(value) === SECRET_SET_SENTINEL) {
        if (!isRecord(existing)) throw generatedCrudError("This secret has not been set.", "BAD_USER_INPUT");
        output.set(value, validationCurrent?.[value.name]);
      }
    }
  }
  const authored = Object.fromEntries([...output].map(([column, val]) => [fieldNameForColumn(column), val]));
  assertTypedValuesValid(table, authored, validationCurrent);
  for (const {value, definition} of pairs) {
    if (!output.has(value) && !output.has(definition)) continue;
    const metadata = value.typedBy!;
    const stored = output.has(definition) ? output.get(definition) : current?.[definition.name];
    if (isRecord(stored) && stored.osfType === "Document") {
      const carrier = table.columns.find(c => c.name === metadata.documentColumn);
      if (!carrier) throw generatedCrudError("A Document carrier is required.", "INVALID_DEFINITION");
      const targetId = output.has(value) ? output.get(value) : current?.[carrier.name];
      if (targetId != null) {
        const target = getGeneratedCrudTables().find(t => t.source?.authoringEntityName === "Document");
        if (!target?.tenantScoped || !target.primaryKey) throw generatedCrudError("A tenant Document target is required.", "INVALID_DEFINITION");
        requireEntityOperation(target, "get", session);
        const visible = await sql`select id from ${sql.id(target.schema,target.table)} where id=${String(targetId)}::uuid and tenant_id=${session.tenantId}::uuid for share`.execute(trx);
        if (!visible.rows.length) throw generatedCrudError("The document is unavailable.", "FORBIDDEN");
        if (target.source?.authorization?.recordPermissions) await assertRecordPermissionInTransaction(trx,session,target,String(targetId),"view");
        await assertDocumentFieldsInTransaction(trx,session,table,new Map([[{...carrier,document:stored.document as NonNullable<GeneratedCrudColumn["document"]>},targetId]]));
      }
      output.set(carrier,targetId ?? null);
      output.set(value,null);
    } else {
      if (metadata.documentColumn) {
        const carrier = table.columns.find(c => c.name === metadata.documentColumn)!;
        output.set(carrier,null);
      }
      if (metadata.encrypted && secretDefinition(stored) && output.has(value) && output.get(value) != null) {
        const plaintext = output.get(value);
        if (typeof plaintext !== "string") throw generatedCrudError("A secret must be text.", "BAD_USER_INPUT");
        const existing = current?.[value.name];
        const unchanged = isRecord(existing) && validationCurrent?.[value.name] === plaintext;
        output.set(value,unchanged ? existing : encryptSecret(secretKeys(),secretScope(table,session,String(id)),value.name,plaintext));
      }
    }
  }
  return output;
}

/** Restore reference values, and redact even a malformed secret envelope fail-closed. */
export function projectTypedValues(table: GeneratedCrudTable, row: GeneratedEntityRow): GeneratedEntityRow {
  let output = {...row};
  for (const {value,definition} of typedValueColumns(table)) {
    const metadata=value.typedBy!;
    const stored=row[definition.name];
    if (isRecord(stored) && stored.osfType === "Document" && metadata.documentColumn) output[value.name]=row[metadata.documentColumn] ?? null;
    if (metadata.encrypted) output=redactElicitedValues(output,value.name);
    if (metadata.encrypted && secretDefinition(stored) && row[value.name] != null) output[value.name]=SECRET_SET_SENTINEL;
  }
  return output;
}
