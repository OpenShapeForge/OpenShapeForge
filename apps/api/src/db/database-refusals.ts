// SPDX-License-Identifier: BUSL-1.1
/**
 * The one place a database error is allowed to become a client-facing answer.
 *
 * Authored rules live in PL/pgSQL triggers and guard functions (a plugin's
 * tenant-consistency checks, an integration's publication gate, a status
 * transition rule). When such a rule refuses a write it RAISEs, the driver
 * throws, and until now every transport redacted that to
 * `INTERNAL_SERVER_ERROR` — the caller could not learn WHY the write was
 * refused, and a refusal that is the rule working looked like an outage.
 *
 * What is exposed, and why it is safe
 * ------------------------------------
 * Two kinds of database error become a readable 4xx:
 *
 *   1. A RAISED refusal. Postgres tags an error with the internal routine
 *      that produced it; `exec_stmt_raise` is the PL/pgSQL RAISE statement
 *      and nothing else. An error from that routine carries text a person on
 *      the platform side wrote for exactly this purpose — its MESSAGE, DETAIL
 *      and HINT are authored for a human reader — so they are forwarded as
 *      the answer. The public code follows the SQLSTATE the author chose
 *      (`raise_exception` P0001 is a refused operation, the integrity class
 *      23xxx maps to the constraint vocabulary below, `insufficient_privilege`
 *      42501 is forbidden), unless the message itself opens with
 *      `UPPERCASE_CODE: reason`, in which case that code is used verbatim.
 *      Postgres never phrases its own errors that way.
 *
 *   2. A SYSTEM constraint violation reworded in the API's own vocabulary: a
 *      foreign key that points at nothing becomes `REFERENCE_NOT_FOUND`, a
 *      duplicate `ALREADY_EXISTS`, a failed check or missing value
 *      `VALIDATION`, a permission or row-level-security refusal `FORBIDDEN`.
 *      The public field name is included only when it can be derived from a
 *      declared relationship or a known constraint shape; the driver's message,
 *      the constraint name, the table name and the offending values (`detail`)
 *      are never forwarded.
 *
 * Everything else — syntax errors, cast failures, connection faults, driver
 * text — stays exactly as redacted as before. A misclassification here would
 * be a leak, so the recognisers are narrow on purpose and the unit tests pin
 * the negative cases.
 */
import { httpStatusForCode } from "../connectors/provider-outcome.js";

export type DatabaseRefusal = {
  status: number;
  code: string;
  message: string;
  /** Authored DETAIL of a RAISEd refusal; never a system detail. */
  detail?: string;
  /** Authored HINT of a RAISEd refusal; never a system hint. */
  hint?: string;
};

/** The driver-independent facts this module reads off a database error. */
export type DatabaseErrorFacts = {
  sqlstate: string;
  message: string;
  /** The Postgres source routine that reported the error (`exec_stmt_raise` for RAISE). */
  routine?: string;
  detail?: string;
  hint?: string;
  constraint?: string;
  table?: string;
};

/**
 * What a write path knows about the table it wrote, so a constraint violation
 * can name the public field instead of the database column.
 */
export type DatabaseErrorTableContext = {
  /** Bare table name (no schema): the prefix in Postgres' default constraint names. */
  table: string;
  /** Public field name for a column, or undefined when the column is not exposed. */
  fieldName: (column: string) => string | undefined;
  /** Columns declared as `belongsTo` foreign keys on the entity. */
  belongsTo: ReadonlySet<string>;
};

const SQLSTATE_RAISE_EXCEPTION = "P0001";
const SQLSTATE_NOT_NULL_VIOLATION = "23502";
const SQLSTATE_FOREIGN_KEY_VIOLATION = "23503";
const SQLSTATE_UNIQUE_VIOLATION = "23505";
const SQLSTATE_CHECK_VIOLATION = "23514";
const SQLSTATE_INSUFFICIENT_PRIVILEGE = "42501";
const INTEGRITY_CONSTRAINT_CLASS = "23";

/** The PL/pgSQL routine behind every RAISE statement; the structural mark of authored text. */
const RAISE_ROUTINE = "exec_stmt_raise";

/** `UPPERCASE_CODE: reason` — the convention an authored message may follow to pick its code. */
const AUTHORED_MESSAGE = /^([A-Z][A-Z0-9_]*[A-Z0-9]): (\S.*)$/s;

/**
 * Status per public code. Kept local rather than only in the canonical
 * transport table because VALIDATION is answered 400 elsewhere on the
 * platform for malformed arguments, while a database check that the row
 * fails is a well-formed request the rule rejects: 422.
 */
const STATUS_BY_CODE: Record<string, number> = {
  OPERATION_REFUSED: 409,
  REFERENCE_NOT_FOUND: 404,
  REFERENCE_IN_USE: 409,
  ALREADY_EXISTS: 409,
  VALIDATION: 422,
  FORBIDDEN: 403,
};

