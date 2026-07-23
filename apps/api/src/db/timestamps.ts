const postgresTimestampPattern =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?([+-]\d{2})(?::?(\d{2}))?$/;

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
    return timestampToIso(value);
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
