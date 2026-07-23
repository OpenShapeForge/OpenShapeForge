/**
 * Bootstrap DDL for platform.schema_migrations — the single ledger used by
 * both the generated-schema roll-forward migration and the versioned bespoke
 * migration runner. Idempotent; safe to call from every migration step.
 *
 * Note: platform.schema_migrations is also described by the generated
 * manifest, so this DDL must stay in sync with the compiler output
 * (packages/compiler/config/platform-schema.yaml).
 */
import { sql, type Kysely } from "kysely";

export async function ensureSchemaMigrationsTable(
  db: Kysely<any>,
): Promise<void> {
  await sql`
    create schema if not exists platform;
    create table if not exists platform.schema_migrations (
      version text primary key not null,
      checksum text not null,
      applied_at timestamptz not null default now(),
      applied_by text
    );
  `.execute(db);
}
