// SPDX-License-Identifier: BUSL-1.1
/** Bounded, provider-neutral transforms applied before request placement. */
import { HttpError } from "../rest/http-error.js";

type Rec = Record<string, unknown>;
type Step = Rec & { op: string };

function isRecord(value: unknown): value is Rec {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function configured(index: number, op: unknown, message: string): never {
  throw new HttpError(
    500,
    "SERVICE_MISCONFIGURED",
    `Request transform step ${index} (op ${JSON.stringify(op ?? null)}): ${message}`,
  );
}

function rejected(message: string): never {
  throw new HttpError(400, "BAD_USER_INPUT", message);
}

function path(step: Step, index: number, key: string): string {
  const value = step[key];
  if (typeof value !== "string" || value.length === 0)
    configured(index, step.op, `\`${key}\` must be a non-empty path`);
  if (
    value
      .split(".")
      .some((segment) => segment.length === 0 || segment === "__proto__" || segment === "prototype" || segment === "constructor")
  )
    configured(index, step.op, `\`${key}\` contains an unsafe path segment`);
  return value;
}

function readPath(value: Rec, pathValue: string): unknown {
  let current: unknown = value;
  for (const segment of pathValue.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function writePath(value: Rec, pathValue: string, next: unknown): void {
  const segments = pathValue.split(".");
  let current = value;
  for (const segment of segments.slice(0, -1)) {
    const child = current[segment];
    current[segment] = isRecord(child) ? { ...child } : {};
    current = current[segment] as Rec;
  }
  current[segments.at(-1)!] = next;
}

function deletePath(value: Rec, pathValue: string): void {
  const segments = pathValue.split(".");
  const parents: Array<{ value: Rec; key: string }> = [];
  let current: Rec = value;
  for (const segment of segments.slice(0, -1)) {
    const child = current[segment];
    if (!isRecord(child)) return;
    parents.push({ value: current, key: segment });
    current = child;
  }
  delete current[segments.at(-1)!];
  for (const parent of parents.reverse()) {
    const child = parent.value[parent.key];
    if (isRecord(child) && Object.keys(child).length === 0) delete parent.value[parent.key];
    else break;
  }
}

function namedMap(step: Step, index: number, key: string): Rec {
  const raw = step[key];
  if (!isRecord(raw)) configured(index, step.op, `\`${key}\` must be an object`);
  return raw;
}

function fieldName(fields: Rec, key: string, fallback: string): string {
  const value = fields[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function mapped(values: Rec, value: unknown, label: string): string {
  if (typeof value !== "string" || typeof values[value] !== "string")
    rejected(`Recurrence ${label} has an unsupported value.`);
  return values[value] as string;
}

function validTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function wallMinute(value: string): string | undefined {
  return /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/.exec(value)?.[1];
}

function instantWallMinute(value: string, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(value))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function validateTimeRange(start: unknown, end: unknown, timeZone: unknown): asserts timeZone is string {
  if (typeof start !== "string" || typeof end !== "string")
    rejected("A time range needs both a start and an end date-time.");
  if (!validTimeZone(timeZone)) rejected("A time range needs a valid IANA time zone.");
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(start) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(end))
    rejected("A time range needs valid RFC 3339 date-times with an offset.");
  const startInstant = Date.parse(start);
  const endInstant = Date.parse(end);
  if (!Number.isFinite(startInstant) || !Number.isFinite(endInstant))
    rejected("A time range needs valid RFC 3339 date-times with an offset.");
  if (endInstant <= startInstant) rejected("A time range must end after it starts.");
  if (
    wallMinute(start) !== instantWallMinute(start, timeZone) ||
    wallMinute(end) !== instantWallMinute(end, timeZone)
  )
    rejected("The start and end offsets must agree with the IANA time zone.");
}

function zonedMidnightAfter(date: string, timeZone: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) rejected("Recurrence end date must use YYYY-MM-DD.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  )
    rejected("Recurrence end date must be a real calendar date.");
  const desired = Date.UTC(year, month - 1, day + 1);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  let result = desired;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(
      formatter
        .formatToParts(new Date(result))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number(part.value)]),
    );
    const observed = Date.UTC(
      parts.year!,
      parts.month! - 1,
      parts.day!,
      parts.hour!,
      parts.minute!,
      parts.second!,
    );
    result += desired - observed;
  }
  return new Date(result);
}

function untilValue(date: string, timeZone: string): string {
  const instant = new Date(zonedMidnightAfter(date, timeZone).getTime() - 1000);
  return instant.toISOString().replace(/[-:]/g, "").replace(/\.000Z$/, "Z");
}

function recurrence(step: Step, index: number, root: Rec): void {
  const from = path(step, index, "from");
  const to = path(step, index, "to");
  const raw = readPath(root, from);
  if (raw === undefined || raw === null) return;
  if (!isRecord(raw)) rejected("Recurrence must be an object.");

  const fields = isRecord(step.fields) ? step.fields : {};
  const values = namedMap(step, index, "values");
  const frequencies = isRecord(values.frequencies) ? values.frequencies : {};
  const weekdays = isRecord(values.weekdays) ? values.weekdays : {};
  const endModes = isRecord(values.endModes) ? values.endModes : {};
  const frequencyField = fieldName(fields, "frequency", "frequency");
  const intervalField = fieldName(fields, "interval", "interval");
  const weekdaysField = fieldName(fields, "weekdays", "weekdays");
  const endField = fieldName(fields, "end", "end");
  const timeZoneField = fieldName(fields, "timeZone", "timeZone");
  const endModeField = fieldName(fields, "endMode", "mode");
  const endDateField = fieldName(fields, "endDate", "date");
  const endCountField = fieldName(fields, "endCount", "count");

  const frequency = mapped(frequencies, raw[frequencyField], "frequency");
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(frequency))
    configured(index, step.op, "frequency mappings may yield only RFC 5545 base frequencies");
  const interval = raw[intervalField] ?? 1;
  if (!Number.isInteger(interval) || Number(interval) < 1 || Number(interval) > 999)
    rejected("Recurrence interval must be an integer from 1 through 999.");
  const timeZone = raw[timeZoneField];
  if (!validTimeZone(timeZone)) rejected("Recurrence time zone must be a valid IANA time zone.");
  if (typeof step.start === "string" && typeof step.finish === "string") {
    validateTimeRange(readPath(root, step.start), readPath(root, step.finish), timeZone);
  } else if (step.start !== undefined || step.finish !== undefined) {
    configured(index, step.op, "`start` and `finish` must be supplied together as paths");
  }

  const rule = [`FREQ=${frequency}`];
  if (interval !== 1) rule.push(`INTERVAL=${interval}`);
  const days = raw[weekdaysField];
  if (days !== undefined) {
    if (!Array.isArray(days) || days.length === 0)
      rejected("Recurrence weekdays must be a non-empty list when provided.");
    const mappedDays = days.map((day) => mapped(weekdays, day, "weekday"));
    if (mappedDays.some((day) => !/^(MO|TU|WE|TH|FR|SA|SU)$/.test(day)))
      configured(index, step.op, "weekday mappings may yield only RFC 5545 weekday codes");
    if (new Set(mappedDays).size !== mappedDays.length)
      rejected("Recurrence weekdays must not contain duplicates.");
    rule.push(`BYDAY=${mappedDays.join(",")}`);
  }
  if (frequency === "WEEKLY" && !Array.isArray(days))
    rejected("A weekly recurrence needs at least one weekday.");

  const end = raw[endField];
  if (!isRecord(end)) rejected("Recurrence needs an end condition.");
  const mode = mapped(endModes, end[endModeField], "end condition");
  if (mode === "UNTIL") {
    if (typeof end[endDateField] !== "string")
      rejected("An end-on-date recurrence needs an end date.");
    if (end[endCountField] !== undefined)
      rejected("An end-on-date recurrence cannot also contain an occurrence count.");
    rule.push(`UNTIL=${untilValue(end[endDateField] as string, timeZone)}`);
  } else if (mode === "COUNT") {
    const count = end[endCountField];
    if (!Number.isInteger(count) || Number(count) < 1 || Number(count) > 999)
      rejected("An occurrence-count recurrence needs a count from 1 through 999.");
    if (end[endDateField] !== undefined)
      rejected("A counted recurrence cannot also contain an end date.");
    rule.push(`COUNT=${count}`);
  } else if (mode !== "NEVER") {
    configured(index, step.op, "end-mode mappings may yield only NEVER, UNTIL or COUNT");
  } else if (end[endDateField] !== undefined || end[endCountField] !== undefined) {
    rejected("A recurrence without an end cannot also contain an end date or count.");
  }

  deletePath(root, from);
  writePath(root, to, [`RRULE:${rule.join(";")}`]);
  const timeZoneTo = step.timeZoneTo;
  if (timeZoneTo !== undefined) {
    if (!Array.isArray(timeZoneTo) || timeZoneTo.some((target) => typeof target !== "string"))
      configured(index, step.op, "`timeZoneTo` must be an array of paths");
    for (const target of timeZoneTo as string[]) writePath(root, target, timeZone);
  }
}

