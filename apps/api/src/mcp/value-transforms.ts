// SPDX-License-Identifier: BUSL-1.1
/**
 * Single-value response transforms: each reads one value at `from` and writes
 * one value at `to`. They carry no provider knowledge — an ERP ledger import
 * composes them the same way a Gmail thread composes the
 * decoders in response-transforms.ts: normalise a change marker, turn a
 * signed amount into a side and a magnitude, translate a provider code into a
 * reference-data code, read an OData date.
 */

type Rec = Record<string, unknown>;

/** Builds the caller's SERVICE_MISCONFIGURED error for a malformed step. */
export type Misconfigured = (message: string) => Error;

const SOURCE_VERSION_DIGITS = 20;
const ODATA_DATE = /^\/Date\((\d+)(?:[+-]\d{4})?\)\/$/;
// A zone is required: a bare local time would sort by the runtime's clock zone.
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is Rec {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** An OData `/Date(ms)/` or a zoned ISO time as epoch ms; NaN otherwise. */
function instant(text: string): number {
  const odata = ODATA_DATE.exec(text);
  if (odata) return Number(odata[1]);
  return ISO_WITH_ZONE.test(text) ? Date.parse(text) : Number.NaN;
}

function isoOrNull(time: number): string | null {
  const date = new Date(time);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * A provider's change marker → a `sourceVersion` that sorts as text in change
 * order: a non-negative integer (number or digit string, e.g. a row version)
 * zero-padded to 20 digits, a time (ISO-8601 with a zone, or OData
 * `/Date(ms)/`) as ISO UTC with milliseconds. Anything else is null — a wrong
 * watermark would skip records, a missing one only re-reads them.
 */
export function sourceVersion(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0
      ? String(value).padStart(SOURCE_VERSION_DIGITS, "0")
      : null;
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (/^\d+$/.test(text)) {
    const digits = text.replace(/^0+(?=\d)/, "");
    return digits.length <= SOURCE_VERSION_DIGITS
      ? digits.padStart(SOURCE_VERSION_DIGITS, "0")
      : null;
  }
  return isoOrNull(instant(text));
}

/** A calendar date (`YYYY-MM-DD`, UTC) from an ISO date, zoned ISO time or OData date. */
export function calendarDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (ISO_DATE.test(text)) return text;
  return isoOrNull(instant(text))?.slice(0, 10) ?? null;
}

function numeric(value: unknown): number | null {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : null;
}

/** `negative`, `zero` or `positive`; null when the value is not a number. */
export function sign(value: unknown): "negative" | "zero" | "positive" | null {
  const number = numeric(value);
  if (number === null) return null;
  return number < 0 ? "negative" : number > 0 ? "positive" : "zero";
}

export function absolute(value: unknown): number | null {
  const number = numeric(value);
  return number === null ? null : Math.abs(number);
}

/**
 * Translate a provider code through the step's `values` table (keys compare
 * as text, so 20 and "20" are the same code); `default` when absent, else null.
 */
export function lookup(value: unknown, step: Rec, misconfigured: Misconfigured): unknown {
  if (!isRecord(step.values)) throw misconfigured("`values` must be an object of code to value");
  const key = value === null || value === undefined ? undefined : String(value);
  if (key !== undefined && Object.prototype.hasOwnProperty.call(step.values, key)) {
    return step.values[key];
  }
  return "default" in step ? step.default : null;
}

/** A scalar as text (a number such as an administration code, where a text field expects it); else null. */
export function asText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return null;
}

/** The single-value ops `runSteps` dispatches by name. */
export const VALUE_TRANSFORMS: Readonly<
  Record<string, (value: unknown, step: Rec, misconfigured: Misconfigured) => unknown>
> = {
  "source-version": (value) => sourceVersion(value),
  date: (value) => calendarDate(value),
  sign: (value) => sign(value),
  abs: (value) => absolute(value),
  text: (value) => asText(value),
  lookup,
};
