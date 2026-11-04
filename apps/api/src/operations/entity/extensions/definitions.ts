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
import { exactNumericEquals, operationFailure } from "@openshapeforge/operations";
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
  linkedResultType,
  mapConditionPaths,
  numericValue,
  proofLost,
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
  formulaDependencies,
  formulaGraph,
  presentFormulaDefinition,
  storedFormula,
  validateFormulaDefinition,
  withRestoredField,
  type FormulaDependency,
  type RetypedReader,
} from "./formulas.js";
import {
  announceFieldDefinitionChange,
  FIELD_DEFINITION_RESOURCE_SUFFIX,
  forgetExtensionFields,
  insertFieldVersion,
  loadExtensionFieldsFor,
} from "./store.js";
import { qualifiedTable } from "./write.js";
import {
  assertNoLinkedReaders,
  assertRollupsCanRead,
  assertTenantGraph,
  isLinkedKind,
  lockExtensionGraph,
  presentLinkedDefinition,
  recomputeLinkedReaders,
  refuseProof,
  tenantFieldNames,
  validateLinkedDefinition,
} from "./linked.js";
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
  backfill?: { id: string; state: string; processed: number; total: number; error?: { code: string; message: string } };
};

/** Properties a tenant field may not carry: they need a runtime the serialization step does not have. */
const UNSUPPORTED_PROPERTIES = [
  "authorization", "permissions", "writtenBy", "immutable", "typedBy", "entityValue", "transitions",
  "computed", "deriveOnCreate", "relationship", "document", "variables", "provider", "persisted",
  "children", "shape", "item", "allowedDefinitions", "childAuthorization", "childLock", "writeSource",
  "defaultTemplate", "transform", "suggestions", "runtime", "localized",
];

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

/** Field keys of the tenant by id, for a lookup or rollup that names fields of other entities. */
type FieldNames = ReadonlyMap<string, { key: string }>;

function presentDefinition(set: ExtensionFieldSet, field: ExtensionField, names: FieldNames): ExtensionDefinition {
  return isLinkedKind(field.kind) ? presentLinkedDefinition(field, names) : presentFormulaDefinition(set, field);
}

