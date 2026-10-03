// SPDX-License-Identifier: BUSL-1.1
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { FIELD_ITEM_ID, operationFailure, type FieldValuePolicy } from "@openshapeforge/operations";
import type { GeneratedCrudColumn, GeneratedCrudTable } from "./types.js";
import { fieldNameForColumn } from "./columns.js";
import { canReadClassifiedColumns } from "./classification.js";
import { createOperationAjv } from "../operation-ajv.js";
import { violationsFromAjvErrors } from "./input-validation.js";

const ajv = createOperationAjv();
const validators = new WeakMap<FieldValuePolicy, import("ajv/dist/2020.js").ValidateFunction>();

type Session = { roles?: readonly string[] | null } | null | undefined;
const owns = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const granted = (roles: readonly string[] | undefined, session: Session) =>
  roles === undefined || roles.some((role) => session?.roles?.includes(role));

export function columnFieldPolicy(column: Pick<GeneratedCrudColumn, "fieldPolicy" | "classification" | "immutable" | "writtenBy">): FieldValuePolicy {
  return {
    ...(column.classification ? { classification: column.classification } : {}),
    ...(column.immutable ? { immutable: true } : {}),
    ...(column.writtenBy?.length ? { writtenBy: column.writtenBy.map((writer) => writer.operation) } : {}),
    ...column.fieldPolicy,
  };
}

export function hasUnreadableField(policy: FieldValuePolicy, session: Session, classified: boolean): boolean {
  return !granted(policy.readRoles, session) || Boolean(policy.classification && !classified) ||
    Object.values(policy.children ?? {}).some((child) => hasUnreadableField(child, session, classified)) ||
    Boolean(policy.item && hasUnreadableField(policy.item, session, classified));
}

export function redactFieldValue(value: unknown, policy: FieldValuePolicy, session: Session, classified: boolean): unknown {
  if (!granted(policy.readRoles, session) || (policy.classification && !classified)) {
    return object(value) && typeof value[FIELD_ITEM_ID] === "string" ? { [FIELD_ITEM_ID]: value[FIELD_ITEM_ID] } : null;
  }
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    const item = policy.item ?? (policy.children ? { children: policy.children } : undefined);
    return item ? value.map((entry) => redactFieldValue(entry, item, session, classified)) : value;
  }
  if (policy.item) return null; // Malformed stored collection must fail closed.
  if (!policy.children) return value;
  if (!object(value)) return null;
  const result = { ...value };
  for (const [key, child] of Object.entries(policy.children)) {
    if (owns(value, key)) result[key] = redactFieldValue(value[key], child, session, classified);
  }
  return result;
}

type WriteContext = { session: Session; operation: "create" | "update"; caller: boolean;
  writer?: string; readable: boolean; classified: boolean };

function blocked(policy: FieldValuePolicy, context: WriteContext) {
  if (context.caller && !granted(policy.writeRoles, context.session)) return "permission";
  if (context.operation === "update" && policy.immutable) return "immutable";
  if (context.caller && policy.writtenBy?.length &&
    (!context.writer || !policy.writtenBy.includes(context.writer))) return "operation";
  return undefined;
}

function refuse(path: string, reason: ReturnType<typeof blocked>, policy?: FieldValuePolicy): never {
  throw operationFailure({
    code: reason === "permission" ? "FORBIDDEN" : "BAD_USER_INPUT",
    message: reason === "permission" ? `Not authorized to change field "${path}".`
      : reason === "operation" ? `Field "${path}" can only be written by ${policy?.writtenBy?.join(", ")}.`
      : `Protected field "${path}" cannot be changed or removed.`,
  });
}

