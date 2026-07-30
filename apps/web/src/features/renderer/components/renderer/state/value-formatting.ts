// SPDX-License-Identifier: BUSL-1.1
import type { Field } from "@/generated/compiler/field-contract";
import { normalizePhoneSemanticValue } from "@/features/renderer/runtime/phone-normalization";
import { isFieldCollection } from "@/lib/field-contract/field-v2";

export function formatRendererValue(field: Field, value: unknown) {
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

  return "";
}

export function coerceRendererValue(field: Field, rawValue: unknown) {
  const component = field.render?.component;

  if (component === "Switch" || component === "Toggle") {
    return rawValue === "true" || rawValue === true;
  }

  if (typeof rawValue !== "string") {
    return rawValue ?? undefined;
  }

  if (rawValue.length === 0) {
    return undefined;
  }

  const normalizedPhoneValue = normalizePhoneSemanticValue(field, rawValue);
  if (typeof normalizedPhoneValue === "string" && normalizedPhoneValue !== rawValue) {
    return normalizedPhoneValue;
  }

  if (
    component === "NumberInput" ||
    (!isFieldCollection(field) &&
      (field.valueType === "integer" || field.valueType === "number"))
  ) {
    const parsed = Number(rawValue);
    return Number.isNaN(parsed) ? rawValue : parsed;
  }

  return rawValue;
}

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
