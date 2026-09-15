// SPDX-License-Identifier: BUSL-1.1
/**
 * Idempotent DDL for the invariants the generated manifest cannot express:
 * check constraints and compound foreign keys. Each runs on every migrate,
 * after the generated step, and is a no-op once the constraint is in place —
 * Postgres has no `ADD CONSTRAINT IF NOT EXISTS`, and a drop-and-add on every
 * run would revalidate every row under an ACCESS EXCLUSIVE lock each time.
 *
 * Names and expressions are interpolated as literals into a DO block rather
 * than bound: DDL takes no parameters. Every caller is a migration file in
 * this directory with string constants; nothing here reaches user input.
 */
import { sql, type Kysely } from "kysely";

type Constraint = {
  /** Qualified, unquoted: "platform.identity_relations". */
  table: string;
  name: string;
};

const qualifiedTable = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;
const identifier = /^[a-z_][a-z0-9_]*$/;

function assertNames({ table, name }: Constraint): void {
  if (!qualifiedTable.test(table)) throw new Error(`Invalid table name: ${table}`);
  if (!identifier.test(name)) throw new Error(`Invalid constraint name: ${name}`);
}

/**
 * The DO block that adds `definition` under `name` unless it already exists.
 *
 * With `columns`, a constraint of that name whose key columns differ is
 * dropped first: the generated schema emits a single-column foreign key
 * under the same name a core invariant later widens to a tenant-qualified
 * compound key, and the generated DO block — which guards by name alone —
 * then leaves the compound one in place on every later apply.
 */
function ensureConstraintSql(
  constraint: Constraint,
  definition: string,
  columns?: readonly string[],
): string {
  assertNames(constraint);
  const replaceIfColumnsDiffer = columns
    ? `
      if exists (
        select 1 from pg_constraint c
        where c.conrelid = '${constraint.table}'::regclass
          and c.conname = '${constraint.name}'
          and (
            select array_agg(a.attname::text order by k.ordinality)
            from unnest(c.conkey) with ordinality as k(attnum, ordinality)
            join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
          ) <> array[${columns.map((column) => `'${column}'`).join(", ")}]::text[]
      ) then
        alter table ${constraint.table} drop constraint ${constraint.name};
      end if;`
    : "";
  return `
    do $$
    begin${replaceIfColumnsDiffer}
      if not exists (
        select 1 from pg_constraint
        where conrelid = '${constraint.table}'::regclass
          and conname = '${constraint.name}'
      ) then
        alter table ${constraint.table}
          add constraint ${constraint.name} ${definition};
      end if;
    end
    $$;
  `;
}

export async function ensureCheckConstraint(
  db: Kysely<any>,
  constraint: Constraint & { expression: string },
): Promise<void> {
  await sql
    .raw(ensureConstraintSql(constraint, `check (${constraint.expression})`))
    .execute(db);
}

export async function ensureForeignKey(
  db: Kysely<any>,
  constraint: Constraint & {
    columns: readonly string[];
    references: { table: string; columns: readonly string[] };
    onDelete?: "cascade" | "restrict" | "set null";
    onUpdate?: "restrict";
  },
): Promise<void> {
  if (!qualifiedTable.test(constraint.references.table)) {
    throw new Error(`Invalid referenced table name: ${constraint.references.table}`);
  }
  for (const column of [...constraint.columns, ...constraint.references.columns]) {
    if (!identifier.test(column)) throw new Error(`Invalid column name: ${column}`);
  }
  const actions = [
    constraint.onUpdate ? ` on update ${constraint.onUpdate}` : "",
    constraint.onDelete ? ` on delete ${constraint.onDelete}` : "",
  ].join("");
  await sql
    .raw(
      ensureConstraintSql(
        constraint,
        `foreign key (${constraint.columns.join(", ")}) references ${constraint.references.table} (${constraint.references.columns.join(", ")})${actions}`,
        constraint.columns,
      ),
    )
    .execute(db);
}
