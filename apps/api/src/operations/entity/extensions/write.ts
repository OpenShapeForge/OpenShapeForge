// SPDX-License-Identifier: BUSL-1.1
/**
 * The write half of tenant fields (§5.4). `extensions` is split from the
 * authored values before the static contract sees them, validated against
 * the tenant's current definitions inside the record's own transaction,
 * written into the `extension_values` source with the row, and mirrored into
 * the typed index (and the uniqueness claims) directly after the row's
 * `returning`, in that same transaction.
 */
import { isDeepStrictEqual } from "node:util";
import { sql, type RawBuilder, type Transaction } from "kysely";
import type { DB } from "../../../generated/db/types.js";
import type { DbSessionInput } from "../../../db/session.js";
import { jsonbLiteral } from "../../../db/sql-helpers.js";
import { runtimeJsonSchemas } from "../../../modules/field-schemas.js";
import { appendEntityEventInTransaction } from "../../../platform/entity-events.js";
import { getGeneratedCrudTables, isGeneratedCrudOperationEnabled, requireEntityOperation } from "../catalog.js";
import { assertRecordPermissionInTransaction } from "../record-permissions.js";
import { draftRule } from "../versioned-head.js";
import type { GeneratedCrudColumn, GeneratedCrudTable } from "../types.js";
import {
  EXTENSION_META_KEY,
  EXTENSION_VALUES_COLUMN,
  evaluateCondition,
  extensionError,
  extensionShape,
  extensionValueSchema,
  indexRows,
  isClassified,
  normalizedUnique,
  record,
  referenceIds,
  typedOperand,
  uniqueOperand,
  type ExtensionField,
  type ExtensionFieldSet,
} from "./model.js";
import { conditionValues, storedExtensionSource } from "./read.js";
import { extensibleEntityOf, loadExtensionFields } from "./store.js";
import { operationFailure } from "@openshapeforge/operations";

/** `schema.table` → a quoted identifier pair. */
export function qualifiedTable(name: string): RawBuilder<unknown> {
  const [schema, table] = name.split(".") as [string, string];
  return sql.id(schema, table);
}

/**
 * Take `extensions` out of a caller's values. Only an extensible entity
 * accepts it; on any other entity it stays in the values, where the
 * entity's own contract refuses it as an unknown field.
 */
export function splitExtensionInput(
  table: GeneratedCrudTable,
  values: Record<string, unknown>,
): { values: Record<string, unknown>; extensions?: Record<string, unknown> } {
  if (!Object.hasOwn(values, "extensions") || !extensibleEntityOf(table)) return { values };
  const { extensions, ...authored } = values;
  if (extensions === undefined) return { values: authored };
  if (!record(extensions)) extensionError("extensions must be an object keyed by field key.");
  return { values: authored, extensions };
}

export function extensionValuesColumn(table: GeneratedCrudTable): GeneratedCrudColumn {
  const column = table.columns.find((candidate) => candidate.name === EXTENSION_VALUES_COLUMN);
  if (!column) extensionError("Extension storage metadata is invalid.", "INVALID_DEFINITION");
  return column!;
}

export type PreparedExtensionWrite = {
  readonly table: GeneratedCrudTable;
  readonly set: ExtensionFieldSet;
  readonly before: Readonly<Record<string, unknown>>;
  readonly after: Readonly<Record<string, unknown>>;
  readonly changed: readonly ExtensionField[];
  /** A create: the caller's values before defaults, settled again against the inserted row. */
  readonly create?: { readonly supplied: Readonly<Record<string, unknown>>; readonly base: Readonly<Record<string, unknown>> };
};

const blank = (value: unknown) => value === null || value === undefined || value === "" ||
  (Array.isArray(value) && value.length === 0);

type Violation = { field: string; code: string; message: string };

function refuse(violations: readonly Violation[]): never {
  throw operationFailure({
    code: "VALIDATION",
    message: "The tenant field values do not satisfy their definitions.",
    detail: violations.map((violation) => violation.message).join(" "),
    violations,
    retryable: false,
  });
}

