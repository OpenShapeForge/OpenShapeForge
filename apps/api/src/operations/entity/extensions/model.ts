// SPDX-License-Identifier: BUSL-1.1
/**
 * The tenant field model of an `extensible` entity, as
 * pure functions: what a stored definition means for validation, the index,
 * redaction and `appliesWhen`. Database access lives in store.ts.
 */
import { isDeepStrictEqual } from "node:util";
import { sql, type RawBuilder } from "kysely";
import type { RuntimeExtensibleEntity, RuntimeExtensionIndexColumn } from "@openshapeforge/plugin-runtime";
import { exactNumericEquals, operationFailure, type OperationFieldBaseType } from "@openshapeforge/operations";
import fieldSchemaRegistry from "../../../generated/operations/field-schema-registry.json" with { type: "json" };
import { generatedRuntimeFieldSchemas, storedFieldBaseType } from "../../../modules/field-schemas.js";
import { extensionRegistry } from "./registry.js";

export const EXTENSION_VALUES_COLUMN = "extension_values";
export const EXTENSION_META_KEY = "$meta";
export type ExtensionKind = "stored" | "formula" | "lookup" | "rollup";
export type ExtensionState = "updating" | "ready" | "deprecated" | "suspended" | "deleted";
export type ExtensionDefinition = Record<string, unknown>;

/** One current definition version of one tenant field. */
export type ExtensionField = {
  readonly rowId: string;
  readonly fieldId: string;
  readonly key: string;
  readonly version: number;
  readonly kind: ExtensionKind;
  readonly definition: ExtensionDefinition;
  readonly appliesWhen: unknown;
  readonly state: ExtensionState;
  readonly position: number;
  /** Why the field is suspended, when it is or was before a deprecation: a lost proof redacts its values. */
  readonly suspendedReason?: string;
};

/**
 * The reason a lookup or rollup is suspended when the authorization proof it
 * was saved under no longer holds, and the reason of everything that reads
 * it. Its stored values are target data a reader may no longer see, so the
 * read projection redacts them (read.ts); every other reason keeps them.
 */
export const AUTHORIZATION_PROOF_LOST = "AUTHORIZATION_PROOF_LOST";

/** Whether a field's stored values are redacted from readers: its proof is lost, whatever state it is in now. */
export function proofLost(field: Pick<ExtensionField, "state" | "suspendedReason">): boolean {
  return field.suspendedReason === AUTHORIZATION_PROOF_LOST && (field.state === "suspended" || field.state === "deprecated");
}

/** The reason of a field that reads a suspended one: a lost proof is inherited, anything else stays a reason to keep the value. */
export function inheritedSuspension(input: Pick<ExtensionField, "suspendedReason">): string {
  return input.suspendedReason === AUTHORIZATION_PROOF_LOST ? AUTHORIZATION_PROOF_LOST : "DEPENDENCY_SUSPENDED";
}
export type ExtensionFieldSet = {
  readonly entity: string;
  readonly entry: RuntimeExtensibleEntity;
  readonly hash: string;
  readonly fields: readonly ExtensionField[];
  readonly byKey: ReadonlyMap<string, ExtensionField>;
  readonly byId: ReadonlyMap<string, ExtensionField>;
};

/** What a definition's type means for storage, index and queries. */
export type ExtensionShape = {
  readonly baseType: OperationFieldBaseType;
  readonly collection: boolean;
  /** Set when the osfType names a tenant entity: the value is its id. */
  readonly reference?: { readonly entity: string; readonly table: string };
  /** The index columns an object value projects to, by component. */
  readonly projection?: Partial<Record<RuntimeExtensionIndexColumn, string>>;
  /** The index column a scalar lands in (`ref` for a reference). */
  readonly column: RuntimeExtensionIndexColumn | "ref";
  readonly staticOptions: boolean;
  readonly classified: boolean;
};

export type ExtensionIndexRow = {
  ordinal: number;
  value_text: string | null;
  value_number: string | null;
  value_boolean: boolean | null;
  value_date: string | null;
  value_timestamp: string | null;
  value_ref_id: string | null;
};

const CLASSIFIED = new Set(["confidential", "pii", "bsn"]);
export const SENSITIVITIES = ["public", "internal", "confidential", "pii", "bsn"] as const;
export const EXTENSION_KEY = /^[a-z][A-Za-z0-9]{0,62}$/;
const osfTypes = fieldSchemaRegistry.osfTypes as Record<string, { baseType?: string; kind?: string }>;

export const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function extensionError(message: string, code = "VALIDATION", detail?: string): never {
  throw operationFailure({ code, message, ...(detail ? { detail } : {}), retryable: false });
}

