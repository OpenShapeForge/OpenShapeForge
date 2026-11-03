// SPDX-License-Identifier: BUSL-1.1
// Syntax tree → canonical AST: binds every field reference to a stable id,
// derives the result type statically and refuses what may not be saved, each
// refusal with the stretch of text it is about.
import type { CompilerConditionOperator, CompilerDateUnit } from "./canonical/canonical-condition.js";
import {
  comparable,
  dateUnit,
  DATE_UNITS,
  formulaFunction,
  TIME_FUNCTIONS,
  type CallContext,
  type CallSyntax,
  type Checked,
  type ValueType,
} from "./functions.js";
import { buildDependencyGraph, type DependencyDefinition } from "./graph.js";
import type { SyntaxNode } from "./syntax.js";
import type {
  FormulaAst,
  FormulaDiagnostic,
  FormulaDiagnosticCode,
  FormulaEnvironment,
  FormulaField,
  FormulaFieldRef,
  FormulaType,
} from "./types.js";

export const FORMULA_TYPES: readonly FormulaType[] = ["text", "number", "boolean", "date", "timestamp"];

/** The `extensible.limits.formulaDepth` default. */
export const DEFAULT_FORMULA_DEPTH = 5;

export type CheckOptions = {
  /** The field this formula defines; reading it, directly or through other formulas, is a cycle. */
  fieldId?: string;
  /** `extensible.limits.formulaDepth`. */
  formulaDepth?: number;
};

export type CheckResult = {
  ast?: FormulaAst;
  resultType?: FormulaType;
  errors: FormulaDiagnostic[];
  dependencies: FormulaFieldRef[];
  /** How many formulas deep this one is: 1 over stored fields only. */
  depth?: number;
};

type Span = { start: number; end: number };

const ARITHMETIC = { "+": "add", "-": "sub", "*": "mul", "/": "div" } as const;
const COMPARISON: Record<string, CompilerConditionOperator> = {
  "=": "equals",
  "!=": "notEquals",
  "<": "lessThan",
  ">": "greaterThan",
  "<=": "lessThanOrEquals",
  ">=": "greaterThanOrEquals",
};

const ORDINALS = ["1st", "2nd", "3rd"];
const ordinal = (index: number) => ORDINALS[index] ?? `${index + 1}th`;

export function isFormulaType(type: string): type is FormulaType {
  return (FORMULA_TYPES as readonly string[]).includes(type);
}

export function isComputedField(field: FormulaField): boolean {
  return field.kind === "formula" || field.kind === "lookup" || field.kind === "rollup";
}

export function scopeKey(scope: FormulaField["scope"]): string {
  return scope === "self" ? "" : scope.relation;
}

/** The path a formula AST uses for a field: its id, under the relation for an owned child. */
export function fieldPath(field: { id: string; scope: FormulaField["scope"] }): string {
  return field.scope === "self" ? field.id : `${field.scope.relation}.${field.id}`;
}

function unwrap(node: SyntaxNode): SyntaxNode {
  return node.type === "paren" ? unwrap(node.inner) : node;
}

function isBlankCall(node: SyntaxNode): boolean {
  const inner = unwrap(node);
  return inner.type === "call" && inner.name === "BLANK" && inner.args.length === 0;
}

class Checker {
  readonly errors: FormulaDiagnostic[] = [];
  readonly references: Array<{ field: FormulaField } & Span> = [];

  constructor(private readonly env: FormulaEnvironment) {}

  report(code: FormulaDiagnosticCode, message: string, at: Span, params?: Record<string, string | number>): void {
    this.errors.push({ code, message, start: at.start, end: at.end, ...(params ? { params } : {}) });
  }