/** A valid reference names a row the writer may read, locked against deletion. */
async function assertReferencesReadable(
  trx: Transaction<DB>,
  session: DbSessionInput,
  field: ExtensionField,
  set: ExtensionFieldSet,
  ids: readonly string[],
): Promise<void> {
  const shape = extensionShape(set.entry, field.definition);
  const tables = getGeneratedCrudTables().filter((candidate) =>
    candidate.source?.authoringEntityName === shape.reference!.entity && !candidate.subtype);
  const target = tables.length === 1 ? tables[0] : undefined;
  if (!target || `${target.schema}.${target.table}` !== shape.reference!.table || target.primaryKey !== "id" || !target.tenantScoped) {
    extensionError(`Field ${field.key} has no readable reference target.`, "INVALID_DEFINITION");
  }
  requireEntityOperation(target!, isGeneratedCrudOperationEnabled(target!, "get") ? "get" : "list", session);
  for (const id of new Set(ids)) {
    const visible = await sql<{ id: string }>`select id from ${sql.id(target!.schema, target!.table)}
      where id = ${id}::uuid and tenant_id = ${session.tenantId}::uuid for share`.execute(trx);
    if (!visible.rows.length) {
      throw operationFailure({ code: "FORBIDDEN", message: `A record referenced by ${field.key} is unavailable.`, retryable: false });
    }
    if (target!.source?.authorization?.recordPermissions) {
      await assertRecordPermissionInTransaction(trx, session, target!, id, "view");
    }
  }
}

/**
 * Defaults and `required` (§11 besluit 31), against the record as it is
 * stored. A create, and an update that makes a field apply, store the
 * default of an applicable field that got no value, so `required` is always
 * met by a stored value; an update checks the required fields it touches and
 * the ones it makes apply. Records written before a field existed keep no
 * value (no backfill, §5.3): an update that leaves their fields alone does
 * not start enforcing them.
 */
function settleExtensionValues(
  table: GeneratedCrudTable,
  set: ExtensionFieldSet,
  input: {
    operation: "create" | "update";
    row: Readonly<Record<string, unknown>>;
    current?: Readonly<Record<string, unknown>> | null | undefined;
    before: Readonly<Record<string, unknown>>;
    after: Record<string, unknown>;
    supplied: Readonly<Record<string, unknown>>;
  },
): Violation[] {
  const { operation, after, supplied } = input;
  const values = conditionValues(table, input.row, set, after);
  const was = operation === "update" && input.current ? conditionValues(table, input.current, set, input.before) : undefined;
  const violations: Violation[] = [];
  for (const field of set.fields) {
    if (field.kind !== "stored" || field.state === "deleted" || field.state === "deprecated") continue;
    if (!evaluateCondition(field.appliesWhen, values)) continue;
    const touched = Object.hasOwn(supplied, field.key);
    const becameApplicable = operation === "create" || (was !== undefined && !evaluateCondition(field.appliesWhen, was));
    if (blank(after[field.fieldId]) && field.definition.defaultValue !== undefined &&
        (operation === "create" || (becameApplicable && !touched))) {
      after[field.fieldId] = structuredClone(field.definition.defaultValue);
    }
    if (field.definition.required === true && (touched || becameApplicable) && blank(after[field.fieldId])) {
      violations.push({ field: `extensions.${field.key}`, code: "REQUIRED", message: `extensions.${field.key} is required.` });
    }
  }
  return violations;
}

function changedFields(set: ExtensionFieldSet, before: Readonly<Record<string, unknown>>, after: Readonly<Record<string, unknown>>): ExtensionField[] {
  return set.fields.filter((field) => field.state !== "deleted" && !isDeepStrictEqual(before[field.fieldId], after[field.fieldId]));
}

/**
 * Validate a caller's `extensions` against the tenant definitions and merge
 * it over the stored source. `row` is the record as it will be written,
 * keyed by column, so `appliesWhen` sees the authored values of this write;
 * a create settles again against the row as inserted (completeExtensionWrite),
 * where database defaults are known. Returns undefined for a table that is
 * not extensible.
 */
