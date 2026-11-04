// SPDX-License-Identifier: BUSL-1.1
/**
 * Lookups and rollups (`kind: "lookup"`, `kind: "rollup"`): tenant fields
 * whose value is read from other records — a lookup through a single
 * reference (a tenant reference field or an authored `belongsTo` relation),
 * a rollup as an aggregate over a collection (an authored inverse relation,
 * or the records of another extensible entity whose tenant reference names
 * this one).
 *
 * A computed value is materialized with the rights of whoever wrote the
 * record it was computed from, or of the worker — never with the reader's.
 * So a definition is accepted only when the compiled authorization contract
 * (`extensionRegistry.readAccess`) proves that its target is not authorized
 * more narrowly than its source: every role that may read the source may
 * read the target and the target field, the target's rows are narrowed by no
 * axis, the target field is not classified and has no read roles of its own
 * that leave a source reader out, and no authorization profile of the tenant
 * manages the target's reads. A chain is proven link by link, each when its
 * own definition is saved. The proof is repeated by every migration and by
 * every change of a tenant's authorization profiles; a definition whose
 * proof no longer holds is `suspended` — its values stay readable as the
 * last known ones, marked, and are no filter or sort key — until its
 * designer saves it again or removes it.
 *
 * Recomputation follows the dependency graph in
 * `platform.extension_field_dependencies` across entities: a write of a
 * record recomputes, in its own transaction, the lookups that read it on up
 * to `limits.syncFanOut` referring records, and the rollups of its old and
 * new parent. Beyond that limit the write leaves one row per (field, record)
 * in the recompute journal (`platform.extension_field_recomputes`), which
 * coalesces further writes of that record; the journal worker recomputes the
 * referring records in batches after a short debounce. Until it has, a
 * reader sees the last known value with `extensionsMeta.<key>.stale`, derived
 * from the open journal rows of its page in one query.
 */
import { sql, type Transaction } from "kysely";
import { operationFailure } from "@openshapeforge/operations";
import type { RuntimeExtensionReadAccess, RuntimeExtensionRelation } from "@openshapeforge/plugin-runtime";
import { MAX_RESULT_TEXT_LENGTH, ROUNDING_DECIMALS } from "@openshapeforge/formula";
import type { DB } from "../../../generated/db/types.js";
import { currentDbSessionTransaction, type DbSessionInput } from "../../../db/session.js";
import { entityTableName, entityColumnName } from "../../../db/manifest-lookup.js";
import { jsonbLiteral } from "../../../db/sql-helpers.js";
import { enqueueJob } from "../../../jobs/store.js";
import { actorSessionOf, type JobActorSession } from "../../../jobs/actor-session.js";
import type { ModuleJobHandler } from "../../../modules/contract.js";
import { getGeneratedCrudTables } from "../catalog.js";
import { fieldNameForColumn } from "../columns.js";
import type { GeneratedCrudTable } from "../types.js";
import { formulaColumns } from "./formula-columns.js";
import { authoredFormulaFields, fieldValues, formulaGraph, labelText, storedFormula, tenantFieldType, formulaDependencies } from "./formulas.js";
import {
  conditionPaths,
  EXTENSION_META_KEY,
  evaluateCondition,
  extensionError,
  extensionShape,
  isClassified,
  linkedResultType,
  mapConditionPaths,
  record,
  ROLLUP_AGGREGATES,
  SENSITIVITIES,
  storedLookup,
  storedRollup,
  type ComputedResultType,
  type ExtensionDefinition,
  type ExtensionField,
  type ExtensionFieldSet,
  type RollupAggregate,
} from "./model.js";
import { conditionValues, readValue, storedExtensionSource } from "./read.js";
import { extensionRegistry } from "./registry.js";
import { announceFieldDefinitionChange, forgetExtensionFields, loadExtensionFieldsFor, lockExtensionFields } from "./store.js";
import { formulaRowObject, qualifiedTable, recomputeRecordFormulas } from "./write.js";

export const EXTENSION_RECOMPUTE_KIND = "extensions.recompute";
/** How long the journal worker waits after a change before it recomputes, so a burst of writes is one pass. */
export const RECOMPUTE_DEBOUNCE_MS = 1_000;
export const RECOMPUTE_BATCH_SIZE = 200;
const TENANT_PATH = "extensions.";
/** A chain of recomputes deeper than this is a graph the save-time check should have refused. */
const MAX_PROPAGATION_DEPTH = 32;

export type LinkedDependency = { entity: string; field: string; via: string | null };

function tableOf(entity: string): GeneratedCrudTable | undefined {
  const tables = getGeneratedCrudTables().filter((table) => table.source?.authoringEntityName === entity && !table.subtype);
  return tables.length === 1 ? tables[0] : undefined;
}