  check(node: SyntaxNode): Checked {
    switch (node.type) {
      case "number":
        return { type: "number", ast: { kind: "literal", value: node.value }, syntax: node };
      case "string":
        return { type: "text", ast: { kind: "literal", value: node.value }, syntax: node };
      case "boolean":
        return { type: "boolean", ast: { kind: "literal", value: node.value }, syntax: node };
      case "paren": {
        const inner = this.check(node.inner);
        return { ...inner, syntax: node };
      }
      case "field":
        return this.field(node);
      case "unary":
        return this.unary(node);
      case "binary":
        return this.binary(node);
      case "call":
        return this.call(node);
    }
  }

  private invalid(syntax: SyntaxNode): Checked {
    return { type: "invalid", ast: { kind: "literal", value: null }, syntax };
  }

  private field(node: Extract<SyntaxNode, { type: "field" }>): Checked {
    const relation = node.relation;
    const candidates = this.env.filter((field) =>
      relation ? field.scope !== "self" && field.scope.relation === relation.name : field.scope === "self",
    );
    if (relation && candidates.length === 0) {
      this.report(
        "outOfScope",
        `'${relation.name}' is not an owned single child of this record; reach other records with a lookup or rollup`,
        relation,
        { relation: relation.name },
      );
      return this.invalid(node);
    }
    const display = relation ? `${relation.name}.${node.name}` : node.name;
    const matches = resolve(candidates, node.name, node.braced);
    if (matches.length === 0) {
      this.report("unknownField", `There is no field '${display}'`, node, { name: display });
      return this.invalid(node);
    }
    if (matches.length > 1) {
      this.report(
        "ambiguousField",
        `'${display}' names ${matches.length} fields; use the field's key instead`,
        node,
        { name: display, count: matches.length },
      );
      return this.invalid(node);
    }
    const field = matches[0]!;
    const ast: FormulaAst = { kind: "path", path: fieldPath(field) };
    if (field.classified) {
      this.report(
        "classifiedField",
        `'${field.label}' is classified; a formula may not read it, because its result would reveal the value`,
        node,
        { field: field.label },
      );
      return { type: "invalid", ast, syntax: node };
    }
    if (!isFormulaType(field.type)) {
      this.report(
        "unsupportedFieldType",
        `'${field.label}' is a ${field.type} field, which a formula cannot read; use a lookup or rollup for related records`,
        node,
        { field: field.label, type: field.type },
      );
      return { type: "invalid", ast, syntax: node };
    }
    this.references.push({ field, start: node.start, end: node.end });
    return { type: field.type, ast, syntax: node };
  }

  private unary(node: Extract<SyntaxNode, { type: "unary" }>): Checked {
    const operand = this.check(node.operand);
    this.expectOperand(operand, ["number"], `unary '${node.operator}'`, "operand");
    if (node.operator === "+") return { ...operand, type: typeOr(operand.type, "number"), syntax: node };
    const literal = unwrap(node.operand);
    if (literal.type === "number") {
      return { type: "number", ast: { kind: "literal", value: -literal.value }, syntax: node };
    }
    return {
      type: typeOr(operand.type, "number"),
      ast: { kind: "formula", op: "negate", operands: [operand.ast] },
      syntax: node,
    };
  }

