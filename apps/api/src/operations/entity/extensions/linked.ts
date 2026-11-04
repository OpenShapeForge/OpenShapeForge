// SPDX-License-Identifier: BUSL-1.1
/**
 * Lookups and rollups (`kind: "lookup"`, `kind: "rollup"`): tenant fields
 * whose value is read from other records — a lookup through a single
 * reference (a tenant reference field or an authored `belongsTo` relation),
 * a rollup as an aggregate over a collection (an authored inverse relation,
 * or the records of another extensible entity whose tenant reference names
 * this one). A rollup's `of` may follow one single relation of the child, for a
 * collection whose members are records of their own (rollupPath).
 *
 * A computed value is materialized with the rights of whoever wrote the
 * record it was computed from, or of the worker — never with the reader's.
 * So a definition is accepted only when the compiled authorization contract
 * (`extensionRegistry.readAccess`) proves that its target is not authorized
 * more narrowly than its source: every role that may read the source may
 * read the target and the target field, the target's rows are narrowed by no
 * axis, the target field is not classified and has no read roles of its own
 * that leave a source reader out, and no authorization profile of the tenant
 * manages the reads of the source or the target. A chain is proven link by
 * link, each when its own definition is saved; a rollup's step is a link of its
 * own, in the same definition, from the source to the entity the step reaches.
 * A relation the value travels along is under the same rule: classified or
 * field-policed, it is refused as a tenant reference is. And a computed field is
 * at least as sensitive as what it reads (sensitivityShortfall). The proof is repeated by every migration, by every
 * change of a tenant's authorization profiles and by a database trigger on
 * them; a definition whose proof no longer holds is `suspended`, and so is
 * whatever reads it, across the whole graph: readers get null with
 * `extensionsMeta.suspended`, no filter or sort takes it and a snapshot freezes
 * `{ unavailable }`, until its designer saves it again or removes it. The value
 * stays in the source, so that saving it again can start from what is there.
 *
 * Recomputation follows the dependency graph in
 * `platform.extension_field_dependencies` across entities: a write of a
 * record recomputes, in its own transaction, the lookups that read it, the
 * rollups of its old and new parent and those that reach it from a child, down
 * the chain, on at most `limits.syncFanOut` records in all. A record's neighbours are locked in one
 * order before its write (lockLinkedRecords). Beyond that budget the write
 * leaves one row per (field, record) in the recompute journal
 * (`platform.extension_field_recomputes`), which coalesces further writes of
 * that record; the journal worker recomputes the referring records in batches
 * after a short debounce. Until it has, a reader sees the last known value with
 * `extensionsMeta.<key>.stale`, derived from the open journal rows of its page
 * in one query. A rollup is one aggregate over the child table and the typed
 * index, never a collection in memory, so `where` and `of` are refused when
 * saved if SQL cannot say what they mean.
 */
import { randomUUID } from "node:crypto";
import { sql, type RawBuilder, type Transaction } from "kysely";
import { exactNumericEquals, operationFailure } from "@openshapeforge/operations";
import type { RuntimeExtensionRelation, RuntimeJobOutcome } from "@openshapeforge/plugin-runtime";
import { MAX_RESULT_TEXT_BYTES, MAX_RESULT_TEXT_LENGTH, ROUNDING_DECIMALS } from "@openshapeforge/formula";
import type { DB } from "../../../generated/db/types.js";
import { currentDbSessionTransaction, type DbSessionInput } from "../../../db/session.js";
import { entityTableName, entityColumnName } from "../../../db/manifest-lookup.js";
import { jsonbLiteral } from "../../../db/sql-helpers.js";
import { isCalendarDate } from "../../../platform/structured-filter.js";
import { enqueueJob } from "../../../jobs/store.js";
import { actorSessionOf, type JobActorSession } from "../../../jobs/actor-session.js";
import type { ModuleJobHandler } from "../../../modules/contract.js";
import { getGeneratedCrudTables } from "../catalog.js";
import { fieldNameForColumn } from "../columns.js";
import { sqlstateOf } from "../transition-lock-retry.js";
import type { GeneratedCrudColumn, GeneratedCrudTable } from "../types.js";
import { acrossTenant, jobActorSession, jobSession, startBackfill, type BackfillOperation } from "./backfill.js";
import { authoredFormulaFields, fieldValues, formulaGraph, formulaInputs, labelText, storedFormula, tenantFieldType, formulaDependencies } from "./formulas.js";
import {
  authoredSensitivity,
  AUTHORIZATION_PROOF_LOST,
  classificationOf,
  conditionPaths,
  EXTENSION_META_KEY,
  EXTENSION_VALUES_COLUMN,
  evaluateCondition,
  extensionError,
  extensionShape,
  indexColumnRef,
  inheritedSuspension,
  isClassified,
  linkedResultType,
  mapConditionPaths,
  record,
  referenceIds,
  refuseSensitivity,
  ROLLUP_AGGREGATES,
  rollupPath,
  sensitivityShortfall,
  SENSITIVITIES,
  storedLookup,
  storedRollup,
  type ComputedInput,
  type ComputedResultType,
  type ExtensionDefinition,
  type ExtensionField,
  type ExtensionFieldSet,
  type RollupAggregate,
  type StoredRollup,
} from "./model.js";
import { AUTHORIZATION_MODEL, narrowerReadAccess } from "./read-access.js";
import { conditionValues, readValue, storedExtensionSource } from "./read.js";
import { unlinkReferences } from "./references.js";
import { extensionRegistry } from "./registry.js";
import { announceFieldDefinitionChange, forgetExtensionFields, loadExtensionFieldsFor, lockExtensionFields } from "./store.js";
import { formulaRowObject, ownerLinks, qualifiedTable, recomputeRecordFormulas } from "./write.js";

export const EXTENSION_RECOMPUTE_KIND = "extensions.recompute";
export const EXTENSION_REVALIDATE_KIND = "extensions.revalidate";
/** The subject a recompute job names, so that a row's job can be found. */
const RECOMPUTE_SUBJECT = "ExtensionFieldRecompute";
const RECOMPUTE_SWEEP_LIMIT = 500;
/** How long the journal worker waits after a change before it recomputes, so a burst of writes is one pass. */
export const RECOMPUTE_DEBOUNCE_MS = 1_000;
export const RECOMPUTE_BATCH_SIZE = 200;
const TENANT_PATH = "extensions.";
/** Between the collection and the step in the `via` of a dependency on what a rollup's step reaches. */
const STEP_VIA = ":";
/** A chain of recomputes deeper than this is a graph the save-time check should have refused. */
const MAX_PROPAGATION_DEPTH = 32;
/** The most distinct values an arrayUnique within the text bounds can list: one character and a separator each. */
const MOST_UNIQUE_VALUES = Math.floor((MAX_RESULT_TEXT_LENGTH + 2) / 3);

export type LinkedDependency = { entity: string; field: string; via: string | null };

function tableOf(entity: string): GeneratedCrudTable | undefined {
  const tables = getGeneratedCrudTables().filter((table) => table.source?.authoringEntityName === entity && !table.subtype);
  return tables.length === 1 ? tables[0] : undefined;
}

/** The table a write of this one lands in, as an entity: a subtype writes its base. */
function baseTableOf(table: GeneratedCrudTable): GeneratedCrudTable {
  return table.subtype ? tableOf(table.subtype.base.entityName) ?? table : table;
}

const budgets = new WeakMap<object, Set<string>>();

/**
 * One transaction, one budget: the records it recomputes itself, along every
 * chain and on every path, delete included. A record counts once, whatever
 * number of its fields follow. `limits.syncFanOut` of the entity it recomputes
 * says how far a write goes; the rest goes to the journal.
 */
export function writeBudget(trx: Transaction<DB>): Set<string> {
  const scope = currentDbSessionTransaction() ?? trx;
  const budget = budgets.get(scope) ?? new Set<string>();
  budgets.set(scope, budget);
  return budget;
}

/** Whether this transaction recomputed the record: a write that came back to its own record holds a row older than the stored one. */
export function recomputedInThisWrite(trx: Transaction<DB>, table: GeneratedCrudTable, id: string): boolean {
  return writeBudget(trx).has(`${baseTableOf(table).source?.authoringEntityName}:${id}`);
}

/** Take these records of an entity from the budget, all of them or none. */
export function withinBudget(budget: Set<string>, set: ExtensionFieldSet, records: readonly string[]): boolean {
  const keys = records.map((id) => `${set.entity}:${id}`);
  if (new Set([...budget, ...keys]).size > set.entry.limits.syncFanOut) return false;
  for (const key of keys) budget.add(key);
  return true;
}

/** The lookups and rollups the runtime computes: neither deprecated, suspended nor deleted. */
export function computedLinked(set: ExtensionFieldSet): ExtensionField[] {
  return set.fields.filter((field) => (field.kind === "lookup" || field.kind === "rollup") &&
    (field.state === "ready" || field.state === "updating") && linkedResultType(field) !== undefined);
}

const tenantPathId = (path: string): string | undefined => path.startsWith(TENANT_PATH) ? path.slice(TENANT_PATH.length) : undefined;

/**
 * The entities whose reads an authorization profile of this tenant manages
 * (docs/authorization-profiles.md), across the tenant: what the proof needs is
 * every policy, not those the writer may see. A managed subtype shares its
 * base's table, so its base counts as managed too.
 */
async function managedEntities(trx: Transaction<DB>, session: DbSessionInput): Promise<Set<string>> {
  let table: string, entity: string, managed: string;
  try {
    table = entityTableName("AuthorizationOperationPolicy");
    entity = entityColumnName("AuthorizationOperationPolicy", "entityType");
    managed = entityColumnName("AuthorizationOperationPolicy", "managed");
  } catch {
    return new Set();
  }
  const rows = await acrossTenant(trx, session, "read the managed entities of the tenant", () =>
    sql<{ entity: string }>`select distinct ${sql.ref(entity)} as entity from ${qualifiedTable(table)}
      where tenant_id = ${session.tenantId}::uuid and ${sql.ref(managed)}`.execute(trx));
  return withBases(rows.rows.map((row) => row.entity));
}

/** Entities as the proof compares them: a subtype and the base whose table it shares. */
function withBases(entities: readonly string[]): Set<string> {
  const subtypes = new Map(getGeneratedCrudTables().flatMap((item) => item.subtype && item.source?.authoringEntityName
    ? [[item.source.authoringEntityName, item.subtype.base.entityName] as const] : []));
  return new Set(entities.flatMap((entity) => subtypes.has(entity) ? [entity, subtypes.get(entity)!] : [entity]));
}

/** Every current field key of the tenant by field id, for presenting stored paths. */
export async function tenantFieldNames(trx: Transaction<DB>, tenantId: string): Promise<Map<string, { entity: string; key: string; label: unknown; state: string }>> {
  const rows = await sql<{ field_id: string; entity: string; key: string; label: unknown; state: string }>`
    select field_id::text as field_id, entity, key, definition->'label' as label, state from platform.extension_field_definitions
    where tenant_id = ${tenantId}::uuid and is_current`.execute(trx);
  return new Map(rows.rows.map((row) => [row.field_id, { entity: row.entity, key: row.key, label: row.label, state: row.state }]));
}

// ---------------------------------------------------------------------------
// Resolution: what a stored or a caller's definition names.

/** One field of a related entity a lookup returns or a rollup reads. */
type TargetField = { entity: string; path: string; type: string; label: string; authored?: string; field?: ExtensionField };

type ResolvedLookup = {
  kind: "lookup";
  via: { path: string; label: string; tenant?: ExtensionField; relation?: RuntimeExtensionRelation };
  target: string;
  field: TargetField;
};

type ResolvedRollup = {
  kind: "rollup";
  collection: { path: string; label: string; relation?: RuntimeExtensionRelation; reference?: { entity: string; field: ExtensionField } };
  child: string;
  /** The child's field that names the parent: an authored foreign key's field, or a tenant reference's path. */
  link: string;
  aggregate: RollupAggregate;
  of?: TargetField;
  /** The one relation `of` follows on the child; `of` is a field of its target then. */
  step?: RollupStep;
  /** `of` and `where` as SQL over the child's row (`child`) and the step's target (`target`). */
  ofSql?: RawBuilder<unknown>;
  whereSql?: RawBuilder<unknown>;
  where?: unknown;
  whereFields: TargetField[];
};

/** The single relation `rollup.of` follows from a child to the record that holds the value. */
type RollupStep = {
  /** As stored: the relation's key, or `extensions.<fieldId>`. */
  path: string;
  label: string;
  /** The child's field that names the target: an authored foreign key's field, or a tenant reference's path. */
  link: string;
  target: string;
  /** `schema.table` of the target. */
  table: string;
  relation?: RuntimeExtensionRelation;
  reference?: ExtensionField;
};

type Sets = (entity: string) => Promise<ExtensionFieldSet | undefined>;

function setLoader(trx: Transaction<DB>, session: DbSessionInput, own?: ExtensionFieldSet): Sets {
  const loaded = new Map<string, Promise<ExtensionFieldSet | undefined>>();
  if (own) loaded.set(own.entity, Promise.resolve(own));
  return (entity) => {
    if (!loaded.has(entity)) {
      const entry = extensionRegistry.entity(entity);
      loaded.set(entity, entry ? loadExtensionFieldsFor(trx, session, entity, entry) : Promise.resolve(undefined));
    }
    return loaded.get(entity)!;
  };
}

/**
 * One field of `entity` by a caller's name (`extensions.<key>`, an authored
 * field name) or a stored path (`extensions.<fieldId>`): its stored path and
 * the type a computed field reads it as. Refused with the reason when it is
 * not in reach: classified, field-policed, a reference, a collection,
 * platform-kept, deprecated or deleted.
 */
async function resolveField(sets: Sets, entity: string, name: unknown, stored: boolean, purpose: string): Promise<TargetField> {
  if (typeof name !== "string" || !name) extensionError(`${purpose} names a field of ${entity}.`);
  const tenant = tenantPathId(name as string);
  if (tenant !== undefined) {
    const set = await sets(entity);
    if (!set) extensionError(`${purpose}: ${entity} has no tenant fields; name one of its own fields.`);
    const field = stored ? set!.byId.get(tenant) : set!.byKey.get(tenant);
    if (!field || field.state === "deleted") extensionError(`${purpose}: ${name} is not a field of ${entity}.`);
    if (field!.state === "deprecated") extensionError(`${purpose}: ${entity}.${field!.key} is deprecated.`);
    if (isClassified(field!.definition)) extensionError(`${purpose}: ${entity}.${field!.key} is classified, so its value cannot be shown on another record.`);
    const type = field!.kind === "stored" ? tenantFieldType(set!.entry, field!)
      : field!.kind === "formula" ? storedFormula(field!.definition)?.resultType ?? "formula" : linkedResultType(field!) ?? field!.kind;
    return { entity, path: `${TENANT_PATH}${field!.fieldId}`, type, label: `${entity}.${field!.key}`, field: field! };
  }
  const table = tableOf(entity);
  const column = table?.columns.find((candidate) => fieldNameForColumn(candidate) === name);
  if (!table || !column) extensionError(`${purpose}: ${name} is not a field of ${entity}.`);
  if (column!.classification) extensionError(`${purpose}: ${entity}.${name} is classified, so its value cannot be shown on another record.`);
  if (column!.fieldPolicy?.readRoles?.length) extensionError(`${purpose}: ${entity}.${name} has read roles of its own.`);
  const authored = authoredFormulaFields(table!).find((field) => field.id === name);
  if (!authored) extensionError(`${purpose}: ${entity}.${name} is not a value a computed field can read (a reference, a document or structured data).`);
  if (authored!.outOfScope) extensionError(`${purpose}: ${entity}.${name} cannot be read: ${authored!.outOfScope}.`);
  return { entity, path: name as string, type: authored!.type, label: `${entity}.${name}`, authored: column!.name };
}

