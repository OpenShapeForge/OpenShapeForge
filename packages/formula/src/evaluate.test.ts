// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";

import { evaluateExpression } from "./canonical/expression-evaluator.js";
import { env, record } from "./__fixtures__/env.js";
import { dependencies } from "./dependencies.js";
import { analyze } from "./editor.js";
import { evaluate } from "./evaluate.js";
import type { FormulaAst, FormulaRecord } from "./types.js";

function compiled(text: string) {
  const analysis = analyze(text, env);
  if (!analysis.ast || !analysis.resultType) {
    throw new Error(`${text}: ${analysis.errors.map((error) => error.message).join("; ")}`);
  }
  return { ast: analysis.ast, resultType: analysis.resultType, dependencies: analysis.dependencies };
}

function evaluated(text: string, sample: FormulaRecord = record) {
  const { ast, resultType } = compiled(text);
  return evaluate(ast, sample, { env, resultType });
}

describe("the two reference examples", () => {
  test("{Capacity kWh} * {Price per kWh}", () => {
    expect(evaluated("{Capacity kWh} * {Price per kWh}")).toEqual({ ok: true, value: 5400 });
  });

  test("{Capacity kWh} * pricing.amount reads the owned child", () => {
    expect(evaluated("{Capacity kWh} * pricing.amount")).toEqual({ ok: true, value: 6749.325 });
  });

  test("without a pricing child the child field is blank, so it counts as 0", () => {
    const { pricing: _pricing, ...withoutChild } = record;
    expect(evaluated("{Capacity kWh} * pricing.amount", withoutChild)).toEqual({ ok: true, value: 0 });
    expect(evaluated("IF(pricing.amount = BLANK(), -1, pricing.amount)", withoutChild)).toEqual({ ok: true, value: -1 });
  });
});

describe("per-record error codes instead of exceptions", () => {
  test("division and remainder by zero", () => {
    expect(evaluated("{Capacity kWh} / 0")).toEqual({ ok: false, error: "divideByZero" });
    expect(evaluated("0 / 0")).toEqual({ ok: false, error: "divideByZero" });
    expect(evaluated("MOD({Capacity kWh}, 0)")).toEqual({ ok: false, error: "divideByZero" });
    expect(evaluated("{Capacity kWh} / {Price per kWh}", { ...record, "f-ppk": null })).toEqual({
      ok: false,
      error: "divideByZero",
    });
  });

  test("NaN and Infinity never come out as values", () => {
    expect(evaluated("SQRT(-1)")).toEqual({ ok: false, error: "invalidNumber" });
    expect(evaluated("VALUE('n/a')")).toEqual({ ok: false, error: "invalidNumber" });
    expect(evaluated("POWER(10, 400)")).toEqual({ ok: false, error: "numberOutOfRange" });
    expect(evaluated("{Capacity kWh} * 1e308 * 10")).toEqual({ ok: false, error: "numberOutOfRange" });
  });

  test("an error propagates through every operator above it", () => {
    expect(evaluated("ROUND(1 / 0, 2) + 1")).toEqual({ ok: false, error: "divideByZero" });
    expect(evaluated("IF(1 / 0 > 1, 'a', 'b')")).toEqual({ ok: false, error: "divideByZero" });
    expect(evaluated("LEFT({Title}, 1 / 0)")).toEqual({ ok: false, error: "divideByZero" });
    expect(evaluated("SWITCH(1 / 0, 1, 'a', 'b')")).toEqual({ ok: false, error: "divideByZero" });
  });

  test("impossible dates", () => {
    expect(evaluated("DATEADD({Launch date}, 1e12, 'days')")).toEqual({ ok: false, error: "invalidDate" });
    expect(evaluated("YEAR({Launch date})", { ...record, "f-launch": "2026-02-30" })).toEqual({ ok: false, error: "invalidDate" });
    expect(evaluated("YEAR({Launch date})", { ...record, "f-launch": "next week" })).toEqual({ ok: false, error: "invalidDate" });
  });

  test("stored values of the wrong type", () => {
    expect(evaluated("{Capacity kWh} + 1", { ...record, "f-cap": "lots" })).toEqual({ ok: false, error: "typeError" });
    expect(evaluated("NOT({Active})", { ...record, "f-active": "yes" })).toEqual({ ok: false, error: "typeError" });
    expect(evaluated("LEN({Title})", { ...record, title: 42 })).toEqual({ ok: false, error: "typeError" });
    expect(evaluated("YEAR({Launch date})", { ...record, "f-launch": 20260301 })).toEqual({ ok: false, error: "typeError" });
  });

  test("ISERROR turns an error into a value", () => {
    expect(evaluated("ISERROR({Capacity kWh} / 0)")).toEqual({ ok: true, value: true });
    expect(evaluated("IF(ISERROR(YEAR({Launch date})), 0, 1)", { ...record, "f-launch": "bad" })).toEqual({ ok: true, value: 0 });
  });
});

