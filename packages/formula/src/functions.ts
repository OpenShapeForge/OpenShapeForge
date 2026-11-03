// SPDX-License-Identifier: BUSL-1.1
// The function vocabulary: Airtable's names and argument order, each typed
// statically and lowered onto the canonical expression AST.
import type {
  CompilerDateUnit,
  CompilerFormulaOperator,
} from "./canonical/canonical-condition.ts";
import type { SyntaxNode } from "./syntax.ts";
import type { FormulaAst, FormulaDiagnosticCode, FormulaType } from "./types.ts";

/** A checked expression's type: `blank` is BLANK(), `invalid` already has a diagnostic. */
export type ValueType = FormulaType | "blank" | "invalid";

export type Checked = { type: ValueType; ast: FormulaAst; syntax: SyntaxNode };

export type CallSyntax = Extract<SyntaxNode, { type: "call" }>;

/** What a function's typing rule can ask of the checker. */
export interface CallContext {
  readonly call: CallSyntax;
  readonly args: readonly Checked[];
  report(code: FormulaDiagnosticCode, message: string, at: { start: number; end: number }, params?: Record<string, string | number>): void;
  /** Reports a type mismatch unless the argument is one of `allowed` (blank and invalid always pass). */
  expect(index: number, allowed: readonly FormulaType[]): void;
  /** The common type of `branches`; a branch of another type is refused as a mixed branch. */
  unify(branches: readonly { checked: Checked; label: string }[]): ValueType;
  /** The calendar unit literal at `index`, or `fallback` when the argument is absent. */
  unit(index: number, fallback?: CompilerDateUnit): CompilerDateUnit | undefined;
}

export type FunctionCategory = "text" | "logical" | "numeric" | "date" | "record";

export interface FormulaFunction {
  name: string;
  category: FunctionCategory;
  /** How the editor shows the call, e.g. `ROUND(value, [precision])`. */
  signature: string;
  description: string;
  minArgs: number;
  maxArgs: number;
  /** The result type a suggestion shows; `undefined` when it depends on the arguments. */
  returns?: FormulaType;
  lower(context: CallContext): { type: ValueType; ast: FormulaAst };
}

/** Time functions: refused in phase 1, because a stored value of "now" is stale the moment it is written. */
export const TIME_FUNCTIONS: ReadonlySet<string> = new Set(["NOW", "TODAY", "TONOW", "FROMNOW"]);

const TEMPORAL: readonly FormulaType[] = ["date", "timestamp"];
const CONCATENABLE: readonly FormulaType[] = ["text", "number", "boolean"];

const formula = (op: CompilerFormulaOperator, operands: readonly Checked[]): FormulaAst => ({
  kind: "formula",
  op,
  operands: operands.map((operand) => operand.ast),
});

const lit = (value: unknown): FormulaAst => ({ kind: "literal", value });

function argumentOf(context: CallContext, index: number): Checked {
  return context.args[index]!;
}

/** Every argument must be of `types`; the result is `returns` and the AST `op` over all arguments. */
function simple(
  name: string,
  category: FunctionCategory,
  signature: string,
  description: string,
  op: CompilerFormulaOperator,
  argTypes: readonly (readonly FormulaType[])[],
  returns: FormulaType,
  minArgs = argTypes.length,
): FormulaFunction {
  return {
    name,
    category,
    signature,
    description,
    minArgs,
    maxArgs: argTypes.length,
    returns,
    lower(context) {
      context.args.forEach((_, index) => context.expect(index, argTypes[index]!));
      return { type: returns, ast: formula(op, context.args) };
    },
  };
}

/** Any number of arguments, all of the same types. */
function variadic(
  name: string,
  category: FunctionCategory,
  signature: string,
  description: string,
  op: CompilerFormulaOperator,
  argTypes: readonly FormulaType[],
  returns: FormulaType,
): FormulaFunction {
  return {
    name,
    category,
    signature,
    description,
    minArgs: 1,
    maxArgs: Infinity,
    returns,
    lower(context) {
      context.args.forEach((_, index) => context.expect(index, argTypes));
      return { type: returns, ast: formula(op, context.args) };
    },
  };
}

function datePart(name: "YEAR" | "MONTH" | "DAY", description: string): FormulaFunction {
  return {
    name,
    category: "date",
    signature: `${name}(date)`,
    description,
    minArgs: 1,
    maxArgs: 1,
    returns: "number",
    lower(context) {
      context.expect(0, TEMPORAL);
      const op = name === "YEAR" ? "year" : name === "MONTH" ? "month" : "day";
      return { type: "number", ast: { kind: "date", op, left: argumentOf(context, 0).ast } };
    },
  };
}

