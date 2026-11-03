// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";

import { MAX_FORMULA_LENGTH, MAX_NESTING, MAX_NODES, parseFormula, tokenize, type SyntaxNode } from "./syntax.ts";

/** A compact rendering of the tree: fields in braces, calls by name, binaries in parentheses. */
function shape(node: SyntaxNode): string {
  switch (node.type) {
    case "number":
      return String(node.value);
    case "string":
      return JSON.stringify(node.value);
    case "boolean":
      return node.value ? "TRUE" : "FALSE";
    case "field":
      return `${node.relation ? `${node.relation.name}.` : ""}{${node.name}}${node.braced ? "" : "*"}`;
    case "call":
      return `${node.name}(${node.args.map(shape).join(", ")})`;
    case "unary":
      return `(${node.operator}${shape(node.operand)})`;
    case "binary":
      return `(${shape(node.left)} ${node.operator} ${shape(node.right)})`;
    case "paren":
      return `[${shape(node.inner)}]`;
  }
}

function parsed(text: string): string {
  const result = parseFormula(text);
  if (result.error) throw new Error(`${text}: ${result.error.message}`);
  return shape(result.syntax);
}

function syntaxError(text: string) {
  const result = parseFormula(text);
  if (!result.error) throw new Error(`${text} parsed`);
  return result.error;
}

describe("field references", () => {
  test("braces allow spaces and punctuation in names", () => {
    expect(parsed("{Capacity kWh}")).toBe("{Capacity kWh}");
    expect(parsed("{Price (excl. VAT) €}")).toBe("{Price (excl. VAT) €}");
    expect(parsed("{  padded  }")).toBe("{  padded  }");
  });

  test("a closing brace and a backslash are escaped inside braces", () => {
    expect(parsed("{Cost \\{net\\}}")).toBe("{Cost {net}}");
    expect(parsed("{Cost {net\\}}")).toBe("{Cost {net}}");
    expect(parsed("{a\\}b}")).toBe("{a}b}");
    expect(parsed("{back\\\\slash}")).toBe("{back\\slash}");
  });

  test("bare identifiers are fields, unicode letters included", () => {
    expect(parsed("capacityKwh")).toBe("{capacityKwh}*");
    expect(parsed("prijs_per_kWh")).toBe("{prijs_per_kWh}*");
    expect(parsed("größe")).toBe("{größe}*");
  });

  test("relation.field reaches an owned child", () => {
    expect(parsed("pricing.amount")).toBe("pricing.{amount}*");
    expect(parsed("pricing.{List price}")).toBe("pricing.{List price}");
    const result = parseFormula("pricing . amount");
    expect(result.syntax?.type).toBe("field");
  });

  test("TRUE and FALSE are booleans in any case", () => {
    expect(parsed("TRUE")).toBe("TRUE");
    expect(parsed("false")).toBe("FALSE");
    expect(parsed("{TRUE}")).toBe("{TRUE}");
  });
});

describe("literals", () => {
  test("numbers", () => {
    expect(parsed("42")).toBe("42");
    expect(parsed("3.25")).toBe("3.25");
    expect(parsed(".5")).toBe("0.5");
    expect(parsed("1e3")).toBe("1000");
    expect(parsed("2.5E-2")).toBe("0.025");
  });

  test("strings in either quote with escapes", () => {
    expect(parsed('"kWh"')).toBe('"kWh"');
    expect(parsed("'kWh'")).toBe('"kWh"');
    expect(parsed('"say \\"hi\\""')).toBe('"say \\"hi\\""');
    expect(parsed("'it\\'s'")).toBe('"it\'s"');
    expect(parsed('"a\\nb\\tc\\\\d"')).toBe('"a\\nb\\tc\\\\d"');
    expect(parsed('"{not a field}"')).toBe('"{not a field}"');
    expect(parsed('""')).toBe('""');
  });
});