/** The lookups and rollups the runtime computes: neither deprecated, suspended nor deleted. */
export function computedLinked(set: ExtensionFieldSet): ExtensionField[] {
  return set.fields.filter((field) => (field.kind === "lookup" || field.kind === "rollup") &&
    (field.state === "ready" || field.state === "updating") && linkedResultType(field) !== undefined);
}

const tenantPathId = (path: string): string | undefined => path.startsWith(TENANT_PATH) ? path.slice(TENANT_PATH.length) : undefined;

/** The entities whose reads an authorization profile of this tenant manages (docs/authorization-profiles.md). */
async function managedEntities(trx: Transaction<DB>, tenantId: string): Promise<Set<string>> {
  let table: string, entity: string, managed: string;
  try {
    table = entityTableName("AuthorizationOperationPolicy");
    entity = entityColumnName("AuthorizationOperationPolicy", "entityType");
    managed = entityColumnName("AuthorizationOperationPolicy", "managed");
  } catch {
    return new Set();
  }
  const rows = await sql<{ entity: string }>`select distinct ${sql.ref(entity)} as entity from ${qualifiedTable(table)}
    where tenant_id = ${tenantId}::uuid and ${sql.ref(managed)}`.execute(trx);
  return new Set(rows.rows.map((row) => row.entity));
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
  where?: unknown;
  whereFields: TargetField[];
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

async function resolveLookup(sets: Sets, set: ExtensionFieldSet, lookup: Record<string, unknown>, stored: boolean): Promise<ResolvedLookup> {
  const via = lookup.via;
  if (typeof via !== "string" || !via) extensionError("A lookup names its reference: lookup.via.");
  const tenant = tenantPathId(via as string);
  let resolvedVia: ResolvedLookup["via"];
  let target: string;
  if (tenant !== undefined) {
    const field = stored ? set.byId.get(tenant) : set.byKey.get(tenant);
    if (!field || field.state === "deleted") extensionError(`lookup.via: ${via} is not a field of ${set.entity}.`);
    if (field!.state === "deprecated") extensionError(`lookup.via: ${field!.key} is deprecated.`);
    const shape = extensionShape(set.entry, field!.definition);
    if (field!.kind !== "stored" || !shape.reference) extensionError(`lookup.via: ${field!.key} is not a reference field.`);
    if (shape.collection) extensionError(`lookup.via: ${field!.key} holds more than one reference; a lookup follows a single one.`);
    if (isClassified(field!.definition)) extensionError(`lookup.via: ${field!.key} is classified; what it points at would show through the lookup.`);
    resolvedVia = { path: `${TENANT_PATH}${field!.fieldId}`, label: field!.key, tenant: field! };
    target = shape.reference!.entity;
  } else {
    const relation = set.entry.relations.find((candidate) => candidate.key === via && candidate.kind === "belongsTo");
    if (!relation) extensionError(`lookup.via: ${via} is neither a tenant reference field (extensions.<key>) nor a single relation of ${set.entity}.`);
    resolvedVia = { path: relation!.key, label: relation!.key, relation: relation! };
    target = relation!.entity;
  }
  const field = await resolveField(sets, target, lookup.field, stored, "lookup.field");
  if (!SCALAR.has(field.type)) extensionError(`lookup.field: ${field.label} is a ${field.type} field; a lookup returns one text, number, boolean, date or timestamp.`);
  return { kind: "lookup", via: resolvedVia, target, field };
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
    link = fieldNameForColumn(column!);
    resolved = { path: relation!.key, label: relation!.key, relation: relation! };
  }
  const of = rollup.of === undefined || rollup.of === null ? undefined : await resolveField(sets, child, rollup.of, stored, "rollup.of");
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
  return { kind: "rollup", collection: resolved, child, link, aggregate: aggregate as RollupAggregate, ...(of ? { of } : {}), ...(where !== undefined ? { where } : {}), whereFields };
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
  if (!from || !to) return `${!from ? source : target} is outside the compiled authorization contract tenant fields may reach.`;
  if (!owned) {
    const missing = from.roles.filter((role) => !to.roles.includes(role));
    if (missing.length) {
      return `${target} is readable for ${to.roles.join(", ") || "no role"}, ${source} also for ${missing.join(", ")}; ` +
        `${missing.length === 1 ? "that role" : "those roles"} would see ${target} values ${missing.length === 1 ? "it" : "they"} may not read.`;
    }
    const classes = (access: RuntimeExtensionReadAccess) => access.principalClasses ?? ["person", "application", "service", "unknown"];
    const outside = classes(from).filter((kind) => !classes(to).includes(kind));
    if (outside.length) return `${target} is readable for fewer principal classes than ${source} (not for ${outside.join(", ")}).`;
  }
  if (to.rowPolicy) return `the rows of ${target} are narrowed by ${to.rowPolicy}, so a reader of ${source} would see values of ${target} records hidden from them.`;
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
  if (resolved.kind === "lookup") {
    if (resolved.field.field?.state === "suspended") return `${resolved.field.label} is suspended.`;
    return narrower(source, resolved.target, resolved.field, managed);
  }
  const owned = resolved.collection.relation?.ownership === "owned" && resolved.collection.relation.childAuthorization === "owner";
  for (const field of [resolved.of, ...resolved.whereFields]) {
    if (field?.field?.state === "suspended") return `${field.label} is suspended.`;
    const reason = narrower(source, resolved.child, field, managed, owned);
    if (reason) return reason;
  }
  return narrower(source, resolved.child, undefined, managed, owned);
}

