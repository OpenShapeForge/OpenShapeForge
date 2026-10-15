// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import type { VersionedMigration } from "../versioned-runner.js";

/** Carry the previous generated Chip default forward without rewriting rows.
 * Custom host defaults remain untouched; the normal manifest drift check
 * decides whether they match that host's compiled contract.
 */
const migration: VersionedMigration = {
  version: "0016_chip-definition-default",
  fileUrl: import.meta.url,
  async up(db) {
    await sql`do $$ begin
      if exists (
        select 1 from pg_attrdef d
        join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
        where d.adrelid = to_regclass('erp.chips') and a.attname = 'definition'
          and pg_get_expr(d.adbin, d.adrelid) =
            quote_literal('{"key":"value","osfType":"string","required":false}'::jsonb::text) || '::jsonb'
      ) then
        alter table erp.chips alter column definition set default
          '{"key":"value","osfType":"string","required":false,"validation":{"minLength":1,"maxLength":8000}}'::jsonb;
      end if;
    end $$`.execute(db);
  },
};
export default migration;