  private binary(node: Extract<SyntaxNode, { type: "binary" }>): Checked {
    const operator = node.operator;
    if ((operator === "=" || operator === "!=") && (isBlankCall(node.left) || isBlankCall(node.right))) {
      const subject = isBlankCall(node.right) ? this.check(node.left) : this.check(node.right);
      return {
        type: subject.type === "invalid" ? "invalid" : "boolean",
        ast: { kind: "rule", operator: operator === "=" ? "isEmpty" : "isNotEmpty", left: subject.ast },
        syntax: node,
      };
    }
    const left = this.check(node.left);
    const right = this.check(node.right);
    const failed = left.type === "invalid" || right.type === "invalid";
    if (operator === "&") {
      this.expectConcatenable(left, "left");
      this.expectConcatenable(right, "right");
      return {
        type: failed ? "invalid" : "text",
        ast: { kind: "formula", op: "concat", operands: [left.ast, right.ast] },
        syntax: node,
      };
    }
    if (operator in ARITHMETIC) {
      const hint = operator === "+" ? " (join text with &)" : "";
      const okLeft = this.expectOperand(left, ["number"], `'${operator}'`, "left side", hint);
      const okRight = this.expectOperand(right, ["number"], `'${operator}'`, "right side", hint);
      return {
        type: failed || !okLeft || !okRight ? "invalid" : "number",
        ast: { kind: "formula", op: ARITHMETIC[operator as keyof typeof ARITHMETIC], operands: [left.ast, right.ast] },
        syntax: node,
      };
    }
    const ordering = operator !== "=" && operator !== "!=";
    let ok = true;
    if (ordering) {
      for (const [side, checked] of [["left side", left], ["right side", right]] as const) {
        if (!["number", "date", "timestamp", "blank", "invalid"].includes(checked.type)) {
          ok = false;
          this.report(
            "typeMismatch",
            `'${operator}' compares numbers or dates; the ${side} is ${checked.type}`,
            checked.syntax,
            { operator, side, actual: checked.type },
          );
        }
      }
    }
    if (ok && !comparable(left.type, right.type)) {
      ok = false;
      this.report(
        "typeMismatch",
        `'${operator}' cannot compare ${left.type} with ${right.type}`,
        { start: node.start, end: node.end },
        { operator, left: left.type, right: right.type },
      );
    }
    return {
      type: failed || !ok ? "invalid" : "boolean",
      ast: { kind: "rule", operator: COMPARISON[operator]!, left: left.ast, right: right.ast },
      syntax: node,
    };
  }

  private call(node: CallSyntax): Checked {
    const nameSpan = { start: node.start, end: node.nameEnd };
    if (TIME_FUNCTIONS.has(node.name)) {
      this.report(
        "timeFunction",
        `${node.name}() changes with time, so its value cannot be stored; time-dependent formulas are not supported`,
        node,
        { function: node.name },
      );
      node.args.forEach((arg) => this.check(arg));
      return this.invalid(node);
    }
    const fn = formulaFunction(node.name);
    if (!fn) {
      this.report("unknownFunction", `There is no function ${node.name}()`, nameSpan, { function: node.name });
      node.args.forEach((arg) => this.check(arg));
      return this.invalid(node);
    }
    const args = node.args.map((arg) => this.check(arg));
    if (args.length < fn.minArgs || args.length > fn.maxArgs) {
      const expected =
        fn.minArgs === fn.maxArgs
          ? `${fn.minArgs}`
          : fn.maxArgs === Infinity
            ? `at least ${fn.minArgs}`
            : `${fn.minArgs} to ${fn.maxArgs}`;
      this.report(
        "argumentCount",
        `${fn.name}() takes ${expected} argument${expected === "1" ? "" : "s"}, not ${args.length}: ${fn.signature}`,
        node,
        { function: fn.name, expected, actual: args.length },
      );
      return this.invalid(node);
    }
    const before = this.errors.length;
    const lowered = fn.lower(this.context(node, args));
    const failed = this.errors.length > before || args.some((arg) => arg.type === "invalid");
    return { type: failed ? "invalid" : lowered.type, ast: lowered.ast, syntax: node };
  }

  private context(call: CallSyntax, args: readonly Checked[]): CallContext {
    return {
      call,
      args,
      report: (code, message, at, params) => this.report(code, message, at, params),
      expect: (index, allowed) => {
        const arg = args[index];
        if (!arg || arg.type === "blank" || arg.type === "invalid") return;
        if ((allowed as readonly string[]).includes(arg.type)) return;
        this.report(
          "typeMismatch",
          `${call.name}() needs ${listTypes(allowed)} as its ${ordinal(index)} argument, not ${arg.type}`,
          arg.syntax,
          { function: call.name, argument: index + 1, expected: allowed.join("|"), actual: arg.type },
        );
      },
      unify: (branches) => this.unify(call.name, branches),
      unit: (index, fallback) => this.unit(call, args, index, fallback),
    };
  }

