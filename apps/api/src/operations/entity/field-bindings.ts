import { filterFieldNames } from "./filter-groups.js";
// SPDX-License-Identifier: BUSL-1.1
/**
 * The entity half of the typed-variable runtime: a stored field whose value
 * comes from a variable instead of a literal.
 *
 * One generated JSONB map per bindable entity holds the bindings
 * (`FIELD_BINDINGS_COLUMN`); each value column holds what its binding
 * resolved to at the last write. The two are separate on purpose — the
 * binding is the author's intent and survives, the value is a result:
 *
 * - A **write** resolves every binding the record will have, under the
 *   caller's own identity and tenant, validates the resolved values through
 *   the Operation's compiled contract like any literal, and stores the map
 *   beside them. A literal for a field clears that field's binding; `unbind`
 *   resolves once more and writes that value as a literal, so unbinding
 *   freezes what the record holds NOW and never a stale snapshot.
 * - A **live read** resolves every binding again, under the reading actor and
 *   tenant, and returns that value. A source that is gone, withheld from this
 *   reader, or no longer fits the destination is a refusal; a stale or
 *   widened value is never returned.
 * - A **query** may not filter or sort by a bindable field. Its column holds
 *   the value of the last write, which a later source change makes stale, so
 *   ordering or selecting by it would be a wrong answer rather than a slow
 *   one (see `assertBoundFieldQueryAllowed`).
 *
 * Two namespaces, as everywhere: `chips.<key>` is the tenant's Chip
 * catalogue, each Chip typed by the FieldDefinition stored beside its value;
 * `local.<key>` is another field of this same record, typed by the record's
 * own compiled definition. A local binding may itself resolve through another
 * one, bounded by depth and refused on a cycle. Nothing is ever evaluated:
 * a resolved value is data, and a `{{…}}` sequence inside it stays text.
 */

import {
  assertVariableCompatible,
  assertVariableSourceValue,
  bindingKindPermitted,
  declaredVariableOffer,
  escapeMarkdownVariableText,
  fieldBindingMap,
  isFieldBinding,
  MAX_BINDING_TEMPLATE_LENGTH,
  operationFailure,
  operationErrorOf,
  parseVariableReference,
  schemaVariableShape,
  schemaVariableSlot,
  variableText,
  variableTokens,
  VariableError,
  FIELD_BINDINGS_COLUMN,
  FIELD_BINDINGS_FIELD,
  type VariableReference,
  type FieldBinding,
  type FieldBindingMap,
  type FieldVariableMode,
  type VariableOffer,
  type VariableSlot,
  type VariableValueShape,
} from "@openshapeforge/operations";
import { sql, type Transaction } from "kysely";
import type { DB } from "../../generated/db/types.js";
import type { DbSessionInput } from "../../db/session.js";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import { withDbSession } from "../../db/session.js";
import { generatedRuntimeFieldSchemas } from "../../modules/field-schemas.js";
import { fieldNameForColumn } from "./columns.js";
import { bindingColumnReadable } from "./field-binding-policy.js";
import { assertEntityValuesValid } from "./input-validation.js";
import {
  generatedCrudError,
  getGeneratedCrudTables,
  isGeneratedCrudOperationEnabled,
  projectGeneratedEntityRow,
  requireEntityOperation,
} from "./catalog.js";
import { entityOperationContract } from "./runtime.js";
import type { GeneratedCrudColumn, GeneratedCrudTable, GeneratedEntityRow, ListPageInput } from "./types.js";

/** How deep a chain of local bindings may go before it is a design error. */
const MAX_LOCAL_DEPTH = 8;

/**
 * How many `{{…}}` tokens one authored template may carry. A template is
 * authored text, not a program: a few dozen variables is generous, and the
 * bound keeps one field from turning a single write into a thousand
 * authorized reads.
 */
const MAX_BINDING_TOKENS = 64;
const MAX_RESOLVED_TEMPLATE_LENGTH = 200_000;

/**
 * How many source records one request may resolve, however many rows, fields
 * and tokens ask for them. Each distinct global is read once per request
 * (`ResolutionScope.globals`), so an ordinary page of records that share a
 * handful of variables stays far below this; a page whose bindings would fan
 * out into hundreds of reads is refused instead of served slowly.
 */
