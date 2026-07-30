// SPDX-License-Identifier: BUSL-1.1
export type ComputedLiteralToken =
  | { type: "string"; value: string }
  | { type: "number"; value: number }
  | { type: "boolean"; value: boolean }
  | { type: "null"; value: null };

export type ComputedSymbolTokenType =
  | "("
  | ")"
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "!"
  | "=="
  | "!="
  | "==="
  | "!=="
  | ">"
  | ">="
  | "<"
  | "<="
  | "&&"
  | "||"
  | "??";

export type ComputedToken =
  | { type: "placeholder"; value: string }
  | ComputedLiteralToken
  | { type: ComputedSymbolTokenType };

export type ComputedOperator =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "=="
  | "!="
  | "==="
  | "!=="
  | ">"
  | ">="
  | "<"
  | "<="
  | "&&"
  | "||"
  | "??";

export type ComputedParseResult = {
  value: unknown;
  nextIndex: number;
};
