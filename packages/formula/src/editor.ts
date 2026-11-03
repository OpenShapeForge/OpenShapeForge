// SPDX-License-Identifier: BUSL-1.1
// What a formula editor needs while someone types: diagnostics and a preview
// on every keystroke (`analyze`), completions at the caret (`suggest`), and
// tokens to colour. Shaped for Battery's FieldFormula (`suggestions` of
// `{ value, label, context, kind }`, `onSuggestionSelect(value)`) and
// FormulaToken (`field | operator | number | function | parenthesis`).
import { checkFormula, isFormulaType, type CheckOptions } from "./check.js";
import { evaluate } from "./evaluate.js";
import { braceFieldName } from "./format.js";
import { FORMULA_FUNCTIONS, TIME_FUNCTIONS } from "./functions.js";
import { isIdentifier, parseFormula, tokenize, type Token } from "./syntax.js";
import type {
  FormulaAst,
  FormulaDiagnostic,
  FormulaEnvironment,
  FormulaEvaluation,
  FormulaField,
  FormulaFieldRef,
  FormulaRecord,
  FormulaType,
} from "./types.js";

/**
 * A token to colour. The first five types are Battery's FormulaTokenType;
 * `text`, `boolean`, `separator` (`,` `.`) and `invalid` are for the host to
 * map onto them.
 */
export type FormulaTokenType =
  | "field"
  | "operator"
  | "number"
  | "function"
  | "parenthesis"
  | "text"
  | "boolean"
  | "separator"
  | "invalid";

export type FormulaToken = { value: string; type: FormulaTokenType; start: number; end: number };

export type FormulaAnalysis = {
  /** Present only when the formula may be saved. */
  ast?: FormulaAst;
  resultType?: FormulaType;
  errors: FormulaDiagnostic[];
  dependencies: FormulaFieldRef[];
  depth?: number;
  tokens: FormulaToken[];
  /** The formula evaluated against `options.sample`, when one is given and the formula is valid. */
  preview?: FormulaEvaluation;
};

export type AnalyzeOptions = CheckOptions & { sample?: FormulaRecord };

/** Parses, binds and types `text` in one go, for live feedback and for the save-time check. */
export function analyze(text: string, env: FormulaEnvironment, options: AnalyzeOptions = {}): FormulaAnalysis {
  const tokens = formulaTokens(text);
  const parsed = parseFormula(text);
  if (parsed.error) return { errors: [parsed.error], dependencies: [], tokens };
  const checked = checkFormula(parsed.syntax, env, options);
  const analysis: FormulaAnalysis = { ...checked, tokens };
  if (checked.ast && checked.resultType && options.sample) {
    analysis.preview = evaluate(checked.ast, options.sample, { env, resultType: checked.resultType });
  }
  return analysis;
}

/** Tokens to colour, for any text, including half-typed formulas. */
export function formulaTokens(text: string): FormulaToken[] {
  const tokens = tokenize(text).filter((token) => token.type !== "eof");
  return tokens.map((token, index) => ({
    value: token.text,
    type: tokenType(token, tokens[index - 1], tokens[index + 1]),
    start: token.start,
    end: token.end,
  }));
}

function tokenType(token: Token, previous: Token | undefined, next: Token | undefined): FormulaTokenType {
  switch (token.type) {
    case "field":
      return "field";
    case "number":
      return "number";
    case "string":
      return "text";
    case "operator":
      return "operator";
    case "lparen":
    case "rparen":
      return "parenthesis";
    case "comma":
    case "dot":
      return "separator";
    case "identifier": {
      if (next?.type === "lparen") return "function";
      const upper = token.text.toUpperCase();
      if (previous?.type !== "dot" && next?.type !== "dot" && (upper === "TRUE" || upper === "FALSE")) return "boolean";
      return "field";
    }
    default:
      return "invalid";
  }
}

export type FormulaSuggestion = {
  kind: "field" | "function";
  /** The field's label or the function's name. */
  label: string;
  /** What replaces `from`–`to` when the suggestion is picked. */
  value: string;
  /** An owned child field's relation, or a function's signature. */
  context?: string;
  /** The field's type, or the function's result type when it is fixed. */
  type?: FormulaType;
  description?: string;
};

export type FormulaSuggestions = {
  /** The stretch of text a picked suggestion replaces. */
  from: number;
  to: number;
  items: FormulaSuggestion[];
};

export type SuggestOptions = {
  /** The field being defined: never suggested to itself. */
  fieldId?: string;
  /** At most this many items (default 50). */
  limit?: number;
};

type Mode =
  | { kind: "none" }
  | { kind: "brace"; prefix: string; from: number; to: number }
  | { kind: "identifier"; prefix: string; from: number; to: number }
  | { kind: "member"; relation: string; prefix: string; from: number; to: number };