const MAX_SOURCE_READS = 100;

/** The entity whose records are the tenant's global variables. */
const GLOBAL_ENTITY = "Chip";
/** Its key field, and the field its typed value lives in. */
const GLOBAL_KEY_FIELD = "key";
const GLOBAL_VALUE_FIELD = "value";

export type BindableField = { field: string; column: string; variables: FieldVariableMode };

/** The bindings column of a table, when it has bindable fields at all. */
export function fieldBindingsColumn(table: GeneratedCrudTable): GeneratedCrudColumn | undefined {
  const column = table.columns.find((candidate) => candidate.fieldBindings !== undefined);
  if (!column) return undefined;
  if (column.name !== FIELD_BINDINGS_COLUMN || column.type !== "jsonb" || column.sourceField !== undefined) {
    throw generatedCrudError("Field-binding storage metadata is invalid.", "INVALID_DEFINITION");
  }
  return column;
}

/** The fields of this table that accept a binding, by authored key. */
export function bindableFields(table: GeneratedCrudTable): ReadonlyMap<string, BindableField> {
  const column = fieldBindingsColumn(table);
  const entries = (column?.fieldBindings?.fields ?? []).map((entry) => {
    const backing = table.columns.find((candidate) => candidate.name === entry.column);
    if (!backing || fieldNameForColumn(backing) !== entry.field) {
      throw generatedCrudError("Field-binding metadata does not match its table.", "INVALID_DEFINITION");
    }
    return [entry.field, entry] as const;
  });
  return new Map(entries);
}

/**
 * Filtering or sorting by a bindable field is refused, and so is reaching for
 * the bindings map itself. The stored column is the value of the last write;
 * a source that changed since then makes it stale, and the engine cannot
 * compare or order values it has not resolved. Refusing is the honest answer —
 * a page of rows ordered by a value that may no longer hold is not a weaker
 * result, it is a wrong one. A caller that needs it reads the records and
 * compares the resolved values it got back.
 */
export function assertBoundFieldQueryAllowed(
  table: GeneratedCrudTable,
  input: Pick<ListPageInput, "filter" | "sort">,
  exactFilterFields = false,
): void {
  const bindable = bindableFields(table);
  if (bindable.size === 0) return;
  const refused = new Set<string>([...bindable.keys(), FIELD_BINDINGS_FIELD]);
  const filtered = filterFieldNames(input.filter).find(
    (key) => refused.has(key) || (!exactFilterFields && key.endsWith("In") && refused.has(key.slice(0, -2))),
  );
  const sorted = input.sort?.field && refused.has(input.sort.field) ? input.sort.field : undefined;
  const field = filtered ?? sorted;
  if (!field) return;
  throw generatedCrudError(
    `Filtering or sorting by ${field} is not supported.`,
    "BAD_USER_INPUT",
    {
      detail:
        "The field accepts a variable, so its stored value is the result of the last write and may no longer match " +
        "its source. Read the records and compare the resolved values instead.",
    },
  );
}

