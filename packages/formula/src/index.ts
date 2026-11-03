// SPDX-License-Identifier: BUSL-1.1
// @openshapeforge/formula — customer formulas in spreadsheet grammar.
//
//   analyze(text, env)            text → { ast, resultType, errors, dependencies, tokens }
//   formatFormula(ast, env)       ast → text with today's labels
//   dependencies(ast)             the fields a formula reads
//   buildDependencyGraph(defs)    cycles and evaluation order over (entity, field)
//   evaluate(ast, record, opts)   one record's value, or its error code
//   suggest(text, cursor, env)    completions for the editor
//
// The AST is the canonical expression AST of @openshapeforge/compiler; the
// evaluator under ./canonical is a verbatim copy of the compiler's.
export type {
  FormulaAst,
  FormulaDiagnostic,
  FormulaDiagnosticCode,
  FormulaEnvironment,
  FormulaErrorCode,
  FormulaEvaluation,
  FormulaField,
  FormulaFieldKind,
  FormulaFieldRef,
  FormulaFieldScope,
  FormulaRecord,
  FormulaType,
  FormulaValue,
} from "./types.ts";
export { parseFormula, tokenize, MAX_FORMULA_LENGTH, MAX_NESTING, MAX_NODES } from "./syntax.ts";
export type { BinaryOperator, ParseResult, SyntaxNode, Token, TokenType } from "./syntax.ts";
export {
  checkFormula,
  DEFAULT_FORMULA_DEPTH,
  fieldPath,
  FORMULA_TYPES,
  isComputedField,
  isFormulaType,
} from "./check.ts";
export type { CheckOptions, CheckResult } from "./check.ts";
export { DATE_UNITS, dateUnit, FORMULA_FUNCTIONS, formulaFunction, TIME_FUNCTIONS } from "./functions.ts";
export type { FormulaFunction, FunctionCategory } from "./functions.ts";
export { formatFormula, FormulaFormatError } from "./format.ts";
export { childExpressions, dependencies, dependencyNodes } from "./dependencies.ts";
export { buildDependencyGraph, dependencyNodeKey } from "./graph.ts";
export type { DependencyDefinition, DependencyGraph, DependencyNode } from "./graph.ts";
export { evaluate } from "./evaluate.ts";
export type { EvaluateOptions } from "./evaluate.ts";
export { analyze, applySuggestion, formulaTokens, suggest } from "./editor.ts";
export type {
  AnalyzeOptions,
  FormulaAnalysis,
  FormulaSuggestion,
  FormulaSuggestions,
  FormulaToken,
  FormulaTokenType,
  SuggestOptions,
} from "./editor.ts";
export { formulaTypeForBaseType } from "./base-types.ts";
