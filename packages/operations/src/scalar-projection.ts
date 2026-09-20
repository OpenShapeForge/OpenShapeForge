// SPDX-License-Identifier: BUSL-1.1
/**
 * One storage scalar, every projection.
 *
 * A manifest column carries one of these scalar types. Each transport used to
 * keep its own switch over them — DDL, the Kysely row types, the GraphQL SDL,
 * the JSON Schema of REST, MCP and the canonical Operation catalogue — and the
 * switches disagreed (a `bigint` was `integer` on one transport and `number`
 * on another). The table below is the one answer; a new scalar is one row.
 *
 * `numeric` and `bigint` cross every transport as decimal strings
 * (`"12.50"`, `"9007199254740993"`): a JSON number is an IEEE double and
 * GraphQL Float is the same double, and money and 64-bit counters do not
 * survive either. Postgres hands both to the driver as text, the row
 * serializer keeps them text, and the schemas say so. Inputs are the JSON
 * numbers a form sends; the exactness a value needs is the value's, not the
 * transport's, and a create or update sends what a person typed.
 */

export type ScalarType =
  | "uuid"
  | "text"
  | "boolean"
  | "integer"
  | "bigint"
  | "numeric"
  | "date"
  | "timestamptz"
  | "jsonb"
  | "text[]";

export type ScalarJsonSchema = {
  type?: "string" | "boolean" | "integer" | "number" | "array";
  format?: "uuid" | "date" | "date-time";
  pattern?: string;
  description?: string;
  items?: { type: "string" };
};

/** A decimal number as text: an optional sign, digits, an optional fraction. */
export const DECIMAL_PATTERN = "^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$";
/** A 64-bit integer as text. */
export const INTEGER_TEXT_PATTERN = "^-?(?:0|[1-9][0-9]*)$";

/**
 * The wire text of a numeric or bigint value the database or a handler
 * produced: text stays text, a bigint prints exactly, a finite number prints
 * every digit of its shortest round-trip representation without exponent
 * notation (1e-21 is "0.000000000000000000001", 1e21 is
 * "1000000000000000000000"). Anything else is returned as is for the caller
 * to refuse.
 */
export function decimalText(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isFinite(value)) return expandExponent(value.toString());
  return value;
}

/** `d.dddde±x` as plain decimal digits, moving the point without touching a digit. */
function expandExponent(text: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (!match) return text;
  const [, sign, integer, fraction = "", exponent] = match;
  const digits = `${integer}${fraction}`;
  const point = integer!.length + Number(exponent);
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

export type ScalarProjection = {
  /** The Postgres column type. */
  sql: string;
  /** The Kysely row type, as `generate.ts` names it in the generated `DB`. */
  ts: string;
  /** The GraphQL scalar; `Decimal` is the platform's own, a decimal string. */
  gql: "ID" | "String" | "Boolean" | "Int" | "Decimal" | "JSON" | "[String!]";
  /** The JSON Schema of one value. `jsonb` is unconstrained. */
  json: ScalarJsonSchema;
};

export const SCALAR_PROJECTION: Readonly<Record<ScalarType, ScalarProjection>> = {
  uuid: { sql: "uuid", ts: "string", gql: "ID", json: { type: "string", format: "uuid" } },
  text: { sql: "text", ts: "string", gql: "String", json: { type: "string" } },
  boolean: { sql: "boolean", ts: "boolean", gql: "Boolean", json: { type: "boolean" } },
  integer: { sql: "integer", ts: "number", gql: "Int", json: { type: "integer" } },
  bigint: {
    sql: "bigint",
    ts: "string",
    gql: "Decimal",
    json: { type: "string", pattern: INTEGER_TEXT_PATTERN, description: "A 64-bit integer as a decimal string, exact." },
  },
  numeric: {
    sql: "numeric",
    ts: "Numeric",
    gql: "Decimal",
    json: { type: "string", pattern: DECIMAL_PATTERN, description: "A decimal number as a string, e.g. \"12.50\", exact." },
  },
  date: { sql: "date", ts: "DateOnly", gql: "String", json: { type: "string", format: "date" } },
  timestamptz: {
    sql: "timestamptz",
    ts: "Timestamp",
    gql: "String",
    json: { type: "string", format: "date-time" },
  },
  jsonb: { sql: "jsonb", ts: "Json", gql: "JSON", json: {} },
  "text[]": {
    sql: "text[]",
    ts: "string[]",
    gql: "[String!]",
    json: { type: "array", items: { type: "string" } },
  },
};

export const SCALAR_TYPES = Object.keys(SCALAR_PROJECTION) as readonly ScalarType[];

export function isScalarType(value: unknown): value is ScalarType {
  return typeof value === "string" && Object.hasOwn(SCALAR_PROJECTION, value);
}

/** A fresh JSON Schema object for one value of `type`; callers may extend it. */
export function scalarJsonSchema(type: ScalarType): ScalarJsonSchema {
  return { ...SCALAR_PROJECTION[type].json };
}
