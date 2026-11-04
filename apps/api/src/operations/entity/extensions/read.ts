// SPDX-License-Identifier: BUSL-1.1
/**
 * The read half of tenant fields: `extensions` and `extensionsMeta`
 * from the record's `extension_values` source, keyed by the readable key,
 * redacted per key exactly as a classified column is, with the definition's
 * `defaultValue` for a record that has no value yet. The raw source column
 * never leaves this projection.
 */
import type { FieldValuePolicy } from "@openshapeforge/operations";
import type { DbSessionInput } from "../../../db/session.js";
import { redactFieldValue } from "../field-policy.js";
import { canReadClassifiedColumns } from "../classification.js";
import { fieldNameForColumn } from "../columns.js";
import type { GeneratedCrudTable, GeneratedEntityRow } from "../types.js";
import {
  classificationOf,
  EXTENSION_META_KEY,
  EXTENSION_VALUES_COLUMN,
  evaluateCondition,
  isClassified,
  numericValue,
  proofLost,
  record,
  type ExtensionField,
  type ExtensionFieldSet,
} from "./model.js";
import { carriesExtensionValues, extensibleEntityOf, provenExtensionFields } from "./store.js";
import { staleExtensionFields } from "./linked.js";

export type ExtensionMeta = { stale?: true; error?: string; suspended?: true; applicable: boolean; deprecated?: true };

/** The per-request policy a classified tenant field is redacted with. */
export function extensionFieldPolicy(field: ExtensionField): FieldValuePolicy {
  const sensitivity = classificationOf(field.definition);
  return isClassified(field.definition) ? { classification: sensitivity as "confidential" | "pii" | "bsn" } : {};
}

/**
 * Value accessor for appliesWhen over one stored row and its source. A
 * stored condition names a tenant field by id (`extensions.<fieldId>`).
 */
export function conditionValues(
  table: GeneratedCrudTable,
  row: Readonly<Record<string, unknown>>,
  set: ExtensionFieldSet,
  source: Readonly<Record<string, unknown>>,
): (path: string) => unknown {
  const columns = new Map(table.columns.map((column) => [fieldNameForColumn(column), column.name]));
  return (path) => {
    if (path.startsWith("extensions.")) {
      const field = set.byId.get(path.slice("extensions.".length));
      return field ? numericValue(field.definition, source[field.fieldId] ?? field.definition.defaultValue ?? null) : null;
    }
    const column = columns.get(path);
    return column ? row[column] ?? null : null;
  };
}

/**
 * The value a reader sees: the stored one, else the default of a field that
 * applies. A create (and an update that makes a field apply) stores the
 * default (write.ts), so the read-time default is only for records written
 * before the field existed (no backfill).
 */
export function readValue(field: ExtensionField, source: Readonly<Record<string, unknown>>, applicable: boolean): unknown {
  const stored = Object.hasOwn(source, field.fieldId) ? source[field.fieldId] : undefined;
  return numericValue(field.definition, stored !== undefined ? stored : applicable ? field.definition.defaultValue ?? null : null);
}

/** The source map of a stored row, never anything but an object. */
export function storedExtensionSource(row: Readonly<Record<string, unknown>> | null | undefined): Record<string, unknown> {
  const value = row?.[EXTENSION_VALUES_COLUMN];
  return record(value) ? value : {};
}

/**
 * Replace the raw source column with the readable projection. Rows of a
 * table that merely shares an extensible entity's physical table (a subtype)
 * lose the raw column and gain nothing.
 */
export function projectExtensionRow(
  table: GeneratedCrudTable,
  session: DbSessionInput | null | undefined,
  row: GeneratedEntityRow,
): GeneratedEntityRow {
  if (!carriesExtensionValues(table) || !Object.hasOwn(row, EXTENSION_VALUES_COLUMN)) return row;
  const source = storedExtensionSource(row);
  const result: GeneratedEntityRow = { ...row };
  delete result[EXTENSION_VALUES_COLUMN];
  if (!extensibleEntityOf(table)) return result;
  const set = provenExtensionFields(session, table);
  if (!set) return result;
  const classified = canReadClassifiedColumns(table.source?.authorization, session ?? undefined);
  const meta = record(source[EXTENSION_META_KEY]) ? source[EXTENSION_META_KEY] as Record<string, unknown> : {};
  const values = conditionValues(table, row, set, source);
  // Proven for this page by the read (linked.ts `proveExtensionStaleness`), never stored per record.
  const stale = staleExtensionFields(set.entity, row.id);
  const extensions: Record<string, unknown> = {};
  const extensionsMeta: Record<string, ExtensionMeta> = {};
  for (const field of set.fields) {
    if (field.state === "deleted") continue;
    const applicable = evaluateCondition(field.appliesWhen, values);
    // A lost proof redacts: the stored value is data of another record that
    // this reader may no longer see. It stays in the source, for when the
    // field is saved again.
    const value = proofLost(field) ? null : readValue(field, source, applicable);
    extensions[field.key] = redactFieldValue(value, extensionFieldPolicy(field), session ?? undefined, classified);
    const fieldMeta = record(meta[field.fieldId]) ? meta[field.fieldId] as Record<string, unknown> : {};
    extensionsMeta[field.key] = {
      applicable,
      ...(fieldMeta.stale === true || stale?.has(field.fieldId) ? { stale: true as const } : {}),
      ...(typeof fieldMeta.error === "string" ? { error: fieldMeta.error } : {}),
      // From the definition, never stored per record: a suspended formula's
      // values are of two generations until its backfill runs to the end, and
      // a field whose proof is lost reads as null.
      ...(field.state === "suspended" ? { suspended: true as const } : {}),
      ...(field.state === "deprecated" ? { deprecated: true as const } : {}),
    };
  }
  result.extensions = extensions;
  result.extensionsMeta = extensionsMeta;
  return result;
}