/** A field's own entry in the source's `$meta`. */
export function fieldMeta(source: Readonly<Record<string, unknown>>, fieldId: string): unknown {
  const meta = source[EXTENSION_META_KEY];
  return record(meta) ? meta[fieldId] : undefined;
}

/** Whether a write changes a field: its value, or for a computed field also its `$meta` (an error code). */
export function fieldChanged(field: Pick<ExtensionField, "fieldId" | "kind">, before: Readonly<Record<string, unknown>>, after: Readonly<Record<string, unknown>>): boolean {
  return !isDeepStrictEqual(before[field.fieldId], after[field.fieldId]) ||
    (field.kind !== "stored" && !isDeepStrictEqual(fieldMeta(before, field.fieldId), fieldMeta(after, field.fieldId)));
}

/** The aggregates a rollup computes over its collection. */
export const ROLLUP_AGGREGATES = ["sum", "count", "countAll", "min", "max", "avg", "arrayUnique"] as const;
export type RollupAggregate = typeof ROLLUP_AGGREGATES[number];
/** The result types of a computed field, one per typed index column (as `@openshapeforge/formula` types them). */
export const COMPUTED_RESULT_TYPES = ["text", "number", "boolean", "date", "timestamp"] as const;
export type ComputedResultType = typeof COMPUTED_RESULT_TYPES[number];

/**
 * A lookup as it is stored: `via` and `field` name a tenant field as
 * `extensions.<fieldId>` and an authored field or relation by its key.
 */
export type StoredLookup = { via: string; field: string; resultType: ComputedResultType };
/**
 * A rollup as it is stored: `collection` is an authored inverse relation by
 * key or `<Entity>.extensions.<fieldId>` (the records of another entity whose
 * tenant reference names this one); `of` and the paths of `where` name the
 * child's fields as `via` and `field` do, and `of` may follow one single
 * relation of the child first (rollupPath).
 */
export type StoredRollup = { collection: string; aggregate: RollupAggregate; of?: string; where?: unknown; resultType: ComputedResultType };

/**
 * A rollup's `of` in its parts: the field it reads and the one relation of the
 * child it follows to get there, if any, each an authored name or
 * `extensions.<key>`. Undefined when it takes more than one step.
 */
export function rollupPath(of: string): { via?: string; field: string } | undefined {
  const segments = of.split(".");
  const next = () => segments[0] === "extensions" ? segments.splice(0, 2).join(".") : segments.shift()!;
  const first = next();
  if (!segments.length) return { field: first };
  const second = next();
  return segments.length ? undefined : { via: first, field: second };
}

const resultTyped = (value: unknown): value is { resultType: ComputedResultType } =>
  record(value) && (COMPUTED_RESULT_TYPES as readonly string[]).includes(String(value.resultType));

export function storedLookup(definition: ExtensionDefinition): StoredLookup | undefined {
  const lookup = definition.lookup;
  return resultTyped(lookup) && typeof (lookup as Record<string, unknown>).via === "string" &&
    typeof (lookup as Record<string, unknown>).field === "string" ? lookup as unknown as StoredLookup : undefined;
}

export function storedRollup(definition: ExtensionDefinition): StoredRollup | undefined {
  const rollup = definition.rollup;
  return resultTyped(rollup) && typeof (rollup as Record<string, unknown>).collection === "string" &&
    (ROLLUP_AGGREGATES as readonly string[]).includes(String((rollup as Record<string, unknown>).aggregate))
    ? rollup as unknown as StoredRollup : undefined;
}

/** The result type of a lookup or rollup, as it was fixed when its definition was saved. */
export function linkedResultType(field: Pick<ExtensionField, "kind" | "definition">): ComputedResultType | undefined {
  if (field.kind === "lookup") return storedLookup(field.definition)?.resultType;
  if (field.kind === "rollup") return storedRollup(field.definition)?.resultType;
  return undefined;
}

export function isCollection(definition: ExtensionDefinition): boolean {
  const cardinality = definition.cardinality;
  if (cardinality === "collection") return true;
  if (record(cardinality)) return cardinality.max === "unbounded" || (typeof cardinality.max === "number" && cardinality.max > 1);
  return false;
}

export function classificationOf(definition: ExtensionDefinition): string | undefined {
  return record(definition.classification) && typeof definition.classification.sensitivity === "string"
    ? definition.classification.sensitivity : undefined;
}

export function isClassified(definition: ExtensionDefinition): boolean {
  return CLASSIFIED.has(classificationOf(definition) ?? "");
}

