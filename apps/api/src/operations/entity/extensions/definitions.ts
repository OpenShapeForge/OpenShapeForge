// SPDX-License-Identifier: BUSL-1.1
/**
 * The definition Operations of an extensible entity E (contract fase 1a):
 * `E.fieldDefinitions.list/create/update/deprecate/restore/delete/reorder/
 * affectedRecords`, and `T.referencedBy` on every entity a tenant field may
 * point at. Definitions are append-only versions in
 * `platform.extension_field_definitions`; the lifecycle (§5.3) is a data
 * migration, so every change that touches records starts a backfill.
 */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { sql, type Transaction } from "kysely";
import { operationFailure } from "@openshapeforge/operations";
import type { RuntimeExtensibleEntity } from "@openshapeforge/plugin-runtime";
import type { DB } from "../../../generated/db/types.js";
import type { DbSessionInput } from "../../../db/session.js";
import { jsonbLiteral } from "../../../db/sql-helpers.js";
import { generatedRuntimeFieldSchemas, runtimeJsonSchemas } from "../../../modules/field-schemas.js";
import { getGeneratedCrudTables, isGeneratedCrudOperationEnabled, requireEntityOperation } from "../catalog.js";
import { fieldColumnMap } from "../columns.js";
import type { GeneratedCrudTable } from "../types.js";
import {
  conditionPaths,
  EXTENSION_KEY,
  extensionError,
  extensionShape,
  hasStaticOptions,
  isCollection,
  record,
  schemaFieldOf,
  SENSITIVITIES,
  type ExtensionDefinition,
  type ExtensionField,
  type ExtensionFieldSet,
  type ExtensionKind,
  type ExtensionState,
} from "./model.js";
import { extensionRegistry } from "./registry.js";
import { forgetExtensionFields, loadExtensionFieldsFor } from "./store.js";
import { qualifiedTable } from "./write.js";
import { latestBackfills, scheduleExtensionRetention, startBackfill, type BackfillOperation, type BackfillRow } from "./backfill.js";

export type FieldDefinitionAction =
  | "list" | "create" | "update" | "deprecate" | "restore" | "delete" | "reorder" | "affectedRecords";

export type FieldDefinitionRecord = {
  fieldId: string;
  key: string;
  version: number;
  kind: ExtensionKind;
  definition: ExtensionDefinition;
  appliesWhen: unknown;
  state: ExtensionState;
  position: number;
  backfill?: { id: string; state: string; processed: number; total: number };
};

/** Properties a tenant field may not carry: they need a runtime the serialization step does not have. */
const UNSUPPORTED_PROPERTIES = [
  "authorization", "permissions", "writtenBy", "immutable", "typedBy", "entityValue", "transitions",
  "computed", "deriveOnCreate", "relationship", "document", "variables", "provider", "persisted",
  "children", "shape", "item", "allowedDefinitions", "childAuthorization", "childLock", "writeSource",
  "defaultTemplate", "transform", "suggestions", "runtime", "localized",
];
const UNAVAILABLE_KINDS = new Set(["formula", "lookup", "rollup"]);

function tableOf(entity: string): GeneratedCrudTable {
  const tables = getGeneratedCrudTables().filter((table) => table.source?.authoringEntityName === entity && !table.subtype);
  if (tables.length !== 1) extensionError(`Entity ${entity} has no unambiguous table.`, "INVALID_DEFINITION");
  return tables[0]!;
}

function entryOf(entity: string): RuntimeExtensibleEntity {
  const entry = extensionRegistry.entity(entity);
  if (!entry) extensionError(`Entity ${entity} has no tenant fields.`, "NOT_FOUND");
  return entry!;
}

/** Manage roles (Organization.All.ReadWrite included by the compiler). */
export function assertMayManage(entity: string, session: DbSessionInput): void {
  const entry = entryOf(entity);
  if (!(session.roles ?? []).some((role) => entry.manageRoles.includes(role))) {
    throw operationFailure({ code: "FORBIDDEN", message: `Not authorized to design the fields of ${entity}.`, retryable: false });
  }
}

/** Reading definitions follows the entity's own read roles. */
export function assertMayRead(entity: string, session: DbSessionInput): void {
  const table = tableOf(entity);
  requireEntityOperation(table, isGeneratedCrudOperationEnabled(table, "list") ? "list" : "get", session);
}

function toRecord(field: ExtensionField, backfill?: BackfillRow): FieldDefinitionRecord {
  return {
    fieldId: field.fieldId, key: field.key, version: field.version, kind: field.kind,
    definition: field.definition, appliesWhen: field.appliesWhen, state: field.state, position: field.position,
    ...(backfill ? { backfill: { id: backfill.id, state: backfill.state, processed: Number(backfill.processed), total: Number(backfill.total) } } : {}),
  };
}

