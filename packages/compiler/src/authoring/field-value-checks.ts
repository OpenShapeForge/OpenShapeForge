// SPDX-License-Identifier: BUSL-1.1
import { createHash } from "node:crypto";
import type { ColumnDefinition, TableConstraintDefinition } from "../schema.js";
import { numericRule, stringRule } from "../field-json-schema.js";
import { fieldCardinality } from "./compiler/helpers.js";
import type { Field } from "./types/authoring.js";

/**
 * Database backstops for the two authored value contracts the JSON schema
 * already carries as `enum` and `pattern`: a static `options` list becomes
 * `CHECK (col IN (...))`, a `validation.pattern` becomes `CHECK (col ~ '...')`.
 * The runtime check (apps/api operations/entity/input-validation.ts) is the
 * one that names the field; these make sure a write that bypasses it cannot
 * persist a value the contract forbids.
 *
 * Scalar text columns only: a collection or jsonb field stores its values
 * inside a structure the column cannot constrain this way, and a referentiedata
 * or remote options source is data, not schema.
 *
 * Both are compiler-owned table constraints, the shape entity-value storage
 * uses: rendered as name-guarded DDL and applied on every migrate. A changed
 * options list changes the manifest checksum, so a built database is rebuilt
 * rather than left with a stale CHECK (docs/migrations.md).
 */

const ident = (value: string) => `"${value.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const digestOf = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 12);

/**
 * The subset of JSON Schema (ECMA-262) regex syntax whose meaning under a
 * PostgreSQL advanced regular expression (`~`) is the same: literals, escaped
 * metacharacters, the `\d \w \s` classes and their negations outside a
 * bracket expression, bracket expressions of literals and ranges, groups
 * without `(?` modifiers, alternation, the usual quantifiers and anchors.
 * Anything else (lookarounds, backreferences, `\b`, unicode escapes, named
 * groups, flags, and a class shorthand inside brackets, which an ARE reads
 * as an escape of the letter) is left to the runtime validator, which speaks
 * ECMA-262.
 */
const SAFE_POSIX_PATTERN =
  /^(?:[A-Za-z0-9 _:;,@#%&=!~\-]|\\[.^$|()\[\]{}*+?\\\/\-]|\\[dwsDWS]|\[\^?(?:[A-Za-z0-9 _:;,@#%&=!~.\/]|\\[.^$|()\[\]{}*+?\\\/\-]|[A-Za-z0-9]-[A-Za-z0-9])+\]|\((?!\?)|\)|\||\.|\^|\$|[*+?](?!\?)|\{\d+(?:,\d*)?\})+$/;

export function isPosixSafePattern(pattern: string): boolean {
  if (!SAFE_POSIX_PATTERN.test(pattern)) return false;
  let depth = 0;
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "\\") { index += 1; continue; }
    if (character === "[") {
      const close = pattern.indexOf("]", index + 2);
      if (close < 0) return false;
      index = close;
      continue;
    }
    if (character === "(") depth += 1;
    if (character === ")" && --depth < 0) return false;
  }
  return depth === 0;
}

function constraintName(table: string, column: string, kind: "options" | "pattern" | "requires"): string {
  const name = `${table}_${column}_${kind}_check`;
  return name.length <= 63 ? name : `${name.slice(0, 50)}_${digestOf(name)}`;
}

function checkConstraint(
  schema: string,
  table: string,
  column: string,
  kind: "options" | "pattern" | "requires",
  expression: string,
): TableConstraintDefinition {
  const name = constraintName(table, column, kind);
  return {
    compilerOwned: true,
    version: `0001_field-${kind}-${`${schema}-${name}`.replaceAll("_", "-")}-${digestOf(expression)}`,
    name,
    kind: "check",
    expression,
  };
}

/**
 * The static options and safe pattern CHECKs for one table's scalar text
 * columns, and the `validation.requires` CHECK for any single column: when
 * the column holds a value, every column it requires holds one too.
 */
export function fieldValueCheckConstraints(
  schema: string,
  table: string,
  columns: ReadonlyArray<{ field: Field | undefined; column: ColumnDefinition }>,
): TableConstraintDefinition[] {
  const constraints: TableConstraintDefinition[] = [];
  const columnOf = new Map(columns.filter((entry) => entry.field).map((entry) => [entry.field!.key, entry]));
  for (const { field, column } of columns) {
    const requires = field?.validation?.requires;
    if (field && requires?.length && fieldCardinality(field) === "single") {
      const required = requires.map((key) => {
        const target = columnOf.get(key);
        if (!target || key === field.key || fieldCardinality(target.field!) !== "single") {
          throw new Error(`Field "${field.key}" of ${schema}.${table} requires "${key}", which is not another persisted single field.`);
        }
        return `${ident(target.column.name)} IS NOT NULL`;
      });
      constraints.push(checkConstraint(schema, table, column.name, "requires",
        `${ident(column.name)} IS NULL OR (${required.join(" AND ")})`));
    }
    if (!field || column.type !== "text" || fieldCardinality(field) !== "single") continue;
    const options = field.options;
    if (options?.type === "static" && options.items && options.items.length > 0) {
      const values = [...new Set(options.items.map((item) => item.value))];
      constraints.push(checkConstraint(schema, table, column.name, "options",
        `${ident(column.name)} IN (${values.map(literal).join(", ")})`));
    }
    const pattern = stringRule(field.validation?.pattern);
    if (pattern !== undefined && pattern.length > 0 && isPosixSafePattern(pattern)) {
      constraints.push(checkConstraint(schema, table, column.name, "pattern",
        `${ident(column.name)} ~ ${literal(pattern)}`));
    }
  }
  return constraints;
}

/**
 * An authored `defaultValue` is a value the row takes when the caller omits
 * the field, so it has to satisfy the field's own contract: the static
 * options, the pattern, the length and numeric bounds the JSON schema and the
 * CHECKs enforce on a caller. A default outside it would make the omitted
 * field the one way to store an invalid value; the build fails instead.
 */
export function assertDefaultSatisfiesContract(field: Field): void {
  const value = field.defaultValue;
  if (value === undefined || value === null) return;
  const refuse = (why: string): never => {
    throw new Error(`Field ${field.key} declares defaultValue ${JSON.stringify(value)}, which ${why}.`);
  };
  const options = field.options;
  if (options?.type === "static" && options.items?.length && fieldCardinality(field) === "single" &&
    !options.items.some((item) => item.value === value)) {
    refuse(`is not one of its options (${options.items.map((item) => item.value).join(", ")})`);
  }
  const validation = field.validation;
  if (!validation) return;
  if (typeof value === "string") {
    const minLength = numericRule(validation.minLength);
    const maxLength = numericRule(validation.maxLength);
    const pattern = stringRule(validation.pattern);
    if (minLength !== undefined && value.length < minLength) refuse(`is shorter than minLength ${minLength}`);
    if (maxLength !== undefined && value.length > maxLength) refuse(`is longer than maxLength ${maxLength}`);
    if (pattern !== undefined && !new RegExp(pattern, "u").test(value)) refuse(`does not match pattern ${pattern}`);
  }
  if (typeof value === "number") {
    const min = numericRule(validation.min);
    const max = numericRule(validation.max);
    if (min !== undefined && value < min) refuse(`is below min ${min}`);
    if (max !== undefined && value > max) refuse(`is above max ${max}`);
  }
}