/** One thing a computed field reads, or a reference its value travels along. */
export type ComputedInput = { readonly label: string; readonly sensitivity: string | undefined };

/** The sensitivity of an authored field in reach of a computed field: what is classified never is. */
export function authoredSensitivity(entity: string, field: string): "public" | "internal" {
  return extensionRegistry.readAccess(entity)?.internalFields?.includes(field) ? "internal" : "public";
}

/**
 * Why a computed field may not be saved under its classification: what it
 * shows is at least as sensitive as the most sensitive thing it reads, public
 * below internal, and a public value goes where an internal one does not (a
 * quote that leaves the house). Nothing classified reaches a computed field,
 * and each link proved its own inputs when it was saved, so its direct inputs
 * hold the floor of the whole chain.
 */
export function sensitivityShortfall(definition: ExtensionDefinition, inputs: readonly ComputedInput[]): string | undefined {
  if (classificationOf(definition) !== "public") return undefined;
  const input = inputs.find((candidate) => candidate.sensitivity === "internal");
  return input && `it reads ${input.label}, which is internal, so it is internal at least.`;
}

export function refuseSensitivity(key: string, kind: string, reason: string): never {
  throw operationFailure({
    code: "VALIDATION",
    message: `The ${kind} ${key} cannot be saved: ${reason}`,
    violations: [{ field: "definition.classification", code: "CLASSIFICATION_TOO_LOW", message: reason }],
    data: { reason: "CLASSIFICATION_TOO_LOW" },
    retryable: false,
  });
}

export function hasStaticOptions(definition: ExtensionDefinition): boolean {
  return record(definition.options) && definition.options.type === "static";
}

export function extensionShape(entry: RuntimeExtensibleEntity, definition: ExtensionDefinition): ExtensionShape {
  const osfType = String(definition.osfType ?? "");
  const target = entry.targets.find((candidate) => candidate.entity === osfType);
  const baseType = target ? "string" : storedFieldBaseType({ key: "extension", osfType });
  const projection = baseType === "object" ? extensionRegistry.indexProjection(osfType) : undefined;
  const column: ExtensionShape["column"] = target ? "ref"
    : baseType === "string" ? "text"
    : baseType === "integer" || baseType === "number" ? "number"
    : baseType === "boolean" ? "boolean"
    : baseType === "date" ? "date"
    : baseType === "datetime" ? "timestamp"
    : projection?.number ? "number" : "text";
  return {
    baseType,
    collection: isCollection(definition),
    ...(target ? { reference: { entity: target.entity, table: target.table } } : {}),
    ...(projection ? { projection } : {}),
    column,
    staticOptions: hasStaticOptions(definition),
    classified: isClassified(definition),
  };
}

const numericOsfType = (osfType: unknown): boolean => {
  const base = typeof osfType === "string" ? osfTypes[osfType]?.baseType ?? osfType : undefined;
  return base === "integer" || base === "number";
};

/**
 * A value as the number its field holds. The value schema admits exact decimal
 * text beside a number, and a form sends text, but tenant values are JSON
 * numbers: in the source, and from there in every read, snapshot and formula.
 * Covers integer, number and the types on them (money, percentage), and the
 * number of an object type that projects one (measurement). Reads apply it too, so a value stored as text before reads
 * the same. Text that is no number is left to the validator, and text no JSON
 * number holds exactly stays what it is, for `unrepresentable` to hear: a write
 * refuses it, and a read delivers what was stored rather than round it.
 */
export function numericValue(definition: ExtensionDefinition, value: unknown, unrepresentable?: (text: string) => void): unknown {
  const component = numericOsfType(definition.osfType) ? undefined : extensionRegistry.indexProjection(String(definition.osfType))?.number;
  if (component === undefined && !numericOsfType(definition.osfType)) return value;
  const number = (item: unknown): unknown => {
    if (typeof item !== "string" || !item.trim() || Number.isNaN(Number(item))) return item;
    if (exactNumericEquals(item, Number(item))) return Number(item);
    unrepresentable?.(item);
    return item;
  };
  return component === undefined ? number(value)
    : record(value) && typeof value[component] === "string" ? { ...value, [component]: number(value[component]) } : value;
}

/** The entity id a stored reference value names, or the ids of a collection. */
export function referenceIds(shape: ExtensionShape, value: unknown): string[] {
  if (!shape.reference || value === null || value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).filter((item): item is string => typeof item === "string");
}

