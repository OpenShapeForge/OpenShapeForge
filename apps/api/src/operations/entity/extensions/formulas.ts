// SPDX-License-Identifier: BUSL-1.1
/**
 * Formula fields (`kind: "formula"`) of an extensible entity, as pure
 * functions over a proven definition set: the fields a formula may name, the
 * save-time check, the dependency graph and the evaluation of one record.
 * The database side (owned children, write-back, backfill) lives in write.ts
 * and backfill.ts; the language itself is @openshapeforge/formula.
 *
 * A formula reads the fields of its own record — authored (`name`) and
 * tenant fields, formulas included — and those of an owned single child
 * under its relation (`spec.weight`). Owned children are authorized through
 * their owner, so nothing a formula reads is out of the writer's or the
 * reader's reach; a classified field is never in reach at all, because the
 * result would reveal it. The stored definition keeps
 * `formula: { text, ast, resultType }`: the AST names fields by id (a tenant
 * field's id, an authored field's name), so renaming a field never breaks a
 * formula, and the text a caller reads is printed again with today's labels.
 * The result type is fixed when the definition is saved and picks the typed
 * index column (`osfType` follows it), so a formula filters and sorts as any
 * stored field of that type.
 */
import {
  analyze,
  buildDependencyGraph,
  dependencies,
  dependencyNodes,
  evaluate,
  formatFormula,
  formulaTypeForBaseType,
  type DependencyNode,
  type FormulaAst,
  type FormulaDiagnostic,
  type FormulaEnvironment,
  type FormulaErrorCode,
  type FormulaField,
  type FormulaFieldRef,
  type FormulaRecord,
  type FormulaType,
} from "@openshapeforge/formula";
import { isDeepStrictEqual } from "node:util";
import { operationFailure } from "@openshapeforge/operations";
import type { RuntimeExtensibleEntity } from "@openshapeforge/plugin-runtime";
import { storedFieldBaseType } from "../../../modules/field-schemas.js";
import { getGeneratedCrudTables } from "../catalog.js";
import { fieldNameForColumn } from "../columns.js";
import type { GeneratedCrudTable } from "../types.js";
import { formulaColumns, outOfScopeFormulaColumns, readContractProperties } from "./formula-columns.js";
import {
  EXTENSION_META_KEY,
  evaluateCondition,
  extensionError,
  extensionShape,
  isClassified,
  isEntityOsfType,
  record,
  type ExtensionDefinition,
  type ExtensionField,
  type ExtensionFieldSet,
} from "./model.js";
import { conditionValues, readValue } from "./read.js";

/** The osfType a formula's result is stored as: the one whose index column its result type is. */
export const FORMULA_OSF_TYPES: Readonly<Record<FormulaType, string>> = {
  text: "string", number: "number", boolean: "boolean", date: "date", timestamp: "datetime",
};

export type StoredFormula = { text: string; ast: FormulaAst; resultType: FormulaType };

/** A dependency as `platform.extension_field_dependencies` keeps it. */
export type FormulaDependency = { entity: string; field: string; via: string | null };

export function storedFormula(definition: ExtensionDefinition): StoredFormula | undefined {
  const formula = definition.formula;
  return record(formula) && typeof formula.text === "string" && record(formula.ast) &&
    typeof formula.resultType === "string" && Object.hasOwn(FORMULA_OSF_TYPES, formula.resultType)
    ? formula as unknown as StoredFormula : undefined;
}

/** The formulas the runtime computes: current, and neither deprecated, suspended nor deleted. */
export function computedFormulas(set: ExtensionFieldSet): ExtensionField[] {
  return set.fields.filter((field) => field.kind === "formula" && (field.state === "ready" || field.state === "updating") &&
    storedFormula(field.definition) !== undefined);
}

const labelText = (label: unknown, fallback: string): string => {
  if (typeof label === "string" && label.trim()) return label;
  if (!record(label)) return fallback;
  const text = label.en ?? Object.values(label).find((value) => typeof value === "string" && value.trim());
  return typeof text === "string" && text.trim() ? text : fallback;
};

function entityTable(entity: string): GeneratedCrudTable | undefined {
  const tables = getGeneratedCrudTables().filter((table) => table.source?.authoringEntityName === entity && !table.subtype);
  return tables.length === 1 ? tables[0] : undefined;
}