function toRecord(set: ExtensionFieldSet, field: ExtensionField, backfill?: BackfillRow, names: FieldNames = new Map()): FieldDefinitionRecord {
  const error = backfill?.state === "failed" && backfill.error && typeof backfill.error === "object" ? backfill.error as Record<string, unknown> : undefined;
  return {
    fieldId: field.fieldId, key: field.key, version: field.version, kind: field.kind,
    definition: presentDefinition(set, field, names), appliesWhen: appliesWhenForCaller(set, field.appliesWhen), state: field.state, position: field.position,
    ...(backfill ? { backfill: { id: backfill.id, state: backfill.state, processed: Number(backfill.processed), total: Number(backfill.total),
      ...(error && typeof error.code === "string" ? { error: { code: error.code, message: String(error.message ?? "") } } : {}) } } : {}),
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
  input: { fieldId: string; key: string; kind?: unknown; definition: unknown; appliesWhen?: unknown },
  existing?: ExtensionField,
): { kind: ExtensionKind; definition: ExtensionDefinition; appliesWhen: unknown; dependsOn: Array<FormulaDependency | { entity?: string; field: string; via?: string | null }>; readers?: RetypedReader[] } {
  const kind = input.kind ?? "stored";
  if (kind !== "stored" && kind !== "formula") extensionError(`Unknown field kind ${String(kind)}.`);
  if (typeof input.key !== "string" || !EXTENSION_KEY.test(input.key)) {
    extensionError("A field key starts with a lowercase letter and holds letters and digits only (at most 63).");
  }
  const clash = set.byKey.get(input.key);
  if (clash && clash.fieldId !== existing?.fieldId) extensionError(`Field key ${input.key} is already in use.`, "CONFLICT");
  if (!record(input.definition)) extensionError("A field definition is an object.");
  const definition = { ...input.definition as ExtensionDefinition };
  delete definition.key;
  if (kind === "formula") {
    // The result type follows from the formula; whatever osfType came along
    // (a definition read back and sent again) is the server's to set.
    delete definition.osfType;
    for (const property of UNSUPPORTED_PROPERTIES) {
      if (definition[property] !== undefined) extensionError(`Tenant fields do not support ${property}.`);
    }
    if (!SENSITIVITIES.includes((record(definition.classification) ? definition.classification.sensitivity : undefined) as typeof SENSITIVITIES[number])) {
      extensionError("A tenant field declares its classification (public, internal, confidential, pii or bsn).");
    }
    const valid = validateFormulaDefinition(set, { fieldId: input.fieldId, key: input.key, definition, appliesWhen: input.appliesWhen });
    return { kind: "formula", definition: valid.definition, appliesWhen: null, dependsOn: valid.dependsOn, readers: valid.readers };
  }
  if (definition.formula !== undefined) extensionError("Only a field of kind formula carries a formula.");
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
    // Every record that takes the default stores it as a JSON number; nothing rounds it there.
    numericValue(definition, definition.defaultValue, (text, number) => {
      if (exactNumericEquals(text, number)) return;
      const message = "The default value has more digits than a number holds.";
      throw operationFailure({ code: "VALIDATION", message, violations: [{ field: "definition.defaultValue", code: "NOT_REPRESENTABLE", message }], retryable: false });
    });
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

/**
 * Any definition a tenant may save: a lookup or rollup through its own
 * validator (other entities, the authorization proof), the rest as above;
 * a computed one then against the tenant's whole graph (cycles and depth
 * across entities).
 */
async function validateAnyDefinition(
  trx: Transaction<DB>,
  session: DbSessionInput,
  set: ExtensionFieldSet,
  table: GeneratedCrudTable,
  input: { fieldId: string; key: string; kind?: unknown; definition: unknown; appliesWhen?: unknown },
  existing?: ExtensionField,
): Promise<ReturnType<typeof validateFieldDefinition>> {
  let valid: ReturnType<typeof validateFieldDefinition>;
  if (isLinkedKind(input.kind)) {
    if (typeof input.key !== "string" || !EXTENSION_KEY.test(input.key)) {
      extensionError("A field key starts with a lowercase letter and holds letters and digits only (at most 63).");
    }
    const clash = set.byKey.get(input.key);
    if (clash && clash.fieldId !== existing?.fieldId) extensionError(`Field key ${input.key} is already in use.`, "CONFLICT");
    if (!record(input.definition)) extensionError("A field definition is an object.");
    const definition = { ...input.definition as ExtensionDefinition };
    delete definition.key;
    for (const property of UNSUPPORTED_PROPERTIES) {
      if (definition[property] !== undefined) extensionError(`Tenant fields do not support ${property}.`);
    }
    const linked = await validateLinkedDefinition(trx, session, set, { fieldId: input.fieldId, key: input.key, kind: input.kind, definition, appliesWhen: input.appliesWhen });
    valid = { kind: input.kind, definition: linked.definition, appliesWhen: null, dependsOn: linked.dependsOn };
  } else {
    valid = validateFieldDefinition(set, table, input, existing);
  }
  if (valid.kind === "formula") assertReadsNoLostProof(set, input.key, valid.dependsOn);
  if (valid.kind !== "stored") {
    await assertTenantGraph(trx, session, { entity: set.entity, fieldId: input.fieldId, key: input.key, kind: valid.kind, definition: valid.definition, dependsOn: valid.dependsOn });
  }
  return valid;
}

/** A formula over a field whose proof is lost would show what its readers no longer see: it waits for that field to be saved again. */
function assertReadsNoLostProof(set: ExtensionFieldSet, key: string, dependsOn: readonly { entity?: string; field: string; via?: string | null }[]): void {
  for (const dependency of dependsOn) {
    const input = (dependency.entity ?? set.entity) === set.entity && !dependency.via ? set.byId.get(dependency.field) : undefined;
    if (input && proofLost(input)) refuseProof(key, "formula", `${input.key} is suspended.`);
  }
}

// ---------------------------------------------------------------------------
// Storage

const insertVersion = insertFieldVersion;

/**
 * The fields this one depends on: rewritten with every
 * version, in `platform.extension_field_dependencies` — what `appliesWhen`
 * names, and what a formula reads (an owned child's field on the child
 * entity, `via` its relation). Lookups and rollups add theirs the same way.
 */
async function writeDependencies(
  trx: Transaction<DB>,
  session: DbSessionInput,
  entity: string,
  fieldId: string,
  dependsOn: readonly { entity?: string; field: string; via?: string | null }[],
): Promise<void> {
  await sql`delete from platform.extension_field_dependencies
    where tenant_id = ${session.tenantId}::uuid and field_id = ${fieldId}::uuid`.execute(trx);
  const unique = new Map(dependsOn.map((item) => [JSON.stringify([item.entity ?? entity, item.field, item.via ?? null]), item]));
  for (const dependency of unique.values()) {
    await sql`insert into platform.extension_field_dependencies (tenant_id, field_id, depends_on_entity, depends_on_field, via_field)
      values (${session.tenantId}::uuid, ${fieldId}::uuid, ${dependency.entity ?? entity}, ${dependency.field}, ${dependency.via ?? null})`.execute(trx);
  }
}

/**
 * Refuse taking away a field another (not deleted) field still depends on,
 * naming those fields — a lookup or rollup of another entity as `<Entity>.<key>`.
 */
async function assertNoDependents(trx: Transaction<DB>, session: DbSessionInput, set: ExtensionFieldSet, field: ExtensionField, dependents: readonly string[], action: string): Promise<void> {
  const others = dependents.some((id) => !set.byId.has(id)) ? await tenantFieldNames(trx, session.tenantId!) : new Map();
  const names = dependents.flatMap((id) => {
    if (id === field.fieldId) return [];
    const own = set.byId.get(id);
    if (own) return own.state === "deleted" ? [] : [own.key];
    const other = others.get(id);
    return other && other.state !== "deleted" ? [`${other.entity}.${other.key}`] : [];
  }).sort();
  if (names.length) {
    extensionError(`${field.key} cannot be ${action}: ${names.join(", ")} depend${names.length === 1 ? "s" : ""} on it (appliesWhen, formula, lookup or rollup).`, "CONFLICT");
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

/**
 * A new version of a formula field. Classification never changes; a new
 * formula (another AST or result type), or one that was suspended, is
 * `updating` until its backfill has recomputed every record and every
 * formula that reads it. A new label or key alone recomputes nothing.
 */
async function updateFormula(
  trx: Transaction<DB>,
  session: DbSessionInput,
  set: ExtensionFieldSet,
  field: ExtensionField,
  change: { key: string; definition: ExtensionDefinition; dependsOn: Parameters<typeof writeDependencies>[4]; readers: readonly RetypedReader[] },
): Promise<[ExtensionField, BackfillRow | undefined]> {
  if (!isDeepStrictEqual(field.definition.classification, change.definition.classification)) {
    extensionError(`${field.key}: its classification never changes once the field exists; create a new field, copy the values and delete this one.`);
  }
  const before = storedFormula(field.definition);
  const after = storedFormula(change.definition)!;
  if (before && before.resultType !== after.resultType) await assertNoLinkedReaders(trx, session, set.entity, field);
  await assertRetypedReadersUnread(trx, session, set, change.readers);
  const recompute = field.state === "suspended" || !before || before.resultType !== after.resultType || !isDeepStrictEqual(before.ast, after.ast);
  const next = await insertVersion(trx, session, set.entity, {
    fieldId: field.fieldId, key: change.key, version: field.version + 1, kind: "formula", definition: change.definition,
    appliesWhen: null, state: recompute ? "updating" : field.state, position: field.position,
  });
  await writeDependencies(trx, session, set.entity, field.fieldId, change.dependsOn);
  const started = recompute ? await startBackfill(trx, session, { entity: set.entity, field: next, operation: "formula" }) : undefined;
  await storeRetypedReaders(trx, session, set, change.readers);
  if (recompute) await recomputeLinkedReaders(trx, session, set.entity, field.fieldId);
  return [next, started];
}

/**
 * A new version of a lookup or rollup: classification never changes; another
 * reference, field, collection, aggregate or condition, or a field that was
 * suspended (its proof is the one just made), is `updating` until its
 * backfill has recomputed every record. A new label or key alone recomputes nothing.
 */
async function updateLinked(
  trx: Transaction<DB>,
  session: DbSessionInput,
  set: ExtensionFieldSet,
  field: ExtensionField,
  change: { key: string; definition: ExtensionDefinition; dependsOn: Parameters<typeof writeDependencies>[4] },
): Promise<[ExtensionField, BackfillRow | undefined]> {
  if (!isDeepStrictEqual(field.definition.classification, change.definition.classification)) {
    extensionError(`${field.key}: its classification never changes once the field exists; create a new field, copy the values and delete this one.`);
  }
  const spec = (definition: ExtensionDefinition) => definition[field.kind];
  if (linkedResultType(field) !== linkedResultType({ kind: field.kind, definition: change.definition })) {
    // A formula over it would compute against a type it was not checked with.
    await assertNoDependents(trx, session, set, field, await dependentsOf(trx, session, set.entity, field.fieldId), "given another result type");
  }
  const recompute = field.state === "suspended" || !isDeepStrictEqual(spec(field.definition), spec(change.definition));
  const next = await insertVersion(trx, session, set.entity, {
    fieldId: field.fieldId, key: change.key, version: field.version + 1, kind: field.kind, definition: change.definition,
    appliesWhen: null, state: recompute ? "updating" : field.state, position: field.position,
  });
  await writeDependencies(trx, session, set.entity, field.fieldId, change.dependsOn);
  const started = recompute ? await startBackfill(trx, session, { entity: set.entity, field: next, operation: field.kind as BackfillOperation }) : undefined;
  return [next, started];
}

/**
 * The readers a formula change typed again (formulas.ts `retypedReaders`):
 * each a new version with its new AST and result type, `updating` until its
 * own backfill has computed every record (and rewritten its index in the
 * column of its new type).
 */
async function storeRetypedReaders(trx: Transaction<DB>, session: DbSessionInput, set: ExtensionFieldSet, readers: readonly RetypedReader[]): Promise<void> {
  for (const reader of readers) {
    const next = await insertVersion(trx, session, set.entity, {
      ...reader.field, version: reader.field.version + 1, definition: reader.definition, state: "updating",
    });
    await writeDependencies(trx, session, set.entity, reader.field.fieldId, formulaDependencies(set, storedFormula(reader.definition)!.ast));
    await startBackfill(trx, session, { entity: set.entity, field: next, operation: "formula" });
  }
}

/**
 * A formula typed again along a change must have no lookup or rollup over it:
 * the guard on the changed formula holds for its whole set of readers, or the
 * backfill would write a text into what a lookup stores as a number.
 */
async function assertRetypedReadersUnread(trx: Transaction<DB>, session: DbSessionInput, set: ExtensionFieldSet, readers: readonly RetypedReader[]): Promise<void> {
  for (const reader of readers) {
    if (storedFormula(reader.field.definition)?.resultType !== storedFormula(reader.definition)?.resultType) {
      await assertNoLinkedReaders(trx, session, set.entity, reader.field);
    }
  }
}

/**
 * A stored field's default or `appliesWhen` changed: what a record without a
 * value reads changes with it (read.ts `readValue`), and so does every
 * computed field over it. Each formula that reads the field directly is
 * backfilled, and computes the formulas over it in turn; each lookup and
 * rollup that reads it, on any entity, is backfilled as well.
 */
async function recomputeFormulaReaders(trx: Transaction<DB>, session: DbSessionInput, set: ExtensionFieldSet, field: ExtensionField): Promise<void> {
  const node = { entity: set.entity, field: field.fieldId };
  for (const reader of formulaGraph(set).affectedBy([node])) {
    const reads = storedFormula(reader.definition)!;
    if (!formulaDependencies(set, reads.ast).some((dependency) => dependency.via === null && dependency.field === field.fieldId)) continue;
    await startBackfill(trx, session, { entity: set.entity, field: reader, operation: "formula" });
  }
  await recomputeLinkedReaders(trx, session, set.entity, field.fieldId);
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
  // One designer at a time per tenant: a lookup or rollup closes a cycle
  // across two entities whose designers would otherwise each see half of it.
  if (action !== "list" && action !== "affectedRecords") await lockExtensionGraph(trx, session.tenantId!);
  const set = await loadExtensionFieldsFor(trx, session, entity, entry, { lock: action !== "list" });
  const names: FieldNames = set.fields.some((field) => isLinkedKind(field.kind)) ? await tenantFieldNames(trx, session.tenantId!) : new Map();
  switch (action) {
    case "list": {
      const backfills = await latestBackfills(trx, session.tenantId!, entity);
      const items = set.fields
        .filter((field) => field.state !== "deleted" && (input.includeDeprecated === true || field.state !== "deprecated"))
        .map((field) => toRecord(set, field, backfills.get(field.fieldId), names));
      return { items };
    }
    case "create": {
      const live = set.fields.filter((field) => field.state !== "deleted");
      if (live.length >= entry.limits.fields) extensionError(`${entity} holds at most ${entry.limits.fields} tenant fields.`, "LIMIT_EXCEEDED");
      const fieldId = randomUUID();
      const valid = await validateAnyDefinition(trx, session, set, table, { fieldId, key: input.key as string, kind: input.kind, definition: input.definition, appliesWhen: input.appliesWhen });
      // A computed field is `updating` until its backfill has computed every record.
      const formula = valid.kind !== "stored";
      const field = await insertVersion(trx, session, entity, {
        fieldId, key: input.key as string, version: 1, kind: valid.kind, definition: valid.definition,
        appliesWhen: valid.appliesWhen, state: formula ? "updating" : "ready", position: Math.max(-1, ...set.fields.map((item) => item.position)) + 1,
      });
      await writeDependencies(trx, session, entity, field.fieldId, valid.dependsOn);
      const started = formula ? await startBackfill(trx, session, { entity, field, operation: valid.kind as BackfillOperation }) : undefined;
      if (valid.definition.retention) await scheduleExtensionRetention(trx, session, entity);
      return toRecord(set, field, started, isLinkedKind(field.kind) ? await tenantFieldNames(trx, session.tenantId!) : names);
    }
    case "update": {
      const field = requireField(set, input.fieldId);
      if (field.state === "updating") extensionError(`${field.key} is being updated; wait until its backfill is done.`, "CONFLICT");
      // A deprecated field is changed only once it is back: a retype or
      // unique would otherwise bring it back silently.
      if (field.state === "deprecated") extensionError(`${field.key} is deprecated; restore it before changing it.`, "CONFLICT");
      if (input.kind !== undefined && input.kind !== field.kind) {
        extensionError(`${field.key} is a ${field.kind} field; its kind never changes. Create a new field instead.`);
      }
      const key = input.key === undefined ? field.key : input.key as string;
      const definition = input.definition === undefined ? presentDefinition(set, field, names) : input.definition;
      const appliesWhen = input.appliesWhen === undefined ? appliesWhenForCaller(set, field.appliesWhen) : input.appliesWhen;
      const valid = await validateAnyDefinition(trx, session, set, table, { fieldId: field.fieldId, key, kind: field.kind, definition, appliesWhen }, field);
      const unchanged = isLinkedKind(field.kind) ? field.definition : presentFormulaDefinition(set, field);
      if (key === field.key && isDeepStrictEqual(valid.definition, unchanged) && isDeepStrictEqual(valid.appliesWhen, field.appliesWhen) &&
          field.state !== "suspended") {
        return toRecord(set, field, undefined, names);
      }
      if (isLinkedKind(field.kind)) {
        return toRecord(set, ...await updateLinked(trx, session, set, field, { key, definition: valid.definition, dependsOn: valid.dependsOn }),
          await tenantFieldNames(trx, session.tenantId!));
      }
      if (field.kind === "formula") {
        return toRecord(set, ...await updateFormula(trx, session, set, field, { key, definition: valid.definition, dependsOn: valid.dependsOn, readers: valid.readers ?? [] }));
      }
      let backfill = await typeChange(trx, session, set, field.definition, valid.definition, field);
      if (valid.definition.defaultValue !== undefined && valid.appliesWhen) await assertRollupsCanRead(trx, session, entity, field);
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
      if (!isDeepStrictEqual(valid.definition.defaultValue, field.definition.defaultValue) || !isDeepStrictEqual(valid.appliesWhen, field.appliesWhen ?? null)) {
        await recomputeFormulaReaders(trx, session, set, field);
      }
      // A retype that also turns unique on claims as it rebuilds: the unique
      // backfill rewrites claims only, the retype the index only.
      const started = backfill ? await startBackfill(trx, session, { entity, field: next, operation: backfill === "retype" && valid.definition.unique === true && field.definition.unique !== true ? "unique" : backfill }) : undefined;
      if (valid.definition.retention && !field.definition.retention) await scheduleExtensionRetention(trx, session, entity);
      return toRecord(set, next, started, names);
    }
    case "deprecate":
    case "restore": {
      const field = requireField(set, input.fieldId);
      // A field in `updating` can always be deprecated, then deleted: a
      // backfill that never finishes must not trap it.
      const from: ExtensionState[] = action === "deprecate" ? ["ready", "updating", "suspended"] : ["deprecated"];
      if (!from.includes(field.state)) extensionError(`${field.key} is ${field.state}; only a ${from.join(" or ")} field can be ${action}d.`, "CONFLICT");
      if (action === "deprecate") await assertNoDependents(trx, session, set, field, await dependentsOf(trx, session, entity, field.fieldId), "deprecated");
      // A restored formula was not computed while it was deprecated: it is
      // checked again as if it were saved now — the fields it reads may have
      // changed type, a cycle or the depth limit may have been reached in
      // the meantime — and its backfill brings every record up to date.
      const recompute = action === "restore" && field.kind !== "stored";
      const restored = recompute && field.kind === "formula"
        ? restoredFormula(set, field)
        : recompute
          ? { ...await validateAnyDefinition(trx, session, withRestoredField(set, field.fieldId), table,
            { fieldId: field.fieldId, key: field.key, kind: field.kind, definition: presentDefinition(set, field, names) }, field), readers: [] as RetypedReader[] }
          : undefined;
      const next = await insertVersion(trx, session, entity, { ...field, version: field.version + 1,
        ...(restored ? { definition: restored.definition } : {}),
        state: action === "deprecate" ? "deprecated" : recompute ? "updating" : "ready" });
      if (restored) await writeDependencies(trx, session, entity, field.fieldId, restored.dependsOn);
      const started = recompute ? await startBackfill(trx, session, { entity, field: next, operation: field.kind as BackfillOperation }) : undefined;
      if (restored) await storeRetypedReaders(trx, session, set, restored.readers ?? []);
      if (restored) await assertRetypedReadersUnread(trx, session, set, restored.readers ?? []);
      return toRecord(set, next, started, names);
    }
    case "affectedRecords": {
      const field = requireField(set, input.fieldId);
      return { count: await affectedRecordCount(trx, session, entity, field.fieldId) };
    }
    case "delete": {
      const field = requireField(set, input.fieldId);
      if (field.state !== "deprecated") extensionError(`${field.key} must be deprecated before it can be deleted.`, "CONFLICT");
      await assertNoDependents(trx, session, set, field, await dependentsOf(trx, session, entity, field.fieldId), "deleted");
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
      // per field, as backfills over every record of the tenant. A lookup or
      // rollup is computed again from what it reads, which also repairs a value
      // a write behind the runtime's back left stale, and what its journal
      // still had open is settled along the way. What reads a rebuilt field
      // on another entity follows. A field whose proof is lost, or a suspended
      // lookup or rollup, is only brought back by saving it.
      const stopped = (field: ExtensionField) => proofLost(field) || (isLinkedKind(field.kind) && field.state === "suspended");
      if (input.fieldId !== undefined && stopped(requireField(set, input.fieldId))) {
        extensionError(`${requireField(set, input.fieldId).key} is suspended; save it again to bring it back.`, "CONFLICT");
      }
      const fields = input.fieldId === undefined
        ? set.fields.filter((field) => field.state !== "deleted" && !stopped(field))
        : [requireField(set, input.fieldId)];
      const backfills: Array<{ fieldId: string; backfillId: string }> = [];
      const computing = new Set(fields.filter((field) => isLinkedKind(field.kind)).map((field) => field.fieldId));
      for (const field of fields) {
        // A suspended formula is computed again rather than re-indexed: the
        // index of a backfill that stopped halfway holds two generations.
        const resume = field.kind === "formula" && field.state === "suspended"
          ? await insertVersion(trx, session, entity, { ...field, version: field.version + 1, state: "updating" }) : undefined;
        if (isLinkedKind(field.kind)) {
          await sql`delete from platform.extension_field_recomputes
            where tenant_id = ${session.tenantId}::uuid and field_id = ${field.fieldId}::uuid`.execute(trx);
        }
        const operation: BackfillOperation = resume ? "formula" : isLinkedKind(field.kind) && field.state !== "deprecated" ? field.kind : "rebuild";
        const started = await startBackfill(trx, session, { entity, field: resume ?? field, operation });
        backfills.push({ fieldId: field.fieldId, backfillId: started.id });
        await recomputeLinkedReaders(trx, session, entity, field.fieldId, computing);
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
      return { items: reloaded.fields.filter((field) => field.state !== "deleted").map((field) => toRecord(reloaded, field, undefined, names)) };
    }
  }
}

/** A formula as it is restored: checked as if it were saved now, and not over a field whose proof is lost. */
function restoredFormula(set: ExtensionFieldSet, field: ExtensionField) {
  const restored = validateFormulaDefinition(withRestoredField(set, field.fieldId), { fieldId: field.fieldId, key: field.key, definition: presentFormulaDefinition(set, field) });
  assertReadsNoLostProof(set, field.key, restored.dependsOn);
  return restored;
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
