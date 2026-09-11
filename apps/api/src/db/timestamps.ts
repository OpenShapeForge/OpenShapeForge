// SPDX-License-Identifier: BUSL-1.1
const postgresTimestampPattern =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?([+-]\d{2})(?::?(\d{2}))?$/;
const timestampTokenPattern =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2})(?::?(\d{2}))?)$/;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
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
  const daysInMonth = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return year >= 1 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth[month - 1]! &&
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