export async function prepareExtensionWrite(
  trx: Transaction<DB>,
  session: DbSessionInput,
  table: GeneratedCrudTable,
  input: {
    operation: "create" | "update";
    current?: Readonly<Record<string, unknown>> | null;
    row: Readonly<Record<string, unknown>>;
    extensions?: Readonly<Record<string, unknown>>;
  },
): Promise<PreparedExtensionWrite | undefined> {
  // Shared: a definition change waits for this write, and this write reads
  // the definitions a change committed before it (store.ts).
  const set = await loadExtensionFields(trx, session, table, { lock: "shared" });
  if (!set) {
    if (input.extensions) extensionError("This entity has no tenant fields.");
    return undefined;
  }
  const before = storedExtensionSource(input.current);
  const after: Record<string, unknown> = { ...before };
  const supplied = input.extensions ?? {};
  const checked: Record<string, unknown> = {};
  const violations: Violation[] = [];
  for (const [key, value] of Object.entries(supplied)) {
    // A deleted field, or one whose delete backfill still runs, is no key.
    const field = set.byKey.get(key);
    if (!field) { violations.push({ field: `extensions.${key}`, code: "UNKNOWN_FIELD", message: `extensions.${key} is not a field of this entity.` }); continue; }
    if (field.state === "deprecated") { violations.push({ field: `extensions.${key}`, code: "DEPRECATED_FIELD", message: `extensions.${key} is deprecated and can no longer be written.` }); continue; }
    if (field.kind !== "stored") { violations.push({ field: `extensions.${key}`, code: "COMPUTED_FIELD", message: `extensions.${key} is computed and cannot be written.` }); continue; }
    if (value === undefined) continue;
    if (value === null) delete after[field.fieldId];
    else { after[field.fieldId] = value; checked[key] = value; }
  }
  if (Object.keys(checked).length) {
    const result = runtimeJsonSchemas.validate(extensionValueSchema(set), checked);
    if (!result.valid) {
      for (const violation of result.error.violations ?? []) {
        const key = String(violation.field ?? "").split("/")[1] ?? "";
        violations.push({ field: `extensions.${key}`, code: violation.code, message: `extensions.${key} is not a valid value.` });
      }
    }
  }
  if (violations.length) refuse(violations);
  const base = { ...after };
  const settled = settleExtensionValues(table, set, { operation: input.operation, row: input.row, current: input.current, before, after, supplied });
  // A create's `required` is decided against the inserted row only, where
  // database defaults are known; here the defaults are a first estimate.
  if (settled.length && input.operation === "update") refuse(settled);
  const changed = changedFields(set, before, after);
  for (const field of changed) {
    const ids = referenceIds(extensionShape(set.entry, field.definition), after[field.fieldId]);
    if (ids.length) await assertReferencesReadable(trx, session, field, set, ids);
  }
  if (changed.length) stripDeleted(set, after);
  return { table, set, before, after, changed, ...(input.operation === "create" ? { create: { supplied, base } } : {}) };
}

/** A deleted field's value is stripped by its backfill; a write that touches the record anyway drops what remains of it. */
function stripDeleted(set: ExtensionFieldSet, after: Record<string, unknown>): void {
  for (const key of Object.keys(after)) {
    if (key !== EXTENSION_META_KEY && set.byId.get(key)?.state === "deleted") delete after[key];
  }
}

/** The value the row stores: the merged source, only when it changes. */
export function extensionStorageValue(prepared: PreparedExtensionWrite | undefined): RawBuilder<unknown> | undefined {
  return prepared?.changed.length ? jsonbLiteral(prepared.after) : undefined;
}

