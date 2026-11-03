// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";

import { env, spanOf } from "./__fixtures__/env.ts";
import { analyze } from "./editor.ts";
import type { FormulaDiagnosticCode, FormulaEnvironment, FormulaField } from "./types.ts";

function accepted(text: string, environment: FormulaEnvironment = env) {
  const result = analyze(text, environment);
  if (result.errors.length > 0) throw new Error(`${text}: ${result.errors.map((error) => error.message).join("; ")}`);
  return result;
}

/** The single refusal of `text`, with its span checked against `part`. */
function refused(
  text: string,
  code: FormulaDiagnosticCode,
  part: string,
  options: Parameters<typeof analyze>[2] = {},
  environment: FormulaEnvironment = env,
) {
  const result = analyze(text, environment, options);
  expect(result.ast).toBeUndefined();
  expect(result.resultType).toBeUndefined();
  const diagnostic = result.errors.find((error) => error.code === code);
  if (!diagnostic) throw new Error(`${text}: expected ${code}, got ${JSON.stringify(result.errors)}`);
  const [start, end] = spanOf(text, part);
  expect({ start: diagnostic.start, end: diagnostic.end }).toEqual({ start, end });
  return diagnostic;
}

describe("the two reference examples", () => {
  test("{Capacity kWh} * {Price per kWh} binds both customer fields by id", () => {
    const result = accepted("{Capacity kWh} * {Price per kWh}");
    expect(result.resultType).toBe("number");
    expect(result.ast).toEqual({
      kind: "formula",
      op: "mul",
      operands: [
        { kind: "path", path: "f-cap" },
        { kind: "path", path: "f-ppk" },
      ],
    });
    expect(result.dependencies).toEqual([
      { id: "f-cap", scope: "self" },
      { id: "f-ppk", scope: "self" },
    ]);
    expect(result.depth).toBe(1);
  });

  test("{Capacity kWh} * pricing.amount reaches the owned child", () => {
    const result = accepted("{Capacity kWh} * pricing.amount");
    expect(result.resultType).toBe("number");
    expect(result.ast).toEqual({
      kind: "formula",
      op: "mul",
      operands: [
        { kind: "path", path: "f-cap" },
        { kind: "path", path: "pricing.amount" },
      ],
    });
    expect(result.dependencies).toEqual([
      { id: "f-cap", scope: "self" },
      { id: "amount", scope: { relation: "pricing" } },
    ]);
  });
});

describe("binding", () => {
  test("braces prefer the label, bare names the key, both fall back to either ignoring case", () => {
    expect(accepted("{Title}").ast).toEqual({ kind: "path", path: "title" });
    expect(accepted("{capacityKwh}").ast).toEqual({ kind: "path", path: "f-cap" });
    expect(accepted("capacityKwh").ast).toEqual({ kind: "path", path: "f-cap" });
    expect(accepted("{capacity KWH}").ast).toEqual({ kind: "path", path: "f-cap" });
    expect(accepted("{ Title }").ast).toEqual({ kind: "path", path: "title" });
    expect(accepted("Title").ast).toEqual({ kind: "path", path: "title" });
    expect(accepted("{Cost \\{net\\}}").ast).toEqual({ kind: "path", path: "f-cost" });
    expect(accepted("pricing.{Amount}").ast).toEqual({ kind: "path", path: "pricing.amount" });
  });

  test("a key wins over another field's label in bare form, and a label in braces", () => {
    const tricky: FormulaEnvironment = [
      { id: "a", label: "net", key: "gross", type: "number", scope: "self" },
      { id: "b", label: "gross", key: "net", type: "number", scope: "self" },
    ];
    expect(accepted("net", tricky).ast).toEqual({ kind: "path", path: "b" });
    expect(accepted("{net}", tricky).ast).toEqual({ kind: "path", path: "a" });
  });

  test("dependencies are listed once, in order of first use", () => {
    expect(accepted("{Price per kWh} + {Capacity kWh} * {Price per kWh}").dependencies).toEqual([
      { id: "f-ppk", scope: "self" },
      { id: "f-cap", scope: "self" },
    ]);
  });
});