function authoredType(name: string, osfType: string): string {
  if (isEntityOsfType(osfType)) return osfType;
  try {
    return formulaTypeForBaseType(storedFieldBaseType({ key: name, osfType })) ?? osfType;
  } catch {
    return osfType;
  }
}

const authoredCache = new Map<string, readonly FormulaField[]>();

/**
 * The authored fields of a table a formula may name: the columns of
 * formulaColumns (which the entity's read contract names, never a
 * reference), and — only to refuse them as `outOfScope`, with the reason —
 * the read-contract columns the platform changes outside the record's own
 * write (formula-columns.ts).
 */
function authoredFields(table: GeneratedCrudTable, scope: FormulaField["scope"], skip: ReadonlySet<string> = new Set()): readonly FormulaField[] {
  const cacheKey = `${table.name}:${scope === "self" ? "" : scope.relation}`;
  const cached = authoredCache.get(cacheKey);
  if (cached) return cached;
  const properties = readContractProperties(table.source?.authoringEntityName ?? "");
  const fields: FormulaField[] = [];
  const listed = [...formulaColumns(table).map((column) => ({ column, reason: undefined as string | undefined })), ...outOfScopeFormulaColumns(table)];
  for (const { column, reason } of listed) {
    const name = fieldNameForColumn(column);
    const property = properties[name];
    if (skip.has(column.name) || !record(property)) continue;
    const osfType = typeof property["x-osf-type"] === "string" ? property["x-osf-type"] : column.type;
    const i18n = record(property["x-osf-i18n"]) ? property["x-osf-i18n"].title : undefined;
    fields.push({
      id: name, key: name, label: labelText(i18n ?? property.title, name), type: authoredType(name, osfType), scope,
      ...(reason ? { outOfScope: reason } : {}),
    });
  }
  authoredCache.set(cacheKey, Object.freeze(fields));
  return authoredCache.get(cacheKey)!;
}

function tenantFieldType(entry: RuntimeExtensibleEntity, field: ExtensionField): string {
  const shape = extensionShape(entry, field.definition);
  const osfType = String(field.definition.osfType ?? field.kind);
  if (shape.reference || shape.collection || shape.baseType === "object") return osfType;
  return formulaTypeForBaseType(shape.baseType) ?? osfType;
}

const environments = new WeakMap<ExtensionFieldSet, FormulaEnvironment>();

/**
 * The fields in reach of a formula on this set's entity: the authored ones,
 * the current tenant fields (never a deprecated or deleted one), and the
 * authored fields of every owned single child under its relation.
 */
export function formulaEnvironment(set: ExtensionFieldSet): FormulaEnvironment {
  const cached = environments.get(set);
  if (cached) return cached;
  const own = entityTable(set.entity);
  const tenant = set.fields.filter((field) => field.state !== "deleted" && field.state !== "deprecated").map((field): FormulaField => {
    const base = { id: field.fieldId, key: field.key, label: labelText(field.definition.label, field.key), scope: "self" as const,
      ...(isClassified(field.definition) ? { classified: true } : {}) };
    const formula = field.kind === "formula" ? storedFormula(field.definition) : undefined;
    if (formula) return { ...base, type: formula.resultType, kind: "formula", dependencies: dependencies(formula.ast) };
    if (field.kind !== "stored") return { ...base, type: field.kind, kind: field.kind };
    return { ...base, type: tenantFieldType(set.entry, field) };
  });
  const children = set.entry.ownedSingleChildren.flatMap((child) => {
    const table = entityTable(child.entity);
    return table ? authoredFields(table, { relation: child.relation }, new Set([child.foreignKey])) : [];
  });
  const environment = Object.freeze([...(own ? authoredFields(own, "self") : []), ...tenant, ...children]);
  environments.set(set, environment);
  return environment;
}

/** The (entity, field) nodes a formula reads, an owned child's on the child entity. */
function nodesOf(set: ExtensionFieldSet, refs: readonly FormulaFieldRef[]): DependencyNode[] {
  return dependencyNodes(set.entity, refs, Object.fromEntries(set.entry.ownedSingleChildren.map((child) => [child.relation, child.entity])));
}

/** What a stored formula reads, as rows of `platform.extension_field_dependencies`. */
export function formulaDependencies(set: ExtensionFieldSet, ast: FormulaAst): FormulaDependency[] {
  const refs = dependencies(ast);
  return nodesOf(set, refs).map((node, index) => {
    const scope = refs[index]!.scope;
    return { entity: node.entity, field: node.field, via: scope === "self" ? null : scope.relation };
  });
}

