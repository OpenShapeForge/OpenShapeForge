// SPDX-License-Identifier: BUSL-1.1
// Canonical AST → formula text with today's labels. Field references are
// stored by id, so renaming a field changes what this prints, never what the
// formula means. The output parses back to the same AST.
//
// Spellings with the same meaning print one way: `CONCATENATE(a, b)` prints as
// `a & b`, `IF(c, x, BLANK())` as `IF(c, x)`, `BLANK() = x` as `x = BLANK()`,
// `<>` as `!=`, and function names in capitals.
import type { CompilerExpressionInput } from "./canonical/canonical-condition.ts";
import { fieldPath } from "./check.ts";
import { isIdentifier } from "./syntax.ts";
import type { FormulaAst, FormulaEnvironment } from "./types.ts";

const enum Precedence {
  Comparison = 1,
  Concatenation = 2,
  Additive = 3,
  Multiplicative = 4,
  Unary = 5,
  Primary = 6,
}

const INFIX_FORMULA: Partial<Record<string, { symbol: string; precedence: Precedence }>> = {
  add: { symbol: "+", precedence: Precedence.Additive },
  sub: { symbol: "-", precedence: Precedence.Additive },
  mul: { symbol: "*", precedence: Precedence.Multiplicative },
  div: { symbol: "/", precedence: Precedence.Multiplicative },
};

const COMPARISON_SYMBOL: Partial<Record<string, string>> = {
  equals: "=",
  notEquals: "!=",
  lessThan: "<",
  greaterThan: ">",
  lessThanOrEquals: "<=",
  greaterThanOrEquals: ">=",
};

const FUNCTION_NAME: Partial<Record<string, string>> = {
  concat: "CONCATENATE",
  left: "LEFT",
  right: "RIGHT",
  mid: "MID",
  len: "LEN",
  trim: "TRIM",
  upper: "UPPER",
  lower: "LOWER",
  substitute: "SUBSTITUTE",
  not: "NOT",
  isError: "ISERROR",
  round: "ROUND",
  roundUp: "ROUNDUP",
  roundDown: "ROUNDDOWN",
  min: "MIN",
  max: "MAX",
  sum: "SUM",
  average: "AVERAGE",
  abs: "ABS",
  value: "VALUE",
  mod: "MOD",
  power: "POWER",
  sqrt: "SQRT",
  ceiling: "CEILING",
  floor: "FLOOR",
};

const DATE_FUNCTION_NAME: Partial<Record<string, string>> = {
  dateAdd: "DATEADD",
  dateDiff: "DATETIME_DIFF",
  datetimeFormat: "DATETIME_FORMAT",
  year: "YEAR",
  month: "MONTH",
  day: "DAY",
};

export class FormulaFormatError extends Error {}

type Printed = { text: string; precedence: Precedence };

const primary = (text: string): Printed => ({ text, precedence: Precedence.Primary });

export function quoteText(value: string, quote: '"' | "'" = '"'): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(quote === '"' ? /"/g : /'/g, `\\${quote}`)
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
  return `${quote}${escaped}${quote}`;
}

export function braceFieldName(name: string): string {
  return `{${name.replace(/\\/g, "\\\\").replace(/}/g, "\\}")}}`;
}

/**
 * Prints `ast` as formula text, naming fields by their current label in
 * `env`. A field that is no longer in `env` prints as `{<id>}`, which then
 * fails to bind rather than silently meaning something else. Throws
 * {@link FormulaFormatError} on an AST the parser cannot have produced.
 */