/** Replace one record's index rows (and claim) for one field from its source value. */
export async function writeExtensionFieldIndex(
  trx: Transaction<DB>,
  tenantId: string,
  set: ExtensionFieldSet,
  field: ExtensionField,
  recordId: string,
  value: unknown,
): Promise<void> {
  const shape = extensionShape(set.entry, field.definition);
  await sql`delete from ${qualifiedTable(set.entry.valuesTable)}
    where tenant_id = ${tenantId}::uuid and record_id = ${recordId}::uuid and field_id = ${field.fieldId}::uuid`.execute(trx);
  const rows = indexRows(shape, value);
  if (rows.length) {
    await sql`insert into ${qualifiedTable(set.entry.valuesTable)}
      (tenant_id, record_id, field_id, ordinal, value_text, value_number, value_boolean, value_date, value_timestamp, value_ref_id)
      values ${sql.join(rows.map((row) => sql`(${tenantId}::uuid, ${recordId}::uuid, ${field.fieldId}::uuid, ${row.ordinal},
        ${row.value_text}, ${row.value_number}::numeric, ${row.value_boolean}::boolean, ${row.value_date}::date,
        ${row.value_timestamp}::timestamptz, ${row.value_ref_id}::uuid)`))}`.execute(trx);
  }
  if (field.definition.unique !== true) return;
  await sql`delete from ${qualifiedTable(set.entry.uniqueTable)}
    where tenant_id = ${tenantId}::uuid and field_id = ${field.fieldId}::uuid and record_id = ${recordId}::uuid`.execute(trx);
  const operand = uniqueOperand(shape, value);
  if (operand === null) return;
  const claimed = await sql<{ record_id: string }>`insert into ${qualifiedTable(set.entry.uniqueTable)}
      (tenant_id, field_id, value_text, record_id)
    values (${tenantId}::uuid, ${field.fieldId}::uuid, ${normalizedUnique(operand.column, typedOperand(operand.column, operand.value))}, ${recordId}::uuid)
    on conflict (tenant_id, field_id, value_text) do nothing
    returning record_id`.execute(trx);
  if (!claimed.rows.length) {
    throw operationFailure({
      code: "CONFLICT",
      message: `extensions.${field.key} must be unique; another record already has this value.`,
      violations: [{ field: `extensions.${field.key}`, code: "UNIQUE", message: `extensions.${field.key} is already in use.` }],
      retryable: false,
    });
  }
}

/**
 * The index and the per-key audit entry of a write, after the row's own
 * `returning`: same transaction, so a refused claim takes the row with it.
 * A create settles its defaults and `required` once more against `row`, the
 * record as inserted (database defaults included, §11 besluit 31); a value
 * that only this settlement adds is written back to the source here, and
 * the source the record now holds is returned.
 */
