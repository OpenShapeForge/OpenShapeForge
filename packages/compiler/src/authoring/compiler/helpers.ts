// @ts-nocheck
// SPDX-License-Identifier: BUSL-1.1
// ── Naming & pluralization helpers ──
import type { Field } from "../types.js";
import { cardinalityOf } from "@openshapeforge/operations";

export const FIELD_VALUE_TYPE_TO_SQL: Record<string, string> = {
  string: "text",
  integer: "integer",
  number: "numeric",
  boolean: "boolean",
  date: "date",
  datetime: "timestamptz",
  object: "jsonb",
};

export const FIELD_VALUE_TYPE_TO_GQL: Record<string, string> = {
  string: "String",
  integer: "Int",
  number: "Decimal",
  boolean: "Boolean",
  date: "String",
  datetime: "String",
  object: "JSON",
};

const POSTGRES_INTEGER_MIN = -2_147_483_648;
const POSTGRES_INTEGER_MAX = 2_147_483_647;

function numericValidationRule(rule: unknown): number | undefined {
  const value = rule && typeof rule === "object" ? (rule as { value?: unknown }).value : rule;
  return typeof value === "number" ? value : undefined;
}

function needsWideInteger(field: Pick<Field, "baseType" | "validation">): boolean {
  if (field.baseType !== "integer") return false;
  const minimum = numericValidationRule(field.validation?.min);
  const maximum = numericValidationRule(field.validation?.max);
  return (
    (minimum !== undefined && minimum < POSTGRES_INTEGER_MIN) ||
    (maximum !== undefined && maximum > POSTGRES_INTEGER_MAX)
  );
}

export function fieldCardinality(field: Pick<Field, "cardinality">): "single" | "collection" {
  return cardinalityOf(field.cardinality).cardinality;
}

export function isCollectionField(field: Pick<Field, "cardinality">): boolean {
  return fieldCardinality(field) === "collection";
}

export function isUuidField(field: Pick<Field, "baseType" | "validation">): boolean {
  return field.baseType === "string" && field.validation?.format === "uuid";
}

export function fieldSqlType(
  field: Pick<Field, "baseType" | "cardinality" | "validation">,
): string {
  if (isCollectionField(field)) return "jsonb";
  if (isUuidField(field)) return "uuid";
  if (needsWideInteger(field)) return "bigint";
  return FIELD_VALUE_TYPE_TO_SQL[field.baseType] ?? "text";
}

export function fieldGraphqlBaseType(
  field: Pick<Field, "baseType" | "cardinality" | "validation">,
): string {
  if (isCollectionField(field)) {
    const itemType =
      field.baseType === "object"
        ? "JSON"
        : isUuidField(field)
          ? "ID"
          : needsWideInteger(field)
            ? "Decimal"
            : (FIELD_VALUE_TYPE_TO_GQL[field.baseType] ?? "String");
    return `[${itemType}]`;
  }
  if (isUuidField(field)) return "ID";
  if (needsWideInteger(field)) return "Decimal";
  return FIELD_VALUE_TYPE_TO_GQL[field.baseType] ?? "String";
}

export function deriveTableName(entityName: string): string {
  const snake = entityName
    .replace(/([A-Z])/g, "_$1")
    .toLowerCase()
    .replace(/^_/, "");

  if (snake.endsWith("s") || snake.endsWith("sh") || snake.endsWith("ch") || snake.endsWith("x") || snake.endsWith("z")) {
    return snake + "es";
  }
  if (snake.endsWith("y") && !["ay", "ey", "iy", "oy", "uy"].some((v) => snake.endsWith(v))) {
    return snake.slice(0, -1) + "ies";
  }
  return snake + "s";
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function uncapitalize(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

export function pluralize(s: string): string {
  if (s.endsWith("s") || s.endsWith("sh") || s.endsWith("ch") || s.endsWith("x") || s.endsWith("z")) return s + "es";
  if (s.endsWith("y") && !["ay", "ey", "iy", "oy", "uy"].some((v) => s.endsWith(v))) return s.slice(0, -1) + "ies";
  return s + "s";
}
