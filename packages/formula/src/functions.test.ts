// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";

import { env, record } from "./__fixtures__/env.ts";
import { analyze } from "./editor.ts";
import { evaluate } from "./evaluate.ts";
import { formatFormula } from "./format.ts";
import { dateUnit, FORMULA_FUNCTIONS } from "./functions.ts";
import type { FormulaEvaluation, FormulaRecord, FormulaType } from "./types.ts";

/** Analyses, checks the type, evaluates against the record and checks the round trip. */
function run(text: string, type: FormulaType, sample: FormulaRecord = record): FormulaEvaluation {
  const analysis = analyze(text, env);
  if (!analysis.ast) throw new Error(`${text}: ${analysis.errors.map((error) => error.message).join("; ")}`);
  expect(analysis.resultType).toBe(type);
  const printed = formatFormula(analysis.ast, env);
  expect(analyze(printed, env).ast).toEqual(analysis.ast);
  return evaluate(analysis.ast, sample, { env, resultType: type });
}

const value = (text: string, type: FormulaType, sample?: FormulaRecord) => {
  const result = run(text, type, sample);
  if (!result.ok) throw new Error(`${text}: ${result.error}`);
  return result.value;
};

describe("text", () => {
  test("CONCATENATE and &", () => {
    expect(value("CONCATENATE({Title}, ' (', {Capacity kWh}, ' kWh)')", "text")).toBe("Home battery (13.5 kWh)");
    expect(value("{Title} & ' / ' & pricing.currency", "text")).toBe("Home battery / EUR");
    expect(value("CONCATENATE({Active})", "text")).toBe("true");
  });

  test("LEFT, RIGHT, MID", () => {
    expect(value("LEFT({Title}, 4)", "text")).toBe("Home");
    expect(value("RIGHT({Title}, 7)", "text")).toBe("battery");
    expect(value("MID({Title}, 6, 3)", "text")).toBe("bat");
  });

  test("LEN, TRIM, UPPER, LOWER", () => {
    expect(value("LEN({Title})", "number")).toBe(12);
    expect(value("TRIM('  x  ')", "text")).toBe("x");
    expect(value("UPPER({Category})", "text")).toBe("STORAGE");
    expect(value("LOWER('kWh')", "text")).toBe("kwh");
  });

  test("SUBSTITUTE, all occurrences or one", () => {
    expect(value("SUBSTITUTE('a.b.c', '.', '-')", "text")).toBe("a-b-c");
    expect(value("SUBSTITUTE('a.b.c', '.', '-', 2)", "text")).toBe("a.b-c");
  });
});

describe("logical", () => {
  test("IF with and without else", () => {
    expect(value("IF({Capacity kWh} > 10, 'large', 'small')", "text")).toBe("large");
    expect(value("IF({Capacity kWh} > 100, 'large')", "text")).toBeNull();
  });

  test("AND, OR, NOT", () => {
    expect(value("AND({Active}, {Capacity kWh} > 10)", "boolean")).toBe(true);
    expect(value("AND({Active}, {Capacity kWh} > 100)", "boolean")).toBe(false);
    expect(value("OR({Capacity kWh} > 100, {Category} = 'storage')", "boolean")).toBe(true);
    expect(value("NOT({Active})", "boolean")).toBe(false);
  });

  test("SWITCH with and without default", () => {
    expect(value("SWITCH({Category}, 'solar', 1, 'storage', 2, 0)", "number")).toBe(2);
    expect(value("SWITCH({Category}, 'solar', 1, 0)", "number")).toBe(0);
    expect(value("SWITCH({Category}, 'solar', 1)", "number")).toBeNull();
  });

  test("BLANK, TRUE, FALSE and the emptiness test", () => {
    expect(value("IF({Title} = BLANK(), 'untitled', {Title})", "text")).toBe("Home battery");
    expect(value("{Title} = BLANK()", "boolean", { ...record, title: "" })).toBe(true);
    expect(value("BLANK() != {Title}", "boolean")).toBe(true);
    expect(value("IF(TRUE(), 1, 2) + IF(FALSE, 1, 2)", "number")).toBe(3);
  });

  test("ISERROR catches an error instead of propagating it", () => {
    expect(value("ISERROR(1 / 0)", "boolean")).toBe(true);
    expect(value("ISERROR({Capacity kWh} / 2)", "boolean")).toBe(false);
    expect(value("IF(ISERROR(SQRT(-1)), 0, SQRT(-1))", "number")).toBe(0);
  });
});