describe("operators", () => {
  test("multiplication binds tighter than addition", () => {
    expect(parsed("1 + 2 * 3")).toBe("(1 + (2 * 3))");
    expect(parsed("1 * 2 + 3")).toBe("((1 * 2) + 3)");
    expect(parsed("(1 + 2) * 3")).toBe("([(1 + 2)] * 3)");
  });

  test("binary operators are left-associative", () => {
    expect(parsed("10 - 3 - 2")).toBe("((10 - 3) - 2)");
    expect(parsed("8 / 4 / 2")).toBe("((8 / 4) / 2)");
    expect(parsed('"a" & "b" & "c"')).toBe('(("a" & "b") & "c")');
  });

  test("& sits between arithmetic and comparison", () => {
    expect(parsed('1 + 2 & "x"')).toBe('((1 + 2) & "x")');
    expect(parsed('"a" & "b" = "ab"')).toBe('(("a" & "b") = "ab")');
    expect(parsed("{a} * 2 > {b} + 1")).toBe("(({a} * 2) > ({b} + 1))");
  });

  test("every comparison operator, with <> as !=", () => {
    for (const op of ["=", "!=", "<", ">", "<=", ">="]) expect(parsed(`1 ${op} 2`)).toBe(`(1 ${op} 2)`);
    expect(parsed("1 <> 2")).toBe("(1 != 2)");
  });

  test("unary minus binds tightest and stacks", () => {
    expect(parsed("-5")).toBe("(-5)");
    expect(parsed("-{a} * 2")).toBe("((-{a}) * 2)");
    expect(parsed("2 * -3")).toBe("(2 * (-3))");
    expect(parsed("1 - -1")).toBe("(1 - (-1))");
    expect(parsed("--1")).toBe("(-(-1))");
    expect(parsed("+1")).toBe("(+1)");
  });

  test("whitespace and newlines are insignificant", () => {
    expect(parsed("  IF(\n  {a} > 1,\n  2,\n  3\n)  ")).toBe("IF(({a} > 1), 2, 3)");
    expect(parsed("{a}*{b}")).toBe("({a} * {b})");
  });
});

describe("calls", () => {
  test("function names are case-insensitive and stored in capitals", () => {
    expect(parsed("round(1.5)")).toBe("ROUND(1.5)");
    expect(parsed("Concatenate({a}, 'b')")).toBe('CONCATENATE({a}, "b")');
  });

  test("no arguments, nested calls and a space before the parenthesis", () => {
    expect(parsed("BLANK()")).toBe("BLANK()");
    expect(parsed("IF(AND({a}, NOT({b})), 1, 2)")).toBe("IF(AND({a}, NOT({b})), 1, 2)");
    expect(parsed("ROUND (1.5)")).toBe("ROUND(1.5)");
  });
});

describe("syntax errors carry a position", () => {
  test("empty formula", () => {
    expect(syntaxError("")).toMatchObject({ code: "syntaxError", start: 0, end: 0 });
    expect(syntaxError("   ")).toMatchObject({ code: "syntaxError", start: 3 });
  });

  test("unclosed parenthesis, call and string", () => {
    expect(syntaxError("(1 + 2")).toMatchObject({ start: 6, end: 6 });
    expect(syntaxError("ROUND(1, 2")).toMatchObject({ start: 10 });
    expect(syntaxError('"open')).toMatchObject({ start: 0, end: 5 });
    expect(syntaxError("{Capacity")).toMatchObject({ start: 0, end: 9 });
  });

  test("dangling and doubled operators", () => {
    expect(syntaxError("1 +")).toMatchObject({ start: 3 });
    expect(syntaxError("1 * * 2")).toMatchObject({ start: 4, end: 5 });
    expect(syntaxError("1 2")).toMatchObject({ start: 2, end: 3 });
  });

  test("argument lists", () => {
    expect(syntaxError("ROUND(1,)")).toMatchObject({ start: 8, end: 9 });
    expect(syntaxError("ROUND(,1)")).toMatchObject({ start: 6, end: 7 });
  });

  test("unexpected characters and empty braces", () => {
    expect(syntaxError("1 # 2")).toMatchObject({ start: 2, end: 3 });
    expect(syntaxError("{}")).toMatchObject({ start: 0, end: 2 });
    expect(syntaxError("{ }")).toMatchObject({ start: 0, end: 3 });
  });

  test("relation paths are one level deep", () => {
    expect(syntaxError("pricing.amount.value")).toMatchObject({ start: 14, end: 15 });
    expect(syntaxError("pricing.")).toMatchObject({ start: 8 });
    expect(syntaxError("pricing.(1)")).toMatchObject({ start: 8, end: 9 });
    // `.1` is a number, so this is a number where an operator should be.
    expect(syntaxError("pricing.1")).toMatchObject({ start: 7, end: 9 });
  });

  test("size limits are refused as too complex", () => {
    expect(parseFormula("1".repeat(MAX_FORMULA_LENGTH + 1)).error?.code).toBe("tooComplex");
    expect(parseFormula("(".repeat(MAX_NESTING + 1) + "1" + ")".repeat(MAX_NESTING + 1)).error?.code).toBe("tooComplex");
    expect(parseFormula("(".repeat(MAX_NESTING) + "1" + ")".repeat(MAX_NESTING)).error).toBeUndefined();
    expect(parseFormula(Array.from({ length: MAX_NODES }, () => "1").join("+")).error?.code).toBe("tooComplex");
  });
});

describe("tokenize never throws", () => {
  test("half-typed text yields unterminated tokens", () => {
    const tokens = tokenize('ROUND({Cap "x');
    expect(tokens.map((token) => token.type)).toEqual(["identifier", "lparen", "field", "eof"]);
    expect(tokens[2]).toMatchObject({ unterminated: true, value: 'Cap "x' });
    expect(tokenize("@")[0]).toMatchObject({ type: "invalid", text: "@" });
  });
});