const SCALAR = new Set(["text", "number", "boolean", "date", "timestamp"]);

/**
 * The refusal for a relation a computed value would travel along: what it
 * points at would show through the value, so a classified or field-policed
 * foreign key is out of reach as a classified tenant reference is.
 */
function assertRelationReadable(column: GeneratedCrudColumn | undefined, purpose: string, label: string): void {
  if (column?.classification || column?.fieldPolicy) {
    extensionError(`${purpose}: ${label} is ${column.classification ? "classified" : "protected by a field policy"}; what it points at would show through the computed field.`);
  }
}

/** One single tenant reference of `set` a computed value may travel along, or the refusal with the reason. */
function singleReference(set: ExtensionFieldSet, name: string, id: string, stored: boolean, purpose: string, kind: "lookup" | "rollup"): { field: ExtensionField; reference: NonNullable<ReturnType<typeof extensionShape>["reference"]> } {
  const field = stored ? set.byId.get(id) : set.byKey.get(id);
  if (!field || field.state === "deleted") extensionError(`${purpose}: ${name} is not a field of ${set.entity}.`);
  if (field!.state === "deprecated") extensionError(`${purpose}: ${field!.key} is deprecated.`);
  const shape = extensionShape(set.entry, field!.definition);
  if (field!.kind !== "stored" || !shape.reference) extensionError(`${purpose}: ${field!.key} is not a reference field.`);
  if (shape.collection) extensionError(`${purpose}: ${field!.key} holds more than one reference; a ${kind} follows a single one.`);
  if (isClassified(field!.definition)) extensionError(`${purpose}: ${field!.key} is classified; what it points at would show through the ${kind}.`);
  return { field: field!, reference: shape.reference! };
}

async function resolveLookup(sets: Sets, set: ExtensionFieldSet, lookup: Record<string, unknown>, stored: boolean): Promise<ResolvedLookup> {
  const via = lookup.via;
  if (typeof via !== "string" || !via) extensionError("A lookup names its reference: lookup.via.");
  const tenant = tenantPathId(via as string);
  let resolvedVia: ResolvedLookup["via"];
  let target: string;
  if (tenant !== undefined) {
    const { field, reference } = singleReference(set, via as string, tenant, stored, "lookup.via", "lookup");
    resolvedVia = { path: `${TENANT_PATH}${field.fieldId}`, label: field.key, tenant: field };
    target = reference.entity;
  } else {
    const relation = set.entry.relations.find((candidate) => candidate.key === via && candidate.kind === "belongsTo");
    if (!relation) extensionError(`lookup.via: ${via} is neither a tenant reference field (extensions.<key>) nor a single relation of ${set.entity}.`);
    assertRelationReadable(tableOf(set.entity)?.columns.find((candidate) => candidate.name === relation!.foreignKey), "lookup.via", `${set.entity}.${relation!.key}`);
    resolvedVia = { path: relation!.key, label: relation!.key, relation: relation! };
    target = relation!.entity;
  }
  const field = await resolveField(sets, target, lookup.field, stored, "lookup.field");
  if (!SCALAR.has(field.type)) extensionError(`lookup.field: ${field.label} is a ${field.type} field; a lookup returns one text, number, boolean, date or timestamp.`);
  return { kind: "lookup", via: resolvedVia, target, field };
}

/** The single relations `rollup.of` may follow from a child: an extensible child's own, or those the registry keeps for it. */
function stepRelations(child: string): readonly RuntimeExtensionRelation[] {
  return extensionRegistry.entity(child)?.relations.filter((relation) => relation.kind === "belongsTo") ?? extensionRegistry.childRelations(child);
}

/** A stored step as a recompute follows it; undefined when it names nothing any more (a revalidation refuses that). */
function storedStep(child: string, childSet: ExtensionFieldSet | undefined, via: string): RollupStep | undefined {
  const id = tenantPathId(via);
  if (id === undefined) {
    const relation = stepRelations(child).find((candidate) => candidate.key === via);
    const column = tableOf(child)?.columns.find((candidate) => candidate.name === relation?.foreignKey);
    return relation && column ? { path: via, label: `${child}.${via}`, link: fieldNameForColumn(column), target: relation.entity, table: relation.table, relation } : undefined;
  }
  const field = childSet?.byId.get(id);
  const reference = field ? extensionShape(childSet!.entry, field.definition).reference : undefined;
  return field && reference ? { path: via, label: `${child}.${field.key}`, link: via, target: reference.entity, table: reference.table, reference: field } : undefined;
}

/** The relation a caller's or a stored `rollup.of` follows from the child, or the refusal with the reason. */
async function resolveStep(sets: Sets, child: string, via: string, stored: boolean): Promise<RollupStep> {
  const tenant = tenantPathId(via);
  if (tenant === undefined) {
    const relation = stepRelations(child).find((candidate) => candidate.key === via);
    if (!relation) extensionError(`rollup.of: ${via} is neither a tenant reference field (extensions.<key>) nor a single relation of ${child}.`);
    assertRelationReadable(tableOf(child)?.columns.find((candidate) => candidate.name === relation!.foreignKey), "rollup.of", `${child}.${relation!.key}`);
    const step = storedStep(child, undefined, via);
    if (!step) extensionError(`rollup.of: ${child}.${via} has no readable foreign key.`);
    return step!;
  }
  const set = await sets(child);
  if (!set) extensionError(`rollup.of: ${child} has no tenant fields; name a single relation of it.`);
  const { field } = singleReference(set!, via, tenant, stored, "rollup.of", "rollup");
  return storedStep(child, set, `${TENANT_PATH}${field.fieldId}`)!;
}

/** Refuse a path of `where` that leaves the child: a condition reads the child's own fields. */
function assertChildPaths(condition: unknown): void {
  if (Array.isArray(condition)) {
    condition.forEach(assertChildPaths);
    return;
  }
  if (!record(condition)) return;
  [condition.all, condition.any, condition.conditions].forEach(assertChildPaths);
  const path = record(condition.left) ? condition.left.path : undefined;
  if (typeof path !== "string") return;
  const parts = rollupPath(path);
  if (!parts || parts.via !== undefined) extensionError(`rollup.where: ${path} follows a relation; a condition reads the fields of the collection's own records.`);
}

async function resolveRollup(sets: Sets, set: ExtensionFieldSet, rollup: Record<string, unknown>, stored: boolean): Promise<ResolvedRollup> {
  const collection = rollup.collection;
  if (typeof collection !== "string" || !collection) extensionError("A rollup names its collection: rollup.collection.");
  const aggregate = rollup.aggregate;
  if (!(ROLLUP_AGGREGATES as readonly unknown[]).includes(aggregate)) extensionError(`rollup.aggregate is one of ${ROLLUP_AGGREGATES.join(", ")}.`);
  const dot = (collection as string).indexOf(".");
  let resolved: ResolvedRollup["collection"];
  let child: string;
  let link: string;
  if (dot > 0) {
    // `<Entity>.extensions.<key>`: the records of an extensible entity whose tenant reference names this one.
    child = (collection as string).slice(0, dot);
    const referenceSet = await sets(child);
    const id = tenantPathId((collection as string).slice(dot + 1));
    const field = id === undefined || !referenceSet ? undefined : stored ? referenceSet.byId.get(id) : referenceSet.byKey.get(id);
    if (!referenceSet || !field || field.state === "deleted") extensionError(`rollup.collection: ${collection} is not a tenant reference field of an extensible entity.`);
    if (field!.state === "deprecated") extensionError(`rollup.collection: ${child}.${field!.key} is deprecated.`);
    const shape = extensionShape(referenceSet!.entry, field!.definition);
    if (field!.kind !== "stored" || shape.reference?.entity !== set.entity || shape.collection) {
      extensionError(`rollup.collection: ${child}.${field!.key} is not a single reference to ${set.entity}.`);
    }
    if (isClassified(field!.definition)) extensionError(`rollup.collection: ${child}.${field!.key} is classified.`);
    link = `${TENANT_PATH}${field!.fieldId}`;
    resolved = { path: `${child}.${link}`, label: `${child}.${field!.key}`, reference: { entity: child, field: field! } };
  } else {
    const relation = set.entry.relations.find((candidate) => candidate.key === collection && candidate.kind === "hasMany");
    if (!relation) extensionError(`rollup.collection: ${collection} is neither an inverse relation of ${set.entity} nor <Entity>.extensions.<key>.`);
    child = relation!.entity;
    const childTable = tableOf(child);
    const column = childTable?.columns.find((candidate) => candidate.name === relation!.foreignKey);
    if (!childTable || !column) extensionError(`rollup.collection: ${collection} has no readable foreign key.`);
    assertRelationReadable(column, "rollup.collection", `${child}.${fieldNameForColumn(column!)}`);
    link = fieldNameForColumn(column!);
    resolved = { path: relation!.key, label: relation!.key, relation: relation! };
  }
  const path = typeof rollup.of === "string" ? rollupPath(rollup.of) : undefined;
  if (typeof rollup.of === "string" && !path) {
    extensionError(`rollup.of: ${rollup.of} follows more than one relation; a rollup follows one single relation of ${child}: <relation>.<field>.`);
  }
  const step = path?.via === undefined ? undefined : await resolveStep(sets, child, path.via, stored);
  const of = rollup.of === undefined || rollup.of === null ? undefined : await resolveField(sets, step?.target ?? child, path?.field ?? rollup.of, stored, "rollup.of");
  const numeric = aggregate === "sum" || aggregate === "avg";
  if (numeric && of?.type !== "number") extensionError(`rollup.of: ${aggregate} needs a number field${of ? `; ${of.label} is a ${of.type} field` : ""}.`);
  if ((aggregate === "min" || aggregate === "max") && !["number", "date", "timestamp"].includes(of?.type ?? "")) {
    extensionError(`rollup.of: ${aggregate} needs a number, date or timestamp field.`);
  }
  if (aggregate === "arrayUnique" && !of) extensionError("rollup.of: arrayUnique needs the field whose values it lists.");
  if (of && !SCALAR.has(of.type)) extensionError(`rollup.of: ${of.label} is a ${of.type} field; a rollup reads one value per record.`);
  const whereFields: TargetField[] = [];
  let where: unknown;
  if (rollup.where !== undefined && rollup.where !== null) {
    assertChildPaths(rollup.where);
    for (const path of conditionPaths(rollup.where)) {
      const name = path.kind === "authored" ? path.field : `${TENANT_PATH}${path.key}`;
      whereFields.push(await resolveField(sets, child, name, stored, "rollup.where"));
    }
    if (stored) where = rollup.where;
    else {
      const childSet = await sets(child);
      where = mapConditionPaths(rollup.where, (key) => childSet?.byKey.get(key)?.fieldId ?? key);
    }
  }
  const childSet = await sets(child);
  const ofSql = of ? step ? fieldSql(await sets(step.target), of, "rollup.of", "target") : fieldSql(childSet, of, "rollup.of") : undefined;
  const whereSql = where === undefined ? undefined
    : conditionSql(where, new Map(whereFields.map((field) => [field.path, { field, sql: fieldSql(childSet, field, "rollup.where") }])));
  return { kind: "rollup", collection: resolved, child, link, aggregate: aggregate as RollupAggregate, ...(of ? { of } : {}), ...(step ? { step } : {}), ...(ofSql ? { ofSql } : {}),
    ...(whereSql ? { whereSql } : {}), ...(where !== undefined ? { where } : {}), whereFields };
}

const SQL_TYPES: Readonly<Record<string, string>> = { text: "text", number: "numeric", boolean: "boolean", date: "date", timestamp: "timestamptz" };

/**
 * One field of a rollup's child as SQL over the row `child`, or of the target
 * of its step over the row `target`: an authored column, or a tenant field's
 * index row (which holds nothing for a computed field in error, the blank a
 * reader sees). The default of a field that applies to every record is the
 * value of a record without one, as a reader sees it, and a child without a
 * target has no record to default; a default under `appliesWhen` depends on a
 * condition the index does not hold, so such a field is refused, as a
 * collection or a measurement is.
 */
function fieldSql(set: ExtensionFieldSet | undefined, field: TargetField, purpose: string, row: "child" | "target" = "child"): RawBuilder<unknown> {
  const type = SQL_TYPES[field.type];
  if (!type) extensionError(`${purpose}: ${field.label} is a ${field.type} field; a rollup reads one text, number, boolean, date or timestamp per record.`);
  if (field.authored) return sql`${sql.id(row, field.authored)}::${sql.raw(type!)}`;
  const tenant = field.field!;
  if (tenant.definition.defaultValue !== undefined && tenant.appliesWhen) {
    extensionError(`${purpose}: the default of ${field.label} depends on appliesWhen, which the index does not hold, so a rollup cannot compute it.`);
  }
  const shape = extensionShape(set!.entry, tenant.definition);
  const indexed = sql`(select ${indexColumnRef(shape.column, "item")} from ${qualifiedTable(set!.entry.valuesTable)} as item
    where item.tenant_id = ${sql.id(row, "tenant_id")} and item.record_id = ${sql.id(row, "id")} and item.field_id = ${tenant.fieldId}::uuid and item.ordinal = 0)`;
  if (tenant.definition.defaultValue === undefined) return sql`${indexed}::${sql.raw(type!)}`;
  const value = sql`coalesce(${indexed}::${sql.raw(type!)}, cast(${String(tenant.definition.defaultValue)} as ${sql.raw(type!)}))`;
  return row === "target" ? sql`case when target.id is not null then ${value} end` : value;
}

/**
 * A rollup's `where` as SQL, meaning what evaluateCondition means: a blank
 * number compares as 0 and a blank text is empty. What SQL cannot say that way
 * (a literal of another type than its field, an order on a boolean, `contains`
 * on anything but text) is refused with the reason when the rollup is saved.
 */
