// SPDX-License-Identifier: BUSL-1.1
import { operationFailure } from "@openshapeforge/operations";
import { sql, type RawBuilder } from "kysely";
import { jsonbLiteral } from "../db/sql-helpers.js";

export type QueryField = { sql: RawBuilder<unknown>; kind: "text" | "timestamp" | "array" | "objects" | "number" | "boolean" };
export function invalidQuery(message: string): never { throw operationFailure({ code: "VALIDATION", message }); }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** The same bounded typed predicate vocabulary the compiler publishes. */
export function structuredFilter(value: unknown, fields: Record<string, QueryField>): RawBuilder<boolean> {
  let nodes = 0;
  function visit(filter: unknown, depth: number): RawBuilder<boolean> {
    if (!object(filter) || depth > 4 || ++nodes > 200) invalidQuery("The filter is invalid or too complex.");
    const conditions: RawBuilder<unknown>[] = [];
    for (const [key, predicate] of Object.entries(filter)) {
      if (key === "and" || key === "or") {
        if (!Array.isArray(predicate) || !predicate.length || predicate.length > 20) invalidQuery("Invalid filter group.");
        conditions.push(sql`(${sql.join(predicate.map(child => visit(child, depth + 1)), key === "and" ? sql` and ` : sql` or `)})`);
        continue;
      }
      const field = fields[key];
      if (!field || !object(predicate) || !Object.keys(predicate).length) invalidQuery("Unknown filter field or invalid predicate.");
      const column = field.sql;
      const operand = (input: unknown) => {
        if (field.kind === "boolean") {
          if (typeof input !== "boolean") invalidQuery("Invalid boolean filter.");
          return sql`${input}`;
        }
        if (field.kind === "number") {
          if ((typeof input !== "number" || !Number.isFinite(input)) && (typeof input !== "string" || !/^-?[0-9]+(?:\.[0-9]+)?$/.test(input))) invalidQuery("Invalid numeric filter.");
          return sql`${String(input)}::numeric`;
        }
        if (typeof input !== "string" || input.length > 2000) invalidQuery("Invalid filter value.");
        if (field.kind === "timestamp") {
          if (!Number.isFinite(Date.parse(input))) invalidQuery("Invalid timestamp filter.");
          return sql`${input}::timestamptz`;
        }
        return sql`${input}`;
      };
      for (const [operator, input] of Object.entries(predicate)) {
        if (operator === "contains" && ["array", "objects"].includes(field.kind)) {
          if (field.kind === "objects" && (!object(input) || Object.keys(input).sort().join() !== "entityType,recordId" || typeof input.entityType !== "string" || typeof input.recordId !== "string")) invalidQuery("Select a complete timeline subject.");
          if (field.kind === "array" && typeof input !== "string") invalidQuery("Invalid array filter.");
          conditions.push(sql`${column} @> ${jsonbLiteral([input])}`);
        } else if (["array", "objects"].includes(field.kind)) invalidQuery("Unsupported collection filter.");
        else if (operator === "isNull") {
          if (typeof input !== "boolean") invalidQuery("Invalid null filter.");
          conditions.push(input ? sql`${column} is null` : sql`${column} is not null`);
        } else if (operator === "in") {
          if (!Array.isArray(input) || !input.length || input.length > 100) invalidQuery("Invalid membership filter.");
          conditions.push(sql`${column} in (${sql.join(input.map(operand))})`);
        } else if (["eq", "ne", "gt", "gte", "lt", "lte"].includes(operator)) {
          const operators = { eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };
          conditions.push(sql`${column} ${sql.raw(operators[operator as keyof typeof operators])} ${operand(input)}`);
        } else if (field.kind === "text" && (operator === "contains" || operator === "startsWith")) {
          if (typeof input !== "string" || input.length > 500) invalidQuery("Invalid text filter.");
          conditions.push(operator === "contains" ? sql`strpos(lower(${column}),lower(${input})) > 0` : sql`starts_with(lower(${column}),lower(${input}))`);
        } else invalidQuery("Unsupported filter operator.");
      }
    }
    return conditions.length ? sql<boolean>`(${sql.join(conditions, sql` and `)})` : sql<boolean>`true`;
  }
  return visit(value ?? {}, 0);
}
