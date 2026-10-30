// SPDX-License-Identifier: BUSL-1.1
import { sql, type Kysely } from 'kysely';
import manifest from '../../../generated/db/manifest.json' with { type: 'json' };
import type { VersionedMigration } from '../versioned-runner.js';

type ManifestTable = { schema: string; table: string; columns: Array<{ name: string; type: string; required?: boolean; primaryKey?: boolean }> };

/** Honor the host composition when membership's relation is optional.
 * Dropping NOT NULL changes no row; all other shapes remain for the drift
 * checker to classify. Required compositions retain their constraint.
 */
export async function reconcileMembershipRelationNullability(db: Kysely<any>, tables: readonly ManifestTable[]): Promise<void> {
 const table=tables.find(t=>t.schema==='erp'&&t.table==='relation_group_memberships');
 const declared=table?.columns.find(c=>c.name==='relation_id');
 if (!declared || declared.type!=='uuid' || declared.required || declared.primaryKey) return;
 const column=(await sql<{required:boolean;type:string}>`select a.attnotnull as required,format_type(a.atttypid,a.atttypmod) as type from pg_attribute a where a.attrelid=to_regclass('erp.relation_group_memberships') and a.attname='relation_id' and a.attnum>0 and not a.attisdropped`.execute(db)).rows[0];
 if (!column || !column.required || column.type!=='uuid') return;
 await sql`alter table erp.relation_group_memberships alter column relation_id drop not null`.execute(db);
}
const migration: VersionedMigration={
 version:'0022_membership-relation-nullability',fileUrl:import.meta.url,
 async up(db){await reconcileMembershipRelationNullability(db,manifest.tables as ManifestTable[]);},
};
export default migration;
