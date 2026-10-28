// SPDX-License-Identifier: BUSL-1.1
const postgresTimestampPattern =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?([+-]\d{2})(?::?(\d{2}))?$/;
const timestampTokenPattern =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2})(?::?(\d{2}))?)$/;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/**
 * How many days that month of that year has, or `undefined` if there is no
 * such month or no such year.
 *
 * The one calendar fact a regular expression cannot express, and therefore the
 * one every caller that validates a timestamp's FIELDS needs: February is 29
 * days in a leap year and 28 otherwise, so `2024-02-29` is a real date and
 * `2026-02-29` is PostgreSQL's "date/time field value out of range". Shared so
 * that the rule — including the century exception — is stated once.
 */
export function daysInMonth(year: number, month: number): number | undefined {
  if (!Number.isInteger(year) || !Number.isInteger(month)) return undefined;
  if (year < 1 || month < 1 || month > 12) return undefined;
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return MONTH_LENGTHS[month - 1];
}

function isRealTimestamp(value: string): boolean {
  const match = timestampTokenPattern.exec(value);
  if (!match) return false;
  const [, rawYear, rawMonth, rawDay, rawHour, rawMinute, rawSecond, rawOffsetHour, rawOffsetMinute] =
    match;
  const year = Number(rawYear);
  const month = Number(rawMonth);
  const day = Number(rawDay);
  const hour = Number(rawHour);
  const minute = Number(rawMinute);
  const second = Number(rawSecond);
  const offsetHour = rawOffsetHour === undefined ? 0 : Number(rawOffsetHour);
  const offsetMinute = rawOffsetMinute === undefined ? 0 : Number(rawOffsetMinute);
  const days = daysInMonth(year, month);
  return days !== undefined &&
    day >= 1 &&
    day <= days &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    // PostgreSQL accepts numeric timezone displacements only through 15:59.
    offsetHour <= 15 &&
    offsetMinute <= 59;
}

export function timestampToIso(value: Date | string) {
  if (value instanceof Date) {
    return normalizeIsoFraction(value.toISOString());
  }

  const normalized = value.trim();

  const postgresTimestamp = postgresTimestampPattern.exec(normalized);
  if (postgresTimestamp) {
    const [, date, time, fraction, hourOffset, minuteOffset = "00"] =
      postgresTimestamp;
    const suffix =
      hourOffset === "+00" && minuteOffset === "00"
        ? "Z"
        : `${hourOffset}:${minuteOffset}`;
    return `${date}T${time}${normalizeFraction(fraction)}${suffix}`;
  }

  if (normalized.endsWith("Z") && normalized.includes("T")) {
    const canonical = new Date(normalized).toISOString();
    return normalized.includes(".") ? normalizeIsoFraction(normalized) : canonical;
  }

  return normalizeIsoFraction(new Date(value).toISOString());
}

export function normalizeTimestampToken(value: string) {
  try {
    const source = value.trim();
    if (!isRealTimestamp(source)) throw new Error("Invalid timestamp components.");
    const normalized = timestampToIso(source);
    if (!isRealTimestamp(normalized)) throw new Error("Invalid timestamp components.");
    return normalized;
  } catch {
    throw new Error("expectedUpdatedAt must be an ISO timestamp.");
  }
}

function normalizeIsoFraction(value: string) {
  return value.replace(/\.(\d+)(Z|[+-]\d{2}:?\d{2})$/, (_match, rawFraction, suffix) => {
    const fraction = normalizeFraction(`.${rawFraction}`);
    return `${fraction}${suffix}`;
  });
}

function normalizeFraction(fraction: string | undefined) {
  if (!fraction) return ".000";
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed === "." ? ".000" : trimmed;
}