describe("lazy branches", () => {
  test("the branch not taken is never evaluated", () => {
    expect(evaluated("IF({Price per kWh} = 0, 0, {Capacity kWh} / {Price per kWh})", { ...record, "f-ppk": 0 })).toEqual({
      ok: true,
      value: 0,
    });
    expect(evaluated("SWITCH({Category}, 'storage', 1, 1 / 0)")).toEqual({ ok: true, value: 1 });
  });

  test("AND and OR stop at the first decisive condition", () => {
    expect(evaluated("AND(FALSE, 1 / 0 > 1)")).toEqual({ ok: true, value: false });
    expect(evaluated("OR(TRUE, 1 / 0 > 1)")).toEqual({ ok: true, value: true });
    expect(evaluated("AND(TRUE, 1 / 0 > 1)")).toEqual({ ok: false, error: "divideByZero" });
  });
});

describe("blank values", () => {
  test("blank numbers count as 0 in arithmetic and blank text as empty", () => {
    expect(evaluated("{Capacity kWh} + 1", { ...record, "f-cap": null })).toEqual({ ok: true, value: 1 });
    expect(evaluated("{Title} & '!'", { ...record, title: undefined })).toEqual({ ok: true, value: "!" });
  });

  test("a formula can be blank", () => {
    expect(evaluated("IF({Active}, BLANK(), 1)")).toEqual({ ok: true, value: null });
    expect(evaluated("YEAR({Launch date})", { ...record, "f-launch": null })).toEqual({ ok: true, value: null });
    expect(evaluated("DATEADD({Launch date}, 1, 'days')", { ...record, "f-launch": null })).toEqual({ ok: true, value: null });
  });
});

describe("values are normalised to the result type", () => {
  test("dates as YYYY-MM-DD, timestamps as ISO 8601", () => {
    expect(evaluated("DATEADD({Launch date}, 1, 'year')")).toEqual({ ok: true, value: "2027-03-01" });
    expect(evaluated("{Last seen}")).toEqual({ ok: true, value: "2026-04-02T10:15:00.000Z" });
    expect(evaluated("{Last seen}", { ...record, "f-seen": new Date("2026-04-02T12:15:00+02:00") })).toEqual({
      ok: true,
      value: "2026-04-02T10:15:00.000Z",
    });
  });

  test("dates compare as instants", () => {
    expect(evaluated("{Launch date} < {Last seen}")).toEqual({ ok: true, value: true });
    expect(evaluated("{Launch date} = DATEADD({Last seen}, -32, 'days')")).toEqual({ ok: true, value: false });
    expect(evaluated("{Launch date} = DATEADD({Launch date}, 0, 'days')")).toEqual({ ok: true, value: true });
  });

  test("-0 is 0", () => {
    expect(evaluated("ROUND(-0.4)")).toEqual({ ok: true, value: 0 });
  });
});

describe("the same AST through the canonical evaluator", () => {
  test("agrees with this walk where there is no error", () => {
    const payload = { ...record, "f-cost": 4250, "f-launch": new Date("2026-03-01T00:00:00Z"), "f-seen": new Date("2026-04-02T10:15:00Z") };
    for (const text of [
      "{Capacity kWh} * pricing.amount",
      "ROUND({Capacity kWh} * {Price per kWh} / 3, 2)",
      "IF(AND({Active}, {Capacity kWh} > 10), UPPER({Title}), LOWER({Title}))",
      "SWITCH({Category}, 'storage', 'S', 'solar', 'P', '?')",
      "DATETIME_DIFF({Last seen}, {Launch date}, 'hours')",
      "{Title} = BLANK()",
    ]) {
      const { ast, resultType } = compiled(text);
      const direct = evaluateExpression(ast, payload);
      expect(evaluate(ast, payload, { resultType })).toEqual({ ok: true, value: direct as never });
    }
  });

  test("where it gives Infinity, this walk gives the reason", () => {
    const { ast } = compiled("{Capacity kWh} / 0");
    expect(evaluateExpression(ast, record)).toBe(Infinity);
    expect(evaluate(ast, record)).toEqual({ ok: false, error: "divideByZero" });
  });
});

describe("without an environment", () => {
  test("values are taken as they are and dates come out as ISO timestamps", () => {
    const { ast } = compiled("DATEADD({Launch date}, 1, 'days')");
    expect(evaluate(ast, { "f-launch": new Date("2026-03-01T00:00:00Z") })).toEqual({ ok: true, value: "2026-03-02T00:00:00.000Z" });
  });

  test("an AST the walk does not know is handed to the evaluator whole", () => {
    const ast: FormulaAst = { kind: "coalesce", operands: [{ kind: "path", path: "x" }, { kind: "literal", value: 3 }] };
    expect(evaluate(ast, {})).toEqual({ ok: true, value: 3 });
  });
});

describe("dependencies agree with the analysis", () => {
  test.each([
    "{Capacity kWh} * pricing.amount",
    "IF({Active}, {Title}, {Category}) & pricing.currency",
    "SWITCH({Category}, {Title}, 1, {Capacity kWh})",
  ])("%s", (text) => {
    const { ast, dependencies: analysed } = compiled(text);
    expect(dependencies(ast)).toEqual(analysed);
  });
});