/** A refusal: a save-time diagnostic, or the error code a formula without field references always yields. */
type FormulaRefusal = Omit<FormulaDiagnostic, "code"> & { code: FormulaDiagnostic["code"] | FormulaErrorCode };

function refuseFormula(key: string, errors: readonly FormulaRefusal[]): never {
  throw operationFailure({
    code: "VALIDATION",
    message: `The formula of ${key} cannot be saved: ${errors[0]!.message}.`,
    detail: errors.map((error) => error.message).join(". "),
    violations: errors.map((error) => ({ field: "definition.formula.text", code: error.code, message: error.message })),
    data: { errors: errors.map((error) => ({ code: error.code, message: error.message, start: error.start, end: error.end,
      ...(error.params ? { params: error.params } : {}) })) },
    retryable: false,
  });
}

/** The definition properties a formula field does not take: its value is computed, never entered. */
const NOT_ON_A_FORMULA = [
  "unique", "required", "defaultValue", "options", "cardinality", "onDelete", "validation", "retention", "unit",
] as const;

/** A formula that reads a changed one, typed again: its definition as it is stored from now on. */
export type RetypedReader = { field: ExtensionField; definition: ExtensionDefinition };

/**
 * Check a formula definition before it is saved and return it as stored:
 * the canonical text, the AST bound to field ids, the static result type and
 * `osfType` following it. Refused with every diagnostic (code, message,
 * span) in `data.errors`: syntax, unknown or ambiguous field, type conflict,
 * mixed branches, time functions, out of scope, classified field, a cycle
 * through any other formula of the entity, `limits.formulaDepth` exceeded by
 * this formula or by any formula that reads it (a deprecated one included),
 * a formula that reads it and no longer types with it in place, and a
 * formula without field references that gives every record an error code.
 * `readers` are the formulas that read this one, transitively, whose stored
 * AST or result type changes with it (retypedReaders).
 */
export function validateFormulaDefinition(
  set: ExtensionFieldSet,
  input: { fieldId: string; key: string; definition: ExtensionDefinition; appliesWhen?: unknown },
): { definition: ExtensionDefinition; dependsOn: FormulaDependency[]; readers: RetypedReader[] } {
  const definition = { ...input.definition };
  if (input.appliesWhen !== undefined && input.appliesWhen !== null) {
    extensionError("A formula field applies to every record; it takes no appliesWhen.");
  }
  for (const property of NOT_ON_A_FORMULA) {
    if (definition[property] !== undefined) extensionError(`A formula field takes no ${property}: its value is computed.`);
  }
  const formula = definition.formula;
  if (!record(formula) || typeof formula.text !== "string" || !formula.text.trim()) {
    extensionError("A formula field carries formula: { text }.");
  }
  const env = formulaEnvironment(set);
  const limit = set.entry.limits.formulaDepth;
  const analysis = analyze((formula as { text: string }).text, env, { fieldId: input.fieldId, formulaDepth: limit });
  if (analysis.errors.length || !analysis.ast || !analysis.resultType) {
    refuseFormula(input.key, analysis.errors.length ? analysis.errors
      : [{ code: "undeterminedType", message: "This formula has no type", start: 0, end: (formula as { text: string }).text.length }]);
  }
  assertFormulaSetValid(set, { fieldId: input.fieldId, key: input.key, label: labelText(definition.label, input.key), reads: analysis.dependencies }, limit);
  assertConstantComputes(input, analysis.ast!, analysis.resultType!, (formula as { text: string }).text);
  const text = formatFormula(analysis.ast!, env);
  return {
    definition: { ...definition, osfType: FORMULA_OSF_TYPES[analysis.resultType!], formula: { text, ast: analysis.ast!, resultType: analysis.resultType! } },
    dependsOn: formulaDependencies(set, analysis.ast!),
    readers: retypedReaders(set, { fieldId: input.fieldId, key: input.key, ast: analysis.ast!, resultType: analysis.resultType! }),
  };
}

/**
 * Every formula that reads the changed one, directly or through other
 * formulas (deprecated and deleted ones aside: a restore checks those), typed
 * again in evaluation order with the change in place. A reader that no longer
 * types refuses the change, naming the reader and why; one whose AST or result
 * type changes is returned with its new definition, which the caller stores
 * as a new version and computes again. So a formula whose result type
 * changes never leaves a reader computing over a type it was not checked
 * against.
 */
