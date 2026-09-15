// SPDX-License-Identifier: BUSL-1.1
/**
 * Materialise a handful of manifest tables from the generated schema.sql.
 *
 * A test that builds a purpose-built scratch schema — a hand-rolled
 * platform.tenants, one restricted role, the two or three runtime tables the
 * code under test touches — used to get those tables from the migration file
 * that created them. Those files now own only what the manifest cannot say
 * (checks, policies, functions); the table DDL has exactly one home, the
 * compiler output, and this is how a test borrows it without copying it.
 *
 * The generated file is sliced on the structure the compiler emits: one
 * block per table starting with `CREATE SCHEMA IF NOT EXISTS` (the table,
 * its RLS policy, its indexes), then a foreign-key section of DO blocks. Only
 * the named tables' blocks run, plus the foreign keys between them and to
 * any other table the scratch schema already holds — a reference to a table
 * the test never created is skipped rather than failed, because the test is
 * the one that decides which corner of the model it materialises.
 */
import { readFile } from "node:fs/promises";
import { sql, type Kysely } from "kysely";

const SCHEMA_SQL_URL = new URL("../../../generated/db/schema.sql", import.meta.url);
const FOREIGN_KEY_MARKER = "-- OpenShapeForge generated foreign keys";

let loaded: Promise<{ tables: Map<string, string>; foreignKeys: string[] }> | undefined;

function loadGeneratedSchema() {
  loaded ??= (async () => {
    const contents = await readFile(SCHEMA_SQL_URL, "utf8");
    const marker = contents.indexOf(FOREIGN_KEY_MARKER);
    const tableSection = marker === -1 ? contents : contents.slice(0, marker);
    const foreignKeySection = marker === -1 ? "" : contents.slice(marker);

    const tables = new Map<string, string>();
    for (const block of tableSection.split(/\n(?=CREATE SCHEMA IF NOT EXISTS )/)) {
      const match = /CREATE TABLE IF NOT EXISTS "([a-z_]+)"\."([a-z_]+)"/.exec(block);
      if (match) tables.set(`${match[1]}.${match[2]}`, block.trim());
    }
    const foreignKeys = foreignKeySection
      .split(/\n\n+/)
      .map((block) => block.trim())
      .filter((block) => block.startsWith("DO $openshapeforge_fk$"));
    return { tables, foreignKeys };
  })();
  return loaded;
}

/**
 * Create `names` (qualified, "platform.identities") exactly as schema.sql
 * declares them, in the order given so a reference target can precede its
 * source. Idempotent, like the DDL it replays.
 */
export async function applyGeneratedTables(
  db: Kysely<any>,
  names: readonly string[],
): Promise<void> {
  const schema = await loadGeneratedSchema();
  for (const name of names) {
    const block = schema.tables.get(name);
    if (!block) throw new Error(`schema.sql declares no table ${name}.`);
    await sql.raw(block).execute(db);
  }

  const selected = new Set(names);
  for (const block of schema.foreignKeys) {
    const source = /ALTER TABLE "([a-z_]+)"\."([a-z_]+)"/.exec(block);
    const target = /REFERENCES "([a-z_]+)"\."([a-z_]+)"/.exec(block);
    if (!source || !target || !selected.has(`${source[1]}.${source[2]}`)) continue;
    const targetName = `${target[1]}.${target[2]}`;
    const present = await sql<{ present: boolean }>`
      select to_regclass(${targetName}) is not null as present
    `.execute(db);
    if (present.rows[0]?.present) await sql.raw(block).execute(db);
  }
}
