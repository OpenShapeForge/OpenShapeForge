// SPDX-License-Identifier: BUSL-1.1
/**
 * Tenant fields in a published snapshot, as the
 * platform's `schemas.extensions.snapshot` service: the versioning runtime
 * freezes what this returns and never the raw `extension_values` source.
 *
 *   - `extensions`: per field id, the value as a reader sees it — the stored
 *     one, else the default of a field that applies to the record — for
 *     every field that has one. Classified fields are never frozen: erasure
 *     must not reach into an immutable snapshot.
 *   - `extensionDefinitions`: only for the fields frozen above, what reading
 *     that value later needs: version, key, label, osfType, currency, unit,
 *     options (with their labels), cardinality, and the default when the
 *     value is one.
 *
 * A definition change of a field without a value, or a new field, does not
 * change the snapshot, so it does not change the content hash either.
 */
import type { Transaction } from "kysely";
import type { DB } from "../../../generated/db/types.js";
import type { DbSessionInput } from "../../../db/session.js";
import { getGeneratedCrudTables } from "../catalog.js";
import { evaluateCondition, extensionError, isClassified, record, type ExtensionField } from "./model.js";
import { conditionValues, readValue, storedExtensionSource } from "./read.js";
import { extensionRegistry } from "./registry.js";
import { loadExtensionFieldsFor } from "./store.js";

function frozenDefinition(field: ExtensionField, usedDefault: boolean): Record<string, unknown> {
  const definition = field.definition;
  const currency = (definition.render as { props?: { currency?: unknown } } | undefined)?.props?.currency ?? definition.currency;
  const options = record(definition.options) && definition.options.type === "static" && Array.isArray(definition.options.items)
    ? definition.options.items : undefined;
  return {
    version: field.version, key: field.key, label: definition.label ?? field.key, osfType: definition.osfType,
    ...(currency !== undefined ? { currency } : {}),
    ...(definition.unit !== undefined ? { unit: definition.unit } : {}),
    ...(options ? { options } : {}),
    ...(definition.cardinality !== undefined ? { cardinality: definition.cardinality } : {}),
    ...(usedDefault ? { defaultValue: definition.defaultValue } : {}),
  };
}

export async function extensionSnapshot(
  trx: Transaction<DB>,
  session: DbSessionInput,
  entity: string,
  row: Readonly<Record<string, unknown>>,
): Promise<{ extensions: Record<string, unknown>; extensionDefinitions: Record<string, Record<string, unknown>> }> {
  const entry = extensionRegistry.entity(entity);
  const table = getGeneratedCrudTables().find((candidate) => candidate.source?.authoringEntityName === entity && !candidate.subtype);
  if (!entry || !table) extensionError(`${entity} has no tenant fields.`, "OPERATION_UNAVAILABLE");
  const set = await loadExtensionFieldsFor(trx, session, entity, entry!);
  const source = storedExtensionSource(row);
  const values = conditionValues(table!, row, set, source);
  const extensions: Record<string, unknown> = {};
  const extensionDefinitions: Record<string, Record<string, unknown>> = {};
  for (const field of set.fields) {
    if (field.state === "deleted" || isClassified(field.definition)) continue;
    const value = readValue(field, source, evaluateCondition(field.appliesWhen, values));
    if (value === null || value === undefined) continue;
    extensions[field.fieldId] = value;
    extensionDefinitions[field.fieldId] = frozenDefinition(field, !Object.hasOwn(source, field.fieldId));
  }
  return { extensions, extensionDefinitions };
}