/** The bindings a caller supplied, refused where the entity or field takes none. */
function requestedBindings(
  table: GeneratedCrudTable,
  bindable: ReadonlyMap<string, BindableField>,
  input: { bindings?: unknown; unbind?: unknown },
): { bindings: Map<string, FieldBinding>; unbind: Set<string> } {
  const supplied = input.bindings;
  const unbound = input.unbind;
  const entity = table.source?.authoringEntityName ?? table.name;
  if (supplied === undefined && unbound === undefined) return { bindings: new Map(), unbind: new Set() };
  if (bindable.size === 0) {
    throw generatedCrudError(`No field of ${entity} accepts a variable.`, "BAD_USER_INPUT");
  }
  const bindings = new Map<string, FieldBinding>();
  if (supplied !== undefined) {
    if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) {
      throw generatedCrudError("bindings must be an object of field bindings.", "BAD_USER_INPUT");
    }
    for (const [field, value] of Object.entries(supplied as Record<string, unknown>)) {
      const declared = bindable.get(field);
      if (!declared) throw generatedCrudError(`${entity}.${field} does not accept a variable.`, "BAD_USER_INPUT");
      const binding = normalizeBinding(value);
      if (!binding) throw generatedCrudError(`The binding for ${field} is not a variable reference or a template.`, "BAD_USER_INPUT");
      if (binding.kind === "template" && variableTokens(binding.source).length > MAX_BINDING_TOKENS) {
        throw generatedCrudError(
          `The binding for ${field} carries more than ${MAX_BINDING_TOKENS} variables.`,
          "BAD_USER_INPUT",
        );
      }
      if (!bindingKindPermitted(declared.variables, binding)) {
        throw generatedCrudError(
          binding.kind === "whole"
            ? `${entity}.${field} does not accept a variable as its whole value.`
            : `${entity}.${field} does not accept variables in its text.`,
          "BAD_USER_INPUT",
        );
      }
      bindings.set(field, binding);
    }
  }
  const unbind = new Set<string>();
  if (unbound !== undefined) {
    if (!Array.isArray(unbound) || unbound.some((field) => typeof field !== "string")) {
      throw generatedCrudError("unbind must be a list of field names.", "BAD_USER_INPUT");
    }
    for (const field of unbound as string[]) {
      if (!bindable.has(field)) throw generatedCrudError(`${entity}.${field} does not accept a variable.`, "BAD_USER_INPUT");
      if (bindings.has(field)) throw generatedCrudError(`${field} cannot be bound and unbound in one write.`, "BAD_USER_INPUT");
      unbind.add(field);
    }
  }
  return { bindings, unbind };
}

/** The transport spelling of a binding as the one stored shape. */
function normalizeBinding(value: unknown): FieldBinding | undefined {
  if (typeof value === "string") return { kind: "whole", ref: value };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const supplied = value as Record<string, unknown>;
    if (typeof supplied.template === "string" && Object.keys(supplied).length === 1) {
      return supplied.template.length <= MAX_BINDING_TEMPLATE_LENGTH
        ? { kind: "template", source: supplied.template }
        : undefined;
    }
    // The stored shape itself, so a caller may echo back what it read.
    if (isFieldBinding(supplied)) return supplied as FieldBinding;
  }
  return undefined;
}

/**
 * The destination contract of each bindable field, from the property the
 * entity's own create Operation publishes — the same projection every
 * transport advertises and the same one the write contract validates
 * against, so nothing compares against a second copy of the field metadata.
 * Nullability comes from the column: a NOT NULL destination takes no null.
 */
function bindableSlots(table: GeneratedCrudTable, bindable: ReadonlyMap<string, BindableField>): Map<string, VariableSlot> {
  const cached = slotCache.get(table);
  if (cached) return cached;
  const entity = table.source?.authoringEntityName ?? table.name;
  const contract = ["create", "update"].flatMap((intent) => {
    try {
      return [entityOperationContract(`${entity}.${intent}`)];
    } catch {
      return [];
    }
  })[0];
  const properties = ((contract?.inputSchema?.properties as Record<string, unknown> | undefined)?.values as
    { properties?: Record<string, unknown> } | undefined)?.properties;
  const slots = new Map<string, VariableSlot>();
  for (const [field, declared] of bindable) {
    const schema = properties && Object.hasOwn(properties, field) ? properties[field] : undefined;
    const column = table.columns.find((candidate) => candidate.name === declared.column)!;
    const slot = schema && typeof schema === "object"
      ? schemaVariableSlot(`${entity}.${field}`, schema as Record<string, unknown>, { required: column.required })
      : undefined;
    if (!slot || slot.mode !== declared.variables) {
      throw generatedCrudError(
        `The published contract of ${entity}.${field} does not describe the variable it accepts.`,
        "INVALID_DEFINITION",
      );
    }
    slots.set(field, slot);
  }
  slotCache.set(table, slots);
  return slots;
}

const slotCache = new WeakMap<GeneratedCrudTable, Map<string, VariableSlot>>();