export async function completeExtensionWrite(
  trx: Transaction<DB>,
  session: DbSessionInput,
  prepared: PreparedExtensionWrite | undefined,
  recordId: string,
  row?: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown> | undefined> {
  if (!prepared) return undefined;
  let write = prepared;
  if (prepared.create && row) {
    const after = { ...prepared.create.base };
    const violations = settleExtensionValues(prepared.table, prepared.set, {
      operation: "create", row, before: {}, after, supplied: prepared.create.supplied,
    });
    if (violations.length) refuse(violations);
    if (!isDeepStrictEqual(after, prepared.after)) {
      const changed = changedFields(prepared.set, {}, after);
      for (const field of changed.filter((candidate) => !prepared.changed.includes(candidate))) {
        const ids = referenceIds(extensionShape(prepared.set.entry, field.definition), after[field.fieldId]);
        if (ids.length) await assertReferencesReadable(trx, session, field, prepared.set, ids);
      }
      await sql`update ${sql.id(prepared.table.schema, prepared.table.table)} set ${sql.id(EXTENSION_VALUES_COLUMN)} = ${jsonbLiteral(after)}
        where tenant_id = ${session.tenantId}::uuid and id = ${recordId}::uuid`.execute(trx);
      write = { ...prepared, after, changed };
    }
  }
  if (!write.changed.length) return write === prepared ? undefined : { ...write.after };
  for (const field of write.changed) {
    await writeExtensionFieldIndex(trx, session.tenantId!, write.set, field, recordId, write.after[field.fieldId]);
  }
  await appendExtensionAudit(trx, session, write, recordId);
  return { ...write.after };
}

/**
 * The one internal write of tenant values outside the caller's own create or
 * update (§11, D9): setNull, retention, the delete and retype backfills. It
 * writes the source, bumps `updated_at`, puts a versioned head back to draft
 * (an extensible entity is never an owned child, so the record is its own
 * head), rewrites the index (and claims) of `fields`, and appends the per-key
 * audit entry — the same effects a caller's write has. A field whose value
 * does not change only has its index rewritten (a retype).
 */
export async function rewriteExtensionValues(
  trx: Transaction<DB>,
  session: DbSessionInput,
  input: {
    table: GeneratedCrudTable;
    set: ExtensionFieldSet;
    recordId: string;
    before: Readonly<Record<string, unknown>>;
    after: Readonly<Record<string, unknown>>;
    fields: readonly ExtensionField[];
    /** Rewrite claims as well; false for a retype, which leaves them to the unique backfill. */
    claims?: boolean;
  },
): Promise<void> {
  const { table, set, recordId, before, after } = input;
  const changed = input.fields.filter((field) => !isDeepStrictEqual(before[field.fieldId], after[field.fieldId]));
  if (changed.length) {
    const updatedAt = table.columns.some((column) => column.name === "updated_at");
    const draft = draftRule(table);
    await sql`update ${sql.id(table.schema, table.table)} set ${sql.id(EXTENSION_VALUES_COLUMN)} = ${jsonbLiteral(after)}
        ${updatedAt ? sql`, updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')` : sql``}
        ${draft ? sql`, ${sql.id(draft.column)} = ${draft.value}` : sql``}
      where tenant_id = ${session.tenantId}::uuid and id = ${recordId}::uuid`.execute(trx);
  }
  for (const field of input.fields) {
    const indexed = input.claims === false ? { ...field, definition: { ...field.definition, unique: false } } : field;
    await writeExtensionFieldIndex(trx, session.tenantId!, set, indexed, recordId, after[field.fieldId]);
  }
  // The record itself is named as the event's subject: the audit envelope
  // would otherwise read the whole entity row to derive it, which the
  // worker may not (it holds only the columns this write needs).
  if (changed.length) await appendExtensionAudit(trx, session, { table, before, after, changed }, recordId, true);
}

const REDACTED = "[REDACTED]";

/**
 * §5.7a: the audit trail of tenant fields is per key — "kWh: 10 → 13.5" with
 * the definition version that applied — and a classified key is redacted
 * there exactly as a classified column is. The row trigger never sees the
 * raw source: its audit config hides `extension_values`.
 */
export function extensionAuditPayload(prepared: Pick<PreparedExtensionWrite, "before" | "after" | "changed">): Record<string, unknown> {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const versions: Record<string, number> = {};
  for (const field of prepared.changed) {
    const name = `extensions.${field.key}`;
    const hidden = isClassified(field.definition);
    before[name] = hidden ? REDACTED : prepared.before[field.fieldId] ?? null;
    after[name] = hidden ? REDACTED : prepared.after[field.fieldId] ?? null;
    versions[name] = field.version;
  }
  return { before, after, changedFields: Object.keys(versions).sort(), definitionVersions: versions,
    fieldIds: Object.fromEntries(prepared.changed.map((field) => [`extensions.${field.key}`, field.fieldId])) };
}

async function appendExtensionAudit(
  trx: Transaction<DB>,
  session: DbSessionInput,
  prepared: Pick<PreparedExtensionWrite, "table" | "before" | "after" | "changed">,
  recordId: string,
  namedSubject = false,
): Promise<void> {
  const table = prepared.table;
  const entity = table.source!.authoringEntityName!;
  await appendEntityEventInTransaction(trx, {
    tenantId: session.tenantId!,
    aggregateType: table.source?.graphql?.singleQueryName ?? entity,
    aggregateId: recordId,
    eventType: "extensionsChanged",
    payload: {
      table: `${table.schema}.${table.table}`,
      schema: table.schema,
      operation: "extensionsChanged",
      audit: { entityType: entity, ...extensionAuditPayload(prepared), ...(namedSubject ? { subjects: [{ entityType: entity, recordId }] } : {}) },
    },
  });
}