function conditionSql(condition: unknown, fields: ReadonlyMap<string, { field: TargetField; sql: RawBuilder<unknown> }>): RawBuilder<unknown> {
  const rule = condition as Record<string, unknown>;
  const children = (rule.all ?? rule.any ?? rule.conditions) as unknown[] | undefined;
  if (Array.isArray(children)) {
    const any = rule.any !== undefined || rule.mode === "any";
    return sql`(${sql.join(children.map((child) => conditionSql(child, fields)), any ? sql` or ` : sql` and `)})`;
  }
  const path = String((rule.left as { path?: unknown }).path);
  const operand = fields.get(path);
  if (!operand) extensionError(`rollup.where: ${path} is not a field of the collection.`);
  const { field, sql: left } = operand!;
  const type = SQL_TYPES[field.type]!;
  const refuse = (detail: string): never => extensionError(`rollup.where: ${field.label} is a ${field.type} field; ${detail}, so a rollup cannot compute this condition.`);
  const literal = (value: unknown): RawBuilder<unknown> => {
    const fits = field.type === "number" ? typeof value === "number" && Number.isFinite(value)
      : field.type === "boolean" ? typeof value === "boolean"
      : field.type === "date" ? typeof value === "string" && isCalendarDate(value)
      : field.type === "timestamp" ? typeof value === "string" && Number.isFinite(Date.parse(value))
      : typeof value === "string";
    if (!fits) refuse(`${JSON.stringify(value)} is no value of it`);
    return sql`cast(${String(value)} as ${sql.raw(type)})`;
  };
  const right = (rule.right as { value?: unknown } | undefined)?.value;
  const blank = field.type === "text" ? sql`coalesce(${left}, '') = ''` : sql`${left} is null`;
  const list = () => {
    const items = Array.isArray(right) ? right : [right];
    if (!items.length) refuse("the list is empty");
    const values = items.filter((item) => item !== null);
    const member = values.length ? sql`coalesce(${left} in (${sql.join(values.map(literal))}), false)` : sql`false`;
    return values.length < items.length ? sql`(${member} or ${left} is null)` : member;
  };
  const order = (operator: RawBuilder<unknown>) => {
    if (field.type === "boolean") refuse("it has no order");
    const value = literal(right);
    if (field.type === "number") return sql`coalesce(${left}, 0) ${operator} ${value}`;
    return field.type === "text" ? sql`coalesce(${left} collate "C" ${operator} ${value}, false)` : sql`coalesce(${left} ${operator} ${value}, false)`;
  };
  const contains = () => {
    if (field.type !== "text") refuse("only text contains text");
    return sql`coalesce(strpos(${left}, ${literal(right)}) > 0, false)`;
  };
  switch (rule.operator) {
    case "equals": return right === null ? sql`${left} is null` : sql`coalesce(${left} = ${literal(right)}, false)`;
    case "notEquals": return right === null ? sql`${left} is not null` : sql`${left} is distinct from ${literal(right)}`;
    case "in": return list();
    case "notIn": return sql`not ${list()}`;
    case "isEmpty": return sql`(${blank})`;
    case "isNotEmpty": return sql`not (${blank})`;
    case "contains": return contains();
    case "notContains": return sql`not ${contains()}`;
    case "greaterThan": return order(sql`>`);
    case "greaterThanOrEquals": return order(sql`>=`);
    case "lessThan": return order(sql`<`);
    case "lessThanOrEquals": return order(sql`<=`);
    default: return extensionError(`rollup.where: ${String(rule.operator)} is not a condition a rollup can compute.`);
  }
}

function resolveStored(sets: Sets, set: ExtensionFieldSet, field: Pick<ExtensionField, "kind" | "definition">): Promise<ResolvedLookup | ResolvedRollup> {
  if (field.kind === "lookup") return resolveLookup(sets, set, field.definition.lookup as Record<string, unknown>, true);
  return resolveRollup(sets, set, field.definition.rollup as Record<string, unknown>, true);
}

// ---------------------------------------------------------------------------
// The authorization proof.

/**
 * Why `target` (and `field` on it) is authorized more narrowly than `source`,
 * or undefined when it is not. `owned` is a collection whose children are
 * authorized through their owner, which lends them its readers.
 */
function narrower(
  source: string,
  target: string,
  field: TargetField | undefined,
  managed: ReadonlySet<string>,
  owned = false,
): string | undefined {
  const from = extensionRegistry.readAccess(source);
  const to = extensionRegistry.readAccess(target);
  const reason = narrowerReadAccess(source, target, from, to, owned);
  if (reason || !from || !to) return reason;
  if (managed.has(source)) {
    return `an authorization profile of this tenant manages the reads of ${source}, so a subject granted ${source} by a profile alone could read ${target} values.`;
  }
  if (field?.authored) {
    const roles = to.fieldReadRoles?.[field.path];
    const missing = roles ? from.roles.filter((role) => !roles.includes(role)) : [];
    if (missing.length) return `${field.label} is readable for ${roles!.join(", ")}, ${source} also for ${missing.join(", ")}; that role would see ${field.label}.`;
  }
  if (managed.has(target)) {
    return `an authorization profile of this tenant manages the reads of ${target}, so a reader of ${source} could see ${target} values the profile hides.`;
  }
  return undefined;
}

function proofOf(resolved: ResolvedLookup | ResolvedRollup, source: string, managed: ReadonlySet<string>): string | undefined {
  if (resolved.kind === "lookup") return narrower(source, resolved.target, resolved.field, managed);
  const owned = resolved.collection.relation?.ownership === "owned" && resolved.collection.relation.childAuthorization === "owner";
  for (const field of [resolved.step ? undefined : resolved.of, ...resolved.whereFields]) {
    const reason = narrower(source, resolved.child, field, managed, owned);
    if (reason) return reason;
  }
  const reason = narrower(source, resolved.child, undefined, managed, owned);
  // The step is a link of its own: the target's value lands on the source, and no owner lends its readers to it.
  return reason || !resolved.step ? reason : narrower(source, resolved.step.target, resolved.of, managed);
}

/** What a lookup or rollup reads and the references its value travels along, each with its sensitivity. */
function linkedInputs(resolved: ResolvedLookup | ResolvedRollup, source: string): ComputedInput[] {
  const read = (field: TargetField): ComputedInput => ({ label: field.label,
    sensitivity: field.field ? classificationOf(field.field.definition) : authoredSensitivity(field.entity, field.path) });
  const link = (entity: string, name: string, tenant?: ExtensionField): ComputedInput => tenant
    ? { label: `${entity}.${tenant.key}`, sensitivity: classificationOf(tenant.definition) }
    : { label: `${entity}.${name}`, sensitivity: authoredSensitivity(entity, name) };
  if (resolved.kind === "lookup") return [link(source, resolved.via.path, resolved.via.tenant), read(resolved.field)];
  return [link(resolved.child, resolved.link, resolved.collection.reference?.field), ...(resolved.step ? [link(resolved.child, resolved.step.link, resolved.step.reference)] : []),
    ...(resolved.of ? [read(resolved.of)] : []), ...resolved.whereFields.map(read)];
}

/** The first field a lookup or rollup reads that is suspended itself. */
function suspendedInput(resolved: ResolvedLookup | ResolvedRollup): TargetField | undefined {
  const fields = resolved.kind === "lookup" ? [resolved.field] : [resolved.of, ...resolved.whereFields];
  return fields.find((field) => field?.field?.state === "suspended");
}

export function refuseProof(key: string, kind: string, reason: string): never {
  throw operationFailure({
    code: "FORBIDDEN",
    message: `The ${kind} ${key} cannot be saved: ${reason}`,
    data: { reason: "AUTHORIZATION_NARROWER" },
    retryable: false,
  });
}

// ---------------------------------------------------------------------------
// Save-time validation.

const NOT_ON_A_LINKED_FIELD = [
  "unique", "required", "defaultValue", "options", "cardinality", "onDelete", "validation", "retention", "unit", "formula",
] as const;

/**
 * Check a lookup or rollup definition before it is saved and return it as
 * stored: paths bound to field ids, the result type fixed and `osfType`
 * following it, and the dependencies the graph keeps. Refused with the
 * reason for anything out of reach, a type an aggregate cannot take, and a
 * target the authorization proof does not cover.
 */
export async function validateLinkedDefinition(
  trx: Transaction<DB>,
  session: DbSessionInput,
  set: ExtensionFieldSet,
  input: { fieldId: string; key: string; kind: "lookup" | "rollup"; definition: ExtensionDefinition; appliesWhen?: unknown },
): Promise<{ definition: ExtensionDefinition; dependsOn: LinkedDependency[] }> {
  const definition = { ...input.definition };
  delete definition.osfType;
  if (input.appliesWhen !== undefined && input.appliesWhen !== null) extensionError(`A ${input.kind} applies to every record; it takes no appliesWhen.`);
  for (const property of NOT_ON_A_LINKED_FIELD) {
    if (definition[property] !== undefined) extensionError(`A ${input.kind} takes no ${property}: its value is computed.`);
  }
  if (!SENSITIVITIES.includes((record(definition.classification) ? definition.classification.sensitivity : undefined) as typeof SENSITIVITIES[number])) {
    extensionError("A tenant field declares its classification (public, internal, confidential, pii or bsn).");
  }
  const other = input.kind === "lookup" ? "rollup" : "lookup";
  if (definition[other] !== undefined) extensionError(`Only a field of kind ${other} carries ${other}.`);
  const spec = definition[input.kind];
  if (!record(spec)) extensionError(`A ${input.kind} field carries ${input.kind}: { ... }.`);
  const sets = setLoader(trx, session, set);
  const resolved = input.kind === "lookup"
    ? await resolveLookup(sets, set, spec as Record<string, unknown>, false)
    : await resolveRollup(sets, set, spec as Record<string, unknown>, false);
  const suspendedRead = suspendedInput(resolved);
  const reason = suspendedRead ? `${suspendedRead.label} is suspended.` : proofOf(resolved, set.entity, await managedEntities(trx, session));
  if (reason) refuseProof(input.key, input.kind, reason);
  const shortfall = sensitivityShortfall(definition, linkedInputs(resolved, set.entity));
  if (shortfall) refuseSensitivity(input.key, input.kind, shortfall);
  const resultType = resultTypeOf(resolved);
  const storedSpec = resolved.kind === "lookup"
    ? { via: resolved.via.path, field: resolved.field.path, resultType }
    : { collection: resolved.collection.path, aggregate: resolved.aggregate,
      ...(resolved.of ? { of: resolved.step ? `${resolved.step.path}.${resolved.of.path}` : resolved.of.path } : {}),
      ...(resolved.where !== undefined ? { where: resolved.where } : {}), resultType };
  return {
    definition: { ...definition, osfType: RESULT_OSF_TYPES[resultType], [input.kind]: storedSpec },
    dependsOn: linkedDependencies(set.entity, resolved),
  };
}

const RESULT_OSF_TYPES: Readonly<Record<ComputedResultType, string>> = {
  text: "string", number: "number", boolean: "boolean", date: "date", timestamp: "datetime",
};

function resultTypeOf(resolved: ResolvedLookup | ResolvedRollup): ComputedResultType {
  if (resolved.kind === "lookup") return resolved.field.type as ComputedResultType;
  switch (resolved.aggregate) {
    case "min": case "max": return resolved.of!.type as ComputedResultType;
    case "arrayUnique": return "text";
    default: return "number";
  }
}

/** The lookups and rollups of the tenant that read a field directly, each with its entity and key. */
async function linkedReadersOfField(trx: Transaction<DB>, tenantId: string, entity: string, fieldId: string) {
  const readers = await sql<{ entity: string; key: string; kind: string; field_id: string; state: string }>`
    select distinct f.entity, f.key, f.kind, f.field_id::text as field_id, f.state
    from platform.extension_field_dependencies d
    join platform.extension_field_definitions f on f.tenant_id = d.tenant_id and f.field_id = d.field_id and f.is_current
      and f.state <> 'deleted' and f.kind in ('lookup', 'rollup')
    where d.tenant_id = ${tenantId}::uuid and d.depends_on_entity = ${entity} and d.depends_on_field = ${fieldId}
    order by 1, 2`.execute(trx);
  return readers.rows;
}

/**
 * Refuse a change of a field's result type while a lookup or rollup of the
 * tenant reads it, naming them: their stored result type and index column
 * were fixed against the old one. Create a new field instead.
 */
export async function assertNoLinkedReaders(trx: Transaction<DB>, session: DbSessionInput, entity: string, field: Pick<ExtensionField, "fieldId" | "key">): Promise<void> {
  const readers = await linkedReadersOfField(trx, session.tenantId!, entity, field.fieldId);
  if (readers.length) {
    extensionError(`${field.key}: its result type cannot change while ${readers.map((row) => `${row.entity}.${row.key}`).join(", ")} read${readers.length === 1 ? "s" : ""} it; create a new field instead.`, "CONFLICT");
  }
}

/**
 * What a record reads of a field just changed for every record (its default,
 * `appliesWhen` or formula): each lookup or rollup that reads it is computed
 * again as a backfill of its own, across entities, with what a reader of that
 * sees following from the writes the backfill makes.
 */
export async function recomputeLinkedReaders(trx: Transaction<DB>, session: DbSessionInput, entity: string, fieldId: string, started = new Set<string>()): Promise<void> {
  for (const reader of await linkedReadersOfField(trx, session.tenantId!, entity, fieldId)) {
    if ((reader.state !== "ready" && reader.state !== "updating") || started.has(reader.field_id)) continue;
    started.add(reader.field_id);
    const set = await loadExtensionFieldsFor(trx, session, reader.entity, extensionRegistry.entity(reader.entity)!);
    const field = set.byId.get(reader.field_id);
    if (field) await startBackfill(trx, session, { entity: reader.entity, field, operation: field.kind as BackfillOperation });
  }
}

/** Refuse a `defaultValue` under `appliesWhen` on a field a rollup reads: it could no longer be computed in SQL (fieldSql). */
export async function assertRollupsCanRead(trx: Transaction<DB>, session: DbSessionInput, entity: string, field: Pick<ExtensionField, "fieldId" | "key">): Promise<void> {
  const readers = (await linkedReadersOfField(trx, session.tenantId!, entity, field.fieldId)).filter((reader) => reader.kind === "rollup");
  if (readers.length) {
    extensionError(`${field.key}: a default under appliesWhen cannot be computed by ${readers.map((row) => `${row.entity}.${row.key}`).join(", ")}, which read${readers.length === 1 ? "s" : ""} it.`, "CONFLICT");
  }
}

/** The rows of `platform.extension_field_dependencies` a resolved lookup or rollup keeps. */
function linkedDependencies(entity: string, resolved: ResolvedLookup | ResolvedRollup): LinkedDependency[] {
  if (resolved.kind === "lookup") {
    return [
      { entity, field: tenantPathId(resolved.via.path) ?? resolved.via.path, via: null },
      { entity: resolved.target, field: tenantPathId(resolved.field.path) ?? resolved.field.path, via: resolved.via.path },
    ];
  }
  const via = resolved.collection.path;
  const step = resolved.step;
  const onChild = [resolved.link, ...(step ? [step.link] : resolved.of ? [resolved.of.path] : []), ...resolved.whereFields.map((field) => field.path)]
    .map((path) => ({ entity: resolved.child, field: tenantPathId(path) ?? path, via }));
  return step ? [...onChild, { entity: step.target, field: tenantPathId(resolved.of!.path) ?? resolved.of!.path, via: `${via}${STEP_VIA}${step.path}` }] : onChild;
}

/** The stored definition as a caller reads it: paths named by key again. */
export function presentLinkedDefinition(
  field: Pick<ExtensionField, "kind" | "definition">,
  names: ReadonlyMap<string, { key: string }>,
): ExtensionDefinition {
  const name = (path: string | undefined) => {
    if (path === undefined) return undefined;
    const id = tenantPathId(path);
    return id === undefined ? path : `${TENANT_PATH}${names.get(id)?.key ?? id}`;
  };
  if (field.kind === "lookup") {
    const lookup = storedLookup(field.definition);
    return lookup ? { ...field.definition, lookup: { ...lookup, via: name(lookup.via), field: name(lookup.field) } } : field.definition;
  }
  const rollup = storedRollup(field.definition);
  if (!rollup) return field.definition;
  const dot = rollup.collection.indexOf(".");
  const collection = dot > 0 ? `${rollup.collection.slice(0, dot)}.${name(rollup.collection.slice(dot + 1))}` : rollup.collection;
  const of = rollup.of ? rollupPath(rollup.of) : undefined;
  return {
    ...field.definition,
    rollup: { ...rollup, collection, ...(of ? { of: of.via === undefined ? name(of.field) : `${name(of.via)}.${name(of.field)}` } : {}),
      ...(rollup.where !== undefined ? { where: mapConditionPaths(rollup.where, (id) => names.get(id)?.key ?? id) } : {}) },
  };
}

