// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";

import type { CompilerExpressionInput } from "./canonical-condition.js";
import { evaluateExpression, isErrorValue } from "./expression-evaluator.js";

const lit = (value: unknown): CompilerExpressionInput => ({ kind: "literal", value });
const path = (p: string): CompilerExpressionInput => ({ kind: "path", path: p });
const formula = (op: string, ...operands: CompilerExpressionInput[]): CompilerExpressionInput =>
  ({ kind: "formula", op, operands }) as CompilerExpressionInput;
const date = (
  op: string,
  left?: CompilerExpressionInput,
  right?: CompilerExpressionInput,
  unit?: string,
): CompilerExpressionInput =>
  ({ kind: "date", op, ...(left ? { left } : {}), ...(right ? { right } : {}), ...(unit ? { unit } : {}) }) as CompilerExpressionInput;
const at = (iso: string) => new Date(iso);
const run = (expr: CompilerExpressionInput, payload: Record<string, unknown> = {}) => evaluateExpression(expr, payload);

describe("existing semantics stay as they were", () => {
  test("arithmetic folds left and treats absent operands as 0", () => {
    expect(run(formula("add", lit(1), lit(2), lit(3)))).toBe(6);
    expect(run(formula("sub", lit(10), lit(3), lit(2)))).toBe(5);
    expect(run(formula("mul", path("a"), lit(2)), { a: 4 })).toBe(8);
    expect(run(formula("add", path("missing"), lit(2)))).toBe(2);
    expect(run(formula("div", lit(1), lit(0)))).toBe(Infinity);
    expect(Number.isNaN(run(formula("div", lit(0), lit(0))) as number)).toBe(true);
  });

  test("concat, lower, upper, substring", () => {
    expect(run(formula("concat", lit("a"), lit(null), lit(1)))).toBe("a1");
    expect(run(formula("lower", lit("AbC")))).toBe("abc");
    expect(run(formula("upper", lit(5)))).toBe("");
    expect(run(formula("substring", lit("hello"), lit(1), lit(3)))).toBe("el");
  });

  test("dateDiff without a unit is floored days", () => {
    expect(run(date("dateDiff", lit("2026-01-10T12:00:00Z"), lit("2026-01-01T00:00:00Z")))).toBe(9);
  });

  test("if, coalesce and rules", () => {
    const expr: CompilerExpressionInput = {
      kind: "if",
      condition: { kind: "rule", operator: "greaterThan", left: path("n"), right: lit(3) },
      then: lit("big"),
      else: lit("small"),
    };
    expect(run(expr, { n: 5 })).toBe("big");
    expect(run(expr, { n: 1 })).toBe("small");
    expect(run({ kind: "coalesce", operands: [path("x"), lit(null), lit(7)] })).toBe(7);
  });
});

describe("function nodes", () => {
  test("recordId and createdTime read the payload", () => {
    expect(run({ kind: "function", name: "recordId" }, { id: "r-1" })).toBe("r-1");
    expect(run({ kind: "function", name: "createdTime" }, { createdAt: "2026-02-03T04:05:06Z" })).toEqual(
      at("2026-02-03T04:05:06Z"),
    );
    expect(run({ kind: "function", name: "createdTime" }, {})).toBeUndefined();
  });

  test("today is still midnight UTC", () => {
    const today = run({ kind: "function", name: "today" }) as Date;
    expect(today.getUTCHours()).toBe(0);
  });
});

