// SPDX-License-Identifier: BUSL-1.1
// Formula text → syntax tree. The grammar is Airtable's: `{Field name}` or a
// bare identifier names a field, `relation.field` a field of an owned child,
// `NAME(args)` calls a function, and the operators are
//
//   comparison  = != <> < > <= >=   (lowest, left-associative)
//   concatenate &
//   additive    + -
//   multiplying * /
//   unary       - +                 (highest)
//
// Every node keeps its source span; the binder reports refusals against it.
import type { FormulaDiagnostic } from "./types.js";

export type TokenType =
  | "number"
  | "string"
  | "field"
  | "identifier"
  | "operator"
  | "lparen"
  | "rparen"
  | "comma"
  | "dot"
  | "invalid"
  | "eof";

export type Token = {
  type: TokenType;
  /** The token's source text. */
  text: string;
  /** Decoded value: the number, the unescaped string or field name. */
  value?: string | number;
  start: number;
  end: number;
  /** A string or `{field}` that runs to the end of the text. */
  unterminated?: boolean;
};

export type BinaryOperator = "+" | "-" | "*" | "/" | "&" | "=" | "!=" | "<" | ">" | "<=" | ">=";

type Span = { start: number; end: number };

export type SyntaxNode =
  | ({ type: "number"; value: number } & Span)
  | ({ type: "string"; value: string } & Span)
  | ({ type: "boolean"; value: boolean } & Span)
  | ({
      type: "field";
      name: string;
      braced: boolean;
      relation?: { name: string } & Span;
    } & Span)
  | ({ type: "call"; name: string; nameEnd: number; args: SyntaxNode[] } & Span)
  | ({ type: "unary"; operator: "-" | "+"; operand: SyntaxNode } & Span)
  | ({
      type: "binary";
      operator: BinaryOperator;
      operatorStart: number;
      left: SyntaxNode;
      right: SyntaxNode;
    } & Span)
  | ({ type: "paren"; inner: SyntaxNode } & Span);

/** Longer than this is refused before parsing. */
export const MAX_FORMULA_LENGTH = 10_000;
/** Nesting deeper than this (parentheses, calls, unary chains) is refused. */
export const MAX_NESTING = 64;
/** More values and operators than this is refused, which also bounds every recursion over the tree. */
export const MAX_NODES = 500;

const IDENTIFIER_START = /[\p{L}_]/u;
const IDENTIFIER_PART = /[\p{L}\p{N}_]/u;
const NUMBER = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;
const OPERATORS = ["<=", ">=", "!=", "<>", "+", "-", "*", "/", "&", "=", "<", ">"] as const;

export function isIdentifier(text: string): boolean {
  if (text.length === 0 || !IDENTIFIER_START.test(text[0]!)) return false;
  for (const ch of text.slice(1)) if (!IDENTIFIER_PART.test(ch)) return false;
  return true;
}