describe("result types", () => {
  test.each([
    ["{Capacity kWh} + 1", "number"],
    ['{Title} & " " & {Capacity kWh}', "text"],
    ["{Capacity kWh} > 10", "boolean"],
    ["{Launch date}", "date"],
    ["DATEADD({Launch date}, 2, 'weeks')", "date"],
    ["DATEADD({Launch date}, 2, 'hours')", "timestamp"],
    ["DATEADD({Last seen}, 1, 'days')", "timestamp"],
    ["CREATED_TIME()", "timestamp"],
    ["IF({Active}, BLANK(), 3)", "number"],
    ["{Launch date} < {Last seen}", "boolean"],
    ["{Title} = BLANK()", "boolean"],
  ])("%s is %s", (text, type) => {
    expect(accepted(text).resultType).toBe(type as never);
  });
});

describe("refusals carry code, message and position", () => {
  test("syntax error", () => {
    const result = analyze("ROUND({Capacity kWh}, ", env);
    expect(result.ast).toBeUndefined();
    expect(result.errors).toEqual([
      { code: "syntaxError", message: "Expected a value, field or function, found the end of the formula", start: 22, end: 22 },
    ]);
  });

  test("unknown field", () => {
    const diagnostic = refused("{Capacity kWh} * {Prijs}", "unknownField", "{Prijs}");
    expect(diagnostic.params).toEqual({ name: "Prijs" });
    refused("1 + pricing.discount", "unknownField", "pricing.discount");
  });

  test("ambiguous label", () => {
    const twins: FormulaEnvironment = [
      { id: "a", label: "Price", key: "priceA", type: "number", scope: "self" },
      { id: "b", label: "Price", key: "priceB", type: "number", scope: "self" },
    ];
    refused("{Price} * 2", "ambiguousField", "{Price}", {}, twins);
    expect(accepted("{priceB} * 2", twins).ast).toMatchObject({ operands: [{ path: "b" }, {}] });
  });

  test("unknown function", () => {
    const diagnostic = refused("REGEX_MATCH({Title}, 'a')", "unknownFunction", "REGEX_MATCH");
    expect(diagnostic.params).toEqual({ function: "REGEX_MATCH" });
  });

  test("wrong number of arguments", () => {
    refused("ROUND(1, 2, 3)", "argumentCount", "ROUND(1, 2, 3)");
    refused("LEFT({Title})", "argumentCount", "LEFT({Title})");
    refused("BLANK(1)", "argumentCount", "BLANK(1)");
    refused("SWITCH({Title}, 'a')", "argumentCount", "SWITCH({Title}, 'a')");
    const diagnostic = refused("AND()", "argumentCount", "AND()");
    expect(diagnostic.message).toContain("at least 1");
  });

  test("type conflict in an operator", () => {
    const diagnostic = refused("{Title} + 1", "typeMismatch", "{Title}");
    expect(diagnostic.message).toContain("join text with &");
    refused("{Capacity kWh} * 'x'", "typeMismatch", "'x'");
    refused("-{Title}", "typeMismatch", "{Title}");
    refused("{Title} > 'a'", "typeMismatch", "{Title}");
    refused("{Active} < TRUE", "typeMismatch", "{Active}");
    refused("{Title} = 3", "typeMismatch", "{Title} = 3");
    refused("{Launch date} & ''", "typeMismatch", "{Launch date}");
  });

  test("type conflict in a function argument", () => {
    const diagnostic = refused("LEFT({Capacity kWh}, 2)", "typeMismatch", "{Capacity kWh}");
    expect(diagnostic.params).toMatchObject({ function: "LEFT", argument: 1, expected: "text", actual: "number" });
    refused("IF({Title}, 1, 2)", "typeMismatch", "{Title}");
    refused("ROUND({Capacity kWh}, 'two')", "typeMismatch", "'two'");
    refused("YEAR({Title})", "typeMismatch", "{Title}");
    refused("SWITCH({Capacity kWh}, 'a', 1)", "typeMismatch", "'a'");
  });

  test("mixed branches, stricter than Airtable", () => {
    const diagnostic = refused("IF({Active}, 1, 'none')", "mixedBranches", "'none'");
    expect(diagnostic.params).toMatchObject({ branch: 2, type: "text", expectedBranch: 1, expected: "number" });
    expect(diagnostic.message).toContain("branch 2 (else) is text");
    refused("SWITCH({Category}, 'a', 1, 'b', 'two')", "mixedBranches", "'two'");
    refused("SWITCH({Category}, 'a', 1, 'other')", "mixedBranches", "'other'");
    refused("IF({Active}, {Launch date}, {Last seen})", "mixedBranches", "{Last seen}");
  });

  test("a formula that is always blank has no type", () => {
    refused("BLANK()", "undeterminedType", "BLANK()");
    refused("IF({Active}, BLANK())", "undeterminedType", "IF({Active}, BLANK())");
  });

  test("time functions, including DATETIME_DIFF against now", () => {
    refused("NOW()", "timeFunction", "NOW()");
    refused("DATEADD(TODAY(), 1, 'days')", "timeFunction", "TODAY()");
    refused("DATETIME_DIFF({Launch date}, NOW(), 'days')", "timeFunction", "NOW()");
    refused("TONOW({Launch date})", "timeFunction", "TONOW({Launch date})");
  });

  test("references out of scope", () => {
    const diagnostic = refused("supplier.name", "outOfScope", "supplier");
    expect(diagnostic.message).toContain("lookup or rollup");
    refused("{Supplier}", "unsupportedFieldType", "{Supplier}");
  });

  test("classified fields", () => {
    refused("{Capacity kWh} * {Margin}", "classifiedField", "{Margin}");
  });

  test("invalid calendar unit", () => {
    refused("DATEADD({Launch date}, 1, 'fortnights')", "invalidArgument", "'fortnights'");
    refused("DATEADD({Launch date}, 1, {Title})", "invalidArgument", "{Title}");
  });

  test("a formula reading itself, directly or through another formula", () => {
    refused("{Total} + 1", "cycle", "{Total}", { fieldId: "f-total" });
    const withChain: FormulaEnvironment = [
      ...env,
      {
        id: "f-gross",
        label: "Gross",
        key: "gross",
        type: "number",
        scope: "self",
        kind: "formula",
        dependencies: [{ id: "f-new", scope: "self" }],
      },
    ];
    const diagnostic = refused("{Gross} * 2", "cycle", "{Gross}", { fieldId: "f-new" }, withChain);
    expect(diagnostic.message).toBe("Circular reference: f-new → Gross → f-new");
    expect(analyze("{Total} * 2", env, { fieldId: "f-new" }).errors).toEqual([]);
  });

  test("formula depth beyond the limit", () => {
    const chain: FormulaField[] = [{ id: "s", label: "S", key: "s", type: "number", scope: "self" }];
    for (let level = 1; level <= 5; level += 1) {
      chain.push({
        id: `l${level}`,
        label: `Level ${level}`,
        key: `level${level}`,
        type: "number",
        scope: "self",
        kind: "formula",
        dependencies: [{ id: level === 1 ? "s" : `l${level - 1}`, scope: "self" }],
      });
    }
    expect(analyze("{Level 4} + 1", chain).depth).toBe(5);
    const diagnostic = refused("{S} + {Level 5} + 1", "depthExceeded", "{Level 5}", {}, chain);
    expect(diagnostic.params).toMatchObject({ depth: 6, limit: 5 });
    expect(analyze("{Level 2} + 1", chain, { formulaDepth: 2 }).errors[0]?.code).toBe("depthExceeded");
    expect(analyze("{Total} + 1", env).depth).toBe(2);
  });

  test("several independent refusals are all reported, in text order", () => {
    const result = analyze("{Nope} + LEFT({Capacity kWh}, 1) + NOW()", env);
    expect(result.errors.map((error) => error.code)).toEqual(["unknownField", "typeMismatch", "timeFunction"]);
  });
});