describe("numeric", () => {
  test("ROUND, ROUNDUP, ROUNDDOWN", () => {
    expect(value("ROUND({Capacity kWh} * 1.111, 2)", "number")).toBe(15);
    expect(value("ROUND(2.5)", "number")).toBe(3);
    expect(value("ROUNDUP(pricing.amount, 0)", "number")).toBe(500);
    expect(value("ROUNDDOWN(pricing.amount, 1)", "number")).toBe(499.9);
  });

  test("MIN, MAX, SUM, AVERAGE", () => {
    expect(value("MIN({Capacity kWh}, 20, 5)", "number")).toBe(5);
    expect(value("MAX({Capacity kWh}, 20, 5)", "number")).toBe(20);
    expect(value("SUM({Capacity kWh}, 1.5, BLANK())", "number")).toBe(15);
    expect(value("AVERAGE(1, 2, 6)", "number")).toBe(3);
  });

  test("ABS, VALUE, MOD, POWER, SQRT", () => {
    expect(value("ABS(-{Capacity kWh})", "number")).toBe(13.5);
    expect(value("VALUE('€ 1,234.50') + 1", "number")).toBe(1235.5);
    expect(value("MOD(17, 5)", "number")).toBe(2);
    expect(value("POWER(2, 8)", "number")).toBe(256);
    expect(value("SQRT(81)", "number")).toBe(9);
  });

  test("CEILING, FLOOR", () => {
    expect(value("CEILING({Capacity kWh})", "number")).toBe(14);
    expect(value("CEILING({Capacity kWh}, 5)", "number")).toBe(15);
    expect(value("FLOOR({Capacity kWh}, 5)", "number")).toBe(10);
    expect(value("FLOOR(pricing.amount)", "number")).toBe(499);
  });

  test("a stored numeric text (a Postgres numeric) reads as a number", () => {
    expect(value("{Cost \\{net\\}} * 2", "number")).toBe(8500);
  });
});

describe("date", () => {
  test("DATEADD keeps a date a date for whole-day units", () => {
    expect(value("DATEADD({Launch date}, 1, 'month')", "date")).toBe("2026-04-01");
    expect(value("DATEADD({Launch date}, -1, 'd')", "date")).toBe("2026-02-28");
    expect(value("DATEADD({Launch date}, 90, 'minutes')", "timestamp")).toBe("2026-03-01T01:30:00.000Z");
    expect(value("DATEADD({Last seen}, 1, 'Q')", "timestamp")).toBe("2026-07-02T10:15:00.000Z");
  });

  test("DATETIME_DIFF in units, seconds by default", () => {
    expect(value("DATETIME_DIFF({Last seen}, {Launch date}, 'days')", "number")).toBe(32);
    expect(value("DATETIME_DIFF({Last seen}, {Launch date}, 'months')", "number")).toBe(1);
    expect(value("DATETIME_DIFF({Last seen}, CREATED_TIME(), 'weeks')", "number")).toBe(11);
    expect(value("DATETIME_DIFF(DATEADD({Launch date}, 1, 'minute'), {Launch date})", "number")).toBe(60);
  });

  test("DATETIME_FORMAT", () => {
    expect(value("DATETIME_FORMAT({Launch date}, 'D MMMM YYYY')", "text")).toBe("1 March 2026");
    expect(value("DATETIME_FORMAT({Last seen}, 'YYYY-MM-DD HH:mm')", "text")).toBe("2026-04-02 10:15");
    expect(value("DATETIME_FORMAT({Last seen})", "text")).toBe("2026-04-02T10:15:00.000Z");
  });

  test("YEAR, MONTH, DAY", () => {
    expect(value("YEAR({Launch date}) * 100 + MONTH({Launch date})", "number")).toBe(202603);
    expect(value("DAY({Last seen})", "number")).toBe(2);
  });

  test("unit spellings", () => {
    expect(dateUnit("Days")).toBe("days");
    expect(dateUnit("M")).toBe("months");
    expect(dateUnit("m")).toBe("minutes");
    expect(dateUnit("ms")).toBe("milliseconds");
    expect(dateUnit("fortnight")).toBeUndefined();
  });
});

describe("record", () => {
  test("RECORD_ID and CREATED_TIME", () => {
    expect(value("RECORD_ID()", "text")).toBe("0b3c6f1e-0000-4000-8000-000000000001");
    expect(value("CREATED_TIME()", "timestamp")).toBe("2026-01-15T09:30:00.000Z");
    expect(value("'P-' & LEFT(RECORD_ID(), 8)", "text")).toBe("P-0b3c6f1e");
  });
});

describe("the catalogue", () => {
  test("lists every function the brief names, once", () => {
    const names = FORMULA_FUNCTIONS.map((fn) => fn.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of [
      "CONCATENATE", "LEFT", "RIGHT", "MID", "LEN", "TRIM", "UPPER", "LOWER", "SUBSTITUTE",
      "IF", "AND", "OR", "NOT", "SWITCH", "BLANK", "ISERROR",
      "ROUND", "ROUNDUP", "ROUNDDOWN", "MIN", "MAX", "SUM", "AVERAGE", "ABS", "VALUE", "MOD", "POWER", "SQRT", "CEILING", "FLOOR",
      "DATEADD", "DATETIME_DIFF", "DATETIME_FORMAT", "YEAR", "MONTH", "DAY",
      "RECORD_ID", "CREATED_TIME",
    ]) {
      expect(names).toContain(name);
    }
  });

  test("every entry documents itself", () => {
    for (const fn of FORMULA_FUNCTIONS) {
      expect(fn.signature.startsWith(`${fn.name}(`)).toBe(true);
      expect(fn.description.length).toBeGreaterThan(10);
      expect(fn.minArgs).toBeLessThanOrEqual(fn.maxArgs);
    }
  });
});