function retypedReaders(
  set: ExtensionFieldSet,
  changed: { fieldId: string; key: string; ast: FormulaAst; resultType: FormulaType },
): RetypedReader[] {
  const formulas = set.fields.filter((field) => field.kind === "formula" && field.state !== "deleted" && field.state !== "deprecated" &&
    field.fieldId !== changed.fieldId && storedFormula(field.definition) !== undefined);
  const node = (field: string) => ({ entity: set.entity, field });
  const selfReads = (ast: FormulaAst) => dependencies(ast).filter((ref) => ref.scope === "self").map((ref) => node(ref.id));
  const graph = buildDependencyGraph([
    { node: node(changed.fieldId), dependsOn: selfReads(changed.ast) },
    ...formulas.map((field) => ({ node: node(field.fieldId), dependsOn: selfReads(storedFormula(field.definition)!.ast) })),
  ]);
  const readers = graph.affectedBy([node(changed.fieldId)]).map((item) => set.byId.get(item.field)!).filter((field) => field.fieldId !== changed.fieldId);
  if (!readers.length) return [];
  const replace = (env: FormulaEnvironment, fieldId: string, formula: { ast: FormulaAst; resultType: FormulaType }) =>
    env.map((field) => field.id === fieldId && field.scope === "self"
      ? { ...field, type: formula.resultType, kind: "formula" as const, dependencies: dependencies(formula.ast) } : field);
  let env = replace(formulaEnvironment(set), changed.fieldId, changed);
  const retyped: RetypedReader[] = [];
  for (const reader of readers) {
    const before = storedFormula(reader.definition)!;
    const label = labelText(reader.definition.label, reader.key);
    let text: string;
    try {
      text = formatFormula(before.ast, env);
    } catch (error) {
      refuseFormula(changed.key, [{ code: "typeMismatch", message: `'${label}' reads this formula and could no longer be computed: ${error instanceof Error ? error.message : String(error)}`,
        start: 0, end: 0, params: { field: label } }]);
    }
    const analysis = analyze(text!, env, { fieldId: reader.fieldId });
    if (analysis.errors.length || !analysis.ast || !analysis.resultType) {
      const reason = analysis.errors[0] ?? { code: "undeterminedType" as const, message: "it has no type" };
      refuseFormula(changed.key, [{ code: reason.code, message: `'${label}' reads this formula and could no longer be computed: ${reason.message}`,
        start: 0, end: 0, params: { field: label, reason: reason.message } }]);
    }
    if (analysis.resultType === before.resultType && isDeepStrictEqual(analysis.ast, before.ast)) continue;
    const formula = { text: formatFormula(analysis.ast!, env), ast: analysis.ast!, resultType: analysis.resultType! };
    retyped.push({ field: reader, definition: { ...reader.definition, osfType: FORMULA_OSF_TYPES[formula.resultType], formula } });
    env = replace(env, reader.fieldId, formula);
  }
  return retyped;
}

/**
 * The set as it is once `fieldId` is back from deprecation: what a restore
 * checks the field (and its readers) against before it lets it compute again.
 */
export function withRestoredField(set: ExtensionFieldSet, fieldId: string): ExtensionFieldSet {
  const fields = set.fields.map((field) => field.fieldId === fieldId ? { ...field, state: "ready" as const } : field);
  return {
    ...set, hash: `${set.hash}:restored:${fieldId}`, fields,
    byKey: new Map(fields.filter((field) => field.state !== "deleted").map((field) => [field.key, field])),
    byId: new Map(fields.map((field) => [field.fieldId, field])),
  };
}

/**
 * A formula that reads no field has one value for every record, so the error
 * code it would give every record refuses it now: `"x" & ...` beyond the text
 * limit, `DATEADD(CREATED_TIME(), 8000, 'years')`. RECORD_ID() and
 * CREATED_TIME() read a stand-in record (this field's id, now).
 */
function assertConstantComputes(input: { fieldId: string; key: string }, ast: FormulaAst, resultType: FormulaType, text: string): void {
  if (dependencies(ast).length) return;
  const result = evaluate(ast, { id: input.fieldId, createdAt: new Date().toISOString() }, { resultType });
  if (result.ok) return;
  refuseFormula(input.key, [{ code: result.error, message: `It gives every record the error ${result.error}`, start: 0, end: text.length,
    params: { error: result.error } }]);
}