function scalarRow(column: RuntimeExtensionIndexColumn | "ref", value: unknown, row: ExtensionIndexRow): void {
  if (value === null || value === undefined) return;
  switch (column) {
    case "text": row.value_text = String(value); break;
    case "number": row.value_number = String(value); break;
    case "boolean": row.value_boolean = value === true; break;
    case "date": row.value_date = String(value); break;
    case "timestamp": row.value_timestamp = String(value); break;
    case "ref": row.value_ref_id = String(value); break;
  }
}

/** The derived index rows of one stored value: one per collection element. */
export function indexRows(shape: ExtensionShape, value: unknown): ExtensionIndexRow[] {
  if (value === null || value === undefined) return [];
  const items = shape.collection ? (Array.isArray(value) ? value : []) : [value];
  return items.flatMap((item, ordinal) => {
    if (item === null || item === undefined) return [];
    const row: ExtensionIndexRow = {
      ordinal, value_text: null, value_number: null, value_boolean: null,
      value_date: null, value_timestamp: null, value_ref_id: null,
    };
    if (shape.projection) {
      if (!record(item)) return [];
      for (const [column, component] of Object.entries(shape.projection)) {
        scalarRow(column as RuntimeExtensionIndexColumn, item[component!], row);
      }
    } else if (shape.baseType === "object") {
      return [];
    } else {
      scalarRow(shape.column, item, row);
    }
    return [row];
  });
}

/** The index column and the raw scalar a uniqueness claim is taken on, or null without a value. */
export function uniqueOperand(shape: ExtensionShape, value: unknown): { column: ExtensionShape["column"]; value: string } | null {
  const [row] = indexRows(shape, value);
  if (!row) return null;
  const column = shape.column;
  const raw = column === "ref" ? row.value_ref_id : row[`value_${column}` as keyof ExtensionIndexRow];
  return raw === null || raw === undefined ? null : { column, value: String(raw) };
}

/**
 * What uniqueness compares, as SQL over a value of the
 * index column's type: text trimmed and case-folded (stricter than exact,
 * which is the conservative side), a timestamp as UTC ISO text, a number
 * without trailing zeros, a date and an id as their canonical text. The
 * claim a writer takes, the claim a backfill takes and the duplicate check
 * before a field becomes unique all go through this one expression; the
 * stored value itself stays as it was entered.
 */