/**
 * A refusal from the shared contract, as the canonical failure a caller gets.
 *
 * Which failure that is depends on who the request is about. A WRITE is asked
 * to store a binding, so a source that does not fit is a VALIDATION of that
 * write, with the field named in `violations` the way every other invalid
 * value is. A READ is asked for a record whose binding was accepted earlier
 * and whose source has since gone, been withheld from this reader or stopped
 * fitting: the request itself is not malformed, the record's dependency is,
 * which is what `DEPENDENCY_UNRESOLVED` and `DEPENDENCY_INVALID` say.
 *
 * Neither carries a value — only types, keys and namespaces — so a refusal
 * cannot print the value it refused to hand over.
 */
function bindingRefusal(
  mode: "read" | "write",
  field: string,
  code: string,
  message: string,
) {
  if (mode === "write") {
    return operationFailure({
      code: "VALIDATION",
      message: `${field}: ${message}`,
      retryable: false,
      violations: [{ field, code, message }],
    });
  }
  if (code === "UNKNOWN_VARIABLE" || code === "MISSING_VALUE") {
    return operationFailure({
      code: "DEPENDENCY_UNRESOLVED",
      message: `${field}: ${message}`,
      retryable: false,
    });
  }
  return operationFailure({
    code: "DEPENDENCY_INVALID",
    message: `${field}: ${message}`,
    retryable: false,
  });
}

/** The same refusal for a failure the shared variable contract raised. */
function bindingFailure(scope: Pick<ResolutionScope, "mode">, field: string, error: unknown) {
  return error instanceof VariableError
    ? bindingRefusal(scope.mode, field, error.code, error.message)
    : error;
}

/** One global's declared contract and its value, as its own source holds them. */
type ResolvedGlobal = { readonly shape: VariableValueShape; readonly value: unknown };

/**
 * One tenant global, read through the generated read path of its own entity:
 * the role gate of that entity's read Operation, the tenant predicate beside
 * row-level security, and the same output projection every read goes through,
 * so a value this actor may not see stays withheld. The stored
 * FieldDefinition beside the value is the source's declared contract.
 */
async function resolveGlobal(
  scope: ResolutionScope,
  field: string,
  key: string,
): Promise<ResolvedGlobal> {
  const table = getGeneratedCrudTables().find((candidate) => candidate.source?.authoringEntityName === GLOBAL_ENTITY);
  if (!table || !table.tenantScoped) {
    throw generatedCrudError("Global variables are not available in this application.", "OPERATION_UNAVAILABLE");
  }
  requireEntityOperation(table, isGeneratedCrudOperationEnabled(table, "get") ? "get" : "list", scope.session);
  const keyColumn = table.columns.find((column) => fieldNameForColumn(column) === GLOBAL_KEY_FIELD);
  const valueColumn = table.columns.find((column) => fieldNameForColumn(column) === GLOBAL_VALUE_FIELD);
  const definitionColumn = valueColumn?.typedBy
    ? table.columns.find((column) => column.name === valueColumn.typedBy!.definitionColumn)
    : undefined;
  if (!keyColumn || !valueColumn || !definitionColumn) {
    throw generatedCrudError("Global variable storage metadata is invalid.", "INVALID_DEFINITION");
  }
  if (![keyColumn, valueColumn, definitionColumn].every((column) => bindingColumnReadable(table, column, scope.session))) {
    throw bindingRefusal(scope.mode, field, "SOURCE_UNREADABLE", "The global variable is not available to this reader.");
  }
  consumeSourceRead(scope, field);
  const found = await sql<{ row: GeneratedEntityRow }>`
    select to_jsonb(source.*) as row
    from ${sql.id(table.schema, table.table)} as source
    where ${sql.id("source", keyColumn.name)} = ${key}
      and ${sql.id("source", "tenant_id")} = ${scope.session.tenantId}
    limit 1
  `.execute(scope.trx);
  const row = found.rows[0]?.row;
  if (!row) {
    throw bindingRefusal(scope.mode, field, "UNKNOWN_VARIABLE",
      `there is no chips.${key} variable in this organization.`);
  }
  // The same projection every read of this entity goes through: its
  // classification redaction, and the typed-value guard that refuses a stored
  // definition this runtime cannot protect (`typed-values.ts`).
  const projected = projectGeneratedEntityRow(table, scope.session, row);
  const definition = projected[definitionColumn.name];
  if (!definition || typeof definition !== "object" || Array.isArray(definition) ||
      (definition as { key?: unknown }).key !== GLOBAL_VALUE_FIELD) {
    throw bindingRefusal(scope.mode, field, "SOURCE_CONTRACT_VIOLATED",
      `chips.${key} does not declare the type of its value.`);
  }
  let schema: Record<string, unknown>;
  try {
    schema = generatedRuntimeFieldSchemas.object([definition as Record<string, unknown>]);
  } catch {
    throw bindingRefusal(scope.mode, field, "SOURCE_CONTRACT_VIOLATED",
      `the stored type of chips.${key} is not a valid field definition.`);
  }
  const property = (schema.properties as Record<string, unknown> | undefined)?.[GLOBAL_VALUE_FIELD];
  const required = Array.isArray(schema.required) && schema.required.includes(GLOBAL_VALUE_FIELD);
  const shape = property && typeof property === "object"
    ? schemaVariableShape(property as Record<string, unknown>, { required })
    : undefined;
  if (!shape) {
    throw bindingRefusal(scope.mode, field, "SOURCE_CONTRACT_VIOLATED",
      `the stored type of chips.${key} is not a value type this build can compare.`);
  }
  return { shape, value: projected[valueColumn.name] };
}