  private unify(name: string, branches: readonly { checked: Checked; label: string }[]): ValueType {
    let expected: { type: FormulaType; label: string; branch: number } | undefined;
    let invalid = false;
    branches.forEach(({ checked, label }, index) => {
      if (checked.type === "invalid") {
        invalid = true;
        return;
      }
      if (checked.type === "blank") return;
      if (!expected) {
        expected = { type: checked.type, label, branch: index + 1 };
        return;
      }
      if (checked.type === expected.type) return;
      invalid = true;
      this.report(
        "mixedBranches",
        `${name}() branch ${index + 1} (${label}) is ${checked.type}, but branch ${expected.branch} (${expected.label}) is ${expected.type}; every branch must give the same type`,
        checked.syntax,
        { function: name, branch: index + 1, type: checked.type, expectedBranch: expected.branch, expected: expected.type },
      );
    });
    if (invalid) return "invalid";
    return expected?.type ?? "blank";
  }

  private unit(call: CallSyntax, args: readonly Checked[], index: number, fallback?: CompilerDateUnit): CompilerDateUnit | undefined {
    const arg = args[index];
    if (!arg) return fallback;
    const literal = unwrap(arg.syntax);
    const unit = literal.type === "string" ? dateUnit(literal.value) : undefined;
    if (unit === undefined) {
      this.report(
        "invalidArgument",
        `${call.name}() needs a unit in quotes as its ${ordinal(index)} argument: ${DATE_UNITS.map((u) => `'${u}'`).join(", ")}`,
        arg.syntax,
        { function: call.name, argument: index + 1 },
      );
    }
    return unit;
  }

  private expectOperand(checked: Checked, allowed: readonly FormulaType[], operator: string, side: string, hint = ""): boolean {
    if (checked.type === "blank" || checked.type === "invalid") return true;
    if ((allowed as readonly string[]).includes(checked.type)) return true;
    this.report(
      "typeMismatch",
      `${operator} needs ${listTypes(allowed)}; the ${side} is ${checked.type}${hint}`,
      checked.syntax,
      { operator, side, expected: allowed.join("|"), actual: checked.type },
    );
    return false;
  }

  private expectConcatenable(checked: Checked, side: string): void {
    if (checked.type !== "date" && checked.type !== "timestamp") return;
    this.report(
      "typeMismatch",
      `'&' joins text, numbers and booleans; the ${side} side is a ${checked.type}, so format it with DATETIME_FORMAT() first`,
      checked.syntax,
      { operator: "&", side, actual: checked.type },
    );
  }
}

function typeOr(type: ValueType, fallback: FormulaType): ValueType {
  return type === "invalid" ? "invalid" : fallback;
}

function listTypes(types: readonly FormulaType[]): string {
  if (types.length === 1) return types[0]!;
  return `${types.slice(0, -1).join(", ")} or ${types[types.length - 1]}`;
}

/**
 * The fields `name` designates, in order of preference: inside braces an exact
 * label, then a key; bare, a key, then an exact label; then either, ignoring
 * case and surrounding spaces. The first tier with a match decides.
 */
function resolve(fields: readonly FormulaField[], name: string, braced: boolean): FormulaField[] {
  const byLabel = (field: FormulaField) => field.label === name;
  const byKey = (field: FormulaField) => field.key === name;
  const folded = name.trim().toLocaleLowerCase();
  const loose = (field: FormulaField) =>
    field.label.trim().toLocaleLowerCase() === folded || field.key.toLocaleLowerCase() === folded;
  for (const tier of braced ? [byLabel, byKey, loose] : [byKey, byLabel, loose]) {
    const found = fields.filter(tier);
    if (found.length > 0) return found;
  }
  return [];
}