/** Completions at `cursor`: fields and functions that fit what is typed there. */
export function suggest(text: string, cursor: number, env: FormulaEnvironment, options: SuggestOptions = {}): FormulaSuggestions {
  const mode = completionMode(text, Math.max(0, Math.min(cursor, text.length)));
  if (mode.kind === "none") return { from: cursor, to: cursor, items: [] };
  const usable = env.filter(
    (field) => isFormulaType(field.type) && !field.classified && !(field.scope === "self" && field.id === options.fieldId),
  );
  const fieldsInReach =
    mode.kind === "member"
      ? usable.filter((field) => field.scope !== "self" && field.scope.relation === mode.relation)
      : usable;
  const ranked: Array<{ tier: number; group: number; item: FormulaSuggestion }> = [];
  for (const field of fieldsInReach) {
    // A bare word may be the start of `relation.field`; inside braces it is a label.
    const names =
      field.scope !== "self" && mode.kind === "identifier"
        ? [field.label, field.key, `${field.scope.relation}.${field.key}`]
        : [field.label, field.key];
    const tier = matchTier(mode.prefix, names);
    if (tier === undefined) continue;
    ranked.push({ tier, group: 0, item: fieldSuggestion(field, mode.kind === "member") });
  }
  if (mode.kind === "identifier") {
    for (const fn of FORMULA_FUNCTIONS) {
      if (TIME_FUNCTIONS.has(fn.name)) continue;
      const tier = matchTier(mode.prefix, [fn.name]);
      if (tier === undefined) continue;
      ranked.push({
        tier,
        group: 1,
        item: {
          kind: "function",
          label: fn.name,
          value: `${fn.name}(`,
          context: fn.signature,
          ...(fn.returns ? { type: fn.returns } : {}),
          description: fn.description,
        },
      });
    }
  }
  const items = ranked
    .map((entry, index) => ({ ...entry, index }))
    .sort((a, b) => a.tier - b.tier || a.group - b.group || a.index - b.index)
    .slice(0, options.limit ?? 50)
    .map((entry) => entry.item);
  return { from: mode.from, to: mode.to, items };
}

/** The text and caret after picking `item` from `suggestions`. */
export function applySuggestion(text: string, suggestions: FormulaSuggestions, item: FormulaSuggestion): { text: string; cursor: number } {
  return {
    text: text.slice(0, suggestions.from) + item.value + text.slice(suggestions.to),
    cursor: suggestions.from + item.value.length,
  };
}

function fieldSuggestion(field: FormulaField, memberOnly: boolean): FormulaSuggestion {
  const member = isIdentifier(field.key) ? field.key : braceFieldName(field.label);
  const value =
    field.scope === "self" ? braceFieldName(field.label) : memberOnly ? member : `${field.scope.relation}.${member}`;
  return {
    kind: "field",
    label: field.label,
    value,
    ...(field.scope === "self" ? {} : { context: field.scope.relation }),
    type: field.type as FormulaType,
  };
}

/** 0 for a prefix match, 1 for a match inside, undefined for none. Case-insensitive. */
function matchTier(prefix: string, names: readonly string[]): number | undefined {
  const needle = prefix.trim().toLocaleLowerCase();
  if (needle === "") return 0;
  const folded = names.map((name) => name.toLocaleLowerCase());
  if (folded.some((name) => name.startsWith(needle))) return 0;
  if (folded.some((name) => name.includes(needle))) return 1;
  return undefined;
}

function completionMode(text: string, cursor: number): Mode {
  const before = tokenize(text.slice(0, cursor)).filter((token) => token.type !== "eof");
  const all = tokenize(text);
  const fullTokenAt = (start: number) => all.find((token) => token.start === start);
  const last = before[before.length - 1];
  if (!last) return { kind: "identifier", prefix: "", from: cursor, to: cursor };
  const touching = last.end === cursor;
  if (touching && last.type === "field" && last.unterminated) {
    return { kind: "brace", prefix: last.value as string, from: last.start, to: fullTokenAt(last.start)?.end ?? cursor };
  }
  if (touching && last.type === "string" && last.unterminated) return { kind: "none" };
  const previous = before[before.length - 2];
  const relation = before[before.length - 3];
  if (touching && last.type === "identifier") {
    const to = fullTokenAt(last.start)?.end ?? cursor;
    if (previous?.type === "dot" && previous.end === last.start && relation?.type === "identifier" && relation.end === previous.start) {
      return { kind: "member", relation: relation.text, prefix: last.text, from: last.start, to };
    }
    return { kind: "identifier", prefix: last.text, from: last.start, to };
  }
  if (touching && last.type === "dot" && previous?.type === "identifier" && previous.end === last.start) {
    return { kind: "member", relation: previous.text, prefix: "", from: cursor, to: cursor };
  }
  if (last.type === "operator" || last.type === "lparen" || last.type === "comma") {
    return { kind: "identifier", prefix: "", from: cursor, to: cursor };
  }
  return { kind: "none" };
}