describe("text operators", () => {
  test("left, right, mid", () => {
    expect(run(formula("left", lit("battery"), lit(3)))).toBe("bat");
    expect(run(formula("left", lit("bat"), lit(10)))).toBe("bat");
    expect(run(formula("left", lit("bat"), lit(-1)))).toBe("");
    expect(run(formula("right", lit("battery"), lit(4)))).toBe("tery");
    expect(run(formula("right", lit("battery"), lit(0)))).toBe("");
    expect(run(formula("mid", lit("battery"), lit(2), lit(3)))).toBe("att");
    expect(run(formula("mid", lit("battery"), lit(0), lit(2)))).toBe("ba");
    expect(run(formula("left", lit(null), lit(2)))).toBe("");
  });

  test("len, trim, substitute", () => {
    expect(run(formula("len", lit("kWh")))).toBe(3);
    expect(run(formula("len", lit(null)))).toBe(0);
    expect(run(formula("trim", lit("  a b  ")))).toBe("a b");
    expect(run(formula("substitute", lit("a-b-c"), lit("-"), lit("+")))).toBe("a+b+c");
    expect(run(formula("substitute", lit("a-b-c"), lit("-"), lit("+"), lit(2)))).toBe("a-b+c");
    expect(run(formula("substitute", lit("a-b-c"), lit("-"), lit("+"), lit(3)))).toBe("a-b-c");
    expect(run(formula("substitute", lit("abc"), lit(""), lit("x")))).toBe("abc");
  });
});

describe("logical and numeric operators", () => {
  test("not, negate", () => {
    expect(run(formula("not", lit(true)))).toBe(false);
    expect(run(formula("not", lit(false)))).toBe(true);
    expect(run(formula("not", lit(null)))).toBe(true);
    expect(run(formula("negate", lit(4)))).toBe(-4);
  });

  test("round family rounds the magnitude", () => {
    expect(run(formula("round", lit(2.5)))).toBe(3);
    expect(run(formula("round", lit(-2.5)))).toBe(-3);
    expect(run(formula("round", lit(1.005), lit(2)))).toBe(1.01);
    expect(run(formula("round", lit(1234), lit(-2)))).toBe(1200);
    expect(run(formula("roundUp", lit(1.1)))).toBe(2);
    expect(run(formula("roundUp", lit(-1.1)))).toBe(-2);
    expect(run(formula("roundDown", lit(1.9)))).toBe(1);
    expect(run(formula("roundDown", lit(-1.9)))).toBe(-1);
    expect(run(formula("roundUp", lit(1.11), lit(1)))).toBe(1.2);
  });

  test("abs, power, sqrt, ceiling, floor", () => {
    expect(run(formula("abs", lit(-3)))).toBe(3);
    expect(run(formula("power", lit(2), lit(10)))).toBe(1024);
    expect(run(formula("sqrt", lit(16)))).toBe(4);
    expect(Number.isNaN(run(formula("sqrt", lit(-1))) as number)).toBe(true);
    expect(run(formula("ceiling", lit(2.1)))).toBe(3);
    expect(run(formula("ceiling", lit(0.21), lit(0.1)))).toBe(0.3);
    expect(run(formula("floor", lit(7), lit(5)))).toBe(5);
    expect(run(formula("floor", lit(7), lit(0)))).toBe(0);
  });

  test("value parses text", () => {
    expect(run(formula("value", lit("€ 1,250.50")))).toBe(1250.5);
    expect(run(formula("value", lit("-3")))).toBe(-3);
    expect(run(formula("value", lit("")))).toBeUndefined();
    expect(Number.isNaN(run(formula("value", lit("n/a"))) as number)).toBe(true);
  });

  test("min, max, sum, average skip blanks", () => {
    expect(run(formula("min", lit(3), lit(null), lit(1)))).toBe(1);
    expect(run(formula("max", lit(3), lit(null), lit(1)))).toBe(3);
    expect(run(formula("sum", lit(3), lit(null), lit(1)))).toBe(4);
    expect(run(formula("average", lit(3), lit(null), lit(1)))).toBe(2);
    expect(run(formula("sum", lit(null)))).toBe(0);
    expect(run(formula("average", lit(null)))).toBeUndefined();
  });

  test("isError recognises non-finite numbers and invalid dates", () => {
    expect(run(formula("isError", formula("div", lit(1), lit(0))))).toBe(true);
    expect(run(formula("isError", lit(1)))).toBe(false);
    expect(isErrorValue(new Date(NaN))).toBe(true);
    expect(isErrorValue("text")).toBe(false);
  });
});

