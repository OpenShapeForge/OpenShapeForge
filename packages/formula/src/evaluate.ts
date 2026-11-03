// SPDX-License-Identifier: BUSL-1.1
// Evaluates a formula for one record. Every operator's meaning is the
// canonical evaluator's: this walk evaluates the operands, hands each node to
// `evaluateExpression` with its operands as literals, and inspects the
// result. That is what turns a division by zero, a NaN or an impossible date
// into a per-record error code at the node where it happened, instead of an
// Infinity that surfaces three operators later or not at all.
//
// IF, SWITCH, AND, OR and ISERROR are walked lazily, so `IF({b} = 0, 0, {a} / {b})`
// never divides by zero and `ISERROR(...)` catches an error instead of
// propagating it. Nothing throws: anything unforeseen is a `typeError`.
//
// Every value is bounded, so a result always fits the typed index and no
// formula can make a write allocate without limit: text is at most
// MAX_TEXT_LENGTH characters on the way and MAX_RESULT_TEXT_LENGTH (and
// MAX_RESULT_TEXT_BYTES) as a result, both `textTooLong` beyond; a text function whose output can outgrow
// its input by more than a constant factor (`&`, CONCATENATE, SUBSTITUTE) is
// refused before it builds the text. A date or timestamp lies in the years
// 0001 to 9999 (`invalidDate` otherwise), a number is finite and is rounded
// to ROUNDING_DECIMALS decimals as a result, so binary noise such as
// 0.1 + 0.2 = 0.30000000000000004 never reaches the index.
import type { CompilerExpressionInput } from "./canonical/canonical-condition.js";
import { evaluateExpression, isErrorValue } from "./canonical/expression-evaluator.js";
import { fieldPath } from "./check.js";
import type {
  FormulaAst,
  FormulaEnvironment,
  FormulaErrorCode,
  FormulaEvaluation,
  FormulaRecord,
  FormulaType,
  FormulaValue,
} from "./types.js";

export type EvaluateOptions = {
  /**
   * The fields the formula was bound against. With it, field values arrive as
   * they are stored (ISO text for dates and timestamps, numeric text for
   * numbers) and are read as their type; without it they must already be
   * JavaScript values (`Date`, `number`).
   */
  env?: FormulaEnvironment;
  /** The formula's static result type; the value is normalised to it (dates as `YYYY-MM-DD`). */
  resultType?: FormulaType;
};

class Fault {
  constructor(readonly code: FormulaErrorCode) {}
}

type Outcome = unknown;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

const literal = (value: unknown): CompilerExpressionInput => ({ kind: "literal", value });
const utf8 = new TextEncoder();

/** The longest text a formula builds on the way to its result. */
export const MAX_TEXT_LENGTH = 10_000;
/** The longest text a formula may produce. */
export const MAX_RESULT_TEXT_LENGTH = 1_000;
/**
 * And its most bytes as UTF-8: what one row of the typed index holds
 * (PostgreSQL refuses a btree entry beyond 2704 bytes, and 1000 characters
 * of non-Latin script are up to 3000).
 */
export const MAX_RESULT_TEXT_BYTES = 2_000;
/** The decimals a number result keeps. */
export const ROUNDING_DECIMALS = 10;
/** A date or timestamp lies in the years 0001 to 9999: from the first instant, before the last. */
const FIRST_INSTANT = Date.parse("0001-01-01T00:00:00.000Z");
const END_INSTANT = Date.parse("+010000-01-01T00:00:00.000Z");

/**
 * The value of `ast` for `record`, or the reason it has none. `record` holds
 * fields by id, owned children under their relation name (`{ pricing: { amount: 5 } }`),
 * and `id` / `createdAt` for RECORD_ID() and CREATED_TIME().
 */
export function evaluate(ast: FormulaAst, record: FormulaRecord, options: EvaluateOptions = {}): FormulaEvaluation {
  try {
    const types = new Map((options.env ?? []).map((field) => [fieldPath(field), field.type]));
    const outcome = run(ast, record, types);
    if (outcome instanceof Fault) return { ok: false, error: outcome.code };
    return finish(outcome, options.resultType);
  } catch {
    return { ok: false, error: "typeError" };
  }
}