// ---------------------------------------------------------------------------
// The graph over every entity of the tenant.

/** Serializes the definition changes of one tenant: a cycle across two entities is closed by two designers otherwise. */
export async function lockExtensionGraph(trx: Transaction<DB>, tenantId: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`osf-extensions-graph:${tenantId}`}, 0))`.execute(trx);
}

/**
 * The tenant's computed fields across every extensible entity, with
 * `changed` in place: no cycle anywhere (lookups and rollups add edges
 * between entities, formulas within a record), and no computed field deeper
 * than its entity's `limits.formulaDepth`, counting every formula, lookup and
 * rollup of the chain. A deprecated field counts as a reader: its restore
 * must not be the way past either rule.
 */
export async function assertTenantGraph(
  trx: Transaction<DB>,
  session: DbSessionInput,
  changed: { entity: string; fieldId: string; key: string; kind: string; definition: ExtensionDefinition; dependsOn: readonly { entity?: string; field: string; via?: string | null }[] },
): Promise<void> {
  type Node = { entity: string; field: string; label: string; limit: number; reads: Array<{ entity: string; field: string }> };
  const nodes = new Map<string, Node>();
  const id = (entity: string, field: string) => `${entity}\u0000${field}`;
  const sets = new Map<string, ExtensionFieldSet>();
  for (const entity of extensionRegistry.entityNames()) sets.set(entity, await loadExtensionFieldsFor(trx, session, entity, extensionRegistry.entity(entity)!));
  for (const [entity, set] of sets) {
    for (const field of set.fields) {
      if (field.kind === "stored" || field.state === "deleted") continue;
      if (entity === changed.entity && field.fieldId === changed.fieldId) continue;
      const reads = field.kind === "formula"
        ? formulaDependencies(set, storedFormula(field.definition)?.ast ?? { kind: "literal", value: null })
        : storedDependencies(set, field, sets);
      nodes.set(id(entity, field.fieldId), { entity, field: field.fieldId, label: `${entity}.${field.key}`, limit: set.entry.limits.formulaDepth,
        reads: reads.map((read) => ({ entity: read.entity, field: read.field })) });
    }
  }
  const own = extensionRegistry.entity(changed.entity)!;
  nodes.set(id(changed.entity, changed.fieldId), { entity: changed.entity, field: changed.fieldId, label: `${changed.entity}.${changed.key}`,
    limit: own.limits.formulaDepth, reads: changed.dependsOn.map((read) => ({ entity: read.entity ?? changed.entity, field: read.field })) });
  const depth = new Map<string, number>();
  const visiting: string[] = [];
  const refuse = (message: string, code: string): never => {
    throw operationFailure({ code: "VALIDATION", message: `${changed.key} cannot be saved: ${message}.`,
      violations: [{ field: "definition", code, message }], data: { errors: [{ code, message }] }, retryable: false });
  };
  const visit = (key: string): number => {
    const known = depth.get(key);
    if (known !== undefined) return known;
    const node = nodes.get(key);
    if (!node) return 0;
    const at = visiting.indexOf(key);
    if (at >= 0) {
      const cycle = [...visiting.slice(at), key].map((member) => nodes.get(member)!.label);
      refuse(`circular reference ${cycle.join(" → ")}`, "cycle");
    }
    visiting.push(key);
    const own = 1 + node.reads.reduce((deepest, read) => Math.max(deepest, visit(id(read.entity, read.field))), 0);
    visiting.pop();
    depth.set(key, own);
    if (own > node.limit) {
      refuse(node.field === changed.fieldId && node.entity === changed.entity
        ? `it would be ${own} computed fields deep; the limit is ${node.limit}`
        : `${node.label} reads it and would be ${own} computed fields deep; the limit is ${node.limit}`, "depthExceeded");
    }
    return own;
  };
  visit(id(changed.entity, changed.fieldId));
  for (const key of nodes.keys()) visit(key);
}

/** The dependencies of a stored lookup or rollup, from its definition (a deprecated one's included). */
function storedDependencies(set: ExtensionFieldSet, field: ExtensionField, sets: ReadonlyMap<string, ExtensionFieldSet>): LinkedDependency[] {
  const lookup = field.kind === "lookup" ? storedLookup(field.definition) : undefined;
  if (lookup) {
    const via = tenantPathId(lookup.via);
    const target = via ? extensionShape(set.entry, set.byId.get(via)?.definition ?? {}).reference?.entity
      : set.entry.relations.find((relation) => relation.key === lookup.via)?.entity;
    return [{ entity: set.entity, field: via ?? lookup.via, via: null },
      ...(target ? [{ entity: target, field: tenantPathId(lookup.field) ?? lookup.field, via: lookup.via }] : [])];
  }
  const rollup = field.kind === "rollup" ? storedRollup(field.definition) : undefined;
  if (!rollup) return [];
  const child = rollupChild(set, rollup);
  if (!child) return [];
  const of = rollup.of ? rollupPath(rollup.of) : undefined;
  const step = of?.via !== undefined ? storedStep(child, sets.get(child), of.via) : undefined;
  const paths = [step ? undefined : rollup.of, ...(rollup.where !== undefined ? conditionPaths(rollup.where).map((path) => path.kind === "authored" ? path.field : `${TENANT_PATH}${path.key}`) : [])];
  return [...paths.flatMap((path) => path ? [{ entity: child, field: tenantPathId(path) ?? path, via: rollup.collection }] : []),
    ...(step ? [{ entity: step.target, field: tenantPathId(of!.field) ?? of!.field, via: `${rollup.collection}${STEP_VIA}${step.path}` }] : [])];
}

/** The entity a stored rollup aggregates. */
function rollupChild(set: ExtensionFieldSet, rollup: StoredRollup): string | undefined {
  const dot = rollup.collection.indexOf(".");
  return dot > 0 ? rollup.collection.slice(0, dot) : set.entry.relations.find((relation) => relation.key === rollup.collection)?.entity;
}

// ---------------------------------------------------------------------------
// Computing a record's lookups and rollups.

type LinkedResult = { ok: true; value: unknown } | { ok: false; error: string };

/** Store one result in the source: the value, or null with `$meta[fieldId].error`; a computed value is never stale once written. */
function storeLinked(source: Record<string, unknown>, fieldId: string, result: LinkedResult): void {
  const meta: Record<string, unknown> = record(source[EXTENSION_META_KEY]) ? { ...source[EXTENSION_META_KEY] as Record<string, unknown> } : {};
  const own: Record<string, unknown> = record(meta[fieldId]) ? { ...meta[fieldId] as Record<string, unknown> } : {};
  if (result.ok) {
    if (result.value === null || result.value === undefined) delete source[fieldId];
    else source[fieldId] = result.value;
    delete own.error;
  } else {
    source[fieldId] = null;
    own.error = result.error;
  }
  if (Object.keys(own).length) meta[fieldId] = own; else delete meta[fieldId];
  if (Object.keys(meta).length) source[EXTENSION_META_KEY] = meta; else delete source[EXTENSION_META_KEY];
}

const round = (value: number) => Number.isFinite(value) && Math.abs(value) < 1e21 ? Number(value.toFixed(ROUNDING_DECIMALS)) : value;

/** The values of `fields` on the records of `entity` named by `rows` (formula-readable columns, tenant fields as a reader sees them). */
function valueOf(set: ExtensionFieldSet | undefined, table: GeneratedCrudTable, row: Readonly<Record<string, unknown>>, path: string): unknown {
  const id = tenantPathId(path);
  if (id === undefined) return fieldValues(table, row)[path] ?? null;
  const field = set?.byId.get(id);
  if (!set || !field) return null;
  const source = storedExtensionSource(row);
  const meta = record(source[EXTENSION_META_KEY]) ? (source[EXTENSION_META_KEY] as Record<string, unknown>)[id] : undefined;
  // A computed field in error reads as blank.
  if (field.kind !== "stored" && record(meta) && typeof meta.error === "string") return null;
  return readValue(field, source, evaluateCondition(field.appliesWhen, conditionValues(table, row, set, source)));
}

function typed(type: string, value: unknown): unknown {
  if (value === null || value === undefined || value === "") return null;
  if (type !== "number") return value;
  // Text no JSON number holds exactly stays the text a reader of the target sees (model.ts `numericValue`).
  const number = Number(value);
  if (Number.isNaN(number)) return null;
  return typeof value !== "string" || exactNumericEquals(value, number) ? number : value;
}

const textTooLong = (value: string) => value.length > MAX_RESULT_TEXT_LENGTH || Buffer.byteLength(value, "utf8") > MAX_RESULT_TEXT_BYTES;

/** A value as a lookup or rollup stores it: text beyond the bounds of a formula's is that record's `textTooLong`, never a database error. */
function bounded(value: unknown): LinkedResult {
  return typeof value === "string" && textTooLong(value) ? { ok: false, error: "textTooLong" } : { ok: true, value };
}

function emptyRollup(aggregate: RollupAggregate): LinkedResult {
  return { ok: true, value: aggregate === "count" || aggregate === "countAll" || aggregate === "sum" ? 0 : null };
}

/** How `value` (a text-free SQL expression of `type`) reads as text: what arrayUnique lists. */
function asText(type: string, value: RawBuilder<unknown>): RawBuilder<unknown> {
  switch (type) {
    case "number": return sql`trim_scale(${value})::text`;
    case "timestamp": return timestampText(value);
    default: return sql`(${value})::text`;
  }
}

const timestampText = (value: RawBuilder<unknown>): RawBuilder<unknown> => sql`to_char(${value} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/**
 * The aggregate of one parent's collection, in one statement over the child
 * table and the typed index, with the target of `of`'s step joined per child
 * (a child without one counts as a record, with a blank value): nothing is read
 * into this process but the result. Runs under the parent's `for no key update` (recomputeRecordFormulas),
 * so a concurrent writer of a child waits for it, and reads what committed
 * before it got the lock. `arrayUnique` stops at the first value past what the
 * text bounds can hold: at most one character and a separator each.
 */
async function rollupValue(trx: Transaction<DB>, tenantId: string, resolved: ResolvedRollup, childTable: GeneratedCrudTable, recordId: string): Promise<LinkedResult> {
  const members = resolved.collection.relation
    ? sql`child.${sql.id(resolved.collection.relation.foreignKey)} = ${recordId}::uuid`
    : sql`exists (select 1 from ${qualifiedTable(extensionRegistry.entity(resolved.child)!.valuesTable)} as link
        where link.tenant_id = child.tenant_id and link.record_id = child.id
          and link.field_id = ${resolved.collection.reference!.field.fieldId}::uuid and link.value_ref_id = ${recordId}::uuid)`;
  const step = resolved.step;
  const target = !step ? sql`` : step.relation
    ? sql`left join ${qualifiedTable(step.table)} as target on target.tenant_id = child.tenant_id and target.id = child.${sql.id(step.relation.foreignKey)}`
    : sql`left join ${qualifiedTable(extensionRegistry.entity(resolved.child)!.valuesTable)} as step on step.tenant_id = child.tenant_id and step.record_id = child.id
          and step.field_id = ${step.reference!.fieldId}::uuid and step.ordinal = 0
        left join ${qualifiedTable(step.table)} as target on target.tenant_id = child.tenant_id and target.id = step.value_ref_id`;
  const scope = sql`from ${sql.id(childTable.schema, childTable.table)} as child ${target}
    where child.tenant_id = ${tenantId}::uuid and ${members} ${resolved.whereSql ? sql`and ${resolved.whereSql}` : sql``}`;
  const type = resolved.of?.type ?? "number";
  const value = resolved.ofSql ? (type === "text" ? sql`nullif(${resolved.ofSql}, '')` : resolved.ofSql) : undefined;
  const one = async (expression: RawBuilder<unknown>) => (await sql<{ value: string | null }>`select (${expression})::text as value ${scope}`.execute(trx)).rows[0]?.value ?? null;
  const number = (text: string | null) => text === null ? null : round(Number(text));
  switch (resolved.aggregate) {
    case "countAll": return { ok: true, value: Number(await one(sql`count(*)`)) };
    case "count": return { ok: true, value: Number(await one(value ? sql`count(${value})` : sql`count(*)`)) };
    case "sum": return { ok: true, value: number(await one(sql`coalesce(sum(${value!}), 0)`)) };
    case "avg": return { ok: true, value: number(await one(sql`avg(${value!})`)) };
    case "min":
    case "max": {
      const aggregate = resolved.aggregate === "min" ? sql`min(${value!})` : sql`max(${value!})`;
      if (type === "timestamp") return { ok: true, value: await one(timestampText(aggregate)) };
      const result = await one(aggregate);
      return { ok: true, value: type === "number" ? number(result) : result };
    }
    case "arrayUnique": {
      const items = (await sql<{ items: string[] | null }>`select to_jsonb(array_agg(item)) as items from (
          select distinct left(${asText(type, value!)}, ${MAX_RESULT_TEXT_LENGTH + 1}) as item ${scope} and ${value!} is not null
          limit ${MOST_UNIQUE_VALUES + 1}) as items`.execute(trx)).rows[0]?.items ?? [];
      if (items.length > MOST_UNIQUE_VALUES) return { ok: false, error: "textTooLong" };
      return bounded([...items].sort((left, right) => left.localeCompare(right)).join(", ") || null);
    }
  }
}

/**
 * Compute `fields` (lookups and rollups of `set`) of one record into
 * `source` (mutated). `row` is the record as stored or as it will be written
 * (an authored foreign key). The locks are the caller's: in the record's own
 * write lockLinkedRecords holds a lookup's target `for share`, so a concurrent
 * write of the target waits for this one and then finds this record through
 * the index; a recompute from the other side (fan-out, journal, backfill)
 * needs none on the target, since a later write of it recomputes this again.
 */
export async function computeLinkedValues(
  trx: Transaction<DB>,
  session: DbSessionInput,
  set: ExtensionFieldSet,
  row: Readonly<Record<string, unknown>>,
  source: Record<string, unknown>,
  fields: readonly ExtensionField[],
): Promise<void> {
  if (!fields.length) return;
  const sets = setLoader(trx, session, set);
  const tenantId = session.tenantId!;
  for (const field of fields) {
    let resolved: ResolvedLookup | ResolvedRollup;
    try {
      resolved = await resolveStored(sets, set, field);
    } catch {
      // The definition no longer resolves (a migration changed what it named): its revalidation suspends it.
      continue;
    }
    if (resolved.kind === "lookup") {
      const targetId = resolved.via.tenant ? source[resolved.via.tenant.fieldId] : row[resolved.via.relation!.foreignKey];
      const table = tableOf(resolved.target);
      if (typeof targetId !== "string" || !table) { storeLinked(source, field.fieldId, { ok: true, value: null }); continue; }
      const found = await sql<{ row: Record<string, unknown> }>`select ${formulaRowObject(table, "target")} as row
        from ${sql.id(table.schema, table.table)} as target
        where target.tenant_id = ${tenantId}::uuid and target.id = ${targetId}::uuid`.execute(trx);
      const target = found.rows[0]?.row;
      storeLinked(source, field.fieldId, bounded(target ? typed(resolved.field.type, valueOf(await sets(resolved.target), table, target, resolved.field.path)) : null));
      continue;
    }
    const childTable = tableOf(resolved.child);
    const recordId = row.id;
    if (!childTable || typeof recordId !== "string") { storeLinked(source, field.fieldId, emptyRollup(resolved.aggregate)); continue; }
    storeLinked(source, field.fieldId, await rollupValue(trx, tenantId, resolved, childTable, recordId));
  }
}

/**
 * The lookups of a record's own write to compute: on a create every lookup
 * and rollup, on an update the lookups whose reference this write changes.
 */
export function ownLinkedFields(
  set: ExtensionFieldSet,
  input: { create: boolean; current?: Readonly<Record<string, unknown>> | null | undefined; row: Readonly<Record<string, unknown>>; before: Readonly<Record<string, unknown>>; after: Readonly<Record<string, unknown>> },
): ExtensionField[] {
  const linked = computedLinked(set);
  if (input.create) return linked;
  return linked.filter((field) => {
    const lookup = field.kind === "lookup" ? storedLookup(field.definition) : undefined;
    if (!lookup) return false;
    const via = tenantPathId(lookup.via);
    if (via) return JSON.stringify(input.before[via] ?? null) !== JSON.stringify(input.after[via] ?? null);
    const relation = set.entry.relations.find((candidate) => candidate.key === lookup.via);
    return relation !== undefined && Object.hasOwn(input.row, relation.foreignKey) &&
      String(input.current?.[relation.foreignKey] ?? null) !== String(input.row[relation.foreignKey] ?? null);
  });
}

/** The lookups of `set` that follow one of these stored tenant references (rewriteExtensionValues). */
export function lookupsThrough(set: ExtensionFieldSet, fieldIds: ReadonlySet<string>): ExtensionField[] {
  return computedLinked(set).filter((field) => {
    const via = field.kind === "lookup" ? tenantPathId(storedLookup(field.definition)?.via ?? "") : undefined;
    return via !== undefined && fieldIds.has(via);
  });
}

// ---------------------------------------------------------------------------
// The lock order of a write.

type LockMode = "key share" | "share" | "no key update" | "update";
const LOCK_STRENGTH: Readonly<Record<LockMode, number>> = { "key share": 0, share: 1, "no key update": 2, update: 3 };

/** What a write is about to do to one record, for lockLinkedRecords. */
export type LinkedWrite = {
  operation: "create" | "update" | "delete";
  /** The record; a create has none yet. */
  id?: string;
  /** The columns this write sets, by column name. */
  row?: Readonly<Record<string, unknown>>;
  /** Tenant field values by key. */
  extensions?: Readonly<Record<string, unknown>>;
  /** A member of this record's collection written along with it (collection-mutations.ts), with its values by field name, or `removed`: its id. */
  member?: { table: GeneratedCrudTable; values?: Readonly<Record<string, unknown>> | undefined; removed?: string | undefined };
};

/**
 * Every record this write will recompute, or needs to keep from changing,
 * locked once, in one order — table, then id — before the record's own row
 * lock and the first row write: the record itself, the parents of its rollups
 * (old and new), the records whose lookups read it, the parents that reach it
 * from a child and, along the chain, what reads those, up to the budget of the
 * write (what lies beyond goes through the journal and needs no lock here). Two writers that reach the same records
 * from opposite sides, a parent and its child, therefore never hold what the
 * other waits for.
 *
 * Each record gets the weakest lock that keeps its invariant, and gets it
 * here, at once, at the strength the write will need: `for key share` for "this
 * target exists", `for share` for a lookup's target or the one a child's rollup
 * reaches (it conflicts with a write of the target, which then finds this record
 * through the index), `for no key
 * update` for a record to recompute. A lock is never upgraded later: two holders
 * of a weaker one that both upgrade are a deadlock, and so is an upgrade behind
 * a queued writer. `for no key update` leaves the foreign key checks of
 * concurrent children alone, so writers under one parent only take turns.
 *
 * Returns the lock the caller takes on the record itself when it is part of
 * this order: `for no key update`, what the update will take anyway; undefined
 * when the write touches nothing that reads it, and the caller's usual lock
 * stands. Work is found under the audited tenant bypass: the writer's own row
 * policies must not hide a record whose value follows from this write.
 */
export async function lockLinkedRecords(
  trx: Transaction<DB>,
  session: DbSessionInput,
  table: GeneratedCrudTable,
  write: LinkedWrite,
): Promise<"no key update" | undefined> {
  const tenantId = session.tenantId;
  const own = baseTableOf(table);
  const entity = own.source?.authoringEntityName;
  if (!tenantId || !entity || !extensionRegistry.entityNames().length) return undefined;
  const entry = extensionRegistry.entity(entity);
  const memberTable = write.member ? baseTableOf(write.member.table) : undefined;
  const memberEntity = memberTable?.source?.authoringEntityName;
  // What this write deletes: the record, or the member a collection removes from it.
  const gone = write.operation === "delete" ? { entity, id: write.id! } : memberEntity && write.member?.removed ? { entity: memberEntity, id: write.member.removed } : undefined;
  const referenced = gone ? extensionRegistry.referencedBy(gone.entity) : [];
  if (!entry && !extensionRegistry.readAccess(entity) && !(memberEntity && extensionRegistry.readAccess(memberEntity)) && !referenced.length) return undefined;
  const sets = setLoader(trx, session);
  const set = entry ? await sets(entity) : undefined;
  const dependents = await linkedDependents(trx, tenantId, entity);
  const memberDependents = memberEntity ? await linkedDependents(trx, tenantId, memberEntity) : new Map<string, Dependent>();
  // The owner of an owned single child is recomputed with it, when a formula reads the child.
  const owners: Array<{ table: string; foreignKey: string }> = [];
  for (const link of ownerLinks(own)) {
    const ownerSet = await sets(link.entity);
    if (ownerSet && formulaGraph(ownerSet).relations.includes(link.relation)) owners.push({ table: ownerSet.entry.table, foreignKey: link.foreignKey });
  }
  if (!dependents.size && !memberDependents.size && !owners.length && !referenced.length && !(set && computedLinked(set).length)) return undefined;
  const plan = new Map<string, { table: string; id: string; mode: LockMode }>();
  const lock = (qualified: string, id: unknown, mode: LockMode) => {
    if (typeof id !== "string") return;
    const key = `${qualified}\u0000${id}`;
    const known = plan.get(key);
    if (!known || LOCK_STRENGTH[known.mode] < LOCK_STRENGTH[mode]) plan.set(key, { table: qualified, id, mode });
  };
  const budget = new Set<string>();
  const seen = new Set<string>();
  const stored = async (from: GeneratedCrudTable, id: string) => (await sql<{ row: Record<string, unknown> }>`select to_jsonb(record.*) as row
    from ${sql.id(from.schema, from.table)} as record where record.tenant_id = ${tenantId}::uuid and record.id = ${id}::uuid`.execute(trx)).rows[0]?.row;
  /** What reads this record, down the chain: `changed` names its fields a write changes, undefined for all of them. */
  const follow = async (node: { table: GeneratedCrudTable; entity: string; id?: string; created?: boolean; deleted?: boolean; changed?: ReadonlySet<string>; written?: Readonly<Record<string, unknown>> }): Promise<void> => {
    const dependents = await linkedDependents(trx, tenantId, node.entity);
    if (!dependents.size) return;
    const before = node.id ? await stored(node.table, node.id) : undefined;
    const after = node.deleted ? null : { ...before, ...node.written };
    for (const [fieldId, dependent] of dependents) {
      const touched = (reads: ReadonlySet<string>) => reads.size > 0 && (!node.changed || [...reads].some((read) => node.changed!.has(read)));
      if (!touched(dependent.reads) && !touched(dependent.stepReads)) continue;
      const set = await sets(dependent.entity);
      const field = set?.byId.get(fieldId);
      const sourceTable = tableOf(dependent.entity);
      if (!set || !field || !sourceTable || !computedLinked(set).includes(field)) continue;
      const changes = new Set([fieldId, ...formulaGraph(set).affectedBy([{ entity: set.entity, field: fieldId }]).map((item) => item.fieldId)]);
      const rollup = field.kind === "rollup" ? storedRollup(field.definition)! : undefined;
      const limit = set.entry.limits.syncFanOut + 1;
      const through = !node.id || node.created ? []
        : rollup ? touched(dependent.stepReads) ? await parentsThroughStep(trx, tenantId, sets, set, rollup, node.id, undefined, limit) : []
        : await referringRecords(trx, tenantId, set, storedLookup(field.definition)!.via, node.id, undefined, limit);
      const parents = rollup && touched(dependent.reads) ? await parentsOf(trx, tenantId, set, rollup, node.table, { before, after }, node.id ?? "") : [];
      // Beyond the budget what reads through a reference goes through the journal as a whole, a rollup's parents one by one.
      for (const recordId of [...(withinBudget(budget, set, through) ? through : []), ...parents.filter((id) => withinBudget(budget, set, [id]))]) {
        const visit = `${dependent.entity}\u0000${recordId}\u0000${[...changes].sort().join()}`;
        lock(set.entry.table, recordId, "no key update");
        if (seen.has(visit)) continue;
        seen.add(visit);
        await follow({ table: sourceTable, entity: set.entity, id: recordId, changed: changes });
      }
    }
  };
  await acrossTenant(trx, session, `lock order of a write of ${entity}`, async () => {
    // The fields this write can change: those it names and everything computed on the record.
    const named = write.row ? Object.keys(write.row).flatMap((name) => {
      const column = own.columns.find((candidate) => candidate.name === name);
      return column ? [fieldNameForColumn(column)] : [];
    }) : [];
    const ids = Object.keys(write.extensions ?? {}).flatMap((key) => {
      const field = set?.byKey.get(key);
      return field ? [field.fieldId] : [];
    });
    const computed = set ? set.fields.filter((field) => field.kind !== "stored").map((field) => field.fieldId) : [];
    const source = write.extensions && set
      ? Object.fromEntries(Object.entries(write.extensions).flatMap(([key, value]) => {
        const field = set.byKey.get(key);
        return field ? [[field.fieldId, value]] : [];
      })) : undefined;
    const current = write.id ? await stored(own, write.id) : undefined;
    const written = { ...write.row, ...(source ? { [EXTENSION_VALUES_COLUMN]: { ...storedExtensionSource(current), ...source } } : {}) };
    await follow({
      table: own, entity, ...(write.id ? { id: write.id } : {}), written,
      ...(write.operation === "create" ? { created: true } : write.operation === "delete" ? { deleted: true } : { changed: new Set([...named, ...ids, ...computed]) }),
    });
    if (memberTable && gone && write.member?.removed) await follow({ table: memberTable, entity: gone.entity, id: gone.id, deleted: true });
    for (const owner of owners) lock(owner.table, write.row?.[owner.foreignKey] ?? current?.[owner.foreignKey], "no key update");
    // A target a child's rollup newly reaches must not change before this write has committed: as for a lookup below.
    const reachedBy = async (from: ReadonlyMap<string, Dependent>, entityName: string, value: (step: RollupStep) => unknown) => {
      for (const [fieldId, dependent] of from) {
        const set = dependent.reads.size ? await sets(dependent.entity) : undefined;
        const field = set?.byId.get(fieldId);
        const rollup = field?.kind === "rollup" && computedLinked(set!).includes(field) ? storedRollup(field.definition) : undefined;
        const via = rollup?.of ? rollupPath(rollup.of)?.via : undefined;
        if (via === undefined || rollupChild(set!, rollup!) !== entityName) continue;
        const step = storedStep(entityName, await sets(entityName), via);
        if (step) lock(step.table, value(step), "share");
      }
    };
    await reachedBy(dependents, entity, (step) => step.relation ? write.row?.[step.relation.foreignKey] : write.extensions?.[step.reference!.key]);
    if (write.member && memberEntity) {
      const values = write.member.values;
      await reachedBy(memberDependents, memberEntity, (step) => step.relation ? values?.[step.link] : (values?.extensions as Record<string, unknown> | undefined)?.[step.reference!.key]);
    }
    // A lookup's new target must not change before this write has committed; a reference's must stay.
    for (const field of set?.fields ?? []) {
      if (!set || field.state === "deleted" || field.kind === "formula" || field.kind === "rollup") continue;
      if (field.kind === "stored") {
        const shape = extensionShape(set.entry, field.definition);
        if (shape.reference && Object.hasOwn(write.extensions ?? {}, field.key)) {
          for (const id of referenceIds(shape, write.extensions![field.key])) lock(shape.reference.table, id, "key share");
        }
        continue;
      }
      if (!computedLinked(set).includes(field)) continue;
      const lookup = storedLookup(field.definition)!;
      const via = tenantPathId(lookup.via);
      const reference = via ? set.byId.get(via) : undefined;
      const relation = via ? undefined : set.entry.relations.find((candidate) => candidate.key === lookup.via);
      const target = reference ? write.extensions?.[reference.key] : relation ? write.row?.[relation.foreignKey] : undefined;
      const targetTable = reference ? extensionShape(set.entry, reference.definition).reference?.table : relation?.table;
      if (targetTable) lock(targetTable, target, "share");
    }
    // A delete unlinks the tenant references to it, in this transaction while the budget lasts.
    for (const source of referenced) {
      const sourceSet = await sets(source.sourceEntity);
      if (!sourceSet) continue;
      const records = await sql<{ id: string }>`select distinct record_id::text as id from ${qualifiedTable(source.valuesTable)}
        where tenant_id = ${tenantId}::uuid and value_ref_id = ${gone!.id}::uuid order by 1 limit ${sourceSet.entry.limits.syncFanOut + 1}`.execute(trx);
      if (!withinBudget(budget, sourceSet, records.rows.map((record) => record.id))) continue;
      for (const record of records.rows) lock(sourceSet.entry.table, record.id, "no key update");
    }
    if (!plan.size) return;
    if (write.id) lock(entry?.table ?? `${own.schema}.${own.table}`, write.id, write.operation === "delete" ? "update" : "no key update");
    if (memberTable) lock(`${memberTable.schema}.${memberTable.table}`, write.member?.removed, "update");
    const ordered = [...plan.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, item]) => item);
    for (const item of ordered) {
      await sql`select id from ${qualifiedTable(item.table)} where tenant_id = ${tenantId}::uuid and id = ${item.id}::uuid for ${sql.raw(item.mode)}`.execute(trx);
    }
  });
  return plan.size && write.id && write.operation !== "delete" ? "no key update" : undefined;
}