type ResolutionScope = {
  readonly trx: Transaction<DB>;
  readonly session: DbSessionInput;
  readonly table: GeneratedCrudTable;
  readonly slots: ReadonlyMap<string, VariableSlot>;
  readonly bindings: FieldBindingMap;
  /** Whether this resolution answers a write that stores it, or a live read. */
  readonly mode: "read" | "write";
  /** The literal value of each field that is not bound, by authored key. */
  readonly literals: Readonly<Record<string, unknown>>;
  /** One authorized read per global per REQUEST, however many rows bind it. */
  readonly globals: Map<string, ResolvedGlobal>;
  /** What is left of this request's source-read budget; shared with `globals`. */
  readonly budget: { reads: number };
  readonly resolved: Map<string, unknown>;
};

/**
 * One source read against this request's budget. A page of records that share
 * a few variables costs a few reads; bindings that would fan out into hundreds
 * are refused rather than served, so one request cannot turn into an
 * unbounded read amplifier.
 */
function consumeSourceRead(scope: ResolutionScope, field: string): void {
  if (scope.budget.reads <= 0) {
    throw bindingRefusal(scope.mode, field, "SOURCE_BUDGET_EXCEEDED",
      `resolving the variables of this request would read more than ${MAX_SOURCE_READS} source records.`);
  }
  scope.budget.reads -= 1;
}

/** The value of one field, resolving its binding when it has one. */
async function fieldValue(scope: ResolutionScope, field: string, chain: readonly string[]): Promise<unknown> {
  if (scope.resolved.has(field)) return scope.resolved.get(field);
  const binding = Object.hasOwn(scope.bindings, field) ? scope.bindings[field] : undefined;
  if (!binding) return Object.hasOwn(scope.literals, field) ? scope.literals[field] : undefined;
  if (chain.includes(field)) {
    throw bindingRefusal(scope.mode, field, "BINDING_CYCLE",
      `its binding resolves through itself (${[...chain, field].join(" → ")}).`);
  }
  if (chain.length >= MAX_LOCAL_DEPTH) {
    throw bindingRefusal(scope.mode, field, "BINDING_TOO_DEEP",
      `its binding resolves through more than ${MAX_LOCAL_DEPTH} other fields.`);
  }
  const value = await resolveBinding(scope, field, binding, [...chain, field]);
  const contract = bindingContractFor(scope.table);
  if (!contract) throw generatedCrudError("The destination field contract is not available.", "INVALID_DEFINITION");
  try {
    assertEntityValuesValid(contract, scope.table, { [field]: value }, { partial: true });
  } catch (error) {
    if (scope.mode === "read" && operationErrorOf(error)?.code === "VALIDATION") {
      throw bindingRefusal("read", field, "DESTINATION_CONTRACT_VIOLATED", "The live variable no longer satisfies this field's value contract.");
    }
    throw error;
  }
  scope.resolved.set(field, value);
  return value;
}

