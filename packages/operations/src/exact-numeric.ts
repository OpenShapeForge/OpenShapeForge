// SPDX-License-Identifier: BUSL-1.1
/**
 * Exact numeric values, compared as the numbers they are.
 *
 * A `numeric` or `bigint` column crosses every transport as decimal text
 * (`scalar-projection.ts`): `"12.50"`, `"9007199254740993"`. That is the
 * value's wire projection, not a string that happens to look numeric — so a
 * value that comes back out of the platform, or out of a typed global, must be
 * accepted again where its own type is wanted, and must be compared against
 * the bounds and the closed domain its field authors.
 *
 * `Number(text)` is not that comparison: it rounds through an IEEE double
 * before anything is compared, which is exactly what storing money as numeric
 * avoids. Everything here works on the sign, the digits and the scale, with
 * BigInt doing the only arithmetic — scaling two values to a common number of
 * fraction digits so they can be compared digit for digit.
 *
 * Spelling is not identity: `1`, `1.0` and `1.00` are the same number and
 * compare equal, `-0` equals `0`, and a number literal is converted through
 * the same decimal text the transports print. Length is bounded before any
 * BigInt is built, so a caller cannot send a megabyte of digits.
 */

import { decimalText, DECIMAL_PATTERN, INTEGER_TEXT_PATTERN } from "./scalar-projection.js";

/** A decimal value as sign, digits and scale: `digits / 10 ** scale`, negated when `negative`. */
export type ExactDecimal = {
  readonly negative: boolean;
  readonly digits: bigint;
  readonly scale: number;
};

/**
 * The longest numeric text any exact comparison accepts. Postgres `numeric`
 * holds up to 131072 integral digits, far beyond anything a field authors;
 * this bound keeps a hostile literal from turning into a very large BigInt
 * before it is refused.
 */
export const MAX_EXACT_NUMERIC_LENGTH = 1024;

const DECIMAL = new RegExp(DECIMAL_PATTERN);
const INTEGER_TEXT = new RegExp(INTEGER_TEXT_PATTERN);

/** Canonical decimal text: an optional sign, digits, an optional fraction. */
export function isExactDecimalText(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_EXACT_NUMERIC_LENGTH && DECIMAL.test(value);
}

/** Canonical integer text, the wire form of a 64-bit counter. */
export function isExactIntegerText(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_EXACT_NUMERIC_LENGTH && INTEGER_TEXT.test(value);
}

/**
 * One value as an exact decimal, or `undefined` when it is not a number at
 * all. A number literal goes through `decimalText`, so the comparison sees
 * every digit the platform would print rather than a rounded rendering.
 */
export function exactDecimal(value: unknown): ExactDecimal | undefined {
  if (typeof value === "bigint") return exactDecimalText(value.toString());
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    const text = decimalText(value);
    return typeof text === "string" ? exactDecimalText(text) : undefined;
  }
  return isExactDecimalText(value) ? exactDecimalText(value) : undefined;
}

function exactDecimalText(text: string): ExactDecimal | undefined {
  if (text.length > MAX_EXACT_NUMERIC_LENGTH || !DECIMAL.test(text)) return undefined;
  const negative = text.startsWith("-");
  const [integer, fraction = ""] = (negative ? text.slice(1) : text).split(".");
  const digits = BigInt(`${integer}${fraction}`);
  // A zero has no sign: "-0" and "0" are one value.
  return { negative: negative && digits !== 0n, digits, scale: fraction.length };
}

/** The two values scaled to a common number of fraction digits. */
function aligned(left: ExactDecimal, right: ExactDecimal): [bigint, bigint] {
  const scale = Math.max(left.scale, right.scale);
  const lift = (value: ExactDecimal) => {
    const magnitude = value.digits * 10n ** BigInt(scale - value.scale);
    return value.negative ? -magnitude : magnitude;
  };
  return [lift(left), lift(right)];
}

/** `-1`, `0` or `1`, exactly; `undefined` when either side is not a number. */
export function compareExactNumeric(left: unknown, right: unknown): -1 | 0 | 1 | undefined {
  const a = exactDecimal(left);
  const b = exactDecimal(right);
  if (!a || !b) return undefined;
  const [scaledLeft, scaledRight] = aligned(a, b);
  return scaledLeft === scaledRight ? 0 : scaledLeft < scaledRight ? -1 : 1;
}

/** Whether two numeric values are the same number, whatever their spelling. */
export function exactNumericEquals(left: unknown, right: unknown): boolean {
  return compareExactNumeric(left, right) === 0;
}

/** Whether `value` is a whole number: no non-zero fraction digit. */
export function isExactWholeNumber(value: unknown): boolean {
  const parsed = exactDecimal(value);
  return parsed !== undefined && parsed.digits % 10n ** BigInt(parsed.scale) === 0n;
}

export type ExactNumericBounds = {
  readonly minimum?: unknown;
  readonly maximum?: unknown;
  /** The closed domain, compared as numbers rather than as text. */
  readonly enum?: readonly unknown[];
  /** Whether a fraction is admitted at all. */
  readonly integer?: boolean;
};

export type ExactNumericViolation = "notNumeric" | "notInteger" | "belowMinimum" | "aboveMaximum" | "notInEnum";

/**
 * The exact-comparison half of a numeric field's contract: the authored
 * bounds and closed domain, applied to a value in either of its forms. The
 * JSON type is checked by the schema around this; what is checked here is the
 * number, never its rendering.
 */
export function exactNumericViolation(
  value: unknown,
  bounds: ExactNumericBounds,
): ExactNumericViolation | undefined {
  const parsed = exactDecimal(value);
  if (!parsed) return "notNumeric";
  if (bounds.integer && !isExactWholeNumber(value)) return "notInteger";
  if (bounds.minimum !== undefined) {
    const comparison = compareExactNumeric(value, bounds.minimum);
    if (comparison === undefined || comparison < 0) return "belowMinimum";
  }
  if (bounds.maximum !== undefined) {
    const comparison = compareExactNumeric(value, bounds.maximum);
    if (comparison === undefined || comparison > 0) return "aboveMaximum";
  }
  if (bounds.enum !== undefined && !bounds.enum.some((allowed) => exactNumericEquals(value, allowed))) {
    return "notInEnum";
  }
  return undefined;
}
