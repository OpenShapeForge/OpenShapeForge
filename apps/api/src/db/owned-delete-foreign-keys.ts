// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import type { OwnedDeleteForeignKey } from "@openshapeforge/operations";
import type { OpenShapeForgeDatabase } from "./connection.js";
import { postgresArrayLiteral } from "./sql-helpers.js";

export function ownedDeleteForeignKeyIdentity(fk: OwnedDeleteForeignKey): string {
  return JSON.stringify([fk.source, fk.target, fk.sourceColumns, fk.targetColumns]);
}

export async function readOwnedDeleteForeignKeys(db: OpenShapeForgeDatabase, targetNames: string[]) {
  const references = await sql<OwnedDeleteForeignKey & { action: string; validated: boolean; constraint: string; definition: string }>`
    select source_ns.nspname || '.' || source.relname as source,
      target_ns.nspname || '.' || target.relname as target,
      array(select a.attname::text from unnest(fk.conkey) with ordinality k(num, pos)
        join pg_catalog.pg_attribute a on a.attrelid = fk.conrelid and a.attnum = k.num order by k.pos) as "sourceColumns",
      array(select a.attname::text from unnest(fk.confkey) with ordinality k(num, pos)
        join pg_catalog.pg_attribute a on a.attrelid = fk.confrelid and a.attnum = k.num order by k.pos) as "targetColumns",
      fk.confdeltype::text as action, fk.convalidated as validated, fk.conname as constraint,
      pg_catalog.pg_get_constraintdef(fk.oid) as definition
    from pg_catalog.pg_constraint fk
    join pg_catalog.pg_class source on source.oid = fk.conrelid
    join pg_catalog.pg_namespace source_ns on source_ns.oid = source.relnamespace
    join pg_catalog.pg_class target on target.oid = fk.confrelid
    join pg_catalog.pg_namespace target_ns on target_ns.oid = target.relnamespace
    where fk.contype = 'f' and target_ns.nspname || '.' || target.relname = any(${postgresArrayLiteral(targetNames)}::text[])
  `.execute(db);
  return references.rows;
}