/** One variable's offer and value, from the namespace that owns it. */
async function variableValue(
  scope: ResolutionScope,
  field: string,
  expression: string,
  chain: readonly string[],
): Promise<{ offer: VariableOffer; value: unknown }> {
  const reference = ((): VariableReference => {
    try {
      return parseVariableReference(expression);
    } catch (error) {
      throw bindingFailure(scope, field, error);
    }
  })();
  if (reference.scope === "global") {
    // One authorized read per key per request, however many rows and fields
    // bind it; the cache is the request's, not this row's.
    const cached = scope.globals.get(reference.key) ??
      await resolveGlobal(scope, field, reference.key);
    scope.globals.set(reference.key, cached);
    return { offer: declaredVariableOffer(reference, cached.shape), value: cached.value };
  }
  // A local variable is another field of this same record, typed by this
  // record's own compiled definition — never by anything the caller says.
  const source = scope.slots.get(reference.key) ?? recordFieldSlot(scope.table, reference.key);
  if (!source) {
    throw bindingRefusal(scope.mode, field, "UNKNOWN_VARIABLE",
      `local.${reference.key} is not a field of this record.`);
  }
  const sourceColumn = scope.table.columns.find((column) => fieldNameForColumn(column) === reference.key);
  if (!sourceColumn || !bindingColumnReadable(scope.table, sourceColumn, scope.session)) {
    throw bindingRefusal(scope.mode, field, "SOURCE_UNREADABLE", `local.${reference.key} is not available to this reader.`);
  }
  // Runtime-typed globals already refuse entity references. Local references
  // need a target-record authorization path too; UUID shape alone is insufficient.
  if (hasReferencedValue(source)) {
    throw bindingRefusal(scope.mode, field, "SOURCE_CONTRACT_VIOLATED", "Reference-valued variable sources are not supported by this runtime.");
  }
  const { path: _path, mode: _mode, validation: _validation, ...shape } = source;
  return { offer: declaredVariableOffer(reference, shape), value: await fieldValue(scope, reference.key, chain) };
}

function hasReferencedValue(shape: VariableValueShape): boolean {
  return Boolean(shape.target) || Object.values(shape.children ?? {}).some(hasReferencedValue);
}

/** The declared contract of any field of this record, bindable or not. */
function recordFieldSlot(table: GeneratedCrudTable, field: string): VariableSlot | undefined {
  const entity = table.source?.authoringEntityName ?? table.name;
  const contract = bindingContractFor(table);
  const properties = ((contract?.inputSchema?.properties as Record<string, unknown> | undefined)?.values as
    { properties?: Record<string, unknown> } | undefined)?.properties;
  const schema = properties && Object.hasOwn(properties, field) ? properties[field] : undefined;
  if (!schema || typeof schema !== "object") return undefined;
  const column = table.columns.find((candidate) => fieldNameForColumn(candidate) === field);
  return schemaVariableSlot(`${entity}.${field}`, schema as Record<string, unknown>,
    column?.required === true ? { required: true } : {});
}

function bindingContractFor(table: GeneratedCrudTable) {
  const entity = table.source?.authoringEntityName ?? table.name;
  for (const intent of ["create", "update"]) {
    try { return entityOperationContract(`${entity}.${intent}`); } catch { /* Try the other write contract. */ }
  }
  return undefined;
}