// ---------------------------------------------------------------------------
// Fan-out: a write of one record recomputes the fields that read it elsewhere.

/**
 * The extensible entities whose lookups or rollups can read records of this
 * table's entity: those that reference it or relate to it, those an extensible
 * entity's tenant reference may name (a rollup over it), and those with a
 * collection whose records may lead to it (the step of `rollup.of`). A subtype
 * writes its base table, so it counts as its base entity.
 */
export function linkedReadersOf(table: GeneratedCrudTable): string[] {
  const entity = baseTableOf(table).source?.authoringEntityName;
  if (!entity || !extensionRegistry.readAccess(entity)) return [];
  const own = extensionRegistry.entity(entity);
  return extensionRegistry.entityNames().filter((name) => {
    const entry = extensionRegistry.entity(name)!;
    return entry.targets.some((target) => target.entity === entity) || entry.relations.some((relation) => relation.entity === entity) ||
      (own?.targets.some((target) => target.entity === name) ?? false) || childrenOf(name).some((child) => reachedFrom(child).includes(entity));
  });
}

/** The entities a rollup of an extensible entity may aggregate. */
function childrenOf(entity: string): string[] {
  const referring = extensionRegistry.entityNames().filter((name) => extensionRegistry.entity(name)!.targets.some((target) => target.entity === entity));
  return [...extensionRegistry.entity(entity)!.relations.filter((relation) => relation.kind === "hasMany").map((relation) => relation.entity), ...referring];
}