export function formatFormula(ast: FormulaAst, env: FormulaEnvironment): string {
  const byPath = new Map(env.map((field) => [fieldPath(field), field]));

  const fieldText = (path: string): string => {
    const field = byPath.get(path);
    if (!field) return braceFieldName(path);
    if (field.scope === "self") return braceFieldName(field.label);
    const member = isIdentifier(field.key) ? field.key : braceFieldName(field.label);
    return `${field.scope.relation}.${member}`;
  };

  const call = (name: string, args: readonly (CompilerExpressionInput | undefined)[]): Printed =>
    primary(`${name}(${args.filter((arg) => arg !== undefined).map((arg) => print(arg!).text).join(", ")})`);

  const infix = (symbol: string, precedence: Precedence, left: CompilerExpressionInput, right: CompilerExpressionInput): Printed => {
    const l = print(left);
    const r = print(right);
    const leftText = l.precedence < precedence ? `(${l.text})` : l.text;
    const rightText = r.precedence <= precedence ? `(${r.text})` : r.text;
    return { text: `${leftText} ${symbol} ${rightText}`, precedence };
  };

  const chain = (symbol: string, precedence: Precedence, operands: readonly CompilerExpressionInput[]): Printed => {
    if (operands.length < 2) throw new FormulaFormatError(`'${symbol}' needs two operands`);
    let result = print(operands[0]!);
    for (const operand of operands.slice(1)) {
      const left = result.precedence < precedence ? `(${result.text})` : result.text;
      const right = print(operand);
      const rightText = right.precedence <= precedence ? `(${right.text})` : right.text;
      result = { text: `${left} ${symbol} ${rightText}`, precedence };
    }
    return result;
  };

  const print = (node: CompilerExpressionInput): Printed => {
    const kind = (node as { kind?: string }).kind;
    switch (kind) {
      case "literal": {
        const value = (node as { value: unknown }).value;
        if (value === null || value === undefined) return primary("BLANK()");
        if (typeof value === "boolean") return primary(value ? "TRUE()" : "FALSE()");
        if (typeof value === "string") return primary(quoteText(value));
        if (typeof value === "number" && Number.isFinite(value)) {
          return value < 0 || Object.is(value, -0)
            ? { text: `-${String(-value)}`, precedence: Precedence.Unary }
            : primary(String(value));
        }
        throw new FormulaFormatError(`A formula cannot hold the literal ${String(value)}`);
      }
      case "path":
        return primary(fieldText((node as { path: string }).path));
      case "formula": {
        const { op, operands } = node as { op: string; operands: CompilerExpressionInput[] };
        const infixOp = INFIX_FORMULA[op];
        if (infixOp) return chain(infixOp.symbol, infixOp.precedence, operands);
        if (op === "concat" && operands.length === 2) return chain("&", Precedence.Concatenation, operands);
        if (op === "negate") {
          const operand = print(operands[0]!);
          const text = operand.precedence < Precedence.Unary || operand.text.startsWith("-") ? `(${operand.text})` : operand.text;
          return { text: `-${text}`, precedence: Precedence.Unary };
        }
        const name = FUNCTION_NAME[op];
        if (!name) throw new FormulaFormatError(`The formula operator '${op}' has no formula syntax`);
        return call(name, operands);
      }
      case "rule": {
        const { operator, left, right } = node as { operator: string; left: CompilerExpressionInput; right?: CompilerExpressionInput };
        if (operator === "isEmpty" || operator === "isNotEmpty") {
          return infix(operator === "isEmpty" ? "=" : "!=", Precedence.Comparison, left, { kind: "literal", value: null });
        }
        const symbol = COMPARISON_SYMBOL[operator];
        if (!symbol || right === undefined) throw new FormulaFormatError(`The condition operator '${operator}' has no formula syntax`);
        return infix(symbol, Precedence.Comparison, left, right);
      }
      case "group": {
        const group = node as { mode?: string; conditions?: CompilerExpressionInput[]; all?: CompilerExpressionInput[]; any?: CompilerExpressionInput[] };
        const mode = group.mode ?? (group.any ? "any" : "all");
        return call(mode === "any" ? "OR" : "AND", group.conditions ?? group.all ?? group.any ?? []);
      }
      case "if": {
        const { condition, then } = node as { condition: CompilerExpressionInput; then: CompilerExpressionInput };
        const otherwise = (node as { else?: CompilerExpressionInput }).else;
        const blankElse =
          otherwise === undefined ||
          ((otherwise as { kind?: string }).kind === "literal" && (otherwise as { value: unknown }).value == null);
        return call("IF", blankElse ? [condition, then] : [condition, then, otherwise]);
      }
      case "switch": {
        const sw = node as {
          subject: CompilerExpressionInput;
          cases: Array<{ when: CompilerExpressionInput; then: CompilerExpressionInput }>;
          default?: CompilerExpressionInput;
        };
        return call("SWITCH", [sw.subject, ...sw.cases.flatMap((entry) => [entry.when, entry.then]), sw.default]);
      }
      case "date": {
        const date = node as { op: string; left?: CompilerExpressionInput; right?: CompilerExpressionInput; unit?: string };
        const name = DATE_FUNCTION_NAME[date.op];
        if (!name || (date.op === "dateDiff" && date.unit === undefined)) {
          throw new FormulaFormatError(`The date operator '${date.op}' has no formula syntax`);
        }
        const args = [date.left, date.right].filter((arg) => arg !== undefined).map((arg) => print(arg!).text);
        if (date.unit !== undefined) args.push(quoteText(date.unit, "'"));
        return primary(`${name}(${args.join(", ")})`);
      }
      case "function": {
        const name = (node as { name: string }).name;
        if (name === "recordId") return primary("RECORD_ID()");
        if (name === "createdTime") return primary("CREATED_TIME()");
        throw new FormulaFormatError(`The function '${name}' has no formula syntax`);
      }
      default:
        throw new FormulaFormatError(`An expression of kind '${kind ?? "untagged"}' has no formula syntax`);
    }
  };

  return print(ast).text;
}
