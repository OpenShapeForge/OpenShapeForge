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
 *     value is one. A formula's result is frozen as the value it had, but
 *     only while its definition is `ready`: an `updating` or `suspended`
 *     formula may hold the value of another generation, so it freezes as
 *     `{ unavailable: "<state>" }`; a record whose formula gave an error code
 *     freezes `{ error: "<code>" }`, not the absence of a value. Its
 *     definition carries `kind: "formula"` and `formula: { text, resultType }`
 *     (the text with the labels of that moment), never the AST.
 *
 * A definition change of a field without a value, or a new field, does not
 * change the snapshot, so it does not change the content hash either.
 */
import type { Transaction } from "kysely";
import type { DB } from "../../../generated/db/types.js";
import type { DbSessionInput } from "../../../db/session.js";
import { getGeneratedCrudTables } from "../catalog.js";
import { presentFormulaDefinition, storedFormula } from "./formulas.js";
import { evaluateCondition, extensionError, fieldMeta, isClassified, record, type ExtensionField, type ExtensionFieldSet } from "./model.js";
import { conditionValues, readValue, storedExtensionSource } from "./read.js";
import { extensionRegistry } from "./registry.js";
import { loadExtensionFieldsFor } from "./store.js";
import { isLinkedKind, presentLinkedDefinition, proveExtensionStaleness, staleExtensionFields, tenantFieldNames } from "./linked.js";

function frozenDefinition(set: ExtensionFieldSet, field: ExtensionField, usedDefault: boolean, names: ReadonlyMap<string, { key: string }>): Record<string, unknown> {
  const definition = field.definition;
  const linked = isLinkedKind(field.kind) ? presentLinkedDefinition(field, names)[field.kind] as Record<string, unknown> | undefined : undefined;
  const formula = field.kind === "formula" ? storedFormula(presentFormulaDefinition(set, field)) : undefined;
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
    ...(formula ? { kind: "formula", formula: { text: formula.text, resultType: formula.resultType } } : {}),
    ...(linked ? { kind: field.kind, [field.kind]: linked } : {}),
  };
}

/**
 * What a snapshot freezes of a computed field (see the module comment): a
 * lookup or rollup the recompute journal still has to bring up to date
 * freezes as `{ unavailable: "stale" }`, as a formula of another state does.
 */
function frozenFormula(field: ExtensionField, source: Readonly<Record<string, unknown>>, stale?: ReadonlySet<string>): unknown {
  if (field.state !== "ready") return { unavailable: field.state };
  if (stale?.has(field.fieldId)) return { unavailable: "stale" };
  const error = fieldMeta(source, field.fieldId);
  if (record(error) && typeof error.error === "string") return { error: error.error };
  return source[field.fieldId] ?? null;
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
  await proveExtensionStaleness(trx, session, set, [row]);
  const stale = staleExtensionFields(entity, row.id);
  const names = set.fields.some((field) => isLinkedKind(field.kind)) ? await tenantFieldNames(trx, session.tenantId!) : new Map<string, { key: string }>();
  const extensions: Record<string, unknown> = {};
  const extensionDefinitions: Record<string, Record<string, unknown>> = {};
  for (const field of set.fields) {
    if (field.state === "deleted" || isClassified(field.definition)) continue;
    const value = field.kind !== "stored" ? frozenFormula(field, source, stale) : readValue(field, source, evaluateCondition(field.appliesWhen, values));
    if (value === null || value === undefined) continue;
    extensions[field.fieldId] = value;
    extensionDefinitions[field.fieldId] = frozenDefinition(set, field, field.kind === "stored" && !Object.hasOwn(source, field.fieldId), names);
  }
  return { extensions, extensionDefinitions };
}