/**
 * Splits formula text into tokens. Never throws: an unknown character becomes
 * an `invalid` token and an unclosed string or field an `unterminated` one, so
 * the editor can colour a half-typed formula.
 */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    const start = i;
    if (ch === "{") {
      let name = "";
      i += 1;
      let closed = false;
      while (i < text.length) {
        const c = text[i]!;
        if (c === "\\" && (text[i + 1] === "}" || text[i + 1] === "{" || text[i + 1] === "\\")) {
          name += text[i + 1];
          i += 2;
          continue;
        }
        if (c === "}") {
          closed = true;
          i += 1;
          break;
        }
        name += c;
        i += 1;
      }
      tokens.push({ type: "field", text: text.slice(start, i), value: name, start, end: i, ...(closed ? {} : { unterminated: true }) });
      continue;
    }
    if (ch === '"' || ch === "'") {
      let value = "";
      i += 1;
      let closed = false;
      while (i < text.length) {
        const c = text[i]!;
        if (c === "\\" && i + 1 < text.length) {
          const next = text[i + 1]!;
          value += next === "n" ? "\n" : next === "t" ? "\t" : next;
          i += 2;
          continue;
        }
        if (c === ch) {
          closed = true;
          i += 1;
          break;
        }
        value += c;
        i += 1;
      }
      tokens.push({ type: "string", text: text.slice(start, i), value, start, end: i, ...(closed ? {} : { unterminated: true }) });
      continue;
    }
    NUMBER.lastIndex = i;
    const number = NUMBER.exec(text);
    if (number && (/\d/.test(ch) || (ch === "." && /\d/.test(text[i + 1] ?? "")))) {
      i += number[0].length;
      tokens.push({ type: "number", text: number[0], value: Number(number[0]), start, end: i });
      continue;
    }
    if (IDENTIFIER_START.test(ch)) {
      i += 1;
      while (i < text.length && IDENTIFIER_PART.test(text[i]!)) i += 1;
      tokens.push({ type: "identifier", text: text.slice(start, i), value: text.slice(start, i), start, end: i });
      continue;
    }
    const operator = OPERATORS.find((op) => text.startsWith(op, i));
    if (operator) {
      i += operator.length;
      tokens.push({ type: "operator", text: operator, value: operator === "<>" ? "!=" : operator, start, end: i });
      continue;
    }
    const single: Partial<Record<string, TokenType>> = { "(": "lparen", ")": "rparen", ",": "comma", ".": "dot" };
    i += 1;
    tokens.push({ type: single[ch] ?? "invalid", text: ch, start, end: i });
  }
  tokens.push({ type: "eof", text: "", start: text.length, end: text.length });
  return tokens;
}

class SyntaxFailure extends Error {
  constructor(readonly diagnostic: FormulaDiagnostic) {
    super(diagnostic.message);
  }
}

function describe(token: Token): string {
  return token.type === "eof" ? "the end of the formula" : `'${token.text}'`;
}

const COMPARISON = new Set(["=", "!=", "<", ">", "<=", ">="]);