/** The entities `rollup.of` may step to from a child. */
function reachedFrom(child: string): string[] {
  return [...stepRelations(child).map((relation) => relation.entity), ...(extensionRegistry.entity(child)?.targets.map((target) => target.entity) ?? [])];
}

type Change = {
  before?: Readonly<Record<string, unknown>> | null | undefined;
  after?: Readonly<Record<string, unknown>> | null | undefined;
};

/** The fields of a write that changed: authored by name, tenant fields by id (`$meta` included for a computed one). */
function changedFields(table: GeneratedCrudTable, change: Change): Set<string> {
  const changed = new Set<string>();
  const before = change.before ?? {}, after = change.after ?? {};
  for (const column of table.columns) {
    if (column.name === EXTENSION_VALUES_COLUMN) continue;
    if (JSON.stringify(before[column.name] ?? null) !== JSON.stringify(after[column.name] ?? null)) changed.add(fieldNameForColumn(column));
  }
  const was = storedExtensionSource(change.before), is = storedExtensionSource(change.after);
  const meta = (source: Record<string, unknown>, id: string) => record(source[EXTENSION_META_KEY]) ? (source[EXTENSION_META_KEY] as Record<string, unknown>)[id] : undefined;
  for (const id of new Set([...Object.keys(was), ...Object.keys(is)])) {
    if (id === EXTENSION_META_KEY) continue;
    if (JSON.stringify(was[id] ?? null) !== JSON.stringify(is[id] ?? null) || JSON.stringify(meta(was, id) ?? null) !== JSON.stringify(meta(is, id) ?? null)) changed.add(id);
  }
  for (const id of new Set([...Object.keys(record(was[EXTENSION_META_KEY]) ? was[EXTENSION_META_KEY] as object : {}), ...Object.keys(record(is[EXTENSION_META_KEY]) ? is[EXTENSION_META_KEY] as object : {})])) {
    if (JSON.stringify(meta(was, id) ?? null) !== JSON.stringify(meta(is, id) ?? null)) changed.add(id);
  }
  return changed;
}

const depthOf = new WeakMap<object, number>();

/** A computed field that reads an entity across a relation: what it reads there as a target or a child (`reads`), and through a rollup's step (`stepReads`). */
type Dependent = { entity: string; reads: Set<string>; stepReads: Set<string> };

/** The computed fields that read an entity across a relation, with what each reads there. */
async function linkedDependents(trx: Transaction<DB>, tenantId: string, entity: string): Promise<Map<string, Dependent>> {
  const rows = await sql<{ field_id: string; entity: string; depends_on_field: string; via_field: string }>`
    select distinct d.field_id::text as field_id, f.entity, d.depends_on_field, d.via_field
    from platform.extension_field_dependencies d
    join platform.extension_field_definitions f on f.tenant_id = d.tenant_id and f.field_id = d.field_id and f.is_current
      and f.state in ('ready', 'updating') and f.kind in ('lookup', 'rollup')
    where d.tenant_id = ${tenantId}::uuid and d.depends_on_entity = ${entity} and d.via_field is not null
    order by 1, 3`.execute(trx);
  const byField = new Map<string, Dependent>();
  for (const row of rows.rows) {
    const item = byField.get(row.field_id) ?? { entity: row.entity, reads: new Set<string>(), stepReads: new Set<string>() };
    (row.via_field.includes(STEP_VIA) ? item.stepReads : item.reads).add(row.depends_on_field);
    byField.set(row.field_id, item);
  }
  return byField;
}

/**
 * Carry a write of one record on to the lookups and rollups that read it:
 * called after every create, update and delete of an entity a tenant field
 * can reach (mutations.ts, collection-mutations.ts) and after every internal
 * write of tenant values (write.ts `rewriteExtensionValues`), so a recompute
 * carries on along the chain. Records are recomputed in this transaction while
 * its budget lasts (writeBudget), a lookup's referring records as a whole or
 * not at all; the rest is journaled. A rollup follows the old and the new
 * parent of the record, and from the target of its step the parents of the
 * children that name it, as a lookup its referring records. A write through a
 * subtype is a write of its base entity.
 * The records are found and written under the audited tenant bypass: the
 * writer's row policies must not leave a value behind on a record it cannot see.
 */
export async function propagateRecordChange(
  trx: Transaction<DB>,
  session: DbSessionInput,
  table: GeneratedCrudTable,
  change: Change,
): Promise<void> {
  const base = baseTableOf(table);
  const entity = base.source?.authoringEntityName;
  const tenantId = session.tenantId;
  if (!entity || !tenantId || !extensionRegistry.entityNames().length || !extensionRegistry.readAccess(entity)) return;
  const scope = currentDbSessionTransaction() ?? trx;
  const depth = depthOf.get(scope) ?? 0;
  if (depth > MAX_PROPAGATION_DEPTH) extensionError("Tenant field recomputation does not converge.", "INVALID_DEFINITION");
  const dependents = await linkedDependents(trx, tenantId, entity);
  if (!dependents.size) return;
  const recordId = String((change.after ?? change.before)?.id ?? "");
  if (!recordId) return;
  const created = !change.before, deleted = !change.after;
  const changed = changedFields(base, change);
  const touched = (reads: ReadonlySet<string>) => [...reads].some((read) => changed.has(read));
  const relevant = [...dependents].filter(([, dependent]) => created || deleted || touched(dependent.reads) || touched(dependent.stepReads));
  if (!relevant.length) return;
  const budget = writeBudget(trx);
  const work = async () => {
    const sets = setLoader(trx, session);
    for (const [fieldId, dependent] of relevant) {
      const set = await loadExtensionFieldsFor(trx, session, dependent.entity, extensionRegistry.entity(dependent.entity)!, { lock: "shared" });
      const field = set.byId.get(fieldId);
      if (!field || !computedLinked(set).includes(field)) continue;
      const sourceTable = tableOf(dependent.entity);
      if (!sourceTable) continue;
      if (field.kind === "lookup") {
        // A new record is referred to by none yet; a deleted one is the deletion guard's (references.ts) or its foreign key's.
        if (created || deleted) continue;
        const sources = await referringRecords(trx, tenantId, set, storedLookup(field.definition)!.via, recordId, undefined, set.entry.limits.syncFanOut + 1);
        if (!withinBudget(budget, set, sources)) {
          await journalRecompute(trx, session, { entity: set.entity, field, targetEntity: entity, targetId: recordId });
          continue;
        }
        for (const source of sources) await recomputeLinkedRecord(trx, session, { table: sourceTable, set, recordId: source, fields: [field] });
        continue;
      }
      const rollup = storedRollup(field.definition)!;
      // A new target is reached by no child yet; a deleted one is left by its foreign key or the deletion guard, through a write of the child.
      if (!created && !deleted && touched(dependent.stepReads)) {
        const parents = await parentsThroughStep(trx, tenantId, sets, set, rollup, recordId, undefined, set.entry.limits.syncFanOut + 1);
        if (withinBudget(budget, set, parents)) {
          for (const parent of parents) await recomputeLinkedRecord(trx, session, { table: sourceTable, set, recordId: parent, fields: [field] });
        } else {
          await journalRecompute(trx, session, { entity: set.entity, field, targetEntity: entity, targetId: recordId });
        }
      }
      if (!dependent.reads.size || !(created || deleted || touched(dependent.reads))) continue;
      for (const parent of await parentsOf(trx, tenantId, set, rollup, base, change, recordId)) {
        if (withinBudget(budget, set, [parent])) {
          await recomputeLinkedRecord(trx, session, { table: sourceTable, set, recordId: parent, fields: [field] });
        } else {
          await journalRecompute(trx, session, { entity: set.entity, field, targetEntity: set.entity, targetId: parent });
        }
      }
    }
  };
  depthOf.set(scope, depth + 1);
  try {
    if (depth) await work();
    else await acrossTenant(trx, session, `recompute what reads ${entity} ${recordId}`, work);
  } finally {
    depthOf.set(scope, depth);
  }
}

/** The records of `set` whose lookup reference (`via`) names `targetId`, in id order. */
async function referringRecords(trx: Transaction<DB>, tenantId: string, set: ExtensionFieldSet, via: string, targetId: string, after?: string, limit?: number): Promise<string[]> {
  const id = tenantPathId(via);
  const page = (column: string) => sql`${after ? sql`and ${sql.ref(column)} > ${after}::uuid` : sql``} order by 1 ${limit ? sql`limit ${limit}` : sql``}`;
  if (id) {
    const rows = await sql<{ id: string }>`select distinct record_id::text as id from ${qualifiedTable(set.entry.valuesTable)}
      where tenant_id = ${tenantId}::uuid and value_ref_id = ${targetId}::uuid and field_id = ${id}::uuid ${page("record_id")}`.execute(trx);
    return rows.rows.map((row) => row.id);
  }
  const relation = set.entry.relations.find((candidate) => candidate.key === via);
  if (!relation) return [];
  const rows = await sql<{ id: string }>`select id::text as id from ${qualifiedTable(set.entry.table)}
    where tenant_id = ${tenantId}::uuid and ${sql.ref(relation.foreignKey)} = ${targetId}::uuid ${page("id")}`.execute(trx);
  return rows.rows.map((row) => row.id);
}

/**
 * The records still holding a lookup's value after its target went and the
 * foreign key set their reference to null: what a journal row of a deleted
 * target recomputes, since nothing names that target any more.
 */
async function orphanedRecords(trx: Transaction<DB>, tenantId: string, set: ExtensionFieldSet, via: string, fieldId: string, after: string | undefined, limit: number): Promise<string[]> {
  const relation = set.entry.relations.find((candidate) => candidate.key === via);
  if (!relation) return [];
  const rows = await sql<{ id: string }>`select id::text as id from ${qualifiedTable(set.entry.table)}
    where tenant_id = ${tenantId}::uuid and ${sql.ref(relation.foreignKey)} is null
      and (${sql.ref(EXTENSION_VALUES_COLUMN)} ? ${fieldId} or ${sql.ref(EXTENSION_VALUES_COLUMN)} -> ${EXTENSION_META_KEY} ? ${fieldId})
      ${after ? sql`and id > ${after}::uuid` : sql``} order by id limit ${limit}`.execute(trx);
  return rows.rows.map((row) => row.id);
}

/**
 * The old and the new parent a child's write touches, for a rollup over its
 * collection. An internal write names only the tenant values it changed; an
 * authored foreign key it did not change is read from the stored row.
 */
async function parentsOf(
  trx: Transaction<DB>,
  tenantId: string,
  set: ExtensionFieldSet,
  rollup: NonNullable<ReturnType<typeof storedRollup>>,
  childTable: GeneratedCrudTable,
  change: Change,
  recordId: string,
): Promise<string[]> {
  const dot = rollup.collection.indexOf(".");
  const relation = dot > 0 ? undefined : set.entry.relations.find((candidate) => candidate.key === rollup.collection);
  if (relation && !childTable.columns.some((column) => column.name === relation.foreignKey)) return [];
  let stored: unknown;
  const parent = async (row: Readonly<Record<string, unknown>> | null | undefined) => {
    if (!row) return undefined;
    if (dot > 0) return storedExtensionSource(row)[tenantPathId(rollup.collection.slice(dot + 1)) ?? ""];
    if (Object.hasOwn(row, relation!.foreignKey)) return row[relation!.foreignKey];
    if (stored === undefined) {
      const found = recordId ? await sql<{ parent: string | null }>`select ${sql.ref(relation!.foreignKey)}::text as parent
        from ${sql.id(childTable.schema, childTable.table)} where tenant_id = ${tenantId}::uuid and id = ${recordId}::uuid`.execute(trx) : undefined;
      stored = found?.rows[0]?.parent ?? null;
    }
    return stored;
  };
  return [...new Set([await parent(change.before), await parent(change.after)].filter((id): id is string => typeof id === "string"))].sort();
}

type StepMembers = { step: RollupStep; from: RawBuilder<unknown>; parent: RawBuilder<unknown>; target: RawBuilder<unknown> };

/** The children of a rollup that follows a step, as SQL, each with its parent and the target its step names; undefined for a rollup without a step. */
async function stepMembers(sets: Sets, set: ExtensionFieldSet, rollup: StoredRollup): Promise<StepMembers | undefined> {
  const via = rollup.of ? rollupPath(rollup.of)?.via : undefined;
  const child = via === undefined ? undefined : rollupChild(set, rollup);
  const table = child ? tableOf(child) : undefined;
  const step = child && table ? storedStep(child, await sets(child), via!) : undefined;
  if (!table || !step) return undefined;
  const indexed = (alias: string, fieldId: string) => sql`join ${qualifiedTable(extensionRegistry.entity(child!)!.valuesTable)} as ${sql.id(alias)}
    on ${sql.id(alias, "tenant_id")} = child.tenant_id and ${sql.id(alias, "record_id")} = child.id
      and ${sql.id(alias, "field_id")} = ${fieldId}::uuid and ${sql.id(alias, "ordinal")} = 0`;
  const dot = rollup.collection.indexOf(".");
  const relation = dot > 0 ? undefined : set.entry.relations.find((candidate) => candidate.key === rollup.collection);
  const link = relation ? sql`` : indexed("link", tenantPathId(rollup.collection.slice(dot + 1))!);
  const hop = step.relation ? sql`` : indexed("hop", step.reference!.fieldId);
  return {
    step,
    from: sql`from ${sql.id(table.schema, table.table)} as child ${link} ${hop}`,
    parent: relation ? sql`child.${sql.id(relation.foreignKey)}` : sql`link.value_ref_id`,
    target: step.relation ? sql`child.${sql.id(step.relation.foreignKey)}` : sql`hop.value_ref_id`,
  };
}

/** The records whose rollup reads `targetId` through the step of its `of`: the parents of the children that name it, in id order. */
async function parentsThroughStep(trx: Transaction<DB>, tenantId: string, sets: Sets, set: ExtensionFieldSet, rollup: StoredRollup, targetId: string, after?: string, limit?: number): Promise<string[]> {
  const members = await stepMembers(sets, set, rollup);
  if (!members) return [];
  const rows = await sql<{ id: string }>`select distinct ${members.parent}::text as id ${members.from}
    where child.tenant_id = ${tenantId}::uuid and ${members.target} = ${targetId}::uuid and ${members.parent} is not null
      ${after ? sql`and ${members.parent} > ${after}::uuid` : sql``} order by 1 ${limit ? sql`limit ${limit}` : sql``}`.execute(trx);
  return rows.rows.map((row) => row.id);
}

/**
 * Recompute lookups and rollups of one stored record (and the formulas over
 * them), through the one internal write. The cause is another record, so a
 * published head stays published (rewriteExtensionValues): whoever renames a
 * supplier unpublishes no product.
 */
export async function recomputeLinkedRecord(
  trx: Transaction<DB>,
  session: DbSessionInput,
  input: { table: GeneratedCrudTable; set: ExtensionFieldSet; recordId: string; fields: readonly ExtensionField[] },
): Promise<boolean> {
  return recomputeRecordFormulas(trx, session, { ...input, draft: false, fields: [...input.fields, ...formulaGraph(input.set).affectedBy(
    input.fields.map((field) => ({ entity: input.set.entity, field: field.fieldId })))] });
}

