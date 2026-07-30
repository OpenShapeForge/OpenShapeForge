// SPDX-License-Identifier: BUSL-1.1
import type { GeneratedFormFieldConfig } from "./types";

function formatDateTimeLocalValue(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    return "";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value.slice(0, 16);
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");

  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function readPath(source: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((value, segment) => {
    if (value && typeof value === "object" && segment in (value as Record<string, unknown>)) {
      return (value as Record<string, unknown>)[segment];
    }

    return undefined;
  }, source);
}

export function getInitialFieldValue(
  source: Record<string, unknown> | null | undefined,
  fieldOrPath: GeneratedFormFieldConfig | string,
): unknown {
  if (!source) {
    return undefined;
  }

  const path =
    typeof fieldOrPath === "string"
      ? fieldOrPath
      : fieldOrPath.dataPath || fieldOrPath.key;

  return readPath(source, path);
}

export function formatFieldValue(field: GeneratedFormFieldConfig, value: unknown): string {
  const component = field.render?.component;

  if (component === "DatePicker" && typeof value === "string") {
    return value.slice(0, 10);
  }

  if (component === "DateTimePicker") {
    return formatDateTimeLocalValue(value);
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number") {
    return String(value);
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  return "";
}

export function coerceGeneratedFieldValue(
  field: GeneratedFormFieldConfig,
  rawValue: FormDataEntryValue | null,
): unknown {
  const component = field.render?.component;

  if (component === "Switch" || component === "Toggle") {
    return rawValue === "true" || rawValue === "1" || rawValue === "on";
  }

  if (typeof rawValue !== "string") {
    return undefined;
  }

  if (rawValue.length === 0) {
    return undefined;
  }

  if (
    component === "NumberInput"
    || field.valueType === "integer"
    || field.valueType === "number"
  ) {
    const parsed = Number(rawValue);
    return Number.isNaN(parsed) ? rawValue : parsed;
  }

  return rawValue;
}