/**
 * The graph over every formula of the entity with this one in place: no
 * cycle anywhere, and no formula deeper than the limit — a change to a
 * formula another formula reads can make that reader too deep. A deprecated
 * formula counts as a reader too: it can be restored, and its restore must
 * not be the way past the limit.
 */
function assertFormulaSetValid(
  set: ExtensionFieldSet,
  changed: { fieldId: string; key: string; label: string; reads: readonly FormulaFieldRef[] },
  limit: number,
): void {
  const reads = new Map<string, string[]>();
  for (const field of set.fields) {
    const formula = field.kind === "formula" && field.state !== "deleted" && field.fieldId !== changed.fieldId ? storedFormula(field.definition) : undefined;
    if (formula) reads.set(field.fieldId, dependencies(formula.ast).filter((ref) => ref.scope === "self").map((ref) => ref.id));
  }
  reads.set(changed.fieldId, changed.reads.filter((ref) => ref.scope === "self").map((ref) => ref.id));
  const node = (field: string) => ({ entity: set.entity, field });
  const graph = buildDependencyGraph([...reads].map(([field, read]) => ({ node: node(field), dependsOn: read.map(node) })));
  const labelOf = (id: string) => {
    const field = set.byId.get(id);
    return id === changed.fieldId ? changed.label : field ? labelText(field.definition.label, field.key) : id;
  };
  const cycle = graph.cycles[0];
  if (cycle) {
    refuseFormula(changed.key, [{ code: "cycle", message: `Circular reference: ${[...cycle, cycle[0]!].map((item) => labelOf(item.field)).join(" → ")}`,
      start: 0, end: 0, params: { path: cycle.map((item) => labelOf(item.field)).join(" → ") } }]);
  }
  const depth = new Map<string, number>();
  for (const item of graph.order) {
    const own = (reads.get(item.field) ?? []).reduce((deepest, read) => Math.max(deepest, depth.get(read) ?? 0), 0) + 1;
    depth.set(item.field, own);
    if (own > limit) {
      refuseFormula(changed.key, [{ code: "depthExceeded",
        message: item.field === changed.fieldId
          ? `This formula would be ${own} formulas deep; the limit is ${limit}`
          : `'${labelOf(item.field)}' reads this formula and would be ${own} formulas deep; the limit is ${limit}`,
        start: 0, end: 0, params: { depth: own, limit, field: labelOf(item.field) } }]);
    }
  }
}

/** The stored definition as a caller reads it: the text printed with today's labels. */
export function presentFormulaDefinition(set: ExtensionFieldSet, field: ExtensionField): ExtensionDefinition {
  const formula = field.kind === "formula" ? storedFormula(field.definition) : undefined;
  if (!formula) return field.definition;
  try {
    return { ...field.definition, formula: { ...formula, text: formatFormula(formula.ast, formulaEnvironment(set)) } };
  } catch {
    return field.definition;
  }
}

export type FormulaGraph = {
  /** Computed formulas, each after every formula it reads. */
  readonly order: readonly ExtensionField[];
  /** The computed formulas a change of these (entity, field) nodes affects, transitively, in order. */
  affectedBy(changed: readonly DependencyNode[]): ExtensionField[];
  /** The owned-child relations some computed formula reads. */
  readonly relations: readonly string[];
};

const graphs = new WeakMap<ExtensionFieldSet, FormulaGraph>();

export function formulaGraph(set: ExtensionFieldSet): FormulaGraph {
  const cached = graphs.get(set);
  if (cached) return cached;
  const formulas = computedFormulas(set);
  const byId = new Map(formulas.map((field) => [field.fieldId, field]));
  const graph = buildDependencyGraph(formulas.map((field) => ({
    node: { entity: set.entity, field: field.fieldId },
    dependsOn: nodesOf(set, dependencies(storedFormula(field.definition)!.ast)),
  })));
  const fields = (nodes: readonly DependencyNode[]) => nodes.filter((node) => node.entity === set.entity)
    .map((node) => byId.get(node.field)).filter((field): field is ExtensionField => field !== undefined);
  const relations = [...new Set(formulas.flatMap((field) => dependencies(storedFormula(field.definition)!.ast)
    .flatMap((ref) => ref.scope === "self" ? [] : [ref.scope.relation])))].sort();
  const result: FormulaGraph = Object.freeze({
    order: Object.freeze(fields(graph.order)),
    affectedBy: (changed: readonly DependencyNode[]) => fields(graph.affectedBy(changed)),
    relations: Object.freeze(relations),
  });
  graphs.set(set, result);
  return result;
}