// ---------------------------------------------------------------------------
// The recompute journal.

/** Whether a job still works on this journal row: one waiting or running. */
async function liveRecomputeJob(trx: Transaction<DB>, tenantId: string, id: string): Promise<boolean> {
  const found = await sql<{ live: boolean }>`select exists (select 1 from platform.jobs
    where tenant_id = ${tenantId}::uuid and subject_entity = ${RECOMPUTE_SUBJECT} and subject_id = ${id}::uuid
      and status in ('queued', 'running')) as live`.execute(trx);
  return found.rows[0]?.live === true;
}

/**
 * One journal row per (field, target record): a second write of the target
 * before the worker ran raises its generation and enqueues nothing new, as
 * long as a job still works on the row. The row remembers who asked last, so
 * a job that died can be replaced under that session.
 */
export async function journalRecompute(
  trx: Transaction<DB>,
  session: DbSessionInput,
  input: { entity: string; field: ExtensionField; targetEntity: string; targetId: string },
): Promise<void> {
  const actorSession = jobActorSession(session);
  const row = await sql<{ id: string; generation: number; inserted: boolean }>`
    insert into platform.extension_field_recomputes (tenant_id, entity, field_id, target_entity, target_id, actor_id, actor_session)
    values (${session.tenantId}::uuid, ${input.entity}, ${input.field.fieldId}::uuid, ${input.targetEntity}, ${input.targetId}::uuid,
      ${session.userId}::uuid, ${jsonbLiteral(actorSession)})
    on conflict (tenant_id, field_id, target_id) do update
      set generation = extension_field_recomputes.generation + 1, requested_at = now(),
        actor_id = excluded.actor_id, actor_session = excluded.actor_session
    returning id::text as id, generation, (xmax = 0) as inserted`.execute(trx);
  const journal = row.rows[0]!;
  if (journal.inserted) await enqueueRecompute(trx, session.tenantId!, session.userId!, actorSession, journal.id, "start");
  else if (!await liveRecomputeJob(trx, session.tenantId!, journal.id)) {
    await enqueueRecompute(trx, session.tenantId!, session.userId!, actorSession, journal.id, `revive:${randomUUID()}`);
  }
}

async function enqueueRecompute(trx: Transaction<DB>, tenantId: string, actorId: string, actorSession: JobActorSession, id: string, step: string): Promise<void> {
  await enqueueJob(trx, {
    tenantId, actorId, actorSession, kind: EXTENSION_RECOMPUTE_KIND, payload: { recomputeId: id },
    deliveryKey: `${id}:${step}`, availableAt: new Date(Date.now() + RECOMPUTE_DEBOUNCE_MS),
    subject: { entity: RECOMPUTE_SUBJECT, id },
  });
}

type JournalRow = { id: string; entity: string; field_id: string; target_entity: string; target_id: string; generation: number; pass_generation: number | null; cursor: string | null };

/**
 * One batch of one journal row, recomputed through the one internal write (so
 * formulas over the lookup, further fields along the chain and the record's
 * realtime `updated` event follow). A lookup's row walks the referring records
 * after its cursor, or, when the target is gone, the records its foreign key
 * left without a reference; a rollup's row is one record, the parent it names,
 * or, when it names the target of the rollup's step, the parents that reach
 * that target; a reference field's row unlinks what still points at a deleted
 * target.
 *
 * A pass always runs to its end, whatever is written meanwhile, so a target
 * written more often than a batch takes cannot starve the records at the back.
 * A write during a pass raises the generation; the pass ends, and a new one
 * starts on the latest generation. The row goes once a pass that started on
 * the latest generation has ended.
 *
 * A writer holds a record and then comes for this row, so a batch takes them in
 * that order too: the records first, the row last (settled), holding it no longer
 * than its own commit. A write that raises the generation meanwhile is seen there,
 * and a row of one record is then computed once more. Batches of one row take
 * turns under an advisory lock, which no writer asks for.
 */
export async function runRecomputeBatch(
  trx: Transaction<DB>,
  session: DbSessionInput,
  recomputeId: string,
  batchSize = RECOMPUTE_BATCH_SIZE,
): Promise<{ done: boolean; processed: number; step?: string }> {
  const tenantId = session.tenantId!;
  await sql`select pg_advisory_xact_lock(hashtextextended(${`osf-extensions-recompute:${recomputeId}`}, 0))`.execute(trx);
  const found = await sql<JournalRow>`select id::text as id, entity, field_id::text as field_id, target_entity, target_id::text as target_id,
      generation, pass_generation, cursor from platform.extension_field_recomputes
    where tenant_id = ${tenantId}::uuid and id = ${recomputeId}::uuid`.execute(trx);
  const row = found.rows[0];
  if (!row) return { done: true, processed: 0 };
  const entry = extensionRegistry.entity(row.entity);
  const table = tableOf(row.entity);
  const remove = () => sql`delete from platform.extension_field_recomputes where tenant_id = ${tenantId}::uuid and id = ${row.id}::uuid`.execute(trx);
  /** The row's generation now, under its lock for the rest of the batch; undefined when a rebuild settled it meanwhile. */
  const settled = async () => (await sql<{ generation: number }>`select generation from platform.extension_field_recomputes
    where tenant_id = ${tenantId}::uuid and id = ${row.id}::uuid for update`.execute(trx)).rows[0]?.generation;
  if (!entry || !table) { await remove(); return { done: true, processed: 0 }; }
  const set = await loadExtensionFieldsFor(trx, session, row.entity, entry, { lock: "shared" });
  const field = set.byId.get(row.field_id);
  const computed = field ? computedLinked(set).includes(field) : false;
  const lookup = field && computed ? storedLookup(field.definition) : undefined;
  const reference = field?.kind === "stored" && extensionShape(set.entry, field.definition).reference !== undefined;
  if (!field || (!computed && !reference)) { await remove(); return { done: true, processed: 0 }; }
  const sets = setLoader(trx, session, set);
  const rollup = computed ? storedRollup(field.definition) : undefined;
  const members = rollup ? await stepMembers(sets, set, rollup) : undefined;
  const walk = members?.step.target === row.target_entity ? rollup : undefined;
  return acrossTenant(trx, session, `tenant field recompute ${row.id}`, async () => {
    if (!lookup && !reference && !walk) {
      await recomputeLinkedRecord(trx, session, { table, set, recordId: row.target_id, fields: [field] });
      const generation = await settled();
      if (generation !== undefined && generation !== row.generation) return { done: false, processed: 1, step: `${generation}:again` };
      await remove();
      return { done: true, processed: 1 };
    }
    // The pass this batch belongs to: the running one, or a new one on the latest generation.
    const pass = row.pass_generation ?? row.generation;
    const cursor = row.pass_generation === null ? undefined : row.cursor ?? undefined;
    let sources: string[];
    if (reference) {
      sources = await referringRecords(trx, tenantId, set, `${TENANT_PATH}${field.fieldId}`, row.target_id, undefined, batchSize);
      await unlinkReferences(trx, session, row.entity, set, field, sources, row.target_id);
    } else if (walk) {
      sources = await parentsThroughStep(trx, tenantId, sets, set, walk, row.target_id, cursor, batchSize);
      // A rollup over its own entity: a child's write may have left this row for the record itself.
      const own = row.target_entity === row.entity && cursor === undefined && !sources.includes(row.target_id) ? [row.target_id] : [];
      for (const source of [...own, ...sources]) await recomputeLinkedRecord(trx, session, { table, set, recordId: source, fields: [field] });
    } else {
      const targetTable = tableOf(row.target_entity);
      const gone = targetTable ? !(await sql`select 1 from ${sql.id(targetTable.schema, targetTable.table)}
        where tenant_id = ${tenantId}::uuid and id = ${row.target_id}::uuid`.execute(trx)).rows.length : false;
      sources = gone && !tenantPathId(lookup!.via) ? await orphanedRecords(trx, tenantId, set, lookup!.via, field.fieldId, cursor, batchSize)
        : await referringRecords(trx, tenantId, set, lookup!.via, row.target_id, cursor, batchSize);
      for (const source of sources) await recomputeLinkedRecord(trx, session, { table, set, recordId: source, fields: [field] });
    }
    const generation = await settled();
    if (generation === undefined) return { done: true, processed: sources.length };
    if (sources.length < batchSize) {
      if (pass === generation) {
        await remove();
        return { done: true, processed: sources.length };
      }
      await sql`update platform.extension_field_recomputes set pass_generation = null, cursor = null
        where tenant_id = ${tenantId}::uuid and id = ${row.id}::uuid`.execute(trx);
      return { done: false, processed: sources.length, step: `${generation}:restart` };
    }
    const next = sources.at(-1)!;
    await sql`update platform.extension_field_recomputes set pass_generation = ${pass}, cursor = ${next}
      where tenant_id = ${tenantId}::uuid and id = ${row.id}::uuid`.execute(trx);
    return { done: false, processed: sources.length, step: `${pass}:${next}` };
  });
}

/** The tenant session of a queued job, as the enqueuing request held it. */
async function replayedSession(context: { job: { id: string; tenantId: string; actorId: string }; db: Transaction<DB> }): Promise<{ session: DbSessionInput; actorSession: JobActorSession }> {
  const job = await sql<{ actor_session: unknown }>`select actor_session from platform.jobs
    where tenant_id = ${context.job.tenantId}::uuid and id = ${context.job.id}::uuid`.execute(context.db);
  const actorSession = actorSessionOf(job.rows[0]?.actor_session as JobActorSession);
  return { actorSession, session: jobSession(context.job.tenantId, context.job.actorId, actorSession) };
}

const retryOutcome = (error: unknown, code: string, message: string): RuntimeJobOutcome => ({
  outcome: "retry",
  // A database message may quote values of records, so only its code is kept.
  error: { code: sqlstateOf(error) ?? code, message },
});

/** The `extensions.recompute` job: one batch per run, the next run enqueued with it. A failed batch leaves nothing behind and runs again. */
export const extensionRecomputeJobHandler: ModuleJobHandler = async (payload, context) => {
  const recomputeId = typeof payload.recomputeId === "string" ? payload.recomputeId : undefined;
  if (!recomputeId) return { outcome: "failed", error: { code: "INVALID_PAYLOAD", message: "A recompute job names its journal row." } };
  const { session, actorSession } = await replayedSession(context);
  await sql`savepoint extension_recompute_batch`.execute(context.db);
  try {
    const result = await runRecomputeBatch(context.db, session, recomputeId);
    if (!result.done) await enqueueRecompute(context.db, context.job.tenantId, context.job.actorId, actorSession, recomputeId, result.step!);
    await sql`release savepoint extension_recompute_batch`.execute(context.db);
    return { outcome: "done", result: { processed: result.processed } };
  } catch (error) {
    await sql`rollback to savepoint extension_recompute_batch`.execute(context.db);
    return retryOutcome(error, "RECOMPUTE_FAILED", "A batch of the recompute journal failed; it runs again.");
  }
};

/**
 * The journal never gives up on a row: one without a waiting or running job
 * (its job ran out of attempts) gets a new one, under the session of the write
 * that last asked for it. Runs in the worker's session, across tenants, on the
 * worker's maintenance tick; a batch at a time, so a backlog cannot hold it.
 */
export async function sweepExtensionRecomputes(trx: Transaction<DB>, limit = RECOMPUTE_SWEEP_LIMIT): Promise<number> {
  const orphans = await sql<{ id: string; tenant_id: string; actor_id: string; actor_session: unknown }>`
    select r.id::text as id, r.tenant_id::text as tenant_id, r.actor_id::text as actor_id, r.actor_session
    from platform.extension_field_recomputes r
    where not exists (select 1 from platform.jobs j where j.tenant_id = r.tenant_id
      and j.subject_entity = ${RECOMPUTE_SUBJECT} and j.subject_id = r.id and j.status in ('queued', 'running'))
    order by r.requested_at, r.id limit ${limit}`.execute(trx);
  for (const row of orphans.rows) {
    await enqueueRecompute(trx, row.tenant_id, row.actor_id, actorSessionOf(row.actor_session as JobActorSession), row.id, `sweep:${randomUUID()}`);
  }
  return orphans.rows.length;
}

// ---------------------------------------------------------------------------
// Staleness, as a reader sees it.

const staleness = new WeakMap<object, Map<string, Map<string, Set<string>>>>();

/**
 * One step per page: the open journal rows of the records of `rows`. A lookup
 * whose target has an open row is stale (or whose reference still has to be
 * unlinked), a rollup whose own record has one too, or that reaches a target
 * with one through its step, and so is every formula over either. Only rows of
 * the page's targets are read: a journal with many open rows costs a page
 * nothing. Open rows on a step's target take one query more, per such rollup.
 */
export async function proveExtensionStaleness(
  trx: Transaction<DB>,
  session: DbSessionInput,
  set: ExtensionFieldSet | undefined,
  rows: readonly Readonly<Record<string, unknown>>[],
): Promise<void> {
  if (!set || !rows.length || !session.tenantId) return;
  const computed = computedLinked(set);
  if (!computed.length) return;
  /** The journal keys that make a field of a row stale, per field. */
  const keysOf = (row: Readonly<Record<string, unknown>>, field: ExtensionField): string[] => {
    const lookup = field.kind === "lookup" ? storedLookup(field.definition) : undefined;
    if (!lookup) return [`${field.fieldId}:${String(row.id)}`];
    const via = tenantPathId(lookup.via);
    const relation = via ? undefined : set.entry.relations.find((candidate) => candidate.key === lookup.via);
    const target = via ? storedExtensionSource(row)[via] : relation ? row[relation.foreignKey] : undefined;
    return typeof target !== "string" ? [] : [`${field.fieldId}:${target}`, ...(via ? [`${via}:${target}`] : [])];
  };
  const targets = [...new Set(rows.flatMap((row) => computed.flatMap((field) => keysOf(row, field).map((key) => key.slice(key.indexOf(":") + 1)))))];
  if (!targets.length) return;
  const open = await sql<{ field_id: string; target_id: string }>`select field_id::text as field_id, target_id::text as target_id
    from platform.extension_field_recomputes
    where tenant_id = ${session.tenantId}::uuid and entity = ${set.entity} and target_id = any(${`{${targets.join(",")}}`}::uuid[])`.execute(trx);
  const pending = new Set(open.rows.map((row) => `${row.field_id}:${row.target_id}`));
  // A rollup whose step reaches a target with an open row.
  const stepped = computed.filter((field) => field.kind === "rollup" && rollupPath(storedRollup(field.definition)?.of ?? "")?.via !== undefined);
  const journaled = stepped.length ? await sql<{ field_id: string }>`select distinct field_id::text as field_id from platform.extension_field_recomputes
    where tenant_id = ${session.tenantId}::uuid and entity = ${set.entity} and field_id = any(${`{${stepped.map((field) => field.fieldId).join(",")}}`}::uuid[])`.execute(trx) : undefined;
  const sets = setLoader(trx, session, set);
  for (const field of stepped.filter((item) => journaled?.rows.some((row) => row.field_id === item.fieldId))) {
    const members = await stepMembers(sets, set, storedRollup(field.definition)!);
    if (!members) continue;
    const parents = await sql<{ id: string }>`select distinct ${members.parent}::text as id ${members.from}
      join platform.extension_field_recomputes journal on journal.tenant_id = child.tenant_id and journal.field_id = ${field.fieldId}::uuid and journal.target_id = ${members.target}
      where child.tenant_id = ${session.tenantId}::uuid and ${members.parent} = any(${`{${rows.map((row) => String(row.id)).join(",")}}`}::uuid[])`.execute(trx);
    for (const parent of parents.rows) pending.add(`${field.fieldId}:${parent.id}`);
  }
  if (!pending.size) return;
  const scope = currentDbSessionTransaction() ?? trx;
  const byEntity = staleness.get(scope) ?? new Map<string, Map<string, Set<string>>>();
  staleness.set(scope, byEntity);
  const records = byEntity.get(set.entity) ?? new Map<string, Set<string>>();
  byEntity.set(set.entity, records);
  for (const row of rows) {
    const stale = computed.filter((field) => keysOf(row, field).some((key) => pending.has(key)));
    if (!stale.length) continue;
    const ids = new Set(stale.map((field) => field.fieldId));
    for (const reader of formulaGraph(set).affectedBy(stale.map((field) => ({ entity: set.entity, field: field.fieldId })))) ids.add(reader.fieldId);
    records.set(String(row.id), ids);
  }
}

