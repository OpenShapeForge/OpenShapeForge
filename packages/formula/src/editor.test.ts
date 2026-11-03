// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";

import { env, record } from "./__fixtures__/env.ts";
import { analyze, applySuggestion, formulaTokens, suggest } from "./editor.ts";

/** `|` marks the caret. */
function at(textWithCaret: string) {
  const cursor = textWithCaret.indexOf("|");
  return { text: textWithCaret.replace("|", ""), cursor };
}

function suggestAt(textWithCaret: string, options?: Parameters<typeof suggest>[3]) {
  const { text, cursor } = at(textWithCaret);
  return { text, result: suggest(text, cursor, env, options) };
}

const labels = (result: ReturnType<typeof suggest>) => result.items.map((item) => item.label);

describe("analyze", () => {
  test("a valid formula with a preview against a sample record", () => {
    const analysis = analyze("{Capacity kWh} * pricing.amount", env, { sample: record });
    expect(analysis.errors).toEqual([]);
    expect(analysis.resultType).toBe("number");
    expect(analysis.preview).toEqual({ ok: true, value: 6749.325 });
    expect(analysis.dependencies).toHaveLength(2);
  });

  test("a preview can be an error code", () => {
    expect(analyze("{Capacity kWh} / 0", env, { sample: record }).preview).toEqual({ ok: false, error: "divideByZero" });
  });

  test("an invalid formula has errors, tokens and no AST or preview", () => {
    const analysis = analyze("{Capacity kWh} * {Nope}", env, { sample: record });
    expect(analysis.ast).toBeUndefined();
    expect(analysis.preview).toBeUndefined();
    expect(analysis.errors).toEqual([
      { code: "unknownField", message: "There is no field 'Nope'", start: 17, end: 23, params: { name: "Nope" } },
    ]);
    expect(analysis.tokens.map((token) => token.type)).toEqual(["field", "operator", "field"]);
  });
});

describe("tokens for FormulaToken", () => {
  test("every kind, with spans", () => {
    const tokens = formulaTokens("ROUND({Capacity kWh} * pricing.amount, 2) & 'x' & TRUE");
    expect(tokens.map((token) => [token.value, token.type])).toEqual([
      ["ROUND", "function"],
      ["(", "parenthesis"],
      ["{Capacity kWh}", "field"],
      ["*", "operator"],
      ["pricing", "field"],
      [".", "separator"],
      ["amount", "field"],
      [",", "separator"],
      ["2", "number"],
      [")", "parenthesis"],
      ["&", "operator"],
      ["'x'", "text"],
      ["&", "operator"],
      ["TRUE", "boolean"],
    ]);
    expect(tokens[2]).toMatchObject({ start: 6, end: 20 });
  });

  test("half-typed and invalid input still tokenises", () => {
    expect(formulaTokens("{Cap").map((token) => token.type)).toEqual(["field"]);
    expect(formulaTokens("1 # 2").map((token) => token.type)).toEqual(["number", "invalid", "number"]);
  });
});

describe("suggest", () => {
  test("inside an open brace: fields whose label or key matches, replacing the whole reference", () => {
    const { text, result } = suggestAt("ROUND({cap|");
    expect(result).toMatchObject({ from: 6, to: 10 });
    expect(result.items).toEqual([{ kind: "field", label: "Capacity kWh", value: "{Capacity kWh}", type: "number" }]);
    expect(applySuggestion(text, result, result.items[0]!)).toEqual({ text: "ROUND({Capacity kWh}", cursor: 20 });
  });

  test("with the caret inside a closed reference the whole reference is replaced", () => {
    const { text, result } = suggestAt("{Pri|ce per kWh} * 2");
    expect(result).toMatchObject({ from: 0, to: 15 });
    expect(labels(result)).toEqual(["Price per kWh"]);
    expect(applySuggestion(text, result, result.items[0]!).text).toBe("{Price per kWh} * 2");
  });

  test("a word prefix offers fields and functions, prefix matches first", () => {
    const { text, result } = suggestAt("1 + ro|");
    expect(result).toMatchObject({ from: 4, to: 6 });
    expect(labels(result)).toEqual(["ROUND", "ROUNDUP", "ROUNDDOWN", "ISERROR"]);
    const round = result.items[0]!;
    expect(round).toMatchObject({ kind: "function", value: "ROUND(", context: "ROUND(value, [precision])", type: "number" });
    expect(applySuggestion(text, result, round)).toEqual({ text: "1 + ROUND(", cursor: 10 });
  });

  test("after an operator, a parenthesis or a comma everything in reach is offered", () => {
    const { result } = suggestAt("IF(|");
    expect(result.items.length).toBeGreaterThan(20);
    expect(result.items[0]).toMatchObject({ kind: "field", label: "Title" });
    expect(labels(suggestAt("1 + |").result)).toContain("Amount");
    expect(labels(suggestAt("|").result)).toContain("CONCATENATE");
  });

  test("owned-child fields carry their relation", () => {
    const { result } = suggestAt("{Capacity kWh} * am|");
    expect(result.items[0]).toEqual({ kind: "field", label: "Amount", value: "pricing.amount", context: "pricing", type: "number" });
  });

  test("typing the relation's name offers its fields", () => {
    const { text, result } = suggestAt("{Capacity kWh} * prici|");
    expect(labels(result)).toEqual(["Amount", "Currency"]);
    expect(applySuggestion(text, result, result.items[0]!).text).toBe("{Capacity kWh} * pricing.amount");
  });

  test("after relation. only that child's fields, inserted after the dot", () => {
    const { text, result } = suggestAt("{Capacity kWh} * pricing.|");
    expect(labels(result)).toEqual(["Amount", "Currency"]);
    expect(applySuggestion(text, result, result.items[0]!).text).toBe("{Capacity kWh} * pricing.amount");
    expect(labels(suggestAt("pricing.cur|").result)).toEqual(["Currency"]);
    expect(suggestAt("supplier.|").result.items).toEqual([]);
  });

  test("never offers classified, unreadable or time-dependent things, nor the field itself", () => {
    const everything = labels(suggestAt("|", { fieldId: "f-total" }).result);
    expect(everything).not.toContain("Margin");
    expect(everything).not.toContain("Supplier");
    expect(everything).not.toContain("NOW");
    expect(everything).not.toContain("TODAY");
    expect(everything).not.toContain("Total");
    expect(labels(suggestAt("|").result)).toContain("Total");
  });

  test("nothing inside a string or right after a complete operand", () => {
    expect(suggestAt("'abc|").result.items).toEqual([]);
    expect(suggestAt("{Title}|").result.items).toEqual([]);
    expect(suggestAt("12|").result.items).toEqual([]);
    expect(suggestAt("ROUND(1) |").result.items).toEqual([]);
  });

  test("the limit caps the list", () => {
    expect(suggestAt("|", { limit: 3 }).result.items).toHaveLength(3);
  });
});
