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
 * `bigint` crosses JSON as an integer and Kysely as a string (pg returns it
 * as text so nothing is rounded); `numeric` crosses JSON as a number and
 * GraphQL as Float, which is the precision the runtime gives it today.
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
  items?: { type: "string" };
};

export type ScalarProjection = {
  /** The Postgres column type. */
  sql: string;
  /** The Kysely row type, as `generate.ts` names it in the generated `DB`. */
  ts: string;
  /** The GraphQL scalar. */
  gql: "ID" | "String" | "Boolean" | "Int" | "Float" | "JSON" | "[String!]";
  /** The JSON Schema of one value. `jsonb` is unconstrained. */
  json: ScalarJsonSchema;
};

export const SCALAR_PROJECTION: Readonly<Record<ScalarType, ScalarProjection>> = {
  uuid: { sql: "uuid", ts: "string", gql: "ID", json: { type: "string", format: "uuid" } },
  text: { sql: "text", ts: "string", gql: "String", json: { type: "string" } },
  boolean: { sql: "boolean", ts: "boolean", gql: "Boolean", json: { type: "boolean" } },
  integer: { sql: "integer", ts: "number", gql: "Int", json: { type: "integer" } },
  bigint: { sql: "bigint", ts: "string", gql: "Float", json: { type: "integer" } },
  numeric: { sql: "numeric", ts: "Numeric", gql: "Float", json: { type: "number" } },
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