/** The fields of one record this transaction proved stale (proveExtensionStaleness). */
export function staleExtensionFields(entity: string, recordId: unknown): ReadonlySet<string> | undefined {
  const scope = currentDbSessionTransaction();
  return scope ? staleness.get(scope)?.get(entity)?.get(String(recordId)) : undefined;
}

// ---------------------------------------------------------------------------
// Revalidation.

/** Put one field in `suspended`: the reason in a failed backfill entry and on the definition, an event for whoever follows the definitions. */
async function suspendField(trx: Transaction<DB>, tenantId: string, entity: string, field: Pick<ExtensionField, "rowId" | "fieldId" | "key" | "kind" | "version">, code: string, reason: string): Promise<void> {
  await sql`update platform.extension_field_definitions set state = 'suspended', suspended_reason = ${code}
    where tenant_id = ${tenantId}::uuid and id = ${field.rowId}::uuid and state in ('ready', 'updating')`.execute(trx);
  await sql`insert into platform.extension_field_backfills
      (tenant_id, id, entity, field_id, definition_version, operation, state, processed, total, cursor, error, created_at, updated_at)
    values (${tenantId}::uuid, gen_random_uuid(), ${entity}, ${field.fieldId}::uuid, ${field.version}, ${field.kind}, 'failed', 0, 0, null,
      ${jsonbLiteral({ code, message: `${field.key} is suspended: ${reason}` })}, clock_timestamp(), clock_timestamp())`.execute(trx);
  forgetExtensionFields(trx, tenantId, entity);
  await announceFieldDefinitionChange(trx, tenantId, entity, field.fieldId, "updated");
}

/**
 * Prove every lookup and rollup of the session's tenant again, against the
 * registry this process runs and the tenant's authorization profiles now, and
 * every computed field against what it reads (sensitivityShortfall), and
 * follow what no longer holds down the whole graph. A field whose
 * proof no longer holds, or that no longer resolves, becomes `suspended` with
 * AUTHORIZATION_PROOF_LOST: readers get null with `extensionsMeta.suspended`
 * (read.ts), no filter or sort takes it, a snapshot freezes `{ unavailable }`,
 * and the stored value stays until its designer saves the field again. A
 * computed field that reads a suspended one, a formula as much as a lookup or
 * rollup on another entity, is suspended with it; it inherits a lost proof, and
 * any other reason keeps its last value. Repeated until nothing changes, so a
 * chain suspends link by link. Returns the suspended fields. `managed` stands in
 * for the tenant's policies where they are out of reach: the worker holds no
 * grant on the authorization model, so its job is told what the trigger saw.
 */
export async function revalidateLinkedFields(
  trx: Transaction<DB>,
  session: DbSessionInput,
  managed?: ReadonlySet<string>,
): Promise<Array<{ entity: string; key: string; reason: string }>> {
  const tenantId = session.tenantId!;
  const suspended: Array<{ entity: string; key: string; reason: string }> = [];
  managed ??= await managedEntities(trx, session);
  for (let round = 0; round < 16; round += 1) {
    let changed = false;
    for (const entity of extensionRegistry.entityNames()) {
      const entry = extensionRegistry.entity(entity)!;
      const set = await loadExtensionFieldsFor(trx, session, entity, entry);
      const sets = setLoader(trx, session, set);
      for (const field of set.fields) {
        if (field.kind === "stored" || (field.state !== "ready" && field.state !== "updating")) continue;
        let code = AUTHORIZATION_PROOF_LOST;
        let reason: string | undefined;
        if (field.kind === "formula") {
          const ast = storedFormula(field.definition)?.ast ?? { kind: "literal" as const, value: null };
          const reads = formulaDependencies(set, ast);
          const input = reads.flatMap((read) => read.via === null ? [set.byId.get(read.field)] : []).find((item) => item?.state === "suspended");
          if (input) {
            code = inheritedSuspension(input);
            reason = `${entity}.${input.key} is suspended.`;
          } else reason = sensitivityShortfall(field.definition, formulaInputs(set, ast));
        } else {
          try {
            const resolved = await resolveStored(sets, set, field);
            reason = proofOf(resolved, entity, managed!) ?? sensitivityShortfall(field.definition, linkedInputs(resolved, entity));
            const input = reason ? undefined : suspendedInput(resolved);
            if (input) {
              code = inheritedSuspension(input.field!);
              reason = `${input.label} is suspended.`;
            }
          } catch (error) {
            reason = (error as { operationError?: { message?: string } }).operationError?.message ?? (error instanceof Error ? error.message : String(error));
          }
        }
        if (!reason) continue;
        await lockExtensionFields(trx, tenantId, entity, "exclusive");
        await suspendField(trx, tenantId, entity, field, code, reason);
        suspended.push({ entity, key: field.key, reason });
        changed = true;
      }
    }
    if (!changed) break;
  }
  return suspended;
}

/** After a write of the authorization profile model: revalidate the tenant's lookups and rollups in the same transaction. */
export async function revalidateAfterAuthorizationChange(trx: Transaction<DB>, session: DbSessionInput, table: GeneratedCrudTable): Promise<void> {
  const entity = table.source?.authoringEntityName;
  if (!entity || !AUTHORIZATION_MODEL.includes(entity) || !session.tenantId || !extensionRegistry.entityNames().length) return;
  // Under the lock: a lookup saved concurrently is either seen here or sees this change.
  await lockExtensionGraph(trx, session.tenantId);
  const any = await sql<{ found: boolean }>`select exists (select 1 from platform.extension_field_definitions
    where tenant_id = ${session.tenantId}::uuid and is_current and kind in ('lookup', 'rollup') and state in ('ready', 'updating')) as found`.execute(trx);
  if (!any.rows[0]?.found) return;
  await revalidateLinkedFields(trx, session);
}

/**
 * The `extensions.revalidate` job: what the database trigger on the
 * authorization profile model places (db/migrations/authorization-profiles.ts),
 * so that a custom Operation or direct SQL reaches the proof as a generic write
 * does, and what a failed backfill places so that readers of the field follow it.
 * The payload names the entities the tenant's profiles managed as the writer saw
 * them. A later change has a job of its own, and a job only ever suspends.
 */
export const extensionRevalidateJobHandler: ModuleJobHandler = async (payload, context) => {
  const { session } = await replayedSession(context);
  const managed = Array.isArray(payload.managed) ? payload.managed.filter((entity): entity is string => typeof entity === "string") : [];
  await sql`savepoint extension_revalidate`.execute(context.db);
  try {
    await lockExtensionGraph(context.db, context.job.tenantId);
    const suspended = await revalidateLinkedFields(context.db, session, withBases(managed));
    await sql`release savepoint extension_revalidate`.execute(context.db);
    return { outcome: "done", result: { suspended: suspended.length } };
  } catch (error) {
    await sql`rollback to savepoint extension_revalidate`.execute(context.db);
    return retryOutcome(error, "REVALIDATION_FAILED", "Proving the tenant's lookups and rollups again failed; it runs again.");
  }
};

/** Place one revalidation of the session's tenant, after a change that may have suspended something. */
export async function enqueueRevalidation(trx: Transaction<DB>, session: DbSessionInput, key: string): Promise<void> {
  await enqueueJob(trx, { tenantId: session.tenantId!, actorId: session.userId!, actorSession: jobActorSession(session),
    kind: EXTENSION_REVALIDATE_KIND, payload: {}, deliveryKey: key });
}

/**
 * Fail closed, for a tenant whose revalidation failed: every lookup and rollup
 * it holds, and whatever reads them, suspended as if its proof were lost. Plain
 * SQL over the definitions and the graph: whatever failed cannot have been
 * needed here. Returns the suspended fields.
 */
async function suspendLinkedFieldsOfTenant(trx: Transaction<DB>, tenantId: string, message: string): Promise<Array<{ entity: string; key: string; reason: string }>> {
  const rows = await sql<{ row_id: string; entity: string; field_id: string; key: string; kind: ExtensionField["kind"]; version: number }>`
    with recursive reach as (
      select d.field_id, d.entity, d.id, d.key, d.kind, d.version, d.state from platform.extension_field_definitions d
      where d.tenant_id = ${tenantId}::uuid and d.is_current and d.kind in ('lookup', 'rollup') and d.state in ('ready', 'updating', 'suspended')
      union
      select reader.field_id, reader.entity, reader.id, reader.key, reader.kind, reader.version, reader.state
      from reach
      join platform.extension_field_dependencies edge on edge.tenant_id = ${tenantId}::uuid
        and edge.depends_on_entity = reach.entity and edge.depends_on_field = reach.field_id::text
      join platform.extension_field_definitions reader on reader.tenant_id = edge.tenant_id and reader.field_id = edge.field_id and reader.is_current
    )
    select id::text as row_id, entity, field_id::text as field_id, key, kind, version from reach
    where state in ('ready', 'updating') order by 1`.execute(trx);
  const suspended: Array<{ entity: string; key: string; reason: string }> = [];
  for (const row of rows.rows) {
    await suspendField(trx, tenantId, row.entity, { rowId: row.row_id, fieldId: row.field_id, key: row.key, kind: row.kind, version: row.version },
      AUTHORIZATION_PROOF_LOST, message);
    suspended.push({ entity: row.entity, key: row.key, reason: message });
  }
  return suspended;
}

export type LinkedRevalidationReport = {
  /** The fields this run suspended, a failed tenant's included. */
  suspended: number;
  /** The tenants whose revalidation failed: their lookups and rollups are suspended, fail closed. */
  failedTenants: string[];
};

/**
 * The migration's step: every tenant holding a lookup or rollup, proven
 * again against the manifest this migration installed, each within a failure
 * boundary of its own: a tenant that cannot be proven is suspended, fail closed,
 * and the chain goes on. One tenant never holds up a deployment (the report says
 * which failed). Runs on the migration connection, which names each tenant in
 * every statement.
 */
export async function revalidateLinkedFieldsOfEveryTenant(
  run: <T>(tenantId: string, work: (trx: Transaction<DB>) => Promise<T>) => Promise<T>,
  tenants: readonly string[],
  log: (fields: Record<string, unknown>, message: string) => void = () => undefined,
): Promise<LinkedRevalidationReport> {
  const report: LinkedRevalidationReport = { suspended: 0, failedTenants: [] };
  for (const tenantId of tenants) {
    try {
      report.suspended += (await run(tenantId, (trx) => revalidateLinkedFields(trx, { tenantId, userId: null, roles: [], scope: "tenant" }))).length;
    } catch (error) {
      report.failedTenants.push(tenantId);
      log({ tenantId, error: error instanceof Error ? error.message : String(error) }, "Revalidating the tenant's lookups and rollups failed; they are suspended.");
      try {
        report.suspended += (await run(tenantId, (trx) => suspendLinkedFieldsOfTenant(trx, tenantId,
          "the migration could not prove it again, so it is suspended until it is saved again."))).length;
      } catch (failure) {
        log({ tenantId, error: failure instanceof Error ? failure.message : String(failure) }, "Suspending the tenant's lookups and rollups failed as well.");
      }
    }
  }
  return report;
}

/** Whether a definition kind is one of this module's. */
export function isLinkedKind(kind: unknown): kind is "lookup" | "rollup" {
  return kind === "lookup" || kind === "rollup";
}

type PendingLookup = { set: ExtensionFieldSet; field: ExtensionField; records: string[]; journal?: { targetEntity: string; targetId: string } };

/**
 * Before a record is deleted: the records whose lookup follows an authored
 * relation to it, up to the write's budget. Its foreign key decides what
 * happens to them (it refuses the delete, or sets the reference null, or
 * deletes them too); whichever it is, afterDeleteOfLinkedTarget recomputes
 * those that remain. A lookup with more of them than the budget allows is left
 * to the journal, which finds them by the empty reference.
 */
export async function beforeDeleteOfLinkedTarget(
  trx: Transaction<DB>,
  session: DbSessionInput,
  table: GeneratedCrudTable,
  id: string,
): Promise<PendingLookup[]> {
  const entity = baseTableOf(table).source?.authoringEntityName;
  if (!entity || !session.tenantId || !extensionRegistry.entityNames().some((name) => extensionRegistry.entity(name)!.relations
    .some((relation) => relation.kind === "belongsTo" && relation.entity === entity))) return [];
  const tenantId = session.tenantId;
  const rows = await sql<{ field_id: string; entity: string; via_field: string }>`
    select distinct d.field_id::text as field_id, f.entity, d.via_field from platform.extension_field_dependencies d
    join platform.extension_field_definitions f on f.tenant_id = d.tenant_id and f.field_id = d.field_id and f.is_current
      and f.state in ('ready', 'updating') and f.kind = 'lookup'
    where d.tenant_id = ${tenantId}::uuid and d.depends_on_entity = ${entity} and d.via_field is not null
      and d.via_field not like 'extensions.%' order by 1`.execute(trx);
  if (!rows.rows.length) return [];
  const budget = writeBudget(trx);
  return acrossTenant(trx, session, `find what looks up ${entity} ${id}`, async () => {
    const pending: PendingLookup[] = [];
    for (const row of rows.rows) {
      const set = await loadExtensionFieldsFor(trx, session, row.entity, extensionRegistry.entity(row.entity)!, { lock: "shared" });
      const field = set.byId.get(row.field_id);
      if (!field) continue;
      const records = await referringRecords(trx, tenantId, set, row.via_field, id, undefined, set.entry.limits.syncFanOut + 1);
      if (!withinBudget(budget, set, records)) pending.push({ set, field, records: [], journal: { targetEntity: entity, targetId: id } });
      else if (records.length) pending.push({ set, field, records });
    }
    return pending;
  });
}

export async function afterDeleteOfLinkedTarget(
  trx: Transaction<DB>,
  session: DbSessionInput,
  pending: readonly PendingLookup[],
): Promise<void> {
  if (!pending.length) return;
  await acrossTenant(trx, session, "recompute the lookups of a deleted record", async () => {
    for (const { set, field, records, journal } of pending) {
      const table = tableOf(set.entity);
      if (!table) continue;
      if (journal) await journalRecompute(trx, session, { entity: set.entity, field, ...journal });
      for (const recordId of records) await recomputeLinkedRecord(trx, session, { table, set, recordId, fields: [field] });
    }
  });
}