/** Binds and types a parsed formula against `env`. */
export function checkFormula(syntax: SyntaxNode, env: FormulaEnvironment, options: CheckOptions = {}): CheckResult {
  const checker = new Checker(env);
  const root = checker.check(syntax);
  const errors = checker.errors;

  const dependencies: FormulaFieldRef[] = [];
  const seen = new Set<string>();
  for (const { field } of checker.references) {
    const path = fieldPath(field);
    if (seen.has(path)) continue;
    seen.add(path);
    dependencies.push({ id: field.id, scope: field.scope });
  }

  if (options.fieldId !== undefined) reportCycle(checker, env, options.fieldId);

  const limit = options.formulaDepth ?? DEFAULT_FORMULA_DEPTH;
  let depth = 1;
  let deepest: ({ field: FormulaField } & Span) | undefined;
  for (const reference of checker.references) {
    const own = fieldDepth(reference.field, env, new Set());
    if (own + 1 > depth) {
      depth = own + 1;
      deepest = reference;
    }
  }
  if (depth > limit && deepest) {
    checker.report(
      "depthExceeded",
      `This formula would be ${depth} formulas deep through '${deepest.field.label}'; the limit is ${limit}`,
      deepest,
      { depth, limit, field: deepest.field.label },
    );
  }

  if (errors.length === 0 && root.type === "blank") {
    checker.report("undeterminedType", "This formula is always blank, so it has no type", syntax);
  }
  if (errors.length > 0 || root.type === "invalid" || root.type === "blank") {
    return { errors: sortDiagnostics(errors), dependencies };
  }
  return { ast: root.ast, resultType: root.type, errors: [], dependencies, depth };
}

function fieldDepth(field: FormulaField, env: FormulaEnvironment, visiting: Set<string>): number {
  if (!isComputedField(field)) return 0;
  if (field.depth !== undefined) return field.depth;
  const key = fieldPath(field);
  if (visiting.has(key) || !field.dependencies?.length) return 1;
  visiting.add(key);
  let deepest = 0;
  for (const dependency of field.dependencies) {
    const target = env.find((candidate) => candidate.id === dependency.id && scopeKey(candidate.scope) === scopeKey(dependency.scope));
    if (target) deepest = Math.max(deepest, fieldDepth(target, env, visiting));
  }
  visiting.delete(key);
  return deepest + 1;
}

/**
 * Refuses a formula that reads its own field, directly or through formulas of
 * the same record. Owned children cannot read their owner, so a cycle can only
 * close within the record.
 */
function reportCycle(checker: Checker, env: FormulaEnvironment, fieldId: string): void {
  const self = (id: string) => ({ entity: "", field: id });
  const definitions: DependencyDefinition[] = env
    .filter((field) => field.scope === "self" && field.id !== fieldId && field.dependencies?.length)
    .map((field) => ({
      node: self(field.id),
      dependsOn: field.dependencies!.filter((ref) => ref.scope === "self").map((ref) => self(ref.id)),
    }));
  const reads = checker.references.filter((reference) => reference.field.scope === "self");
  definitions.push({ node: self(fieldId), dependsOn: reads.map((reference) => self(reference.field.id)) });
  const graph = buildDependencyGraph(definitions);
  const labelOf = (id: string) =>
    env.find((field) => field.scope === "self" && field.id === id)?.label ?? id;
  for (const reference of reads) {
    const chain =
      reference.field.id === fieldId ? [self(fieldId)] : graph.path(self(reference.field.id), self(fieldId));
    if (!chain) continue;
    const names = [labelOf(fieldId), ...chain.map((node) => labelOf(node.field))];
    checker.report(
      "cycle",
      `Circular reference: ${names.join(" → ")}`,
      reference,
      { path: names.join(" → ") },
    );
    return;
  }
}

function sortDiagnostics(diagnostics: FormulaDiagnostic[]): FormulaDiagnostic[] {
  return [...diagnostics].sort((a, b) => a.start - b.start || a.end - b.end);
}