// ---------------------------------------------------------------------------
// Validation (§5.2)

function typeLabel(definition: ExtensionDefinition): string {
  return `${String(definition.osfType)}${isCollection(definition) ? "[]" : ""}${hasStaticOptions(definition) ? " (options)" : ""}`;
}

/**
 * A definition a tenant may save. `existing` is the field being changed;
 * its own key and position do not collide with themselves.
 */
export function validateFieldDefinition(
  set: ExtensionFieldSet,
  table: GeneratedCrudTable,
  input: { key: string; kind?: unknown; definition: unknown; appliesWhen?: unknown },
  existing?: ExtensionField,
): { kind: ExtensionKind; definition: ExtensionDefinition; appliesWhen: unknown } {
  const kind = input.kind ?? "stored";
  if (typeof kind === "string" && UNAVAILABLE_KINDS.has(kind)) {
    extensionError(`Fields of kind ${kind} are not available yet (nog niet beschikbaar).`, "NOT_AVAILABLE");
  }
  if (kind !== "stored") extensionError(`Unknown field kind ${String(kind)}.`);
  if (typeof input.key !== "string" || !EXTENSION_KEY.test(input.key)) {
    extensionError("A field key starts with a lowercase letter and holds letters and digits only (at most 63).");
  }
  const clash = set.byKey.get(input.key);
  if (clash && clash.fieldId !== existing?.fieldId) extensionError(`Field key ${input.key} is already in use.`, "CONFLICT");
  if (!record(input.definition)) extensionError("A field definition is an object.");
  const definition = { ...input.definition as ExtensionDefinition };
  delete definition.key;
  const osfType = definition.osfType;
  const entry = set.entry;
  if (typeof osfType !== "string" || !(entry.allowedOsfTypes.includes(osfType) || entry.targets.some((target) => target.entity === osfType))) {
    extensionError(`Type ${String(osfType)} is not available for tenant fields of ${set.entity}.`);
  }
  for (const property of UNSUPPORTED_PROPERTIES) {
    if (definition[property] !== undefined) extensionError(`Tenant fields do not support ${property}.`);
  }
  const sensitivity = record(definition.classification) ? definition.classification.sensitivity : undefined;
  if (!SENSITIVITIES.includes(sensitivity as typeof SENSITIVITIES[number])) {
    extensionError("A tenant field declares its classification (public, internal, confidential, pii or bsn).");
  }
  const shape = extensionShape(entry, definition);
  if (definition.options !== undefined && !hasStaticOptions(definition)) extensionError("Tenant fields offer static options only.");
  if (hasStaticOptions(definition) && shape.baseType !== "string") extensionError("Static options belong on a string field.");
  if (shape.collection && !shape.reference && !shape.staticOptions) {
    extensionError("Only references and static options can hold more than one value.");
  }
  if (shape.baseType === "object" && !shape.projection) extensionError(`Type ${osfType} has no index projection.`);
  if (definition.unique !== undefined && typeof definition.unique !== "boolean") extensionError("unique is a boolean.");
  if (definition.unique === true && (shape.collection || shape.baseType === "boolean" || shape.baseType === "object")) {
    extensionError("Only single scalar values can be unique.");
  }
  if (definition.required !== undefined && typeof definition.required !== "boolean") extensionError("required is a boolean.");
  if (definition.onDelete !== undefined) {
    if (!shape.reference) extensionError("onDelete belongs on a reference field.");
    if (definition.onDelete !== "restrict" && definition.onDelete !== "setNull") extensionError("onDelete is restrict or setNull.");
  }
  if (definition.retention !== undefined) {
    const retention = definition.retention;
    if (!record(retention) || !Number.isInteger(retention.days) || (retention.days as number) < 1 ||
        (retention.from !== undefined && retention.from !== "createdAt" && retention.from !== "updatedAt") ||
        Object.keys(retention).some((key) => key !== "days" && key !== "from")) {
      extensionError("retention is { days, from?: createdAt | updatedAt }.");
    }
  }
  let property: Record<string, unknown> | undefined;
  try {
    const schema = generatedRuntimeFieldSchemas.object([schemaFieldOf({ key: input.key, definition })]);
    property = (schema.properties as Record<string, Record<string, unknown>>)[input.key];
  } catch (error) {
    extensionError("The field definition does not match the FieldDefinition schema.", "VALIDATION",
      error instanceof Error ? error.message : undefined);
  }
  if (definition.defaultValue !== undefined) {
    const result = runtimeJsonSchemas.validate({ type: "object", properties: { value: property ?? {} } }, { value: definition.defaultValue });
    if (!result.valid) extensionError("The default value does not fit the field's type.");
    if (shape.reference) extensionError("A reference field has no default value.");
  }
  const appliesWhen = input.appliesWhen ?? null;
  if (appliesWhen !== null) {
    const authored = fieldColumnMap(table);
    for (const path of conditionPaths(appliesWhen)) {
      if (path.kind === "authored") {
        const column = authored.get(path.field);
        if (!column || column.classification || column.fieldPolicy) extensionError(`appliesWhen names ${path.field}, which is not a readable field of ${set.entity}.`);
      } else {
        const target = set.byKey.get(path.key);
        if (!target || target.fieldId === existing?.fieldId || !hasStaticOptions(target.definition)) {
          extensionError(`appliesWhen may name tenant fields with static options only; extensions.${path.key} is not one.`);
        }
      }
    }
  }
  return { kind: "stored", definition, appliesWhen };
}

