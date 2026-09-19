// SPDX-License-Identifier: BUSL-1.1
/**
 * Idempotent DDL for a plugin-declared table constraint. The migrate chain
 * applies every registry entry on every run and keeps no ledger, so each
 * statement must be a no-op once its constraint exists: the ADD is guarded by
 * name in a DO block. A changed definition under the same name is not
 * reconciled here — constraints are part of the manifest, so changing one
 * moves the manifest checksum and the chain refuses the built database until
 * it is rebuilt (docs/migrations.md).
 */
import type { TableConstraintDefinition, TableDefinition } from "./schema.js";

const constraintNamePattern = /^[a-z][a-z0-9_]*$/;
const relationNamePattern = /^[a-z_][a-z0-9_]*$/;
const onDeleteActions = new Set(["CASCADE", "RESTRICT", "SET NULL"]);
/** Dollar-quote tag of the DO block; a CHECK expression may not contain it. */
const blockTag = "$osf$";

function quoteIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function assertSingleCheckExpression(expression: string, label: string): void {
  let depth = 0;
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index]!;
    if (character === "'" || character === '"') {
      const quote = character;
      while (++index < expression.length) {
        if (expression[index] !== quote) continue;
        if (expression[index + 1] === quote) index += 1;
        else break;
      }
      continue;
    }
    if (character === "$") {
      const delimiter = expression
        .slice(index)
        .match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
      if (delimiter) {
        const closing = expression.indexOf(delimiter, index + delimiter.length);
        if (closing === -1) {
          throw new Error(`${label} has an unterminated dollar-quoted string.`);
        }
        index = closing + delimiter.length - 1;
        continue;
      }
    }
    if (character === "(") depth += 1;
    if (character === ")") {
      if (depth === 0) {
        throw new Error(`${label} closes the compiler-owned CHECK expression.`);
      }
      depth -= 1;
    }
  }
  if (depth !== 0) throw new Error(`${label} has unbalanced parentheses.`);
}

function assertColumns(
  table: TableDefinition,
  constraint: TableConstraintDefinition,
): void {
  if (constraint.kind === "check") return;
  if (constraint.columns.length === 0) {
    throw new Error(
      `Constraint ${table.schema}.${table.name}.${constraint.name} has no columns.`,
    );
  }
  const present = new Set(table.columns.map((column) => column.name));
  const seen = new Set<string>();
  for (const column of constraint.columns) {
    if (!present.has(column)) {
      throw new Error(
        `Constraint ${table.schema}.${table.name}.${constraint.name} references unknown column "${column}".`,
      );
    }
    if (seen.has(column)) {
      throw new Error(
        `Constraint ${table.schema}.${table.name}.${constraint.name} repeats column "${column}".`,
      );
    }
    seen.add(column);
  }
  if (
    constraint.kind === "foreignKey" &&
    constraint.references.columns.length !== constraint.columns.length
  ) {
    throw new Error(
      `Foreign key ${table.schema}.${table.name}.${constraint.name} has ${constraint.columns.length} local column(s) but ${constraint.references.columns.length} referenced column(s).`,
    );
  }
}

/** The constraint body after `ADD CONSTRAINT <name>`. */
function renderConstraintDefinition(
  table: TableDefinition,
  constraint: TableConstraintDefinition,
): string {
  const label = `Check constraint ${table.schema}.${table.name}.${constraint.name}`;
  if (constraint.kind === "check") {
    if (constraint.expression.trim().length === 0) {
      throw new Error(`${label} has an empty expression.`);
    }
    if (/;|--|\/\*|\*\//.test(constraint.expression)) {
      throw new Error(
        `${label} must not contain a statement terminator or comment. Use schemaMigrations for free-form SQL.`,
      );
    }
    if (constraint.expression.includes(blockTag)) {
      throw new Error(`${label} must not contain the ${blockTag} quote tag.`);
    }
    assertSingleCheckExpression(constraint.expression, label);
    return `CHECK (${constraint.expression})`;
  }

  const columns = `(${constraint.columns.map(quoteIdent).join(", ")})`;
  if (constraint.kind === "primaryKey") return `PRIMARY KEY ${columns}`;
  if (constraint.kind === "unique") return `UNIQUE ${columns}`;

  const referenced =
    `${quoteIdent(constraint.references.schema)}.${quoteIdent(constraint.references.table)}` +
    ` (${constraint.references.columns.map(quoteIdent).join(", ")})`;
  if (constraint.onDelete && !onDeleteActions.has(constraint.onDelete)) {
    throw new Error(
      `Foreign key ${table.schema}.${table.name}.${constraint.name} has unsupported ON DELETE action "${constraint.onDelete}".`,
    );
  }
  if (constraint.initiallyDeferred && !constraint.deferrable) {
    throw new Error(
      `Foreign key ${table.schema}.${table.name}.${constraint.name} is initially deferred but not deferrable.`,
    );
  }
  const onDelete = constraint.onDelete ? ` ON DELETE ${constraint.onDelete}` : "";
  const deferred = constraint.deferrable
    ? ` DEFERRABLE${constraint.initiallyDeferred ? " INITIALLY DEFERRED" : ""}`
    : "";
  return `FOREIGN KEY ${columns} REFERENCES ${referenced}${onDelete}${deferred}`;
}

export function renderConstraintSql(
  table: TableDefinition,
  constraint: TableConstraintDefinition,
): string {
  assertColumns(table, constraint);
  if (!constraintNamePattern.test(constraint.name)) {
    throw new Error(
      `Constraint name ${table.schema}.${table.name}.${constraint.name} must be a lower_snake_case identifier.`,
    );
  }
  if (!relationNamePattern.test(table.schema) || !relationNamePattern.test(table.name)) {
    throw new Error(
      `Table ${table.schema}.${table.name} must be a lower_snake_case schema and name to carry constraints.`,
    );
  }
  if (
    constraint.kind === "primaryKey" &&
    table.columns.some((column) => column.primaryKey === true)
  ) {
    throw new Error(
      `Table ${table.schema}.${table.name} declares both a column primary key and table constraint ${constraint.name}.`,
    );
  }

  const tableName = `${quoteIdent(table.schema)}.${quoteIdent(table.name)}`;
  const definition = renderConstraintDefinition(table, constraint);
  return [
    `DO ${blockTag}`,
    "BEGIN",
    "  IF NOT EXISTS (",
    "    SELECT 1 FROM pg_constraint",
    `    WHERE conrelid = '${tableName}'::regclass AND conname = '${constraint.name}'`,
    "  ) THEN",
    `    ALTER TABLE ${tableName}`,
    `      ADD CONSTRAINT ${quoteIdent(constraint.name)} ${definition};`,
    "  END IF;",
    "END",
    `${blockTag};`,
    "",
  ].join("\n");
}