function refuseProof(key: string, kind: string, reason: string): never {
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
  const reason = proofOf(resolved, set.entity, await managedEntities(trx, session.tenantId!));
  if (reason) refuseProof(input.key, input.kind, reason);
  const resultType = resultTypeOf(resolved);
  const storedSpec = resolved.kind === "lookup"
    ? { via: resolved.via.path, field: resolved.field.path, resultType }
    : { collection: resolved.collection.path, aggregate: resolved.aggregate, ...(resolved.of ? { of: resolved.of.path } : {}),
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

/** The rows of `platform.extension_field_dependencies` a resolved lookup or rollup keeps. */
function linkedDependencies(entity: string, resolved: ResolvedLookup | ResolvedRollup): LinkedDependency[] {
  if (resolved.kind === "lookup") {
    return [
      { entity, field: tenantPathId(resolved.via.path) ?? resolved.via.path, via: null },
      { entity: resolved.target, field: tenantPathId(resolved.field.path) ?? resolved.field.path, via: resolved.via.path },
    ];
  }
  const via = resolved.collection.path;
  return [resolved.link, ...[resolved.of, ...resolved.whereFields].flatMap((field) => field ? [field.path] : [])]
    .map((path) => ({ entity: resolved.child, field: tenantPathId(path) ?? path, via }));
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
  return {
    ...field.definition,
    rollup: { ...rollup, collection, ...(rollup.of ? { of: name(rollup.of) } : {}),
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
  for (const entity of extensionRegistry.entityNames()) {
    const set = await loadExtensionFieldsFor(trx, session, entity, extensionRegistry.entity(entity)!);
    for (const field of set.fields) {
      if (field.kind === "stored" || field.state === "deleted") continue;
      if (entity === changed.entity && field.fieldId === changed.fieldId) continue;
      const reads = field.kind === "formula"
        ? formulaDependencies(set, storedFormula(field.definition)?.ast ?? { kind: "literal", value: null })
        : await storedDependencies(trx, session, set, field);
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
async function storedDependencies(trx: Transaction<DB>, session: DbSessionInput, set: ExtensionFieldSet, field: ExtensionField): Promise<LinkedDependency[]> {
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
  const dot = rollup.collection.indexOf(".");
  const child = dot > 0 ? rollup.collection.slice(0, dot) : set.entry.relations.find((relation) => relation.key === rollup.collection)?.entity;
  if (!child) return [];
  const paths = [rollup.of, ...(rollup.where !== undefined ? conditionPaths(rollup.where).map((path) => path.kind === "authored" ? path.field : `${TENANT_PATH}${path.key}`) : [])];
  void trx; void session;
  return paths.flatMap((path) => path ? [{ entity: child, field: tenantPathId(path) ?? path, via: rollup.collection }] : []);
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
  if (type === "number") {
    const number = typeof value === "number" ? value : Number(value);
    return Number.isFinite(number) ? number : null;
  }
  return value;
}

function aggregateOf(aggregate: RollupAggregate, type: string, values: unknown[], members: number): LinkedResult {
  const present = values.map((value) => typed(type, value)).filter((value) => value !== null);
  switch (aggregate) {
    case "countAll": return { ok: true, value: members };
    case "count": return { ok: true, value: present.length };
    case "sum": return { ok: true, value: round((present as number[]).reduce((total, value) => total + value, 0)) };
    case "avg": return { ok: true, value: present.length ? round((present as number[]).reduce((total, value) => total + value, 0) / present.length) : null };
    case "min": case "max": {
      if (!present.length) return { ok: true, value: null };
      const sorted = [...present].sort((left, right) => typeof left === "number" ? (left as number) - (right as number)
        : Date.parse(String(left)) - Date.parse(String(right)) || String(left).localeCompare(String(right)));
      return { ok: true, value: aggregate === "min" ? sorted[0] : sorted.at(-1) };
    }
    case "arrayUnique": {
      const text = [...new Set(present.map(String))].sort((left, right) => left.localeCompare(right)).join(", ");
      return text.length > MAX_RESULT_TEXT_LENGTH ? { ok: false, error: "textTooLong" } : { ok: true, value: text || null };
    }
  }
}

/**
 * Compute `fields` (lookups and rollups of `set`) of one record into
 * `source` (mutated); a rollup reads its collection as committed and its
 * own. `row` is the record as stored or as it will be written (an authored
 * foreign key). In the record's own write (`share`) a lookup reads its
 * target under `for share`, so a concurrent write of the target waits for
 * this one and then finds this record through the index; a recompute from
 * the other side (fan-out, journal, backfill) needs no lock, since a later
 * write of the target recomputes it again.
 */
export async function computeLinkedValues(
  trx: Transaction<DB>,
  session: DbSessionInput,
  set: ExtensionFieldSet,
  row: Readonly<Record<string, unknown>>,
  source: Record<string, unknown>,
  fields: readonly ExtensionField[],
  share = false,
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
        where target.tenant_id = ${tenantId}::uuid and target.id = ${targetId}::uuid ${share ? sql`for share` : sql``}`.execute(trx);
      const target = found.rows[0]?.row;
      storeLinked(source, field.fieldId, { ok: true, value: target ? typed(resolved.field.type, valueOf(await sets(resolved.target), table, target, resolved.field.path)) : null });
      continue;
    }
    const childTable = tableOf(resolved.child);
    const recordId = row.id;
    if (!childTable || typeof recordId !== "string") { storeLinked(source, field.fieldId, aggregateOf(resolved.aggregate, "number", [], 0)); continue; }
    const members = resolved.collection.relation
      ? sql`child.${sql.id(resolved.collection.relation.foreignKey)} = ${recordId}::uuid`
      : sql`exists (select 1 from ${qualifiedTable(extensionRegistry.entity(resolved.child)!.valuesTable)} as link
          where link.tenant_id = child.tenant_id and link.record_id = child.id
            and link.field_id = ${resolved.collection.reference!.field.fieldId}::uuid and link.value_ref_id = ${recordId}::uuid)`;
    const children = await sql<{ row: Record<string, unknown> }>`select ${formulaRowObject(childTable, "child")} as row
      from ${sql.id(childTable.schema, childTable.table)} as child
      where child.tenant_id = ${tenantId}::uuid and ${members} order by child.id`.execute(trx);
    const childSet = await sets(resolved.child);
    const matching = children.rows.map((item) => item.row).filter((child) =>
      resolved.where === undefined || evaluateCondition(resolved.where, (path) => valueOf(childSet, childTable, child, path)));
    const values = resolved.of ? matching.map((child) => valueOf(childSet, childTable, child, resolved.of!.path)) : matching.map(() => 1);
    storeLinked(source, field.fieldId, aggregateOf(resolved.aggregate, resolved.of?.type ?? "number", values, matching.length));
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
// Fan-out: a write of one record recomputes the fields that read it elsewhere.

/**
 * The extensible entities whose lookups or rollups can read records of this
 * table's entity: those that reference it or relate to it, and those an
 * extensible entity's tenant reference may name (a rollup over it).
 */
export function linkedReadersOf(table: GeneratedCrudTable): string[] {
  const entity = table.source?.authoringEntityName;
  if (!entity || table.subtype || !extensionRegistry.readAccess(entity)) return [];
  const own = extensionRegistry.entity(entity);
  return extensionRegistry.entityNames().filter((name) => {
    const entry = extensionRegistry.entity(name)!;
    return entry.targets.some((target) => target.entity === entity) || entry.relations.some((relation) => relation.entity === entity) ||
      (own?.targets.some((target) => target.entity === name) ?? false);
  });
}

type Change = {
  before?: Readonly<Record<string, unknown>> | null;
  after?: Readonly<Record<string, unknown>> | null;
};

/** The fields of a write that changed: authored by name, tenant fields by id (`$meta` included for a computed one). */
function changedFields(table: GeneratedCrudTable, change: Change): Set<string> {
  const changed = new Set<string>();
  const before = change.before ?? {}, after = change.after ?? {};
  for (const column of table.columns) {
    if (column.name === "extension_values") continue;
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

/**
 * Carry a write of one record on to the lookups and rollups that read it:
 * called after every create, update and delete of an entity a tenant field
 * can reach (mutations.ts, collection-mutations.ts) and after every internal
 * write of tenant values (write.ts `rewriteExtensionValues`), so a recompute
 * carries on along the chain. A lookup is recomputed on its referring
 * records in this transaction while there are at most `limits.syncFanOut`,
 * else journaled; a rollup on the old and the new parent of the record.
 */
export async function propagateRecordChange(
  trx: Transaction<DB>,
  session: DbSessionInput,
  table: GeneratedCrudTable,
  change: Change,
): Promise<void> {
  const entity = table.source?.authoringEntityName;
  const tenantId = session.tenantId;
  if (!entity || !tenantId || table.subtype || !extensionRegistry.entityNames().length || !extensionRegistry.readAccess(entity)) return;
  const scope = currentDbSessionTransaction() ?? trx;
  const depth = depthOf.get(scope) ?? 0;
  if (depth > MAX_PROPAGATION_DEPTH) extensionError("Tenant field recomputation does not converge.", "INVALID_DEFINITION");
  const dependents = await sql<{ field_id: string; entity: string; depends_on_field: string; via_field: string }>`
    select distinct d.field_id::text as field_id, f.entity, d.depends_on_field, d.via_field
    from platform.extension_field_dependencies d
    join platform.extension_field_definitions f on f.tenant_id = d.tenant_id and f.field_id = d.field_id and f.is_current
      and f.state in ('ready', 'updating') and f.kind in ('lookup', 'rollup')
    where d.tenant_id = ${tenantId}::uuid and d.depends_on_entity = ${entity} and d.via_field is not null
    order by 1, 3`.execute(trx);
  if (!dependents.rows.length) return;
  const recordId = String((change.after ?? change.before)?.id ?? "");
  if (!recordId) return;
  const created = !change.before, deleted = !change.after;
  const changed = changedFields(table, change);
  const byField = new Map<string, { entity: string; reads: Set<string> }>();
  for (const row of dependents.rows) {
    const item = byField.get(row.field_id) ?? { entity: row.entity, reads: new Set<string>() };
    item.reads.add(row.depends_on_field);
    byField.set(row.field_id, item);
  }
  depthOf.set(scope, depth + 1);
  try {
    for (const [fieldId, dependent] of byField) {
      const set = await loadExtensionFieldsFor(trx, session, dependent.entity, extensionRegistry.entity(dependent.entity)!, { lock: "shared" });
      const field = set.byId.get(fieldId);
      if (!field || !computedLinked(set).includes(field)) continue;
      const sourceTable = tableOf(dependent.entity);
      if (!sourceTable) continue;
      const relevant = created || deleted || [...dependent.reads].some((read) => changed.has(read));
      if (!relevant) continue;
      if (field.kind === "lookup") {
        // A new record is referred to by none yet; a deleted one is the deletion guard's (references.ts) or its foreign key's.
        if (created || deleted) continue;
        const lookup = storedLookup(field.definition)!;
        const sources = await referringRecords(trx, tenantId, set, lookup.via, recordId);
        if (sources.length <= set.entry.limits.syncFanOut) {
          for (const source of sources) await recomputeLinkedRecord(trx, session, { table: sourceTable, set, recordId: source, fields: [field] });
        } else {
          await journalRecompute(trx, session, { entity: set.entity, field, targetEntity: entity, targetId: recordId });
        }
        continue;
      }
      const rollup = storedRollup(field.definition)!;
      for (const parent of await parentsOf(trx, tenantId, set, rollup, table, change, recordId)) {
        await recomputeLinkedRecord(trx, session, { table: sourceTable, set, recordId: parent, fields: [field] });
      }
    }
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
      const found = await sql<{ parent: string | null }>`select ${sql.ref(relation!.foreignKey)}::text as parent
        from ${sql.id(childTable.schema, childTable.table)} where tenant_id = ${tenantId}::uuid and id = ${recordId}::uuid`.execute(trx);
      stored = found.rows[0]?.parent ?? null;
    }
    return stored;
  };
  return [...new Set([await parent(change.before), await parent(change.after)].filter((id): id is string => typeof id === "string"))].sort();
}

/** Recompute lookups and rollups of one stored record (and the formulas over them), through the one internal write. */
export async function recomputeLinkedRecord(
  trx: Transaction<DB>,
  session: DbSessionInput,
  input: { table: GeneratedCrudTable; set: ExtensionFieldSet; recordId: string; fields: readonly ExtensionField[] },
): Promise<boolean> {
  return recomputeRecordFormulas(trx, session, { ...input, fields: [...input.fields, ...formulaGraph(input.set).affectedBy(
    input.fields.map((field) => ({ entity: input.set.entity, field: field.fieldId })))] });
}

// ---------------------------------------------------------------------------
// The recompute journal.

function actorSessionFrom(session: DbSessionInput): JobActorSession {
  return actorSessionOf({
    credential: "trusted-context", roles: [...session.roles ?? []], groups: [...session.groups ?? []],
    relationGroupIds: [...session.relationGroupIds ?? []], scope: session.scope ?? "tenant",
  });
}

/**
 * One journal row per (field, target record): a second write of the target
 * before the worker ran raises its generation and enqueues nothing new.
 */
async function journalRecompute(
  trx: Transaction<DB>,
  session: DbSessionInput,
  input: { entity: string; field: ExtensionField; targetEntity: string; targetId: string },
): Promise<void> {
  const row = await sql<{ id: string; generation: number; inserted: boolean }>`
    insert into platform.extension_field_recomputes (tenant_id, entity, field_id, target_entity, target_id)
    values (${session.tenantId}::uuid, ${input.entity}, ${input.field.fieldId}::uuid, ${input.targetEntity}, ${input.targetId}::uuid)
    on conflict (tenant_id, field_id, target_id) do update
      set generation = extension_field_recomputes.generation + 1, requested_at = now()
    returning id::text as id, generation, (xmax = 0) as inserted`.execute(trx);
  const journal = row.rows[0]!;
  if (journal.inserted) await enqueueRecompute(trx, session.tenantId!, session.userId!, actorSessionFrom(session), journal.id, "start");
}

async function enqueueRecompute(trx: Transaction<DB>, tenantId: string, actorId: string, actorSession: JobActorSession, id: string, step: string): Promise<void> {
  await enqueueJob(trx, {
    tenantId, actorId, actorSession, kind: EXTENSION_RECOMPUTE_KIND, payload: { recomputeId: id },
    deliveryKey: `${id}:${step}`, availableAt: new Date(Date.now() + RECOMPUTE_DEBOUNCE_MS),
    subject: { entity: "ExtensionFieldRecompute", id },
  });
}

type JournalRow = { id: string; entity: string; field_id: string; target_entity: string; target_id: string; generation: number; pass_generation: number | null; cursor: string | null };

/**
 * One batch of one journal row: the referring records after its cursor,
 * recomputed through the one internal write (so formulas over the lookup,
 * further fields along the chain and the record's realtime `updated` event
 * follow). A write of the target during a pass starts the pass over; the row
 * goes once a pass ends on its latest generation. The row is locked for the
 * batch, so a write of the target waits for it rather than slip between.
 */
export async function runRecomputeBatch(
  trx: Transaction<DB>,
  session: DbSessionInput,
  recomputeId: string,
  batchSize = RECOMPUTE_BATCH_SIZE,
): Promise<{ done: boolean; processed: number; step?: string }> {
  const tenantId = session.tenantId!;
  const found = await sql<JournalRow>`select id::text as id, entity, field_id::text as field_id, target_entity, target_id::text as target_id,
      generation, pass_generation, cursor from platform.extension_field_recomputes
    where tenant_id = ${tenantId}::uuid and id = ${recomputeId}::uuid for update`.execute(trx);
  const row = found.rows[0];
  if (!row) return { done: true, processed: 0 };
  const entry = extensionRegistry.entity(row.entity);
  const table = tableOf(row.entity);
  const remove = () => sql`delete from platform.extension_field_recomputes where tenant_id = ${tenantId}::uuid and id = ${row.id}::uuid`.execute(trx);
  if (!entry || !table) { await remove(); return { done: true, processed: 0 }; }
  const set = await loadExtensionFieldsFor(trx, session, row.entity, entry, { lock: "shared" });
  const field = set.byId.get(row.field_id);
  const lookup = field && computedLinked(set).includes(field) ? storedLookup(field.definition) : undefined;
  if (!field || !lookup) { await remove(); return { done: true, processed: 0 }; }
  const restart = row.pass_generation === null || row.generation !== row.pass_generation;
  const cursor = restart ? null : row.cursor;
  const sources = await referringRecords(trx, tenantId, set, lookup.via, row.target_id, cursor ?? undefined, batchSize);
  for (const source of sources) await recomputeLinkedRecord(trx, session, { table, set, recordId: source, fields: [field] });
  if (sources.length < batchSize) {
    await remove();
    return { done: true, processed: sources.length };
  }
  const next = sources.at(-1)!;
  await sql`update platform.extension_field_recomputes set pass_generation = ${row.generation}, cursor = ${next}
    where tenant_id = ${tenantId}::uuid and id = ${row.id}::uuid`.execute(trx);
  return { done: false, processed: sources.length, step: `${row.generation}:${next}` };
}

/** The `extensions.recompute` job: one batch per run, the next run enqueued with it. */
export const extensionRecomputeJobHandler: ModuleJobHandler = async (payload, context) => {
  const recomputeId = typeof payload.recomputeId === "string" ? payload.recomputeId : undefined;
  if (!recomputeId) return { outcome: "failed", error: { code: "INVALID_PAYLOAD", message: "A recompute job names its journal row." } };
  const job = await sql<{ actor_session: unknown }>`select actor_session from platform.jobs
    where tenant_id = ${context.job.tenantId}::uuid and id = ${context.job.id}::uuid`.execute(context.db);
  const actorSession = actorSessionOf(job.rows[0]?.actor_session as JobActorSession);
  const session: DbSessionInput = {
    tenantId: context.job.tenantId, userId: context.job.actorId,
    roles: actorSession.roles, groups: actorSession.groups, scope: actorSession.scope,
  };
  const result = await runRecomputeBatch(context.db, session, recomputeId);
  if (!result.done) await enqueueRecompute(context.db, context.job.tenantId, context.job.actorId, actorSession, recomputeId, result.step!);
  return { outcome: "done", result: { processed: result.processed } };
};

// ---------------------------------------------------------------------------
// Staleness, as a reader sees it.

const staleness = new WeakMap<object, Map<string, Map<string, Set<string>>>>();

/**
 * One step per page: the open journal rows of this entity, matched against
 * the references of `rows` (stored rows). A lookup whose target has an open
 * row is stale, and so is every formula over it.
 */
export async function proveExtensionStaleness(
  trx: Transaction<DB>,
  session: DbSessionInput,
  table: GeneratedCrudTable,
  set: ExtensionFieldSet | undefined,
  rows: readonly Readonly<Record<string, unknown>>[],
): Promise<void> {
  if (!set || !rows.length || !session.tenantId) return;
  const lookups = computedLinked(set).filter((field) => field.kind === "lookup");
  if (!lookups.length) return;
  const open = await sql<{ field_id: string; target_id: string }>`select field_id::text as field_id, target_id::text as target_id
    from platform.extension_field_recomputes where tenant_id = ${session.tenantId}::uuid and entity = ${set.entity}`.execute(trx);
  if (!open.rows.length) return;
  const pending = new Set(open.rows.map((row) => `${row.field_id}:${row.target_id}`));
  const scope = currentDbSessionTransaction() ?? trx;
  const byEntity = staleness.get(scope) ?? new Map<string, Map<string, Set<string>>>();
  staleness.set(scope, byEntity);
  const records = byEntity.get(set.entity) ?? new Map<string, Set<string>>();
  byEntity.set(set.entity, records);
  for (const row of rows) {
    const source = storedExtensionSource(row);
    const stale = lookups.filter((field) => {
      const lookup = storedLookup(field.definition)!;
      const via = tenantPathId(lookup.via);
      const relation = via ? undefined : set.entry.relations.find((candidate) => candidate.key === lookup.via);
      const target = via ? source[via] : relation ? row[relation.foreignKey] : undefined;
      return typeof target === "string" && pending.has(`${field.fieldId}:${target}`);
    });
    if (!stale.length) continue;
    const ids = new Set(stale.map((field) => field.fieldId));
    for (const reader of formulaGraph(set).affectedBy(stale.map((field) => ({ entity: set.entity, field: field.fieldId })))) ids.add(reader.fieldId);
    records.set(String(row.id), ids);
  }
  void table;
}

/** The fields of one record this transaction proved stale (proveExtensionStaleness). */
export function staleExtensionFields(entity: string, recordId: unknown): ReadonlySet<string> | undefined {
  const scope = currentDbSessionTransaction();
  return scope ? staleness.get(scope)?.get(entity)?.get(String(recordId)) : undefined;
}

// ---------------------------------------------------------------------------
// Revalidation.

/**
 * Prove every lookup and rollup of the session's tenant again, against the
 * registry this process runs and the tenant's authorization profiles now: a
 * definition whose proof no longer holds — or that no longer resolves, or
 * reads a field that is suspended — becomes `suspended` (its last values
 * stay, marked, and are no filter or sort key), with the reason in a failed
 * backfill entry, until its designer saves it again or deletes it. Repeated
 * until nothing changes, so a chain suspends link by link. Returns the
 * suspended fields.
 */
export async function revalidateLinkedFields(trx: Transaction<DB>, session: DbSessionInput): Promise<Array<{ entity: string; key: string; reason: string }>> {
  const tenantId = session.tenantId!;
  const suspended: Array<{ entity: string; key: string; reason: string }> = [];
  const managed = await managedEntities(trx, tenantId);
  for (let round = 0; round < 16; round += 1) {
    let changed = false;
    for (const entity of extensionRegistry.entityNames()) {
      const entry = extensionRegistry.entity(entity)!;
      const set = await loadExtensionFieldsFor(trx, session, entity, entry);
      const sets = setLoader(trx, session, set);
      for (const field of set.fields) {
        if ((field.kind !== "lookup" && field.kind !== "rollup") || (field.state !== "ready" && field.state !== "updating")) continue;
        let reason: string | undefined;
        try {
          reason = proofOf(await resolveStored(sets, set, field), entity, managed);
        } catch (error) {
          reason = (error as { operationError?: { message?: string } }).operationError?.message ?? (error instanceof Error ? error.message : String(error));
        }
        if (!reason) continue;
        await lockExtensionFields(trx, tenantId, entity, "exclusive");
        await sql`update platform.extension_field_definitions set state = 'suspended'
          where tenant_id = ${tenantId}::uuid and id = ${field.rowId}::uuid and state in ('ready', 'updating')`.execute(trx);
        await sql`insert into platform.extension_field_backfills
            (tenant_id, id, entity, field_id, definition_version, operation, state, processed, total, cursor, error, created_at, updated_at)
          values (${tenantId}::uuid, gen_random_uuid(), ${entity}, ${field.fieldId}::uuid, ${field.version}, ${field.kind}, 'failed', 0, 0, null,
            ${jsonbLiteral({ code: "AUTHORIZATION_PROOF_LOST", message: `${field.key} is suspended: ${reason}` })}, clock_timestamp(), clock_timestamp())`.execute(trx);
        forgetExtensionFields(trx, tenantId, entity);
        await announceFieldDefinitionChange(trx, tenantId, entity, field.fieldId, "updated");
        suspended.push({ entity, key: field.key, reason });
        changed = true;
      }
    }
    if (!changed) break;
  }
  return suspended;
}

/** The entities whose writes change what a lookup's proof reads: the authorization profile model. */
const AUTHORIZATION_MODEL = new Set([
  "AuthorizationOperationPolicy", "AuthorizationProfile", "AuthorizationProfileAssignment", "AuthorizationProfilePolicy", "AuthorizationProfileVersion",
]);

/** After a write of the authorization profile model: revalidate the tenant's lookups and rollups in the same transaction. */
export async function revalidateAfterAuthorizationChange(trx: Transaction<DB>, session: DbSessionInput, table: GeneratedCrudTable): Promise<void> {
  const entity = table.source?.authoringEntityName;
  if (!entity || !AUTHORIZATION_MODEL.has(entity) || !session.tenantId || !extensionRegistry.entityNames().length) return;
  const any = await sql<{ found: boolean }>`select exists (select 1 from platform.extension_field_definitions
    where tenant_id = ${session.tenantId}::uuid and is_current and kind in ('lookup', 'rollup') and state in ('ready', 'updating')) as found`.execute(trx);
  if (!any.rows[0]?.found) return;
  await lockExtensionGraph(trx, session.tenantId);
  await revalidateLinkedFields(trx, session);
}

/**
 * The migration's step: every tenant holding a lookup or rollup, proven
 * again against the manifest this migration installed. Runs on the
 * migration connection, which names each tenant in every statement.
 */
export async function revalidateLinkedFieldsOfEveryTenant(
  run: <T>(tenantId: string, work: (trx: Transaction<DB>) => Promise<T>) => Promise<T>,
  tenants: readonly string[],
): Promise<number> {
  let suspended = 0;
  for (const tenantId of tenants) {
    suspended += (await run(tenantId, (trx) => revalidateLinkedFields(trx, { tenantId, userId: null, roles: [], scope: "tenant" }))).length;
  }
  return suspended;
}

/** For tests and the reader: whether a definition kind is one of this module's. */
export function isLinkedKind(kind: unknown): kind is "lookup" | "rollup" {
  return kind === "lookup" || kind === "rollup";
}

/** Columns of an entity a lookup or rollup may read, for the worker's column grants (db/migrations/worker-role.ts). */
export function linkedReadableColumns(table: GeneratedCrudTable): string[] {
  return formulaColumns(table).map((column) => column.name);
}

/**
 * Before a record is deleted: the records whose lookup follows an authored
 * relation to it. Its foreign key decides what happens to them (it refuses
 * the delete, or sets the reference null, or deletes them too); whichever it
 * is, afterDeleteOfLinkedTarget recomputes those that remain.
 */
export async function beforeDeleteOfLinkedTarget(
  trx: Transaction<DB>,
  session: DbSessionInput,
  table: GeneratedCrudTable,
  id: string,
): Promise<Array<{ set: ExtensionFieldSet; field: ExtensionField; records: string[] }>> {
  const entity = table.source?.authoringEntityName;
  if (!entity || !session.tenantId || !extensionRegistry.entityNames().length || !extensionRegistry.readAccess(entity)) return [];
  const rows = await sql<{ field_id: string; entity: string; via_field: string }>`
    select distinct d.field_id::text as field_id, f.entity, d.via_field from platform.extension_field_dependencies d
    join platform.extension_field_definitions f on f.tenant_id = d.tenant_id and f.field_id = d.field_id and f.is_current
      and f.state in ('ready', 'updating') and f.kind = 'lookup'
    where d.tenant_id = ${session.tenantId}::uuid and d.depends_on_entity = ${entity} and d.via_field is not null
      and d.via_field not like 'extensions.%' order by 1`.execute(trx);
  const pending: Array<{ set: ExtensionFieldSet; field: ExtensionField; records: string[] }> = [];
  for (const row of rows.rows) {
    const set = await loadExtensionFieldsFor(trx, session, row.entity, extensionRegistry.entity(row.entity)!, { lock: "shared" });
    const field = set.byId.get(row.field_id);
    if (!field) continue;
    const records = await referringRecords(trx, session.tenantId, set, row.via_field, id);
    if (records.length) pending.push({ set, field, records });
  }
  return pending;
}

export async function afterDeleteOfLinkedTarget(
  trx: Transaction<DB>,
  session: DbSessionInput,
  pending: Awaited<ReturnType<typeof beforeDeleteOfLinkedTarget>>,
): Promise<void> {
  for (const { set, field, records } of pending) {
    const table = tableOf(set.entity);
    if (!table) continue;
    for (const recordId of records) await recomputeLinkedRecord(trx, session, { table, set, recordId, fields: [field] });
  }
}