/** Select only stored values whose write protection prevents their removal. */
function protectedValue(value: unknown, policy: FieldValuePolicy, context: WriteContext): unknown {
  if (blocked(policy, context)) return value;
  if (Array.isArray(value)) {
    const item = policy.item ?? (policy.children ? { children: policy.children } : undefined);
    if (!item) return undefined;
    const selected = value.map((entry) => protectedValue(entry, item, context));
    return selected.some((entry) => entry !== undefined) ? selected : undefined;
  }
  if (!object(value)) return undefined;
  const selected = Object.fromEntries(Object.entries(policy.children ?? {}).flatMap(([key, child]) => {
    if (!owns(value, key)) return [];
    const entry = protectedValue(value[key], child, context);
    return entry === undefined ? [] : [[key, entry]];
  }));
  return Object.keys(selected).length ? selected : undefined;
}

function invalidIdentity(path: string): never {
  throw operationFailure({ code: "BAD_USER_INPUT", message: `Invalid or duplicate collection item identity in "${path}".` });
}

function prepareItems(value: unknown[], before: unknown, policy: FieldValuePolicy,
  context: WriteContext, path: string, readable: boolean): unknown[] {
  const item = policy.item ?? (policy.children ? { children: policy.children } : undefined);
  if (!item) return value;
  const previous = Array.isArray(before) ? before : [];
  const used = new Set<number>();
  const key = policy.itemKey;
  const identities = new Set<string>();
  if (key && previous.some(entry => !object(entry) || typeof entry[key] !== "string")) {
    throw operationFailure({ code: "INTERNAL_SERVER_ERROR", message: `Stored collection "${path}" lacks generated item identities.` });
  }
  const prepared = value.map((entry, index) => {
    let previousIndex = -1;
    let identity: string | undefined;
    if (key) {
      if (!object(entry)) invalidIdentity(path);
      if (owns(entry, key)) {
        if (typeof entry[key] !== "string" || identities.has(entry[key])) invalidIdentity(path);
        identity = entry[key]; identities.add(identity);
        previousIndex = previous.findIndex(old => object(old) && old[key] === identity);
        if (context.caller && (context.operation === "create" || previousIndex === -1)) invalidIdentity(path);
      }
    } else {
      previousIndex = previous.findIndex((old, at) => !used.has(at) && isDeepStrictEqual(old, entry));
      // Non-identified structured items retain replacement semantics. The
      // compiler gives every protected object item a key; no positional merge.
    }
    if (previousIndex !== -1) used.add(previousIndex);
    const old = previousIndex === -1 ? undefined : previous[previousIndex];
    if (key && old && object(entry) && Object.keys(entry).every(name => name === key)) return old;
    // Moving an unchanged readable scalar changes only its array position.
    if (!key && old !== undefined && readable && granted(item.readRoles, context.session) &&
      (!item.classification || context.classified) && isDeepStrictEqual(entry, old)) return old;
    const next = prepareValue(entry, old, item,
      { ...context, readable, operation: old === undefined ? "create" : "update" }, `${path}[${index}]`);
    return key && object(next) ? { ...next, [key]: identity ?? randomUUID() } : next;
  });
  if (previous.some((entry, index) => !used.has(index) && protectedValue(entry, item, context) !== undefined)) {
    refuse(path, "immutable");
  }
  return prepared;
}

function prepareValue(value: unknown, before: unknown, policy: FieldValuePolicy,
  context: WriteContext, path: string): unknown {
  const reason = blocked(policy, context);
  const readable = context.readable && granted(policy.readRoles, context.session) &&
    (!policy.classification || context.classified);
  if (reason) {
    if (reason !== "permission" && context.operation === "update" &&
      (!context.caller || readable) && isDeepStrictEqual(value, before)) return before;
    refuse(path, reason, policy);
  }
  if (Array.isArray(value)) {
    return prepareItems(value, before, policy, context, path, readable);
  }
  if (!object(value)) {
    if (protectedValue(before, policy, context) !== undefined) refuse(path, "immutable");
    return value;
  }
  if (Array.isArray(before) && protectedValue(before, policy, context) !== undefined) refuse(path, "immutable");
  if (!policy.children) return value;
  const previous = object(before) ? before : {};
  const result = context.caller ? { ...previous, ...value } : { ...value };
  for (const [key, child] of Object.entries(policy.children ?? {})) {
    if (owns(value, key)) {
      result[key] = prepareValue(value[key], previous[key], child, { ...context, readable }, `${path}.${key}`);
    } else if (!context.caller && protectedValue(previous[key], child, context) !== undefined) {
      refuse(`${path}.${key}`, "immutable");
    }
  }
  return result;
}