/** One owned single child as a formula reads it: its fields by name, or null without one. */
export type OwnedChildValues = Readonly<Record<string, Readonly<Record<string, unknown>> | null>>;

/** The columns of a stored row a formula may read (formulaColumns), keyed by field name. */
export function fieldValues(table: GeneratedCrudTable, row: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(formulaColumns(table).filter((column) => Object.hasOwn(row, column.name))
    .map((column) => [fieldNameForColumn(column), row[column.name] ?? null]));
}

export function childEntityTable(entity: string): GeneratedCrudTable | undefined {
  return entityTable(entity);
}

/**
 * The record a formula reads (see @openshapeforge/formula `evaluate`):
 * authored fields by name, tenant fields by id, owned children under their
 * relation, and `id` / `createdAt` for RECORD_ID() and CREATED_TIME(). A
 * stored tenant field reads as a reader sees it (read.ts `readValue`): its
 * value, else the default of a field that applies — a record written before
 * the field existed holds none.
 */
function formulaRecord(
  set: ExtensionFieldSet,
  table: GeneratedCrudTable,
  row: Readonly<Record<string, unknown>>,
  source: Readonly<Record<string, unknown>>,
  children: OwnedChildValues,
): FormulaRecord {
  const values: Record<string, unknown> = fieldValues(table, row);
  for (const [key, value] of Object.entries(source)) if (key !== EXTENSION_META_KEY) values[key] = value;
  const conditions = conditionValues(table, row, set, source);
  for (const field of set.fields) {
    if (field.kind !== "stored" || field.state === "deleted" || field.definition.defaultValue === undefined) continue;
    values[field.fieldId] = readValue(field, source, evaluateCondition(field.appliesWhen, conditions));
  }
  for (const [relation, child] of Object.entries(children)) values[relation] = child;
  values.id = row.id ?? null;
  values.createdAt = row.created_at ?? null;
  return values;
}

/** Store one result in the source: the value, or null with `$meta[fieldId].error`. */
function storeResult(source: Record<string, unknown>, fieldId: string, result: ReturnType<typeof evaluate>): void {
  const meta: Record<string, unknown> = record(source[EXTENSION_META_KEY]) ? { ...source[EXTENSION_META_KEY] as Record<string, unknown> } : {};
  const own: Record<string, unknown> = record(meta[fieldId]) ? { ...meta[fieldId] as Record<string, unknown> } : {};
  if (result.ok) {
    if (result.value === null) delete source[fieldId];
    else source[fieldId] = result.value;
    delete own.error;
  } else {
    source[fieldId] = null;
    own.error = result.error;
  }
  if (Object.keys(own).length) meta[fieldId] = own;
  else delete meta[fieldId];
  if (Object.keys(meta).length) source[EXTENSION_META_KEY] = meta;
  else delete source[EXTENSION_META_KEY];
}

/**
 * Evaluate the formulas of one record into `source` (mutated), in the
 * graph's order, each seeing the results of the formulas before it. `only`
 * restricts the run to the given field ids (still in order); a per-record
 * error is a value of null and its code in `$meta`. Never throws for data.
 */
export function evaluateFormulas(
  set: ExtensionFieldSet,
  table: GeneratedCrudTable,
  input: {
    row: Readonly<Record<string, unknown>>;
    source: Record<string, unknown>;
    children: OwnedChildValues;
    only?: ReadonlySet<string>;
  },
): void {
  const { order } = formulaGraph(set);
  if (!order.length) return;
  const env = formulaEnvironment(set);
  const values = formulaRecord(set, table, input.row, input.source, input.children) as Record<string, unknown>;
  for (const field of order) {
    if (input.only && !input.only.has(field.fieldId)) continue;
    const formula = storedFormula(field.definition)!;
    storeResult(input.source, field.fieldId, evaluate(formula.ast, values, { env, resultType: formula.resultType }));
    values[field.fieldId] = input.source[field.fieldId] ?? null;
  }
}
