// SPDX-License-Identifier: BUSL-1.1
/**
 * The draft rule of published-snapshot versioning, read from the manifest
 * (`source.versioning.onEdit`, emitted by the compiler beside the managed
 * lifecycle fields): a content edit of the head, or of anything the head owns
 * (`source.versioning.storage.owned`), resets the head's lifecycle field. The
 * generic update applies it to the head row it writes; an update of an owned
 * child and the collection Operations walk up the bound ownership tree to the
 * head. Nothing here is derived from entity or table names.
 */
import { sql, type Transaction } from "kysely";
import type { DB } from "../../generated/db/types.js";
import { generatedCrudError } from "./catalog.js";
import { fieldNameForColumn } from "./columns.js";
import type { GeneratedCrudTable } from "./types.js";

type Versioning = NonNullable<NonNullable<GeneratedCrudTable["source"]>["versioning"]>;
type OwnedChild = Versioning["storage"]["owned"][number];
type Row = Record<string, unknown>;

/** The lifecycle column and value the draft rule writes on a versioned head, if `table` is one. */
export function draftRule(table: GeneratedCrudTable): { column: string; value: string } | undefined {
  const rule = table.source?.versioning?.onEdit;
  if (!rule) return undefined;
  const column = table.columns.find((column) => fieldNameForColumn(column) === rule.field);
  return column ? { column: column.name, value: rule.value } : undefined;
}

/** The path of owned relations from a versioned head down to `table`, or undefined when `table` is not owned by a versioned head. */
function ownershipPath(children: readonly OwnedChild[], table: GeneratedCrudTable): OwnedChild[] | undefined {
  for (const child of children) {
    if (child.schema === table.schema && child.table === table.table) return [child];
    const below = ownershipPath(child.children as readonly OwnedChild[], table);
    if (below) return [child, ...below];
  }
  return undefined;
}

/**
 * Drafts the versioned head that owns `row` of `table`, walking the bound
 * ownership tree upwards one foreign key at a time. A table can sit in
 * several trees (a block is owned by a template variant or a document
 * variant): the row's populated owner columns pick the tree, and a row that
 * resolves to more than one head is refused rather than guessed. A table no
 * versioned head owns leaves nothing to do. The head is touched only when
 * its lifecycle field actually changes, so its version token moves with its
 * state.
 */
export async function draftOwningHead(trx: Transaction<DB>, tables: readonly GeneratedCrudTable[], table: GeneratedCrudTable, row: Row): Promise<void> {
  const matches: Array<{ head: GeneratedCrudTable; rule: { column: string; value: string }; predicates: ReturnType<typeof sql>[] }> = [];
  for (const head of tables) {
    const versioning = head.source?.versioning;
    if (!versioning) continue;
    const path = ownershipPath(versioning.storage.owned, table);
    if (!path) continue;
    const rule = draftRule(head);
    if (!rule) continue;
    let current: Row | undefined = row;
    let predicates: ReturnType<typeof sql>[] = [];
    for (let level = path.length - 1; level >= 0 && current; level--) {
      const relation = path[level]!;
      const parent = level === 0 ? head : tables.find((candidate) => candidate.schema === path[level - 1]!.schema && candidate.table === path[level - 1]!.table);
      // An owner column left null means the row lives in another tree.
      if (!parent || relation.childColumns.some((column) => current![column] == null)) { current = undefined; break; }
      predicates = relation.parentColumns.map((column, index) => sql`${sql.id(column)} = ${current![relation.childColumns[index]!]}`);
      if (level === 0) break;
      const found = await sql<{ row: Row }>`select to_jsonb(${sql.id(parent.table)}.*) as row from ${sql.id(parent.schema, parent.table)} where ${sql.join(predicates, sql` and `)}`.execute(trx);
      current = found.rows[0]?.row;
    }
    if (current) matches.push({ head, rule, predicates });
  }
  if (matches.length > 1) {
    throw generatedCrudError(`The row is owned through more than one versioned head (${matches.map((match) => match.head.name).join(", ")}).`, "INVALID_STATE");
  }
  const match = matches[0];
  if (!match) return;
  await sql`update ${sql.id(match.head.schema, match.head.table)} set ${sql.id(match.rule.column)} = ${match.rule.value}, updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')
    where ${sql.join(match.predicates, sql` and `)} and ${sql.id(match.rule.column)} is distinct from ${match.rule.value}`.execute(trx);
}
