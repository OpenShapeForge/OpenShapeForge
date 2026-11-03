// SPDX-License-Identifier: BUSL-1.1
/**
 * The definition Operations of an extensible entity E:
 * `E.fieldDefinitions.list/create/update/deprecate/restore/delete/reorder/
 * affectedRecords/rebuildIndex`, and `T.referencedBy` on every entity a
 * tenant field may point at. Definitions are append-only versions in
 * `platform.extension_field_definitions`; the lifecycle is a data
 * migration, so every change that touches records starts a backfill.
 */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { sql, type Transaction } from "kysely";
import { operationFailure } from "@openshapeforge/operations";
import type { RuntimeExtensibleEntity } from "@openshapeforge/plugin-runtime";
import type { DB } from "../../../generated/db/types.js";
import type { DbSessionInput } from "../../../db/session.js";
import { generatedRuntimeFieldSchemas, runtimeJsonSchemas } from "../../../modules/field-schemas.js";
import { getGeneratedCrudTables, isGeneratedCrudOperationEnabled, requireEntityOperation } from "../catalog.js";
import { canReadClassifiedColumns } from "../classification.js";
import { fieldColumnMap } from "../columns.js";
import type { GeneratedCrudTable } from "../types.js";
import {
  conditionPaths,
  EXTENSION_KEY,
  extensionError,
  extensionShape,
  hasStaticOptions,
  isClassified,
  isCollection,
  mapConditionPaths,
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
import {
  announceFieldDefinitionChange,
  FIELD_DEFINITION_RESOURCE_SUFFIX,
  forgetExtensionFields,
  insertFieldVersion,
  loadExtensionFieldsFor,
} from "./store.js";
import { qualifiedTable } from "./write.js";
import {
  acrossTenant,
  duplicateValues,
  latestBackfills,
  recordsWithField,
  scheduleExtensionRetention,
  startBackfill,
  type BackfillOperation,
  type BackfillRow,
} from "./backfill.js";

export type FieldDefinitionAction =
  | "list" | "create" | "update" | "deprecate" | "restore" | "delete" | "reorder" | "affectedRecords" | "rebuildIndex";

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

function mayRead(entity: string, session: DbSessionInput): boolean {
  try { assertMayRead(entity, session); return true; } catch { return false; }
}

/**
 * The realtime resource `<Entity>FieldDefinition` (store.ts): an event is
 * delivered only to a session that may list that entity's field
 * definitions, re-decided by the change stream when it reads the event.
 * There is no row to hide, so a deletion is delivered like any change.
 */
export function mayFollowFieldDefinitions(session: DbSessionInput, aggregateType: string): boolean | undefined {
  if (!aggregateType.endsWith(FIELD_DEFINITION_RESOURCE_SUFFIX)) return undefined;
  const entity = aggregateType.slice(0, -FIELD_DEFINITION_RESOURCE_SUFFIX.length);
  if (!extensionRegistry.entity(entity)) return undefined;
  return mayRead(entity, session);
}

/** A stored condition names tenant fields by id; a caller reads and writes keys. */
function appliesWhenForCaller(set: ExtensionFieldSet, appliesWhen: unknown): unknown {
  return appliesWhen === null || appliesWhen === undefined ? null
    : mapConditionPaths(appliesWhen, (fieldId) => set.byId.get(fieldId)?.key ?? fieldId);
}

function toRecord(set: ExtensionFieldSet, field: ExtensionField, backfill?: BackfillRow): FieldDefinitionRecord {
  return {
    fieldId: field.fieldId, key: field.key, version: field.version, kind: field.kind,
    definition: field.definition, appliesWhen: appliesWhenForCaller(set, field.appliesWhen), state: field.state, position: field.position,
    ...(backfill ? { backfill: { id: backfill.id, state: backfill.state, processed: Number(backfill.processed), total: Number(backfill.total) } } : {}),
  };
}

// ---------------------------------------------------------------------------
// Validation

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
): { kind: ExtensionKind; definition: ExtensionDefinition; appliesWhen: unknown; dependsOn: Array<{ field: string }> } {
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
  // The caller names tenant fields by key; the stored condition by field id,
  // and so do the dependencies that keep a named field from going away.
  const appliesWhen = input.appliesWhen ?? null;
  const dependsOn: Array<{ field: string }> = [];
  let stored: unknown = null;
  if (appliesWhen !== null) {
    const authored = fieldColumnMap(table);
    for (const path of conditionPaths(appliesWhen)) {
      if (path.kind === "authored") {
        const column = authored.get(path.field);
        if (!column || column.classification || column.fieldPolicy) extensionError(`appliesWhen names ${path.field}, which is not a readable field of ${set.entity}.`);
        dependsOn.push({ field: path.field });
      } else {
        const target = set.byKey.get(path.key);
        if (!target || target.fieldId === existing?.fieldId || !hasStaticOptions(target.definition)) {
          extensionError(`appliesWhen may name tenant fields with static options only; extensions.${path.key} is not one.`);
        }
        // A condition over a classified field is an oracle for its value:
        // whether the field applies tells a reader what the hidden one holds.
        if (isClassified(target!.definition)) {
          extensionError(`appliesWhen may not name extensions.${path.key}: it is classified.`);
        }
        dependsOn.push({ field: target!.fieldId });
      }
    }
    stored = mapConditionPaths(appliesWhen, (key) => set.byKey.get(key)!.fieldId);
  }
  return { kind: "stored", definition, appliesWhen: stored, dependsOn: [...new Map(dependsOn.map((item) => [item.field, item])).values()] };
}