const CALENDAR_DAY_UNITS: ReadonlySet<CompilerDateUnit> = new Set(["days", "weeks", "months", "quarters", "years"]);

export const FORMULA_FUNCTIONS: readonly FormulaFunction[] = [
  // Text
  {
    name: "CONCATENATE",
    category: "text",
    signature: "CONCATENATE(text, ...)",
    description: "Joins the values into one text; the same as joining them with &.",
    minArgs: 1,
    maxArgs: Infinity,
    returns: "text",
    lower(context) {
      context.args.forEach((_, index) => context.expect(index, CONCATENABLE));
      return { type: "text", ast: formula("concat", context.args) };
    },
  },
  simple("LEFT", "text", "LEFT(text, count)", "The first count characters of the text.", "left", [["text"], ["number"]], "text"),
  simple("RIGHT", "text", "RIGHT(text, count)", "The last count characters of the text.", "right", [["text"], ["number"]], "text"),
  simple("MID", "text", "MID(text, start, count)", "count characters of the text from position start (the first is 1).", "mid", [["text"], ["number"], ["number"]], "text"),
  simple("LEN", "text", "LEN(text)", "The number of characters in the text.", "len", [["text"]], "number"),
  simple("TRIM", "text", "TRIM(text)", "The text without leading and trailing spaces.", "trim", [["text"]], "text"),
  simple("UPPER", "text", "UPPER(text)", "The text in capitals.", "upper", [["text"]], "text"),
  simple("LOWER", "text", "LOWER(text)", "The text in lower case.", "lower", [["text"]], "text"),
  simple(
    "SUBSTITUTE",
    "text",
    "SUBSTITUTE(text, old, new, [occurrence])",
    "Replaces old by new in the text: every occurrence, or only the given one.",
    "substitute",
    [["text"], ["text"], ["text"], ["number"]],
    "text",
    3,
  ),
  // Logical
  {
    name: "IF",
    category: "logical",
    signature: "IF(condition, then, [else])",
    description: "then when the condition holds, else otherwise (blank when else is left out).",
    minArgs: 2,
    maxArgs: 3,
    lower(context) {
      context.expect(0, ["boolean"]);
      const [condition, then, otherwise] = context.args as Checked[];
      const branches = [{ checked: then!, label: "then" }];
      if (otherwise) branches.push({ checked: otherwise, label: "else" });
      return {
        type: context.unify(branches),
        ast: { kind: "if", condition: condition!.ast, then: then!.ast, else: otherwise ? otherwise.ast : lit(null) },
      };
    },
  },
  ...(["AND", "OR"] as const).map(
    (name): FormulaFunction => ({
      name,
      category: "logical",
      signature: `${name}(condition, ...)`,
      description: name === "AND" ? "True when every condition holds." : "True when at least one condition holds.",
      minArgs: 1,
      maxArgs: Infinity,
      returns: "boolean",
      lower(context) {
        context.args.forEach((_, index) => context.expect(index, ["boolean"]));
        return {
          type: "boolean",
          ast: { kind: "group", mode: name === "AND" ? "all" : "any", conditions: context.args.map((arg) => arg.ast) },
        };
      },
    }),
  ),
  simple("NOT", "logical", "NOT(condition)", "True when the condition does not hold.", "not", [["boolean"]], "boolean"),
  {
    name: "SWITCH",
    category: "logical",
    signature: "SWITCH(expression, pattern, result, ..., [default])",
    description: "The result of the first pattern equal to the expression, else the default (blank when left out).",
    minArgs: 3,
    maxArgs: Infinity,
    lower(context) {
      const [subject, ...rest] = context.args as Checked[];
      const pairCount = Math.floor(rest.length / 2);
      const fallback = rest.length % 2 === 1 ? rest[rest.length - 1] : undefined;
      const cases: Array<{ when: FormulaAst; then: FormulaAst }> = [];
      const branches: { checked: Checked; label: string }[] = [];
      for (let pair = 0; pair < pairCount; pair += 1) {
        const pattern = rest[pair * 2]!;
        const result = rest[pair * 2 + 1]!;
        if (!comparable(subject!.type, pattern.type)) {
          context.report(
            "typeMismatch",
            `SWITCH pattern ${pair + 1} is ${pattern.type}, but the expression is ${subject!.type}`,
            pattern.syntax,
            { function: "SWITCH", pattern: pair + 1, expected: subject!.type, actual: pattern.type },
          );
        }
        cases.push({ when: pattern.ast, then: result.ast });
        branches.push({ checked: result, label: `result ${pair + 1}` });
      }
      if (fallback) branches.push({ checked: fallback, label: "default" });
      const ast: FormulaAst = fallback
        ? { kind: "switch", subject: subject!.ast, cases, default: fallback.ast }
        : { kind: "switch", subject: subject!.ast, cases };
      return { type: context.unify(branches), ast };
    },
  },
  {
    name: "BLANK",
    category: "logical",
    signature: "BLANK()",
    description: "An empty value. `{Field} = BLANK()` tests whether a field is empty.",
    minArgs: 0,
    maxArgs: 0,
    lower: () => ({ type: "blank", ast: lit(null) }),
  },
  {
    name: "ISERROR",
    category: "logical",
    signature: "ISERROR(expression)",
    description: "True when the expression has no value because of an error, such as a division by zero.",
    minArgs: 1,
    maxArgs: 1,
    returns: "boolean",
    lower: (context) => ({ type: "boolean", ast: formula("isError", context.args) }),
  },
  ...(["TRUE", "FALSE"] as const).map(
    (name): FormulaFunction => ({
      name,
      category: "logical",
      signature: `${name}()`,
      description: `The logical value ${name.toLowerCase()}.`,
      minArgs: 0,
      maxArgs: 0,
      returns: "boolean",
      lower: () => ({ type: "boolean", ast: lit(name === "TRUE") }),
    }),
  ),
  // Numeric
  simple("ROUND", "numeric", "ROUND(value, [precision])", "Rounds to precision decimals (default 0), halves away from zero.", "round", [["number"], ["number"]], "number", 1),
  simple("ROUNDUP", "numeric", "ROUNDUP(value, [precision])", "Rounds away from zero to precision decimals (default 0).", "roundUp", [["number"], ["number"]], "number", 1),
  simple("ROUNDDOWN", "numeric", "ROUNDDOWN(value, [precision])", "Rounds toward zero to precision decimals (default 0).", "roundDown", [["number"], ["number"]], "number", 1),
  variadic("MIN", "numeric", "MIN(number, ...)", "The smallest of the numbers; blanks are skipped.", "min", ["number"], "number"),
  variadic("MAX", "numeric", "MAX(number, ...)", "The largest of the numbers; blanks are skipped.", "max", ["number"], "number"),
  variadic("SUM", "numeric", "SUM(number, ...)", "The numbers added up; blanks count as nothing.", "sum", ["number"], "number"),
  variadic("AVERAGE", "numeric", "AVERAGE(number, ...)", "The mean of the numbers; blanks are skipped.", "average", ["number"], "number"),
  simple("ABS", "numeric", "ABS(value)", "The value without its sign.", "abs", [["number"]], "number"),
  simple("VALUE", "numeric", "VALUE(text)", "The number in the text, ignoring currency symbols and thousands separators.", "value", [["text"]], "number"),
  simple("MOD", "numeric", "MOD(value, divisor)", "The remainder of dividing value by divisor, with the sign of value.", "mod", [["number"], ["number"]], "number"),
  simple("POWER", "numeric", "POWER(base, power)", "base raised to power.", "power", [["number"], ["number"]], "number"),
  simple("SQRT", "numeric", "SQRT(value)", "The square root of the value.", "sqrt", [["number"]], "number"),
  simple("CEILING", "numeric", "CEILING(value, [significance])", "The nearest multiple of significance (default 1) at or above the value.", "ceiling", [["number"], ["number"]], "number", 1),
  simple("FLOOR", "numeric", "FLOOR(value, [significance])", "The nearest multiple of significance (default 1) at or below the value.", "floor", [["number"], ["number"]], "number", 1),
  // Date
  {
    name: "DATEADD",
    category: "date",
    signature: "DATEADD(date, count, 'unit')",
    description: "The date moved by count units: 'days', 'weeks', 'months', 'quarters', 'years', 'hours', 'minutes', 'seconds' or 'milliseconds'.",
    minArgs: 3,
    maxArgs: 3,
    lower(context) {
      context.expect(0, TEMPORAL);
      context.expect(1, ["number"]);
      const unit = context.unit(2);
      const base = argumentOf(context, 0);
      const type: ValueType =
        base.type === "invalid" || unit === undefined
          ? "invalid"
          : base.type === "date" && CALENDAR_DAY_UNITS.has(unit)
            ? "date"
            : "timestamp";
      return {
        type,
        ast: { kind: "date", op: "dateAdd", left: base.ast, right: argumentOf(context, 1).ast, unit: unit ?? "days" },
      };
    },
  },
  {
    name: "DATETIME_DIFF",
    category: "date",
    signature: "DATETIME_DIFF(date1, date2, ['unit'])",
    description: "date1 minus date2 in whole units (default 'seconds'), truncated toward zero.",
    minArgs: 2,
    maxArgs: 3,
    returns: "number",
    lower(context) {
      context.expect(0, TEMPORAL);
      context.expect(1, TEMPORAL);
      const unit = context.unit(2, "seconds");
      return {
        type: unit === undefined ? "invalid" : "number",
        ast: {
          kind: "date",
          op: "dateDiff",
          left: argumentOf(context, 0).ast,
          right: argumentOf(context, 1).ast,
          unit: unit ?? "seconds",
        },
      };
    },
  },
  {
    name: "DATETIME_FORMAT",
    category: "date",
    signature: "DATETIME_FORMAT(date, ['format'])",
    description: "The date as text, in UTC, with format tokens such as 'YYYY-MM-DD' or 'D MMMM YYYY HH:mm'; ISO 8601 without a format.",
    minArgs: 1,
    maxArgs: 2,
    returns: "text",
    lower(context) {
      context.expect(0, TEMPORAL);
      if (context.args.length > 1) context.expect(1, ["text"]);
      const [date, format] = context.args as Checked[];
      return {
        type: "text",
        ast: format
          ? { kind: "date", op: "datetimeFormat", left: date!.ast, right: format.ast }
          : { kind: "date", op: "datetimeFormat", left: date!.ast },
      };
    },
  },
  datePart("YEAR", "The year of the date (UTC)."),
  datePart("MONTH", "The month of the date, 1 to 12 (UTC)."),
  datePart("DAY", "The day of the month of the date, 1 to 31 (UTC)."),
  // Record
  {
    name: "RECORD_ID",
    category: "record",
    signature: "RECORD_ID()",
    description: "The id of this record.",
    minArgs: 0,
    maxArgs: 0,
    returns: "text",
    lower: () => ({ type: "text", ast: { kind: "function", name: "recordId" } }),
  },
  {
    name: "CREATED_TIME",
    category: "record",
    signature: "CREATED_TIME()",
    description: "When this record was created.",
    minArgs: 0,
    maxArgs: 0,
    returns: "timestamp",
    lower: () => ({ type: "timestamp", ast: { kind: "function", name: "createdTime" } }),
  },
];

