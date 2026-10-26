// SPDX-License-Identifier: BUSL-1.1
import { sql, type Kysely } from "kysely";
import type { VersionedMigration } from "../versioned-runner.js";

/** Keep every admission and its delivered link while changing one role into a
 * list. ALTER TYPE rewrites all rows, including rows hidden by forced RLS,
 * without relaxing the table's security policy. The runner owns the transaction.
 * Applied migrations are immutable; transform forward in a new file.
 */
const migration: VersionedMigration = {
  version: "0019_employee-invitation-roles",
  fileUrl: import.meta.url,
  async up(db: Kysely<any>): Promise<void> {
    await sql`lock table platform.employee_invitations in access exclusive mode`.execute(db);
    const columns = await sql<{ name: string }>`
      select attname as name from pg_attribute
      where attrelid = 'platform.employee_invitations'::regclass
        and attnum > 0 and not attisdropped
    `.execute(db);
    const old = columns.rows.some(column => column.name === "role");
    const current = columns.rows.some(column => column.name === "roles");
    if (old && current) throw new Error("Employee invitations have an ambiguous partial roles upgrade.");
    if (!old) {
      if (!current) throw new Error("Employee invitations have no role column to migrate.");
      return;
    }
    await sql`alter table platform.employee_invitations drop constraint if exists employee_invitations_role_check`.execute(db);
    await sql`alter table platform.employee_invitations rename column role to roles`.execute(db);
    await sql`alter table platform.employee_invitations
      alter column roles type text[] using (case when roles is null then '{}'::text[] else array[roles] end),
      alter column roles set default '{}'::text[],
      alter column roles set not null`.execute(db);
  },
};
export default migration;