// ---------------------------------------------------------------------------
// Storage

const insertVersion = insertFieldVersion;

/**
 * The fields this one depends on: rewritten with every
 * version, in `platform.extension_field_dependencies` (1a: `appliesWhen`;
 * formulas, lookups and rollups add theirs in 1b/1c).
 */
async function writeDependencies(trx: Transaction<DB>, session: DbSessionInput, entity: string, fieldId: string, dependsOn: readonly { field: string }[]): Promise<void> {
  await sql`delete from platform.extension_field_dependencies
    where tenant_id = ${session.tenantId}::uuid and field_id = ${fieldId}::uuid`.execute(trx);
  for (const dependency of dependsOn) {
    await sql`insert into platform.extension_field_dependencies (tenant_id, field_id, depends_on_entity, depends_on_field, via_field)
      values (${session.tenantId}::uuid, ${fieldId}::uuid, ${entity}, ${dependency.field}, null)`.execute(trx);
  }
}

/** Refuse taking away a field another (not deleted) field still depends on, naming those fields. */
function assertNoDependents(set: ExtensionFieldSet, field: ExtensionField, dependents: readonly string[], action: string): void {
  const names = dependents.map((id) => set.byId.get(id)).filter((candidate): candidate is ExtensionField =>
    candidate !== undefined && candidate.state !== "deleted" && candidate.fieldId !== field.fieldId).map((candidate) => candidate.key).sort();
  if (names.length) {
    extensionError(`${field.key} cannot be ${action}: ${names.join(", ")} depend${names.length === 1 ? "s" : ""} on it (appliesWhen).`, "CONFLICT");
  }
}

async function dependentsOf(trx: Transaction<DB>, session: DbSessionInput, entity: string, fieldId: string): Promise<string[]> {
  const rows = await sql<{ field_id: string }>`select distinct field_id::text as field_id from platform.extension_field_dependencies
    where tenant_id = ${session.tenantId}::uuid and depends_on_entity = ${entity} and depends_on_field = ${fieldId}
    order by 1`.execute(trx);
  return rows.rows.map((row) => row.field_id);
}