function run(node: CompilerExpressionInput, record: FormulaRecord, types: Map<string, string>): Outcome {
  const kind = (node as { kind?: string }).kind;
  switch (kind) {
    case "literal":
      return check((node as { value: unknown }).value ?? null);
    case "path":
      return readField((node as { path: string }).path, record, types);
    case "if": {
      const { condition, then } = node as { condition: CompilerExpressionInput; then: CompilerExpressionInput };
      const test = run(condition, record, types);
      if (test instanceof Fault) return test;
      const branch = test === true ? then : (node as { else?: CompilerExpressionInput }).else;
      return branch === undefined ? null : run(branch, record, types);
    }
    case "switch": {
      const sw = node as {
        subject: CompilerExpressionInput;
        cases: Array<{ when: CompilerExpressionInput; then: CompilerExpressionInput }>;
        default?: CompilerExpressionInput;
      };
      const subject = run(sw.subject, record, types);
      if (subject instanceof Fault) return subject;
      for (const entry of sw.cases) {
        const pattern = run(entry.when, record, types);
        if (pattern instanceof Fault) return pattern;
        const equal = evaluateExpression(
          { kind: "rule", operator: "equals", left: literal(subject), right: literal(pattern) },
          {},
        );
        if (equal === true) return run(entry.then, record, types);
      }
      return sw.default === undefined ? null : run(sw.default, record, types);
    }
    case "group": {
      const group = node as { mode?: string; conditions?: CompilerExpressionInput[]; all?: CompilerExpressionInput[]; any?: CompilerExpressionInput[] };
      const any = (group.mode ?? (group.any ? "any" : "all")) === "any";
      for (const condition of group.conditions ?? group.all ?? group.any ?? []) {
        const value = run(condition, record, types);
        if (value instanceof Fault) return value;
        if (any && value === true) return true;
        if (!any && value !== true) return false;
      }
      return !any;
    }
    case "formula": {
      const { op, operands } = node as { op: string; operands: CompilerExpressionInput[] };
      if (op === "isError") {
        const value = run(operands[0]!, record, types);
        return value instanceof Fault || isErrorValue(value);
      }
      const values: unknown[] = [];
      for (const operand of operands) {
        const value = run(operand, record, types);
        if (value instanceof Fault) return value;
        values.push(value);
      }
      if ((op === "div" || op === "mod") && values.slice(1).some((value) => toDivisor(value) === 0)) {
        return new Fault("divideByZero");
      }
      if (builtLength(op, values) > MAX_TEXT_LENGTH) return new Fault("textTooLong");
      return check(evaluateExpression({ ...node, operands: values.map(literal) } as CompilerExpressionInput, {}));
    }
    case "rule": {
      const rule = node as { left: CompilerExpressionInput; right?: CompilerExpressionInput };
      const left = run(rule.left, record, types);
      if (left instanceof Fault) return left;
      const right = rule.right === undefined ? undefined : run(rule.right, record, types);
      if (right instanceof Fault) return right;
      return evaluateExpression(
        { ...node, left: literal(left), ...(rule.right === undefined ? {} : { right: literal(right) }) } as CompilerExpressionInput,
        {},
      );
    }
    case "date": {
      const date = node as { left?: CompilerExpressionInput; right?: CompilerExpressionInput };
      const left = date.left === undefined ? undefined : run(date.left, record, types);
      if (left instanceof Fault) return left;
      const right = date.right === undefined ? undefined : run(date.right, record, types);
      if (right instanceof Fault) return right;
      return check(
        evaluateExpression(
          {
            ...node,
            ...(date.left === undefined ? {} : { left: literal(left) }),
            ...(date.right === undefined ? {} : { right: literal(right) }),
          } as CompilerExpressionInput,
          {},
        ),
      );
    }
    default:
      // function (RECORD_ID, CREATED_TIME) and anything without operands.
      return check(evaluateExpression(node, record));
  }
}

/**
 * The length of the text `op` would build from `values`, for the operators
 * whose output can outgrow their input by more than a constant factor;
 * counted without building it. Every other operator returns 0 here: its text
 * is at most a few times its (already bounded) input, and is checked after.
 */
