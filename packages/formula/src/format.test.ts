// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";

import { env } from "./__fixtures__/env.ts";
import { analyze } from "./editor.ts";
import { formatFormula, FormulaFormatError } from "./format.ts";
import type { FormulaAst, FormulaEnvironment } from "./types.ts";

function astOf(text: string, environment: FormulaEnvironment = env): FormulaAst {
  const analysis = analyze(text, environment);
  if (!analysis.ast) throw new Error(`${text}: ${analysis.errors.map((error) => error.message).join("; ")}`);
  return analysis.ast;
}

describe("canonical text survives parse → format unchanged", () => {
  test.each([
    "{Capacity kWh} * {Price per kWh}",
    "{Capacity kWh} * pricing.amount",
    "{Capacity kWh} * pricing.amount - {Price per kWh} / 2",
    "({Capacity kWh} + 1) * 2",
    "{Capacity kWh} - ({Price per kWh} - 1)",
    "{Capacity kWh} / ({Price per kWh} * 2)",
    "-{Capacity kWh} * 2",
    "-({Capacity kWh} + 1)",
    "-(-{Capacity kWh})",
    "2 * -3",
    "{Capacity kWh} - -1",
    '{Title} & " (" & {Category} & ")"',
    '{Title} & ({Category} & "x")',
    'CONCATENATE({Title}, " ", {Category})',
    '{Capacity kWh} + 1 & "x"',
    '{Title} & "x" = "ax"',
    "{Capacity kWh} >= 10",
    "{Title} != {Category}",
    "{Title} = BLANK()",
    "{Title} != BLANK()",
    'IF({Active}, "yes", "no")',
    'IF({Active}, "yes")',
    "AND({Active}, OR({Capacity kWh} > 1, NOT({Active})))",
    'SWITCH({Category}, "solar", 1, "storage", 2, 0)',
    'SWITCH({Category}, "solar", 1)',
    "ISERROR(1 / {Capacity kWh})",
    "ROUND({Capacity kWh} * {Price per kWh}, 2)",
    "ROUNDUP(1.5) + ROUNDDOWN(1.5, 0)",
    "MIN(1, 2) + MAX(3) + SUM(1, 2, 3) + AVERAGE(4, 5)",
    'ABS(-1) + VALUE("2") + MOD(7, 3) + POWER(2, 3) + SQRT(4) + CEILING(1.2, 0.5) + FLOOR(1.7)',
    'LEFT({Title}, 2) & RIGHT({Title}, 2) & MID({Title}, 2, 3) & TRIM(UPPER(LOWER({Title})))',
    'LEN(SUBSTITUTE({Title}, "a", "b", 1))',
    "DATEADD({Launch date}, 3, 'months')",
    "DATETIME_DIFF({Last seen}, {Launch date}, 'days')",
    "DATETIME_FORMAT({Launch date}, \"YYYY\") & DATETIME_FORMAT({Last seen})",
    "YEAR({Launch date}) + MONTH({Launch date}) + DAY({Launch date})",
    "RECORD_ID() & DATETIME_FORMAT(CREATED_TIME())",
    'IF(TRUE(), FALSE(), BLANK() = {Title})',
    '"say \\"hi\\"\\n" & {Cost {net\\}}',
    "{Capacity kWh} * 0.5 + 1e+21",
  ])("%s", (text) => {
    expect(formatFormula(astOf(text), env)).toBe(text.replace("BLANK() = {Title}", "{Title} = BLANK()"));
  });
});

describe("other spellings normalise to the canonical one, with the same AST", () => {
  test.each([
    ["{capacityKwh}*{pricePerKwh}", "{Capacity kWh} * {Price per kWh}"],
    ["capacityKwh * pricing.{Amount}", "{Capacity kWh} * pricing.amount"],
    ["((({Capacity kWh})))", "{Capacity kWh}"],
    ["+{Capacity kWh}", "{Capacity kWh}"],
    ["-(5)", "-5"],
    ["--5", "-(-5)"],
    ["CONCATENATE({Title}, 'x')", '{Title} & "x"'],
    ["concatenate({Title})", "CONCATENATE({Title})"],
    ["IF({Active}, 1, BLANK())", "IF({Active}, 1)"],
    ["BLANK() = {Title}", "{Title} = BLANK()"],
    ["{Title} <> {Category}", "{Title} != {Category}"],
    ["true", "TRUE()"],
    ["DATEADD({Launch date}, 1, 'M')", "DATEADD({Launch date}, 1, 'months')"],
    ["DATETIME_DIFF({Last seen}, {Launch date})", "DATETIME_DIFF({Last seen}, {Launch date}, 'seconds')"],
    ["'single'", '"single"'],
  ])("%s → %s", (text, canonical) => {
    const ast = astOf(text);
    const printed = formatFormula(ast, env);
    expect(printed).toBe(canonical);
    expect(astOf(printed)).toEqual(ast);
  });
});

describe("renaming", () => {
  test("a renamed field prints its new label and the AST still binds", () => {
    const ast = astOf("{Capacity kWh} * pricing.amount");
    const renamed: FormulaEnvironment = env.map((field) =>
      field.id === "f-cap"
        ? { ...field, label: "Usable capacity (kWh)" }
        : field.id === "amount"
          ? { ...field, key: "listPrice", label: "List price" }
          : field,
    );
    const printed = formatFormula(ast, renamed);
    expect(printed).toBe("{Usable capacity (kWh)} * pricing.listPrice");
    expect(astOf(printed, renamed)).toEqual(ast);
  });

  test("a child key that is not an identifier prints as its braced label", () => {
    const ast = astOf("pricing.amount");
    const odd: FormulaEnvironment = env.map((field) =>
      field.id === "amount" ? { ...field, key: "list-price", label: "List price" } : field,
    );
    expect(formatFormula(ast, odd)).toBe("pricing.{List price}");
  });

  test("a field that left the environment prints as its id and no longer binds", () => {
    const ast = astOf("{Capacity kWh} + 1");
    const without = env.filter((field) => field.id !== "f-cap");
    const printed = formatFormula(ast, without);
    expect(printed).toBe("{f-cap} + 1");
    expect(analyze(printed, without).errors[0]?.code).toBe("unknownField");
  });
});

describe("ASTs without formula syntax are refused", () => {
  test.each([
    [{ kind: "aggregate", op: "sum", collection: "lines" }],
    [{ kind: "coalesce", operands: [] }],
    [{ kind: "function", name: "today" }],
    [{ kind: "formula", op: "matches", operands: [] }],
    [{ kind: "rule", operator: "in", left: { kind: "literal", value: 1 }, right: { kind: "literal", value: [1] } }],
    [{ kind: "date", op: "dateDiff", left: { kind: "literal", value: 1 }, right: { kind: "literal", value: 1 } }],
    [{ kind: "literal", value: Infinity }],
  ])("%j", (ast) => {
    expect(() => formatFormula(ast as FormulaAst, env)).toThrow(FormulaFormatError);
  });
});