const DEFAULT_AUTHORED_STATUS = 409;

const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;

/**
 * Reads the facts off a Postgres error from either driver the runtime has used:
 * Bun's `SQL` (SQLSTATE in `errno`, `constraint`, `table`) and postgres.js
 * (SQLSTATE in `code`, `constraint_name`, `table_name`). Both name the class
 * `PostgresError`; anything else is not a database error and returns undefined.
 */
export function readDatabaseError(error: unknown): DatabaseErrorFacts | undefined {
  if (!(error instanceof Error) || error.name !== "PostgresError") return undefined;
  const raw = error as Error & {
    code?: unknown;
    errno?: unknown;
    routine?: unknown;
    detail?: unknown;
    hint?: unknown;
    constraint?: unknown;
    constraint_name?: unknown;
    table?: unknown;
    table_name?: unknown;
  };
  const sqlstate = [raw.errno, raw.code].find(
    (candidate): candidate is string =>
      typeof candidate === "string" && SQLSTATE_PATTERN.test(candidate),
  );
  if (!sqlstate) return undefined;
  const routine = firstString(raw.routine);
  const detail = firstString(raw.detail);
  const hint = firstString(raw.hint);
  const constraint = firstString(raw.constraint, raw.constraint_name);
  const table = firstString(raw.table, raw.table_name);
  return {
    sqlstate,
    message: error.message,
    ...(routine !== undefined ? { routine } : {}),
    ...(detail !== undefined ? { detail } : {}),
    ...(hint !== undefined ? { hint } : {}),
    ...(constraint !== undefined ? { constraint } : {}),
    ...(table !== undefined ? { table } : {}),
  };
}

