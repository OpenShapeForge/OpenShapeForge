// SPDX-License-Identifier: BUSL-1.1
import { sql, type Kysely } from "kysely";
import { rlsBypassToken } from "../../rls-bypass.js";
import type { VersionedMigration } from "../versioned-runner.js";

/**
 * The tenant-unique configuration codes the generated schema now indexes
 * (`<table>_tenant_<column>_uidx`). Before that index, a tenant could hold two
 * rows with the same code; creating the index over them would abort the
 * migration. Such rows are made unique first: per tenant and code the oldest
 * row keeps its code, every later one gets `-<first 8 characters of its id>`
 * appended — no row is deleted and every other value stays as it was. The
 * index itself remains the generated schema's step.
 */
export const UNIQUE_CONFIGURATION_CODES = [
  { table: "agreement_component_types", column: "code" },
  { table: "case_file_types", column: "code" },
  { table: "case_templates", column: "code" },
  { table: "case_types", column: "code" },
  { table: "sla_policies", column: "code" },
  { table: "work_queues", column: "key" },
] as const;

export async function makeConfigurationCodesUnique(
  db: Kysely<any>,
  targets: ReadonlyArray<{ table: string; column: string }> = UNIQUE_CONFIGURATION_CODES,
): Promise<void> {
  // Duplicates in rows the migration role could not see would still abort
  // the index; this context only makes them visible so they are resolved.
  await sql`select set_config('app.bypass_rls', ${rlsBypassToken()}, true)`.execute(db);
  for (const { table, column } of targets) {
    const present = (await sql<{ ok: boolean }>`
      select exists (
        select 1 from pg_attribute a
         where a.attrelid = to_regclass(${`erp.${table}`}) and a.attname in (${column}, 'tenant_id', 'id')
           and a.attnum > 0 and not a.attisdropped
         group by a.attrelid having count(*) = 3
      ) as ok`.execute(db)).rows[0]?.ok;
    if (!present) continue;
    const order = (await sql<{ ok: boolean }>`
      select exists (select 1 from pg_attribute where attrelid = to_regclass(${`erp.${table}`})
                      and attname = 'created_at' and attnum > 0 and not attisdropped) as ok`.execute(db)).rows[0]?.ok
      ? `"created_at", "id"` : `"id"`;
    await sql.raw(`
      update "erp"."${table}" t
         set "${column}" = left(t."${column}", 150) || '-' || left(t."id"::text, 8)
        from (
          select "id", row_number() over (partition by "tenant_id", "${column}" order by ${order}) as n
            from "erp"."${table}" where "${column}" is not null
        ) d
       where t."id" = d."id" and d.n > 1`).execute(db);
  }
}

const migration: VersionedMigration = {
  version: "0023_unique-configuration-codes",
  fileUrl: import.meta.url,
  async up(db) { await makeConfigurationCodesUnique(db); },
};
export default migration;