function requireField(set: ExtensionFieldSet, fieldId: unknown, allowDeleted = false): ExtensionField {
  const field = typeof fieldId === "string" ? set.byId.get(fieldId) : undefined;
  if (!field || (!allowDeleted && field.state === "deleted")) extensionError("The field does not exist.", "NOT_FOUND");
  return field!;
}

/**
 * Records holding a value of the field: every record of the tenant, the set
 * a delete erases (backfill.ts), not only those this actor may see — so the
 * confirmed number is the number that will be erased.
 */
function affectedRecordCount(trx: Transaction<DB>, session: DbSessionInput, entity: string, fieldId: string): Promise<number> {
  return recordsWithField(trx, session, entity, fieldId);
}

/**
 * Whether a refusal may show this actor values of the field: never for a classified field, and only to an actor who may read the
 * entity. The values shown are only ever those of records the actor may see.
 */
function mayShowValues(set: ExtensionFieldSet, field: ExtensionField, session: DbSessionInput): boolean {
  return !isClassified(field.definition) && mayRead(set.entity, session);
}

/** Strict-er validation, or a reinterpretation of stored values, is "new field + copy". */
const LOWER_BOUNDS = ["min", "minLength", "minItems"];
const UPPER_BOUNDS = ["max", "maxLength", "maxItems"];

function narrowingChange(before: ExtensionDefinition, after: ExtensionDefinition): string | undefined {
  if (!isDeepStrictEqual(before.classification, after.classification)) return "its classification never changes once the field exists";
  const currency = (definition: ExtensionDefinition) => [definition.currency,
    (definition.render as { props?: { currency?: unknown } } | undefined)?.props?.currency];
  if (!isDeepStrictEqual(currency(before), currency(after))) return "changing the currency reinterprets every stored amount";
  if (!isDeepStrictEqual(before.unit, after.unit)) return "changing the unit reinterprets every stored value";
  const was = record(before.validation) ? before.validation : {};
  const is = record(after.validation) ? after.validation : {};
  for (const name of new Set([...Object.keys(was), ...Object.keys(is)])) {
    const previous = was[name], next = is[name];
    if (next === undefined || isDeepStrictEqual(previous, next)) continue;
    const stricter = previous === undefined ||
      (LOWER_BOUNDS.includes(name) ? !(Number(next) <= Number(previous))
        : UPPER_BOUNDS.includes(name) ? !(Number(next) >= Number(previous))
        : true);
    if (stricter) return `validation.${name} becomes stricter`;
  }
  const max = (definition: ExtensionDefinition) => {
    const cardinality = definition.cardinality;
    if (!record(cardinality)) return cardinality === "collection" ? Infinity : 1;
    return cardinality.max === "unbounded" ? Infinity : Number(cardinality.max ?? 1);
  };
  if (max(after) < max(before)) return "cardinality.max becomes lower";
  return undefined;
}