class Parser {
  private index = 0;
  private depth = 0;
  private nodes = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): SyntaxNode {
    if (this.peek().type === "eof") this.fail("The formula is empty", this.peek());
    const node = this.comparison();
    const rest = this.peek();
    if (rest.type !== "eof") this.fail(`Unexpected ${describe(rest)}; expected an operator or the end of the formula`, rest);
    return node;
  }

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.index + offset, this.tokens.length - 1)]!;
  }

  private next(): Token {
    const token = this.peek();
    if (token.type !== "eof") this.index += 1;
    return token;
  }

  private fail(message: string, at: { start: number; end: number }, code: "syntaxError" | "tooComplex" = "syntaxError"): never {
    throw new SyntaxFailure({ code, message, start: at.start, end: Math.max(at.end, at.start) });
  }

  private count(at: Token): void {
    this.nodes += 1;
    if (this.nodes > MAX_NODES) this.fail(`The formula has more than ${MAX_NODES} values and operators`, at, "tooComplex");
  }

  private enter(at: Token): void {
    this.depth += 1;
    if (this.depth > MAX_NESTING) this.fail(`The formula nests deeper than ${MAX_NESTING} levels`, at, "tooComplex");
  }

  private binaryLevel(operators: Set<string>, operand: () => SyntaxNode): SyntaxNode {
    let left = operand();
    for (;;) {
      const token = this.peek();
      if (token.type !== "operator" || !operators.has(token.value as string)) return left;
      this.next();
      this.count(token);
      const right = operand();
      left = {
        type: "binary",
        operator: token.value as BinaryOperator,
        operatorStart: token.start,
        left,
        right,
        start: left.start,
        end: right.end,
      };
    }
  }

  private comparison = (): SyntaxNode => this.binaryLevel(COMPARISON, this.concatenation);
  private concatenation = (): SyntaxNode => this.binaryLevel(new Set(["&"]), this.additive);
  private additive = (): SyntaxNode => this.binaryLevel(new Set(["+", "-"]), this.multiplicative);
  private multiplicative = (): SyntaxNode => this.binaryLevel(new Set(["*", "/"]), this.unary);

  private unary = (): SyntaxNode => {
    const token = this.peek();
    if (token.type === "operator" && (token.value === "-" || token.value === "+")) {
      this.next();
      this.enter(token);
      const operand = this.unary();
      this.depth -= 1;
      return { type: "unary", operator: token.value, operand, start: token.start, end: operand.end };
    }
    return this.primary();
  };

  private primary(): SyntaxNode {
    const token = this.next();
    this.count(token);
    switch (token.type) {
      case "number":
        return { type: "number", value: token.value as number, start: token.start, end: token.end };
      case "string":
        if (token.unterminated) this.fail("This text is missing its closing quote", token);
        return { type: "string", value: token.value as string, start: token.start, end: token.end };
      case "field":
        if (token.unterminated) this.fail("This field reference is missing its closing '}'", token);
        if ((token.value as string).trim() === "") this.fail("A field reference needs a name between '{' and '}'", token);
        return { type: "field", name: token.value as string, braced: true, start: token.start, end: token.end };
      case "lparen": {
        this.enter(token);
        const inner = this.comparison();
        const close = this.next();
        if (close.type !== "rparen") {
          this.fail(`Expected ')' to close the '(' at position ${token.start + 1}, found ${describe(close)}`, close);
        }
        this.depth -= 1;
        return { type: "paren", inner, start: token.start, end: close.end };
      }
      case "identifier":
        return this.identifier(token);
      case "invalid":
        return this.fail(`Unexpected character '${token.text}'`, token);
      default:
        return this.fail(`Expected a value, field or function, found ${describe(token)}`, token);
    }
  }

  private identifier(token: Token): SyntaxNode {
    const name = token.value as string;
    if (this.peek().type === "lparen") return this.call(token);
    if (this.peek().type === "dot") {
      this.next();
      const member = this.next();
      if (member.type === "identifier" || (member.type === "field" && !member.unterminated)) {
        if (this.peek().type === "dot") {
          this.fail("Only one level is in reach: a field of this record or of an owned child", this.peek());
        }
        return {
          type: "field",
          name: member.value as string,
          braced: member.type === "field",
          relation: { name, start: token.start, end: token.end },
          start: token.start,
          end: member.end,
        };
      }
      return this.fail(`Expected a field name after '${name}.', found ${describe(member)}`, member);
    }
    const upper = name.toUpperCase();
    if (upper === "TRUE" || upper === "FALSE") {
      return { type: "boolean", value: upper === "TRUE", start: token.start, end: token.end };
    }
    return { type: "field", name, braced: false, start: token.start, end: token.end };
  }

  private call(nameToken: Token): SyntaxNode {
    const open = this.next();
    this.enter(open);
    const args: SyntaxNode[] = [];
    if (this.peek().type !== "rparen") {
      for (;;) {
        if (this.peek().type === "comma" || this.peek().type === "rparen") {
          this.fail(`Expected an argument, found ${describe(this.peek())}`, this.peek());
        }
        args.push(this.comparison());
        if (this.peek().type !== "comma") break;
        this.next();
      }
    }
    const close = this.next();
    if (close.type !== "rparen") {
      this.fail(`Expected ',' or ')' in the call to ${nameToken.text}, found ${describe(close)}`, close);
    }
    this.depth -= 1;
    return {
      type: "call",
      name: (nameToken.value as string).toUpperCase(),
      nameEnd: nameToken.end,
      args,
      start: nameToken.start,
      end: close.end,
    };
  }
}

export type ParseResult = { syntax: SyntaxNode; error?: undefined } | { syntax?: undefined; error: FormulaDiagnostic };

/** Parses formula text into a syntax tree, or the first syntax error. */
export function parseFormula(text: string): ParseResult {
  if (text.length > MAX_FORMULA_LENGTH) {
    return {
      error: {
        code: "tooComplex",
        message: `A formula is at most ${MAX_FORMULA_LENGTH} characters`,
        start: MAX_FORMULA_LENGTH,
        end: text.length,
        params: { limit: MAX_FORMULA_LENGTH },
      },
    };
  }
  try {
    return { syntax: new Parser(tokenize(text)).parse() };
  } catch (error) {
    if (error instanceof SyntaxFailure) return { error: error.diagnostic };
    throw error;
  }
}