describe("switch", () => {
  const sw: CompilerExpressionInput = {
    kind: "switch",
    subject: path("size"),
    cases: [
      { when: lit("S"), then: lit(1) },
      { when: lit("M"), then: lit(2) },
      { when: lit(null), then: lit(0) },
    ],
    default: lit(9),
  };

  test("picks the first equal case, then the default", () => {
    expect(run(sw, { size: "M" })).toBe(2);
    expect(run(sw, { size: "XL" })).toBe(9);
    expect(run(sw, {})).toBe(0);
  });

  test("without a default an unmatched subject is undefined", () => {
    expect(run({ kind: "switch", subject: lit(1), cases: [{ when: lit(2), then: lit("x") }] })).toBeUndefined();
  });
});

describe("date operators", () => {
  test("dateAdd with fixed and calendar units", () => {
    expect(run(date("dateAdd", lit("2026-01-31T00:00:00Z"), lit(1), "months"))).toEqual(at("2026-02-28T00:00:00Z"));
    expect(run(date("dateAdd", lit("2024-01-31T10:00:00Z"), lit(1), "months"))).toEqual(at("2024-02-29T10:00:00Z"));
    expect(run(date("dateAdd", lit("2026-01-01T00:00:00Z"), lit(2), "quarters"))).toEqual(at("2026-07-01T00:00:00Z"));
    expect(run(date("dateAdd", lit("2026-01-01T00:00:00Z"), lit(-1), "years"))).toEqual(at("2025-01-01T00:00:00Z"));
    expect(run(date("dateAdd", lit("2026-01-01T00:00:00Z"), lit(36), "hours"))).toEqual(at("2026-01-02T12:00:00Z"));
    expect(run(date("dateAdd", lit("2026-01-01T00:00:00Z"), lit(2), "weeks"))).toEqual(at("2026-01-15T00:00:00Z"));
    expect(run(date("dateAdd", lit(null), lit(2), "days"))).toBeUndefined();
    expect(isErrorValue(run(date("dateAdd", lit("2026-01-01T00:00:00Z"), lit(1e12), "days")))).toBe(true);
  });

  test("dateDiff with a unit truncates toward zero", () => {
    const later = lit("2026-03-15T12:00:00Z");
    const earlier = lit("2026-01-31T00:00:00Z");
    expect(run(date("dateDiff", later, earlier, "days"))).toBe(43);
    expect(run(date("dateDiff", earlier, later, "days"))).toBe(-43);
    expect(run(date("dateDiff", later, earlier, "hours"))).toBe(1044);
    expect(run(date("dateDiff", later, earlier, "months"))).toBe(1);
    expect(run(date("dateDiff", earlier, later, "months"))).toBe(-1);
    expect(run(date("dateDiff", lit("2026-02-28T00:00:00Z"), earlier, "months"))).toBe(1);
    expect(run(date("dateDiff", lit("2027-03-01T00:00:00Z"), earlier, "years"))).toBe(1);
    expect(run(date("dateDiff", lit("2026-12-01T00:00:00Z"), earlier, "quarters"))).toBe(3);
    expect(run(date("dateDiff", lit("2026-01-01T00:00:10Z"), lit("2026-01-01T00:00:00Z"), "seconds"))).toBe(10);
  });

  test("datetimeFormat in UTC with moment tokens", () => {
    const d = lit("2026-03-05T14:07:09.042Z");
    expect(run(date("datetimeFormat", d, lit("YYYY-MM-DD")))).toBe("2026-03-05");
    expect(run(date("datetimeFormat", d, lit("D/M/YY h:mm a")))).toBe("5/3/26 2:07 pm");
    expect(run(date("datetimeFormat", d, lit("dddd D MMMM [week] Q")))).toBe("Thursday 5 March week 1");
    expect(run(date("datetimeFormat", d, lit("HH:mm:ss.SSS Z")))).toBe("14:07:09.042 +00:00");
    expect(run(date("datetimeFormat", d))).toBe("2026-03-05T14:07:09.042Z");
  });

  test("year, month, day", () => {
    const d = lit("2026-03-05T23:59:00Z");
    expect(run(date("year", d))).toBe(2026);
    expect(run(date("month", d))).toBe(3);
    expect(run(date("day", d))).toBe(5);
    expect(run(date("year", lit(null)))).toBeUndefined();
  });
});