function firstString(...candidates: unknown[]): string | undefined {
  return candidates.find(
    (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
  );
}

function statusFor(code: string): number {
  return STATUS_BY_CODE[code] ?? httpStatusForCode(code) ?? DEFAULT_AUTHORED_STATUS;
}

/** The public code a RAISEd refusal gets from the SQLSTATE its author chose. */
function raisedCodeFor(sqlstate: string): string | undefined {
  if (sqlstate === SQLSTATE_RAISE_EXCEPTION) return "OPERATION_REFUSED";
  if (sqlstate === SQLSTATE_INSUFFICIENT_PRIVILEGE) return "FORBIDDEN";
  if (sqlstate === SQLSTATE_FOREIGN_KEY_VIOLATION) return "REFERENCE_NOT_FOUND";
  if (sqlstate === SQLSTATE_UNIQUE_VIOLATION) return "ALREADY_EXISTS";
  if (sqlstate.startsWith(INTEGRITY_CONSTRAINT_CLASS)) return "VALIDATION";
  return undefined;
}

/**
 * A refusal RAISEd by PL/pgSQL, or undefined when the error was not raised
 * by a RAISE statement or its SQLSTATE is not one a refusal is raised with.
 * Message, detail and hint are forwarded as authored.
 */
export function raisedRefusal(facts: DatabaseErrorFacts): DatabaseRefusal | undefined {
  if (facts.routine !== RAISE_ROUTINE) return undefined;
  const bySqlstate = raisedCodeFor(facts.sqlstate);
  if (!bySqlstate) return undefined;
  const match = AUTHORED_MESSAGE.exec(facts.message);
  const [code, message] = match
    ? [match[1] as string, (match[2] as string).trim()]
    : [bySqlstate, facts.message.trim()];
  return {
    status: statusFor(code),
    code,
    message,
    ...(facts.detail !== undefined ? { detail: facts.detail } : {}),
    ...(facts.hint !== undefined ? { hint: facts.hint } : {}),
  };
}

/**
 * Classifies a database error into a client-facing refusal, or returns
 * undefined when it must stay redacted. `context` lets a generated write path
 * name the public field behind a constraint; without it the constraint
 * answers are generic but still correctly coded.
 */
export function classifyDatabaseError(
  error: unknown,
  context?: DatabaseErrorTableContext,
): DatabaseRefusal | undefined {
  const facts = readDatabaseError(error);
  if (!facts) return undefined;

  const raised = raisedRefusal(facts);
  if (raised) return raised;

  switch (facts.sqlstate) {
    case SQLSTATE_FOREIGN_KEY_VIOLATION:
      return foreignKeyRefusal(facts, context);
    case SQLSTATE_UNIQUE_VIOLATION:
      return uniqueRefusal(facts, context);
    case SQLSTATE_CHECK_VIOLATION:
      return checkRefusal(facts, context);
    case SQLSTATE_NOT_NULL_VIOLATION:
      return notNullRefusal(facts, context);
    case SQLSTATE_INSUFFICIENT_PRIVILEGE:
      return {
        status: statusFor("FORBIDDEN"),
        code: "FORBIDDEN",
        message: "You do not have permission to perform this operation on this record.",
      };
    default:
      return undefined;
  }
}

/**
 * Postgres reports a foreign-key failure from both sides with the same
 * SQLSTATE. Which side is told apart by the fixed opening words of its
 * message — used as a discriminator only, never forwarded.
 */
const PARENT_SIDE_FOREIGN_KEY = /^update or delete on table /;

function foreignKeyRefusal(
  facts: DatabaseErrorFacts,
  context: DatabaseErrorTableContext | undefined,
): DatabaseRefusal {
  if (PARENT_SIDE_FOREIGN_KEY.test(facts.message)) {
    return {
      status: statusFor("REFERENCE_IN_USE"),
      code: "REFERENCE_IN_USE",
      message: "This record is still referenced by other records and cannot be removed.",
    };
  }
  const field = foreignKeyField(facts, context);
  return {
    status: statusFor("REFERENCE_NOT_FOUND"),
    code: "REFERENCE_NOT_FOUND",
    message: field
      ? `${field} does not refer to a record that exists or is visible to you.`
      : "A referenced record does not exist or is not visible to you.",
  };
}

/**
 * `<table>_<column>_fkey` is the default name Postgres gives a single-column
 * foreign key, and the shape the compiler emits. The column must additionally
 * be a declared belongsTo on the entity — that is what makes naming it a
 * statement about the API contract rather than about the schema.
 */
function foreignKeyField(
  facts: DatabaseErrorFacts,
  context: DatabaseErrorTableContext | undefined,
): string | undefined {
  const column = constraintColumn(facts, context, "_fkey");
  if (column === undefined || !context?.belongsTo.has(column)) return undefined;
  return context.fieldName(column);
}

function uniqueRefusal(
  facts: DatabaseErrorFacts,
  context: DatabaseErrorTableContext | undefined,
): DatabaseRefusal {
  const field = uniqueField(facts, context);
  return {
    status: statusFor("ALREADY_EXISTS"),
    code: "ALREADY_EXISTS",
    message: field
      ? `A record with this ${field} already exists.`
      : "A record with the same unique value already exists.",
  };
}

/**
 * The unique-constraint shapes whose single business column can be read back
 * from the name: Postgres' default `<table>_[tenant_id_]<column>_key`, and the
 * compiler's per-tenant index `<anything>_tenant_<column>_uidx`. The candidate
 * must be an exposed column of the table, or the answer stays generic.
 */
function uniqueField(
  facts: DatabaseErrorFacts,
  context: DatabaseErrorTableContext | undefined,
): string | undefined {
  if (!context || !facts.constraint) return undefined;
  const name = facts.constraint;
  let candidate: string | undefined;
  if (name.endsWith("_key") && name.startsWith(`${context.table}_`)) {
    candidate = name.slice(context.table.length + 1, -"_key".length);
    if (candidate.startsWith("tenant_id_")) candidate = candidate.slice("tenant_id_".length);
  } else if (name.endsWith("_uidx")) {
    const marker = "_tenant_";
    const at = name.lastIndexOf(marker);
    if (at >= 0) candidate = name.slice(at + marker.length, -"_uidx".length);
  }
  if (!candidate || candidate === "tenant_id") return undefined;
  return context.fieldName(candidate);
}

/** `<table>_<column>_check` is Postgres' default name for a single-column check. */
function checkRefusal(
  facts: DatabaseErrorFacts,
  context: DatabaseErrorTableContext | undefined,
): DatabaseRefusal {
  const column = constraintColumn(facts, context, "_check");
  const field = column === undefined ? undefined : context?.fieldName(column);
  return {
    status: statusFor("VALIDATION"),
    code: "VALIDATION",
    message: field
      ? `${field} has a value this record does not allow.`
      : "A value on this record is not allowed.",
  };
}

/**
 * Postgres reports the column of a not-null violation only inside its message
 * (`null value in column "x" of relation "y" ...`); the quoted name is read
 * as a lookup key and only ever surfaces as the exposed public field name.
 */
const NOT_NULL_COLUMN = /^null value in column "([^"]+)"/;

function notNullRefusal(
  facts: DatabaseErrorFacts,
  context: DatabaseErrorTableContext | undefined,
): DatabaseRefusal {
  const column = NOT_NULL_COLUMN.exec(facts.message)?.[1];
  const field = column === undefined ? undefined : context?.fieldName(column);
  return {
    status: statusFor("VALIDATION"),
    code: "VALIDATION",
    message: field ? `${field} is required.` : "A required value is missing.",
  };
}

/** The column named by a default-named `<table>_<column><suffix>` constraint of the written table. */
function constraintColumn(
  facts: DatabaseErrorFacts,
  context: DatabaseErrorTableContext | undefined,
  suffix: string,
): string | undefined {
  if (!context || !facts.constraint) return undefined;
  const prefix = `${context.table}_`;
  if (!facts.constraint.startsWith(prefix) || !facts.constraint.endsWith(suffix)) {
    return undefined;
  }
  const column = facts.constraint.slice(prefix.length, -suffix.length);
  return column.length > 0 ? column : undefined;
}