export function applyRequestTransforms(inputs: Rec, transforms: unknown): Rec {
  if (!Array.isArray(transforms))
    configured(-1, undefined, "`transforms` must be an array");
  const output = structuredClone(inputs);
  transforms.forEach((raw, index) => {
    if (!isRecord(raw) || typeof raw.op !== "string")
      configured(index, (raw as Rec | null)?.op, "a step needs a string `op`");
    const step = raw as Step;
    if (step.op === "move" || step.op === "copy") {
      const from = path(step, index, "from");
      const to = path(step, index, "to");
      const value = readPath(output, from);
      if (value !== undefined) writePath(output, to, value);
      if (step.op === "move") deletePath(output, from);
    } else if (step.op === "time-range") {
      const from = path(step, index, "from");
      const value = readPath(output, from);
      if (value === undefined || value === null) return;
      if (!isRecord(value)) rejected("A time range must be an object.");
      const fields = isRecord(step.fields) ? step.fields : {};
      const start = value[fieldName(fields, "start", "start")];
      const end = value[fieldName(fields, "end", "end")];
      const timeZone = value[fieldName(fields, "timeZone", "timeZone")];
      validateTimeRange(start, end, timeZone);
      deletePath(output, from);
      writePath(output, path(step, index, "startTo"), start);
      writePath(output, path(step, index, "endTo"), end);
      const targets = step.timeZoneTo;
      if (!Array.isArray(targets) || targets.some((target) => typeof target !== "string"))
        configured(index, step.op, "`timeZoneTo` must be an array of paths");
      for (const target of targets as string[]) writePath(output, target, timeZone);
    } else if (step.op === "ical-recurrence") recurrence(step, index, output);
    else configured(index, step.op, "unknown op");
  });
  return output;
}
