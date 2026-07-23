// @ts-nocheck
// ── Naming & pluralization helpers ──
import type { Field } from "../types.js";

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
  number: "Float",
  boolean: "Boolean",
  date: "String",
  datetime: "String",
  object: "JSON",
};

export function fieldCardinality(field: Pick<Field, "cardinality">): "single" | "collection" {
  if (field.cardinality === "collection") return "collection";
  if (field.cardinality && typeof field.cardinality === "object") {
    if (field.cardinality.max === "unbounded") return "collection";
    if (typeof field.cardinality.max === "number" && field.cardinality.max > 1) {
      return "collection";
    }
  }
  return "single";
}

export function isCollectionField(field: Pick<Field, "cardinality">): boolean {
  return fieldCardinality(field) === "collection";
}

export function isUuidField(field: Pick<Field, "valueType" | "validation">): boolean {
  return field.valueType === "string" && field.validation?.format === "uuid";
}

export function fieldSqlType(field: Pick<Field, "valueType" | "cardinality" | "validation">): string {
  if (isCollectionField(field)) return "jsonb";
  if (isUuidField(field)) return "uuid";
  return FIELD_VALUE_TYPE_TO_SQL[field.valueType] ?? "text";
}

export function fieldGraphqlBaseType(field: Pick<Field, "valueType" | "cardinality" | "validation">): string {
  if (isCollectionField(field)) {
    const itemType = field.valueType === "object"
      ? "JSON"
      : isUuidField(field)
        ? "ID"
        : FIELD_VALUE_TYPE_TO_GQL[field.valueType] ?? "String";
    return `[${itemType}]`;
  }
  if (isUuidField(field)) return "ID";
  return FIELD_VALUE_TYPE_TO_GQL[field.valueType] ?? "String";
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
