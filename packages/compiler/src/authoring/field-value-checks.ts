// SPDX-License-Identifier: BUSL-1.1
import { createHash } from "node:crypto";
import type { ColumnDefinition, TableConstraintDefinition } from "../schema.js";
import { stringRule } from "../field-json-schema.js";
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
 * Both are compiler-owned, content-addressed and `replaceExisting`, the same
 * shape entity-value storage uses: the constraint NAME is fixed per column so a
 * changed options list replaces the previous CHECK on the next migrate instead
 * of leaving a stale one behind.
 */

const ident = (value: string) => `"${value.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const digestOf = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 12);

/**
 * The subset of JSON Schema (ECMA-262) regex syntax whose meaning under a
 * PostgreSQL advanced regular expression (`~`) is the same: literals, escaped
 * metacharacters, the `\d \w \s` classes, bracket expressions, groups
 * without `(?` modifiers, alternation, the usual quantifiers and anchors.
 * Anything else (lookarounds, backreferences, `\b`, unicode escapes, named
 * groups, flags) is left to the runtime validator, which speaks ECMA-262.
 */
const SAFE_POSIX_PATTERN =
  /^(?:[A-Za-z0-9 _:;,@#%&=!~\-]|\\[.^$|()\[\]{}*+?\\\/\-]|\\[dwsDWS]|\[\^?(?:[A-Za-z0-9 _:;,@#%&=!~.\/]|\\[.^$|()\[\]{}*+?\\\/\-]|\\[dwsDWS]|[A-Za-z0-9]-[A-Za-z0-9])+\]|\((?!\?)|\)|\||\.|\^|\$|[*+?](?!\?)|\{\d+(?:,\d*)?\})+$/;

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

function constraintName(table: string, column: string, kind: "options" | "pattern"): string {
  const name = `${table}_${column}_${kind}_check`;
  return name.length <= 63 ? name : `${name.slice(0, 50)}_${digestOf(name)}`;
}

function checkConstraint(
  schema: string,
  table: string,
  column: string,
  kind: "options" | "pattern",
  expression: string,
): TableConstraintDefinition {
  const name = constraintName(table, column, kind);
  return {
    compilerOwned: true,
    replaceExisting: true,
    version: `0001_field-${kind}-${`${schema}-${name}`.replaceAll("_", "-")}-${digestOf(expression)}`,
    name,
    kind: "check",
    expression,
  };
}

/** The static options and safe pattern CHECKs for one table's scalar text columns. */
export function fieldValueCheckConstraints(
  schema: string,
  table: string,
  columns: ReadonlyArray<{ field: Field | undefined; column: ColumnDefinition }>,
): TableConstraintDefinition[] {
  const constraints: TableConstraintDefinition[] = [];
  for (const { field, column } of columns) {
    if (!field || column.type !== "text" || (field.cardinality ?? "single") !== "single") continue;
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
