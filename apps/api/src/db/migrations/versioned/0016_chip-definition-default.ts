// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import type { VersionedMigration } from "../versioned-runner.js";

/** Carry legacy text Chips and the previous typed default forward.
 * Text is JSON-encoded as a string, never parsed as a different value.
 * Already-typed custom host defaults remain untouched. The legacy text path
 * installs the core default; a host with a different newly authored default
 * needs its own migration before the normal manifest drift check can succeed.
 */
const migration: VersionedMigration = {
  version: "0016_chip-definition-default",
  fileUrl: import.meta.url,
  async up(db) {
    await sql`do $$ begin
      if exists (
        select 1 from pg_attribute where attrelid = to_regclass('erp.chips')
          and attname = 'value' and atttypid = 'text'::regtype and not attisdropped
      ) and not exists (
        select 1 from pg_attribute where attrelid = to_regclass('erp.chips')
          and attname = 'definition' and not attisdropped
      ) then
        alter table erp.chips add column if not exists definition jsonb not null default
          '{"key":"value","osfType":"multilineText","required":true,"validation":{"minLength":1,"maxLength":8000}}'::jsonb;
        -- Existing text keeps its released semantic type and line breaks.
        -- Only future rows use the current core authoring default.
        alter table erp.chips alter column definition set default
          '{"key":"value","osfType":"string","required":false,"validation":{"minLength":1,"maxLength":8000}}'::jsonb;
        alter table erp.chips alter column value type jsonb using to_jsonb(value);
      end if;
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