/** The value one binding resolves to, checked against both declared contracts. */
async function resolveBinding(
  scope: ResolutionScope,
  field: string,
  binding: FieldBinding,
  chain: readonly string[],
): Promise<unknown> {
  const slot = scope.slots.get(field);
  if (!slot) throw generatedCrudError(`${field} does not accept a variable.`, "BAD_USER_INPUT");
  if (binding.kind === "whole") {
    const { offer, value } = await variableValue(scope, field, binding.ref, chain);
    try {
      assertVariableCompatible(slot, offer, "whole");
      assertVariableSourceValue(offer, value);
    } catch (error) {
      throw bindingFailure(scope, field, error);
    }
    return value;
  }
  // A template is text: every token is replaced by its variable's formatted
  // value, and a Markdown destination escapes each one as data. A template
  // that is one token is still a template — the field authored text, and the
  // result is text, not the variable's own typed value.
  const source = binding.source;
  const markdown = slot.osfType === "markdown";
  const matches = variableTokens(source);
  if (matches.length > MAX_BINDING_TOKENS) {
    throw bindingRefusal(scope.mode, field, "BINDING_TOO_MANY_VARIABLES",
      `its template carries more than ${MAX_BINDING_TOKENS} variables.`);
  }
  let result = "";
  let offset = 0;
  for (const match of matches) {
    const literal = source.slice(offset, match.index);
    const { offer, value } = await variableValue(scope, field, match[1]!, chain);
    try {
      assertVariableCompatible(slot, offer, "template");
      assertVariableSourceValue(offer, value);
      const text = variableText(value);
      const replacement = markdown ? escapeMarkdownVariableText(text) : text;
      if (result.length + literal.length + replacement.length > MAX_RESOLVED_TEMPLATE_LENGTH) {
        throw bindingRefusal(scope.mode, field, "BINDING_TOO_LARGE", "The resolved template exceeds its maximum size.");
      }
      result += literal + replacement;
    } catch (error) {
      throw bindingFailure(scope, field, error);
    }
    offset = match.index + match[0].length;
  }
  const tail = source.slice(offset);
  if (result.length + tail.length > MAX_RESOLVED_TEMPLATE_LENGTH) {
    throw bindingRefusal(scope.mode, field, "BINDING_TOO_LARGE", "The resolved template exceeds its maximum size.");
  }
  return result + tail;
}

/**
 * The scope of one row's resolution. `globals` and `budget` are the REQUEST's
 * and are passed in, so a page of records reads each variable once and the
 * whole page shares one read budget; everything else is this row's.
 */
function resolutionScope(
  trx: Transaction<DB>,
  session: DbSessionInput,
  table: GeneratedCrudTable,
  mode: "read" | "write",
  bindings: FieldBindingMap,
  literals: Readonly<Record<string, unknown>>,
  request: { globals: Map<string, ResolvedGlobal>; budget: { reads: number } },
): ResolutionScope {
  return {
    trx,
    session,
    table,
    mode,
    slots: bindableSlots(table, bindableFields(table)),
    bindings,
    literals,
    globals: request.globals,
    budget: request.budget,
    resolved: new Map(),
  };
}

/** A fresh per-request source cache and read budget. */
function resolutionRequest(): { globals: Map<string, ResolvedGlobal>; budget: { reads: number } } {
  return { globals: new Map(), budget: { reads: MAX_SOURCE_READS } };
}

export type PreparedFieldBindings = {
  /** The caller's values with every bound field's resolved value merged in. */
  readonly values: Record<string, unknown>;
  /** The map to store, when this entity has a bindings column at all. */
  readonly bindings?: { readonly column: string; readonly value: FieldBindingMap | null };
};

/**
 * The binding half of one create or update, resolved before the write.
 *
 * The resulting map is the record's current one minus every field the caller
 * sent a literal for or asked to unbind, plus every binding it supplied. Each
 * field of that map is then resolved and merged into the values, so the
 * Operation's own contract validates a bound value exactly as it validates a
 * literal, and the row that is written agrees with its bindings.
 */
