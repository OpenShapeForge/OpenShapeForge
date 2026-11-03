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
} from "./types.js";
export { parseFormula, tokenize, MAX_FORMULA_LENGTH, MAX_NESTING, MAX_NODES } from "./syntax.js";
export type { BinaryOperator, ParseResult, SyntaxNode, Token, TokenType } from "./syntax.js";
export {
  checkFormula,
  DEFAULT_FORMULA_DEPTH,
  fieldPath,
  FORMULA_TYPES,
  isComputedField,
  isFormulaType,
} from "./check.js";
export type { CheckOptions, CheckResult } from "./check.js";
export { DATE_UNITS, dateUnit, FORMULA_FUNCTIONS, formulaFunction, TIME_FUNCTIONS } from "./functions.js";
export type { FormulaFunction, FunctionCategory } from "./functions.js";
export { formatFormula, FormulaFormatError } from "./format.js";
export { childExpressions, dependencies, dependencyNodes } from "./dependencies.js";
export { buildDependencyGraph, dependencyNodeKey } from "./graph.js";
export type { DependencyDefinition, DependencyGraph, DependencyNode } from "./graph.js";
export { evaluate } from "./evaluate.js";
export type { EvaluateOptions } from "./evaluate.js";
export { analyze, applySuggestion, formulaTokens, suggest } from "./editor.js";
export type {
  AnalyzeOptions,
  FormulaAnalysis,
  FormulaSuggestion,
  FormulaSuggestions,
  FormulaToken,
  FormulaTokenType,
  SuggestOptions,
} from "./editor.js";
export { formulaTypeForBaseType } from "./base-types.js";