/**
 * Type changes: only widening ones, carried out as a backfill.
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
  const narrowing = narrowingChange(before, after);
  if (narrowing) extensionError(`${field.key}: ${narrowing}; create a new field, copy the values and delete this one.`);
  const sameType = before.osfType === after.osfType && isCollection(before) === isCollection(after);
  /** Values in use outside the new options: counted across the tenant, shown only as mayShowValues allows. */
  const removedOptions = async (allowed: string[]) => {
    const outside = (limit?: number) => sql<{ value_text: string; total: string }>`
      select value_text, (count(*) over ())::text as total from (
        select distinct value_text from ${qualifiedTable(set.entry.valuesTable)}
        where tenant_id = ${session.tenantId}::uuid and field_id = ${field.fieldId}::uuid and value_text is not null
          and not (value_text = any(${`{${allowed.map((value) => `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`).join(",")}}`}::text[]))) as used
      order by value_text ${limit ? sql`limit ${limit}` : sql``}`.execute(trx);
    const count = await acrossTenant(trx, session, `check options of tenant field ${field.fieldId}`,
      async () => Number((await outside(1)).rows[0]?.total ?? 0));
    const examples = count && mayShowValues(set, field, session) ? (await outside(20)).rows.map((row) => row.value_text) : [];
    return { count, examples };
  };
  if (sameType) {
    const was = options(before), is = options(after);
    if (!was && !is) return undefined;
    if (was && !is) extensionError(`${field.key}: removing the options of a field is not a widening change.`);
    const missing = await removedOptions(is!);
    if (missing.count) {
      extensionError(`${field.key}: ${missing.count} existing value(s) are not among the options` +
        (missing.examples.length ? `: ${missing.examples.join(", ")}.` : "."));
    }
    // string → options with every existing value an option is the one
    // widening type changes name; the index already holds the same text.
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
        .map((field) => toRecord(set, field, backfills.get(field.fieldId)));
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
      await writeDependencies(trx, session, entity, field.fieldId, valid.dependsOn);
      if (valid.definition.retention) await scheduleExtensionRetention(trx, session, entity);
      return toRecord(set, field);
    }
    case "update": {
      const field = requireField(set, input.fieldId);
      if (field.state === "updating") extensionError(`${field.key} is being updated; wait until its backfill is done.`, "CONFLICT");
      // A deprecated field is changed only once it is back: a retype or
      // unique would otherwise bring it back silently.
      if (field.state === "deprecated") extensionError(`${field.key} is deprecated; restore it before changing it.`, "CONFLICT");
      const key = input.key === undefined ? field.key : input.key as string;
      const definition = input.definition === undefined ? field.definition : input.definition;
      const appliesWhen = input.appliesWhen === undefined ? appliesWhenForCaller(set, field.appliesWhen) : input.appliesWhen;
      const valid = validateFieldDefinition(set, table, { key, kind: field.kind, definition, appliesWhen }, field);
      if (key === field.key && isDeepStrictEqual(valid.definition, field.definition) && isDeepStrictEqual(valid.appliesWhen, field.appliesWhen)) {
        return toRecord(set, field);
      }
      let backfill = await typeChange(trx, session, set, field.definition, valid.definition, field);
      if (valid.definition.unique === true && field.definition.unique !== true) {
        // Counted across the tenant, normalized as claims compare; the values
        // are shown only as mayShowValues allows, and only those of records
        // this actor may see. A duplicate written while the unique backfill
        // runs turns unique off again (backfill.ts).
        const duplicates = await acrossTenant(trx, session, `check duplicates of tenant field ${field.fieldId}`,
          () => duplicateValues(trx, session.tenantId!, set, field, false));
        if (duplicates.count) {
          const shown = mayShowValues(set, field, session) ? (await duplicateValues(trx, session.tenantId!, set, field, true)).examples : [];
          throw operationFailure({
            code: "CONFLICT",
            message: `${field.key} cannot become unique: ${duplicates.count} value(s) are used more than once.`,
            ...(shown.length ? { detail: shown.map((row) => `${row.value} (${row.count}×)`).join(", ") } : {}),
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
      await writeDependencies(trx, session, entity, field.fieldId, valid.dependsOn);
      // A retype that also turns unique on claims as it rebuilds: the unique
      // backfill rewrites claims only, the retype the index only.
      const started = backfill ? await startBackfill(trx, session, { entity, field: next, operation: backfill === "retype" && valid.definition.unique === true && field.definition.unique !== true ? "unique" : backfill }) : undefined;
      if (valid.definition.retention && !field.definition.retention) await scheduleExtensionRetention(trx, session, entity);
      return toRecord(set, next, started);
    }
    case "deprecate":
    case "restore": {
      const field = requireField(set, input.fieldId);
      // A field in `updating` can always be deprecated, then deleted: a
      // backfill that never finishes must not trap it.
      const from: ExtensionState[] = action === "deprecate" ? ["ready", "updating"] : ["deprecated"];
      if (!from.includes(field.state)) extensionError(`${field.key} is ${field.state}; only a ${from.join(" or ")} field can be ${action}d.`, "CONFLICT");
      if (action === "deprecate") assertNoDependents(set, field, await dependentsOf(trx, session, entity, field.fieldId), "deprecated");
      const next = await insertVersion(trx, session, entity, { ...field, version: field.version + 1, state: action === "deprecate" ? "deprecated" : "ready" });
      return toRecord(set, next);
    }
    case "affectedRecords": {
      const field = requireField(set, input.fieldId);
      return { count: await affectedRecordCount(trx, session, entity, field.fieldId) };
    }
    case "delete": {
      const field = requireField(set, input.fieldId);
      if (field.state !== "deprecated") extensionError(`${field.key} must be deprecated before it can be deleted.`, "CONFLICT");
      assertNoDependents(set, field, await dependentsOf(trx, session, entity, field.fieldId), "deleted");
      const count = await affectedRecordCount(trx, session, entity, field.fieldId);
      if (input.confirmAffectedRecords !== count) {
        throw operationFailure({
          code: "CONFIRMATION_MISMATCH",
          message: `Deleting ${field.key} affects ${count} record(s); confirm that number.`,
          data: { affectedRecords: count },
          retryable: false,
        });
      }
      const next = await insertVersion(trx, session, entity, { ...field, version: field.version + 1, state: "deleted" });
      await writeDependencies(trx, session, entity, field.fieldId, []);
      const backfill = await startBackfill(trx, session, { entity, field: next, operation: "delete" });
      return { backfillId: backfill.id };
    }
    case "rebuildIndex": {
      // The index and the claims are derived: rebuilt from the source,
      // per field, as backfills over every record of the tenant.
      const fields = input.fieldId === undefined
        ? set.fields.filter((field) => field.state !== "deleted" && field.kind === "stored")
        : [requireField(set, input.fieldId)];
      const backfills: Array<{ fieldId: string; backfillId: string }> = [];
      for (const field of fields) {
        const started = await startBackfill(trx, session, { entity, field, operation: "rebuild" });
        backfills.push({ fieldId: field.fieldId, backfillId: started.id });
      }
      return { backfills };
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
        await announceFieldDefinitionChange(trx, session.tenantId!, entity, fieldId, "updated");
      }
      forgetExtensionFields(trx, session.tenantId!, entity);
      const reloaded = await loadExtensionFieldsFor(trx, session, entity, entry);
      return { items: reloaded.fields.filter((field) => field.state !== "deleted").map((field) => toRecord(reloaded, field)) };
    }
  }
}

/**
 * `T.referencedBy`: per source entity and field, how many records point at
 * this one — counted from each extensible entity's `(tenant_id,
 * value_ref_id)` index, and only for source entities this reader may list.
 * The index inherits the source entity's row policies, so only records this
 * reader may see are counted; a classified reference field is listed only to
 * a reader who may read the source's classified fields.
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
    if (!mayRead(source.sourceEntity, session)) continue;
    const entry = extensionRegistry.entity(source.sourceEntity)!;
    const classified = canReadClassifiedColumns(tableOf(source.sourceEntity).source?.authorization, session);
    const set = await loadExtensionFieldsFor(trx, session, source.sourceEntity, entry);
    const counts = await sql<{ field_id: string; count: string }>`
      select field_id, count(distinct record_id)::text as count from ${qualifiedTable(source.valuesTable)}
      where tenant_id = ${session.tenantId}::uuid and value_ref_id = ${input.id}::uuid
      group by field_id order by field_id`.execute(trx);
    for (const row of counts.rows) {
      const field = set.byId.get(row.field_id);
      if (!field || field.state === "deleted" || extensionShape(entry, field.definition).reference?.entity !== targetEntity) continue;
      if (isClassified(field.definition) && !classified) continue;
      items.push({ entity: source.sourceEntity, fieldId: field.fieldId, fieldKey: field.key, label: field.definition.label ?? field.key, count: Number(row.count) });
    }
  }
  return { items };
}