export function normalizedUnique(column: ExtensionShape["column"], typed: RawBuilder<unknown>): RawBuilder<string> {
  switch (column) {
    case "text": return sql<string>`lower(btrim(${typed}))`;
    case "number": return sql<string>`trim_scale(${typed})::text`;
    case "timestamp": return sql<string>`to_char(${typed} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
    case "date": return sql<string>`(${typed})::text`;
    case "boolean": return sql<string>`(${typed})::text`;
    case "ref": return sql<string>`(${typed})::text`;
  }
}

const COLUMN_TYPES: Record<ExtensionShape["column"], string> = {
  text: "text", number: "numeric", boolean: "boolean", date: "date", timestamp: "timestamptz", ref: "uuid",
};

/** A raw scalar as a value of its index column's type, for normalizedUnique. */
export function typedOperand(column: ExtensionShape["column"], value: string): RawBuilder<unknown> {
  return sql`cast(${value} as ${sql.raw(COLUMN_TYPES[column])})`;
}

/** The index column a shape's value lands in, under an alias. */
export function indexColumnRef(column: ExtensionShape["column"], alias?: string): RawBuilder<unknown> {
  const name = column === "ref" ? "value_ref_id" : `value_${column}`;
  return alias ? sql.ref(`${alias}.${name}`) : sql.ref(name);
}

/**
 * The FieldDefinition the shared field-schema service validates: the stored
 * definition under its key, without the extension-only properties and with
 * `required` left to `appliesWhen` (checked by the write path itself).
 */
export function schemaFieldOf(field: Pick<ExtensionField, "key" | "definition">): Record<string, unknown> {
  const { unique: _unique, onDelete: _onDelete, required: _required, retention: _retention,
    defaultValue: _defaultValue, key: _key, ...rest } = field.definition;
  return { ...rest, key: field.key };
}

const schemaCache = new Map<string, Readonly<Record<string, unknown>>>();
const SCHEMA_CACHE_LIMIT = 512;

/**
 * The JSON Schema of the writable fields of one definition set, cached on
 * the definition hash (the schema, never a compiled validator: the runtime
 * JSON validator retires its engines on purpose, see modules/field-schemas.ts).
 */
export function extensionValueSchema(set: ExtensionFieldSet): Readonly<Record<string, unknown>> {
  const cacheKey = `${set.entity}:${set.hash}`;
  const cached = schemaCache.get(cacheKey);
  if (cached) return cached;
  const writable = set.fields.filter((field) => field.kind === "stored" && field.state !== "deleted");
  const schema = writable.length
    ? generatedRuntimeFieldSchemas.object(writable.map(schemaFieldOf))
    : { type: "object", properties: {}, additionalProperties: false };
  if (schemaCache.size >= SCHEMA_CACHE_LIMIT) schemaCache.delete(schemaCache.keys().next().value!);
  schemaCache.set(cacheKey, schema);
  return schema;
}

/** The property schema of one field, for MCP enrichment and single checks. */
export function extensionPropertySchema(set: ExtensionFieldSet, key: string): Record<string, unknown> | undefined {
  const properties = extensionValueSchema(set).properties;
  return record(properties) && record(properties[key]) ? properties[key] as Record<string, unknown> : undefined;
}

export function isEntityOsfType(osfType: string): boolean {
  return osfTypes[osfType]?.kind === "entity";
}

// ---------------------------------------------------------------------------
// appliesWhen: a `condition` over authored fields and static-option tenant
// fields. The runtime evaluates the subset the designer can produce: groups
// (`all`/`any`/`conditions` with `mode`) of rules comparing one path with a
// literal. Anything else is refused when the definition is saved.

const RULE_OPERATORS = new Set([
  "equals", "notEquals", "in", "notIn", "isEmpty", "isNotEmpty", "contains", "notContains",
  "greaterThan", "greaterThanOrEquals", "lessThan", "lessThanOrEquals",
]);

/**
 * A path of an `appliesWhen` rule: an authored field by name, or a tenant
 * field. Callers name a tenant field by key (`extensions.<key>`); the stored
 * condition names it by field id (`extensions.<fieldId>`), so renaming a
 * field never breaks a condition that depends on it.
 */
export type ConditionPath = { kind: "authored"; field: string } | { kind: "extension"; key: string };
export const EXTENSIONS_PATH_PREFIX = "extensions.";

/** The condition with every tenant field path rewritten, e.g. key → field id. */
export function mapConditionPaths(condition: unknown, rename: (name: string) => string): unknown {
  if (Array.isArray(condition)) return condition.map((child) => mapConditionPaths(child, rename));
  if (!record(condition)) return condition;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(condition)) {
    if (key === "left" && record(value) && value.kind === "path" && typeof value.path === "string" && value.path.startsWith(EXTENSIONS_PATH_PREFIX)) {
      result[key] = { ...value, path: `${EXTENSIONS_PATH_PREFIX}${rename(value.path.slice(EXTENSIONS_PATH_PREFIX.length))}` };
    } else {
      result[key] = key === "all" || key === "any" || key === "conditions" ? mapConditionPaths(value, rename) : value;
    }
  }
  return result;
}

export function conditionPaths(condition: unknown, depth = 0): ConditionPath[] {
  if (!record(condition) || depth > 8) extensionError("appliesWhen is not a supported condition.");
  const children = [condition.all, condition.any, condition.conditions].filter((value) => value !== undefined);
  if (condition.kind === "group" || children.length) {
    if (condition.mode !== undefined && condition.mode !== "all" && condition.mode !== "any") {
      extensionError("appliesWhen groups combine with all or any.");
    }
    if (children.length !== 1 || !Array.isArray(children[0]) || children[0].length === 0 || children[0].length > 20) {
      extensionError("appliesWhen groups need one non-empty list of conditions.");
    }
    return (children[0] as unknown[]).flatMap((child) => conditionPaths(child, depth + 1));
  }
  if ((condition.kind !== undefined && condition.kind !== "rule") || !RULE_OPERATORS.has(String(condition.operator))) {
    extensionError("appliesWhen supports rules over a field and a literal only.");
  }
  const left = condition.left;
  if (!record(left) || left.kind !== "path" || typeof left.path !== "string") {
    extensionError("An appliesWhen rule compares a field path.");
  }
  const unary = condition.operator === "isEmpty" || condition.operator === "isNotEmpty";
  if (!unary && (!record(condition.right) || condition.right.kind !== "literal")) {
    extensionError("An appliesWhen rule compares its field with a literal value.");
  }
  const path = left.path as string;
  if (path.startsWith("extensions.")) return [{ kind: "extension", key: path.slice("extensions.".length) }];
  if (!/^[a-z][A-Za-z0-9]*$/.test(path)) extensionError(`appliesWhen path ${path} is not a field.`);
  return [{ kind: "authored", field: path }];
}

export { evaluateFieldCondition as evaluateCondition } from "@openshapeforge/operations";