// ---------------------------------------------------------------------------
// Storage

async function insertVersion(
  trx: Transaction<DB>,
  session: DbSessionInput,
  entity: string,
  field: { fieldId: string; key: string; version: number; kind: ExtensionKind; definition: ExtensionDefinition; appliesWhen: unknown; state: ExtensionState; position: number },
): Promise<ExtensionField> {
  await sql`update platform.extension_field_definitions set is_current = false
    where tenant_id = ${session.tenantId}::uuid and field_id = ${field.fieldId}::uuid and is_current`.execute(trx);
  const id = randomUUID();
  await sql`insert into platform.extension_field_definitions
      (tenant_id, id, field_id, entity, key, version, kind, definition, applies_when, state, position, is_current, created_at, created_by)
    values (${session.tenantId}::uuid, ${id}::uuid, ${field.fieldId}::uuid, ${entity}, ${field.key}, ${field.version}, ${field.kind},
      ${jsonbLiteral(field.definition)}, ${field.appliesWhen === null ? null : jsonbLiteral(field.appliesWhen)}, ${field.state}, ${field.position}, true,
      now(), ${session.userId ?? null}::uuid)`.execute(trx);
  forgetExtensionFields(session.tenantId!, entity);
  return { rowId: id, ...field };
}

function requireField(set: ExtensionFieldSet, fieldId: unknown, allowDeleted = false): ExtensionField {
  const field = typeof fieldId === "string" ? set.byId.get(fieldId) : undefined;
  if (!field || (!allowDeleted && field.state === "deleted")) extensionError("The field does not exist.", "NOT_FOUND");
  return field!;
}

async function affectedRecordCount(trx: Transaction<DB>, session: DbSessionInput, entry: RuntimeExtensibleEntity, fieldId: string): Promise<number> {
  const result = await sql<{ count: string }>`select count(*)::text as count from ${qualifiedTable(entry.table)}
    where tenant_id = ${session.tenantId}::uuid and extension_values ? ${fieldId}`.execute(trx);
  return Number(result.rows[0]?.count ?? 0);
}

/**
 * §5.3 type changes: only widening ones, carried out as a backfill.
 * Returns the backfill operation, or refuses with the reason.
 */
async function typeChange(
  trx: Transaction<DB>,
  session: DbSessionInput,
  set: ExtensionFieldSet,
  before: ExtensionDefinition,
  after: ExtensionDefinition,
  field: ExtensionField,
): Promise<BackfillOperation | undefined> {
  const options = (definition: ExtensionDefinition) => hasStaticOptions(definition)
    ? ((definition.options as { items?: Array<{ value: string }> }).items ?? []).map((item) => item.value) : undefined;
  const sameType = before.osfType === after.osfType && isCollection(before) === isCollection(after);
  const removedOptions = async (allowed: string[]) => {
    const used = await sql<{ value_text: string }>`select distinct value_text from ${qualifiedTable(set.entry.valuesTable)}
      where tenant_id = ${session.tenantId}::uuid and field_id = ${field.fieldId}::uuid and value_text is not null
        and not (value_text = any(${`{${allowed.map((value) => `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`).join(",")}}`}::text[]))
      order by value_text limit 20`.execute(trx);
    return used.rows.map((row) => row.value_text);
  };
  if (sameType) {
    const was = options(before), is = options(after);
    if (!was && !is) return undefined;
    if (was && !is) extensionError(`${field.key}: removing the options of a field is not a widening change.`);
    const missing = await removedOptions(is!);
    if (missing.length) extensionError(`${field.key}: existing values are not among the options: ${missing.join(", ")}.`);
    // string → options with every existing value an option is the one
    // widening §5.3 names; the index already holds the same text.
    return was ? undefined : "retype";
  }
  if (isCollection(before) === isCollection(after) && before.osfType === "integer" && after.osfType === "number") return "retype";
  extensionError(`${field.key}: changing ${typeLabel(before)} to ${typeLabel(after)} is not a widening change; ` +
    "create a new field, copy the values and delete this one.");
}