const BY_NAME = new Map(FORMULA_FUNCTIONS.map((fn) => [fn.name, fn]));

export function formulaFunction(name: string): FormulaFunction | undefined {
  return BY_NAME.get(name.toUpperCase());
}

/** Whether values of these types can be compared for equality. */
export function comparable(left: ValueType, right: ValueType): boolean {
  if (left === "blank" || right === "blank" || left === "invalid" || right === "invalid") return true;
  if (left === right) return true;
  return TEMPORAL.includes(left) && TEMPORAL.includes(right);
}

/** Unit spellings Airtable accepts, by canonical unit. Short forms are case-sensitive (`M` is months, `m` minutes). */
const UNIT_ALIASES: ReadonlyArray<readonly [CompilerDateUnit, readonly string[], readonly string[]]> = [
  ["milliseconds", ["millisecond", "milliseconds"], ["ms"]],
  ["seconds", ["second", "seconds"], ["s"]],
  ["minutes", ["minute", "minutes"], ["m"]],
  ["hours", ["hour", "hours"], ["h"]],
  ["days", ["day", "days"], ["d"]],
  ["weeks", ["week", "weeks"], ["w"]],
  ["months", ["month", "months"], ["M"]],
  ["quarters", ["quarter", "quarters"], ["Q"]],
  ["years", ["year", "years"], ["y"]],
];

export const DATE_UNITS: readonly CompilerDateUnit[] = UNIT_ALIASES.map(([unit]) => unit);

export function dateUnit(spelling: string): CompilerDateUnit | undefined {
  const trimmed = spelling.trim();
  for (const [unit, long, short] of UNIT_ALIASES) {
    if (long.includes(trimmed.toLowerCase()) || short.includes(trimmed)) return unit;
  }
  return undefined;
}