/** Runs against the locked storage row on update, before any assignment. */
export function prepareProtectedFieldWrites(
  table: GeneratedCrudTable,
  session: Session,
  values: Map<GeneratedCrudColumn, unknown>,
  operation: "create" | "update",
  before?: Record<string, unknown>,
  caller = true,
  trustedFields: readonly string[] = [],
): Map<GeneratedCrudColumn, unknown> {
  const classified = canReadClassifiedColumns(table.source?.authorization, session);
  const context = { session, operation, caller, readable: true, classified };
  const prepared = new Map(values);
  for (const [column, value] of values) {
    if (!column.fieldPolicy) continue;
    if (column.type === "jsonb" && value !== null && typeof value === "object" &&
      !Array.isArray(value) && !object(value)) {
      throw operationFailure({ code: "INTERNAL_SERVER_ERROR", message: "Protected JSON writes require a concrete value." });
    }
    const merged = prepareValue(value, before?.[column.name], columnFieldPolicy(column),
      { ...context, caller: caller && !trustedFields.includes(fieldNameForColumn(column)) }, fieldNameForColumn(column));
    if (column.fieldPolicy.valueSchema && !(merged === null && !column.required)) {
      const validate = validators.get(column.fieldPolicy) ?? ajv.compile(column.fieldPolicy.valueSchema);
      validators.set(column.fieldPolicy, validate);
      if (!validate(merged)) {
        throw operationFailure({ code: "VALIDATION", message: `The saved value of ${fieldNameForColumn(column)} is invalid.`,
          violations: violationsFromAjvErrors(validate.errors ?? []).map((violation) => ({ ...violation,
            field: [fieldNameForColumn(column), violation.field].filter(Boolean).join(".") })), retryable: false });
      }
    }
    prepared.set(column, merged);
  }
  return prepared;
}

export function assertCallerTopLevelFields(table: GeneratedCrudTable, session: Session,
  input: Record<string, unknown>, operation: "create" | "update", writer?: string): void {
  for (const column of table.columns) {
    const field = fieldNameForColumn(column);
    if (!owns(input, field) && !owns(input, column.name)) continue;
    const policy = columnFieldPolicy(column);
    const reason = blocked(policy, { session, operation, caller: true, readable: true, classified: false,
      ...(writer ? { writer } : {}) });
    if (reason) refuse(field, reason, policy);
  }
}

/** Plugin inputs are checked before their handler receives runtime-owned write services. */
export function assertCallerNestedFields(table: GeneratedCrudTable, session: Session,
  input: Readonly<Record<string, unknown>>, writer: string, operation: "create" | "update"): void {
  const check = (value: unknown, policy: FieldValuePolicy, path: string): void => {
    if (!granted(policy.writeRoles, session)) refuse(path, "permission", policy);
    if (operation === "update" && policy.immutable) refuse(path, "immutable", policy);
    if (policy.writtenBy?.length && !policy.writtenBy.includes(writer)) refuse(path, "operation", policy);
    if (Array.isArray(value)) {
      const item = policy.item ?? (policy.children ? { children: policy.children } : undefined);
      if (item) value.forEach((entry, index) => check(entry, item, `${path}[${index}]`));
    } else if (object(value)) {
      for (const [key, child] of Object.entries(policy.children ?? {})) {
        if (owns(value, key)) check(value[key], child, `${path}.${key}`);
      }
    }
  };
  for (const column of table.columns) {
    if (!column.fieldPolicy) continue;
    const field = fieldNameForColumn(column);
    if (owns(input, field)) check(input[field], column.fieldPolicy, field);
    if (column.name !== field && owns(input, column.name)) check(input[column.name], column.fieldPolicy, field);
  }
}