export async function prepareFieldBindings(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  table: GeneratedCrudTable,
  input: { values: Record<string, unknown>; bindings?: unknown; unbind?: unknown },
  current: GeneratedEntityRow | undefined,
): Promise<PreparedFieldBindings> {
  const bindable = bindableFields(table);
  const requested = requestedBindings(table, bindable, input);
  for (const field of requested.bindings.keys()) {
    if (Object.hasOwn(input.values, field)) {
      throw generatedCrudError(`${field} cannot be supplied as both a literal and a binding.`, "BAD_USER_INPUT");
    }
  }
  const column = fieldBindingsColumn(table);
  if (!column || bindable.size === 0) return { values: input.values };
  const stored = fieldBindingMap(current?.[column.name]);
  if (stored === undefined) {
    throw generatedCrudError("The stored field bindings of this record are not valid.", "INVALID_DEFINITION");
  }
  const next = new Map<string, FieldBinding>();
  for (const [field, binding] of Object.entries(stored)) {
    // A literal for the field replaces its binding; so does an explicit
    // unbind, which keeps the value resolved below instead of the binding.
    if (Object.hasOwn(input.values, field) || requested.unbind.has(field)) continue;
    if (!bindable.has(field)) continue;
    next.set(field, binding);
  }
  for (const [field, binding] of requested.bindings) next.set(field, binding);
  const bindings: FieldBindingMap = Object.fromEntries(next);
  const value = next.size === 0 ? null : bindings;
  // An unbind resolves the source once more and keeps that value; a literal
  // for the same field is the caller's own value and needs no resolution.
  const freezing = [...requested.unbind].filter((field) =>
    !Object.hasOwn(input.values, field) && Object.hasOwn(stored, field));
  if (next.size === 0 && freezing.length === 0) {
    // Nothing is bound after this write. The column is cleared only when it
    // held something, so an ordinary write of an unbound record is untouched.
    return Object.keys(stored).length === 0
      ? { values: input.values }
      : { values: input.values, bindings: { column: column.name, value: null } };
  }
  const values = { ...input.values };
  const request = resolutionRequest();
  await withDbSession(db, session, async (trx, resolvedSession) => {
    // The frozen value of an unbound field is what its source says now, never
    // the column's possibly stale content.
    const frozen = resolutionScope(trx, resolvedSession, table, "write",
      Object.fromEntries(freezing.map((field) => [field, stored[field]!])),
      recordLiterals(table, current, values), request);
    for (const field of freezing) values[field] = await fieldValue(frozen, field, []);
    const scope = resolutionScope(trx, resolvedSession, table, "write", bindings,
      recordLiterals(table, current, values), request);
    for (const field of next.keys()) values[field] = await fieldValue(scope, field, []);
  });
  return { values, bindings: { column: column.name, value } };
}

/**
 * What a local binding reads: the values this write will leave on the record.
 * The caller's own values first, then the row it is updating — so a binding
 * on `local.x` sees the x of this write, not the one it replaces.
 */
function recordLiterals(
  table: GeneratedCrudTable,
  current: GeneratedEntityRow | undefined,
  values: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const literals: Record<string, unknown> = {};
  for (const column of table.columns) {
    const field = fieldNameForColumn(column);
    if (current && Object.hasOwn(current, column.name)) literals[field] = current[column.name];
  }
  return { ...literals, ...values };
}

/**
 * Every binding of these rows, resolved again for this reader. The stored
 * column is never returned as the value of a bound field: a later source
 * change is visible, and a source this reader may not read, or that no longer
 * fits the destination, is a refusal.
 */
export async function resolveBoundEntityRows(
  trx: Transaction<DB>,
  session: DbSessionInput,
  table: GeneratedCrudTable,
  rows: readonly GeneratedEntityRow[],
): Promise<GeneratedEntityRow[]> {
  const bindable = bindableFields(table);
  const column = fieldBindingsColumn(table);
  if (!column || bindable.size === 0 || rows.length === 0) return [...rows];
  const resolvedRows: GeneratedEntityRow[] = [];
  // One cache and one budget for the whole page: 50 records that bind the
  // same two variables read two source records, not a hundred.
  const request = resolutionRequest();
  for (const row of rows) {
    const stored = fieldBindingMap(row[column.name]);
    if (stored === undefined) {
      throw generatedCrudError("The stored field bindings of this record are not valid.", "INVALID_DEFINITION");
    }
    if (Object.keys(stored).length === 0) {
      resolvedRows.push(row);
      continue;
    }
    const scope = resolutionScope(trx, session, table, "read", stored, recordLiterals(table, row, {}), request);
    const resolved: GeneratedEntityRow = { ...row };
    for (const field of Object.keys(stored)) {
      const declared = bindable.get(field);
      if (!declared) {
        throw generatedCrudError("A stored binding names a field that accepts none.", "INVALID_DEFINITION");
      }
      resolved[declared.column] = await fieldValue(scope, field, []);
    }
    resolvedRows.push(resolved);
  }
  return resolvedRows;
}