function builtLength(op: string, values: readonly unknown[]): number {
  switch (op) {
    case "concat":
      return values.reduce<number>((total, value) => total + textOf(value).length, 0);
    case "substitute": {
      const [text, needle, replacement] = values.slice(0, 3).map(textOf) as [string, string, string];
      if (needle === "" || replacement.length <= needle.length) return 0;
      const occurrence = values[3];
      let count = 0;
      for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
        count += 1;
        if (occurrence !== null && occurrence !== undefined) break;
      }
      return text.length + count * (replacement.length - needle.length);
    }
    default:
      return 0;
  }
}

/** A value as the canonical evaluator turns it into text. */
function textOf(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  return String(value);
}

function toDivisor(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return 0;
  return typeof value === "number" ? value : undefined;
}

/** A NaN, an infinity, an invalid date or a text beyond MAX_TEXT_LENGTH becomes the fault that explains it. */
function check(value: unknown): Outcome {
  if (typeof value === "number") {
    if (Number.isNaN(value)) return new Fault("invalidNumber");
    if (!Number.isFinite(value)) return new Fault("numberOutOfRange");
  }
  if (typeof value === "string" && value.length > MAX_TEXT_LENGTH) return new Fault("textTooLong");
  if (value instanceof Date && Number.isNaN(value.getTime())) return new Fault("invalidDate");
  return value === undefined ? null : value;
}

function readField(path: string, record: FormulaRecord, types: Map<string, string>): Outcome {
  const raw = evaluateExpression({ kind: "path", path }, record);
  if (raw === null || raw === undefined) return null;
  const type = types.get(path);
  switch (type) {
    case undefined:
      return check(raw);
    case "number": {
      if (typeof raw === "number") return Number.isFinite(raw) ? raw : new Fault("typeError");
      if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw))) return Number(raw);
      return new Fault("typeError");
    }
    case "text":
      return typeof raw === "string" ? check(raw) : new Fault("typeError");
    case "boolean":
      return typeof raw === "boolean" ? raw : new Fault("typeError");
    case "date":
    case "timestamp": {
      if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? new Fault("invalidDate") : raw;
      if (typeof raw !== "string") return new Fault("typeError");
      const day = ISO_DATE.exec(raw);
      if (day) {
        const date = new Date(Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3])));
        return date.getUTCDate() === Number(day[3]) ? date : new Fault("invalidDate");
      }
      if (!ISO_TIMESTAMP.test(raw)) return new Fault("invalidDate");
      const instant = new Date(raw);
      return Number.isNaN(instant.getTime()) ? new Fault("invalidDate") : instant;
    }
    default:
      return check(raw);
  }
}

function finish(value: unknown, resultType: FormulaType | undefined): FormulaEvaluation {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (value instanceof Date && !(value.getTime() >= FIRST_INSTANT && value.getTime() < END_INSTANT)) return { ok: false, error: "invalidDate" };
  if (typeof value === "string" && (value.length > MAX_RESULT_TEXT_LENGTH || utf8.encode(value).length > MAX_RESULT_TEXT_BYTES)) {
    return { ok: false, error: "textTooLong" };
  }
  switch (resultType) {
    case undefined:
      if (value instanceof Date) return { ok: true, value: value.toISOString() };
      if (typeof value === "number") return { ok: true, value: rounded(value) };
      return isFormulaValue(value) ? { ok: true, value } : { ok: false, error: "typeError" };
    case "number":
      return typeof value === "number" ? { ok: true, value: rounded(value) } : { ok: false, error: "typeError" };
    case "text":
      return typeof value === "string" ? { ok: true, value } : { ok: false, error: "typeError" };
    case "boolean":
      return typeof value === "boolean" ? { ok: true, value } : { ok: false, error: "typeError" };
    case "date":
      return value instanceof Date ? { ok: true, value: value.toISOString().slice(0, 10) } : { ok: false, error: "typeError" };
    case "timestamp":
      return value instanceof Date ? { ok: true, value: value.toISOString() } : { ok: false, error: "typeError" };
  }
}

/** A finite number to ROUNDING_DECIMALS decimals, never -0. */
function rounded(value: number): number {
  const result = Number(value.toFixed(ROUNDING_DECIMALS));
  return result === 0 ? 0 : result;
}

function isFormulaValue(value: unknown): value is FormulaValue {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}