// ---------------------------------------------------------------------------
// The Operations

type Input = Record<string, unknown>;

export async function executeFieldDefinitionAction(
  trx: Transaction<DB>,
  session: DbSessionInput,
  entity: string,
  action: FieldDefinitionAction,
  input: Input,
): Promise<Record<string, unknown>> {
  const entry = entryOf(entity);
  const table = tableOf(entity);
  if (action === "list") assertMayRead(entity, session);
  else assertMayManage(entity, session);
  const set = await loadExtensionFieldsFor(trx, session, entity, entry, { lock: action !== "list" });
  switch (action) {
    case "list": {
      const backfills = await latestBackfills(trx, session.tenantId!, entity);
      const items = set.fields
        .filter((field) => field.state !== "deleted" && (input.includeDeprecated === true || field.state !== "deprecated"))
        .map((field) => toRecord(field, backfills.get(field.fieldId)));
      return { items };
    }
    case "create": {
      const live = set.fields.filter((field) => field.state !== "deleted");
      if (live.length >= entry.limits.fields) extensionError(`${entity} holds at most ${entry.limits.fields} tenant fields.`, "LIMIT_EXCEEDED");
      const valid = validateFieldDefinition(set, table, { key: input.key as string, kind: input.kind, definition: input.definition, appliesWhen: input.appliesWhen });
      const field = await insertVersion(trx, session, entity, {
        fieldId: randomUUID(), key: input.key as string, version: 1, kind: valid.kind, definition: valid.definition,
        appliesWhen: valid.appliesWhen, state: "ready", position: Math.max(-1, ...set.fields.map((item) => item.position)) + 1,
      });
      if (valid.definition.retention) await scheduleExtensionRetention(trx, session, entity);
      return toRecord(field);
    }
    case "update": {
      const field = requireField(set, input.fieldId);
      if (field.state === "updating") extensionError(`${field.key} is being updated; wait until its backfill is done.`, "CONFLICT");
      const key = input.key === undefined ? field.key : input.key as string;
      const definition = input.definition === undefined ? field.definition : input.definition;
      const appliesWhen = input.appliesWhen === undefined ? field.appliesWhen : input.appliesWhen;
      const valid = validateFieldDefinition(set, table, { key, kind: field.kind, definition, appliesWhen }, field);
      if (key === field.key && isDeepStrictEqual(valid.definition, field.definition) && isDeepStrictEqual(valid.appliesWhen, field.appliesWhen)) {
        return toRecord(field);
      }
      let backfill = await typeChange(trx, session, set, field.definition, valid.definition, field);
      if (valid.definition.unique === true && field.definition.unique !== true) {
        const duplicates = await sql<{ value: string; count: string }>`
          select coalesce(value_text, value_number::text, value_ref_id::text, value_date::text, value_timestamp::text) as value, count(*)::text as count
          from ${qualifiedTable(entry.valuesTable)}
          where tenant_id = ${session.tenantId}::uuid and field_id = ${field.fieldId}::uuid and ordinal = 0
          group by 1 having count(*) > 1 order by 1 limit 20`.execute(trx);
        if (duplicates.rows.length) {
          throw operationFailure({
            code: "CONFLICT",
            message: `${field.key} cannot become unique: ${duplicates.rows.length} value(s) are used more than once.`,
            detail: duplicates.rows.map((row) => `${row.value} (${row.count}×)`).join(", "),
            retryable: false,
          });
        }
        backfill ??= "unique";
      }
      if (valid.definition.unique !== true && field.definition.unique === true) {
        await sql`delete from ${qualifiedTable(entry.uniqueTable)}
          where tenant_id = ${session.tenantId}::uuid and field_id = ${field.fieldId}::uuid`.execute(trx);
      }
      const next = await insertVersion(trx, session, entity, {
        fieldId: field.fieldId, key, version: field.version + 1, kind: field.kind, definition: valid.definition,
        appliesWhen: valid.appliesWhen, state: backfill ? "updating" : field.state, position: field.position,
      });
      // A retype that also turns unique on claims as it rebuilds: the unique
      // backfill rewrites claims only, the retype the index only.
      const started = backfill ? await startBackfill(trx, session, { entity, field: next, operation: backfill === "retype" && valid.definition.unique === true && field.definition.unique !== true ? "unique" : backfill }) : undefined;
      if (valid.definition.retention && !field.definition.retention) await scheduleExtensionRetention(trx, session, entity);
      return toRecord(next, started);
    }
    case "deprecate":
    case "restore": {
      const field = requireField(set, input.fieldId);
      const from = action === "deprecate" ? "ready" : "deprecated";
      if (field.state !== from) extensionError(`${field.key} is ${field.state}; only a ${from} field can be ${action}d.`, "CONFLICT");
      const next = await insertVersion(trx, session, entity, { ...field, version: field.version + 1, state: action === "deprecate" ? "deprecated" : "ready" });
      return toRecord(next);
    }
    case "affectedRecords": {
      const field = requireField(set, input.fieldId);
      return { count: await affectedRecordCount(trx, session, entry, field.fieldId) };
    }
    case "delete": {
      const field = requireField(set, input.fieldId);
      if (field.state !== "deprecated") extensionError(`${field.key} must be deprecated before it can be deleted.`, "CONFLICT");
      const count = await affectedRecordCount(trx, session, entry, field.fieldId);
      if (input.confirmAffectedRecords !== count) {
        throw operationFailure({
          code: "CONFIRMATION_MISMATCH",
          message: `Deleting ${field.key} affects ${count} record(s); confirm that number.`,
          data: { affectedRecords: count },
          retryable: false,
        });
      }
      const next = await insertVersion(trx, session, entity, { ...field, version: field.version + 1, state: "deleted" });
      const backfill = await startBackfill(trx, session, { entity, field: next, operation: "delete" });
      return { backfillId: backfill.id };
    }
    case "reorder": {
      const ids = input.fieldIds;
      const live = set.fields.filter((field) => field.state !== "deleted");
      if (!Array.isArray(ids) || ids.length !== live.length || new Set(ids).size !== ids.length ||
          !ids.every((id) => live.some((field) => field.fieldId === id))) {
        extensionError("Reorder names every current field exactly once.");
      }
      // Position is presentation, not a definition: it changes in place on
      // the current version rather than minting one per field.
      for (const [position, fieldId] of (ids as string[]).entries()) {
        await sql`update platform.extension_field_definitions set position = ${position}
          where tenant_id = ${session.tenantId}::uuid and field_id = ${fieldId}::uuid and is_current`.execute(trx);
      }
      forgetExtensionFields(session.tenantId!, entity);
      const reloaded = await loadExtensionFieldsFor(trx, session, entity, entry);
      return { items: reloaded.fields.filter((field) => field.state !== "deleted").map((field) => toRecord(field)) };
    }
  }
}

