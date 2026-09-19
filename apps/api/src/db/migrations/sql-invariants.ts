// SPDX-License-Identifier: BUSL-1.1
/**
 * Idempotent DDL for the invariants the generated manifest cannot express:
 * check constraints and compound foreign keys. Each runs on every migrate,
 * after the generated step, and is a no-op once the constraint is in place
 * with the intended definition — Postgres has no `ADD CONSTRAINT IF NOT
 * EXISTS`, and a drop-and-add on every run would revalidate every row under
 * an ACCESS EXCLUSIVE lock each time. These invariants are hand-written, so
 * the manifest checksum does not cover them: a changed definition has to be
 * noticed here, and is replaced in place.
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
 * dropped first: the generated schema emits a tenant-qualified foreign key
 * under the same name a core invariant later widens further (the document
 * current-version pointer), and the generated DO block — which guards by name alone —
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

/** Name of the throwaway constraint the CHECK probe below adds and discards. */
const checkProbeName = "osf_check_definition_probe";
/** Private SQLSTATE the probe raises to roll its own subtransaction back. */
const checkProbeSqlState = "OSF01";

/**
 * The DO block that makes `name` the CHECK with `expression`, replacing a
 * same-name constraint whose definition differs.
 *
 * Postgres stores a CHECK in its own canonical spelling (`status in ('a')`
 * comes back as `CHECK ((status = ANY (ARRAY['a'::text])))`), so the authored
 * expression cannot be compared to `pg_get_constraintdef` as text. The block
 * therefore asks Postgres for the canonical form of the intended definition:
 * it adds it as a throwaway `NOT VALID` constraint inside a subtransaction —
 * catalog only, no row scan — reads the definition back, and rolls the
 * subtransaction back with a private SQLSTATE. Only when that differs from
 * the current constraint's definition is the constraint dropped and
 * re-added, which is the one time a row scan is paid. A table without the
 * constraint skips the probe and gets the ADD directly.
 */
function ensureCheckConstraintSql(
  constraint: Constraint & { expression: string },
): string {
  assertNames(constraint);
  if (constraint.expression.includes("$osf$")) {
    throw new Error(`Check expression must not contain the $osf$ quote tag: ${constraint.name}`);
  }
  const definition = `check (${constraint.expression})`;
  return `
    do $osf$
    declare
      current_definition text;
      intended_definition text;
    begin
      select pg_get_constraintdef(oid) into current_definition
      from pg_constraint
      where conrelid = '${constraint.table}'::regclass
        and conname = '${constraint.name}';

      if current_definition is null then
        alter table ${constraint.table}
          add constraint ${constraint.name} ${definition};
        return;
      end if;

      begin
        alter table ${constraint.table}
          add constraint ${checkProbeName} ${definition} not valid;
        select regexp_replace(pg_get_constraintdef(oid), ' NOT VALID$', '')
          into strict intended_definition
        from pg_constraint
        where conrelid = '${constraint.table}'::regclass
          and conname = '${checkProbeName}';
        raise exception using errcode = '${checkProbeSqlState}';
      exception when sqlstate '${checkProbeSqlState}' then
        -- The probe's own signal: the subtransaction, and the probe with it,
        -- is rolled back; intended_definition survives as a variable.
      end;

      if current_definition <> intended_definition then
        alter table ${constraint.table} drop constraint ${constraint.name};
        alter table ${constraint.table}
          add constraint ${constraint.name} ${definition};
      end if;
    end
    $osf$;
  `;
}

export async function ensureCheckConstraint(
  db: Kysely<any>,
  constraint: Constraint & { expression: string },
): Promise<void> {
  await sql.raw(ensureCheckConstraintSql(constraint)).execute(db);
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