/**
 * `T.referencedBy`: per source entity and field, how many records point at
 * this one — counted from each extensible entity's `(tenant_id,
 * value_ref_id)` index, and only for source entities this reader may list.
 */
export async function executeReferencedBy(
  trx: Transaction<DB>,
  session: DbSessionInput,
  targetEntity: string,
  input: Input,
): Promise<{ items: Array<{ entity: string; fieldId: string; fieldKey: string; label: unknown; count: number }> }> {
  const target = tableOf(targetEntity);
  requireEntityOperation(target, isGeneratedCrudOperationEnabled(target, "get") ? "get" : "list", session);
  if (typeof input.id !== "string" || !/^[0-9a-f-]{36}$/i.test(input.id)) extensionError("referencedBy needs a record id.");
  const items: Array<{ entity: string; fieldId: string; fieldKey: string; label: unknown; count: number }> = [];
  for (const source of extensionRegistry.referencedBy(targetEntity)) {
    try { assertMayRead(source.sourceEntity, session); } catch { continue; }
    const entry = extensionRegistry.entity(source.sourceEntity)!;
    const set = await loadExtensionFieldsFor(trx, session, source.sourceEntity, entry);
    const counts = await sql<{ field_id: string; count: string }>`
      select field_id, count(distinct record_id)::text as count from ${qualifiedTable(source.valuesTable)}
      where tenant_id = ${session.tenantId}::uuid and value_ref_id = ${input.id}::uuid
      group by field_id order by field_id`.execute(trx);
    for (const row of counts.rows) {
      const field = set.byId.get(row.field_id);
      if (!field || field.state === "deleted" || extensionShape(entry, field.definition).reference?.entity !== targetEntity) continue;
      items.push({ entity: source.sourceEntity, fieldId: field.fieldId, fieldKey: field.key, label: field.definition.label ?? field.key, count: Number(row.count) });
    }
  }
  return { items };
}
