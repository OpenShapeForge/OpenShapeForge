// SPDX-License-Identifier: BUSL-1.1
/**
 * Database-level guards for document content (docs/document-content.md):
 *
 * - document-owned blocks: their provenance columns (origin,
 *   template_block_id, diverged, locked) are written by commands only, so a
 *   document editor cannot unlock a block or forge its template provenance;
 * - the document's pinned template version and follow problem are written by
 *   commands only;
 * - who may read which blocks: a template-owned block needs a template role,
 *   a document-owned block needs a document role, as a restrictive policy
 *   beside the generated tenant policy.
 *
 * The documents module marks its own commands with the transaction-local
 * setting `app.document_command` (link | follow); the generated CRUD never
 * sets it. Messages open with the public code so the API classifies them
 * (db/database-refusals.ts) instead of redacting them. Role names mirror
 * entities/core/block.yaml and document-variant.yaml.
 */
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../connection.js";
import { ensureCheckConstraint } from "./sql-invariants.js";

/**
 * Name and expression of the compiler-owned owner check on erp.blocks, as
 * emitted in apps/api/src/generated/db/manifest.json ("compilerOwned" check
 * with replaceExisting). The plugin-migration step later re-applies it under
 * the same name as a repeatable DROP/ADD, so installing it here first is
 * semantically a no-op for that step.
 */
const BLOCK_OWNER_CHECK = {
  table: "erp.blocks",
  name: "erp_blocks_values_owner_check_7e02a4f3b503",
  expression: 'num_nonnulls("document_variant_id", "variant_id") = 1',
};

async function columnNullable(db: OpenShapeForgeDatabase, table: string, column: string): Promise<string | undefined> {
  const found = await sql<{ is_nullable: string }>`
    select is_nullable from information_schema.columns
    where table_schema = 'erp' and table_name = ${table} and column_name = ${column}
  `.execute(db);
  return found.rows[0]?.is_nullable;
}

/**
 * Pre-step for two earlier shapes of erp.blocks, both of which the generated
 * roll-forward would refuse as non-additive drift. This runs BEFORE the
 * roll-forward; a fresh database, or one already migrated, is a no-op.
 *
 * 1. A database built before blocks had a second owner: variant_id is NOT
 *    NULL. It is relaxed only once no row can end up ownerless:
 *    document_variant_id is added if missing and the owner check is in place
 *    (every existing row has a variant, so it validates).
 * 2. A database from the unreleased document-revision slice: blocks carry
 *    revision_id, documents carry current_revision_id and the
 *    document_revisions table exists. Nothing of that was ever released, so
 *    revision-owned blocks are dropped with their table and columns.
 */
export async function prepareDocumentOwnedBlocks(db: OpenShapeForgeDatabase): Promise<void> {
  if (await columnNullable(db, "blocks", "revision_id")) {
    // Dropping revision_id also drops the owner check that named it; it is
    // re-created below with the current expression.
    await sql`
      drop trigger if exists blocks_revision_guard on erp.blocks;
      drop function if exists app.guard_revision_block_write();
      drop policy if exists blocks_owner_read on erp.blocks;
      delete from erp.blocks where revision_id is not null;
      alter table erp.blocks drop column if exists revision_id_position;
      alter table erp.blocks drop column revision_id;
      alter table erp.blocks add column if not exists document_variant_id uuid;
      alter table erp.documents drop column if exists current_revision_id;
      drop table if exists erp.document_revisions;
      drop function if exists app.guard_document_revision_write();
      drop function if exists app.document_revision_command();
    `.execute(db);
    await ensureCheckConstraint(db, BLOCK_OWNER_CHECK);
  }
  if ((await columnNullable(db, "blocks", "variant_id")) !== "NO") return;
  await sql`alter table erp.blocks add column if not exists document_variant_id uuid`.execute(db);
  await ensureCheckConstraint(db, BLOCK_OWNER_CHECK);
  await sql`alter table erp.blocks alter column variant_id drop not null`.execute(db);
}

export async function applyDocumentContentGuards(db: OpenShapeForgeDatabase): Promise<void> {
  await sql`
    create or replace function app.document_command() returns text
    language sql stable
    as $$ select nullif(current_setting('app.document_command', true), '') $$;

    create or replace function app.has_any_role(candidates text[]) returns boolean
    language sql stable
    as $$ select app.bypass_rls() or coalesce(string_to_array(current_setting('app.roles', true), ',') && candidates, false) $$;

    create or replace function app.guard_document_content_write()
    returns trigger
    language plpgsql
    set search_path = pg_catalog, pg_temp
    as $function$
    begin
      if app.document_command() is not null then
        return new;
      end if;
      if new.template_version_id is distinct from old.template_version_id
        or new.follow_error is distinct from old.follow_error then
        raise exception 'FORBIDDEN: templateVersionId and followError are server-managed.';
      end if;
      return new;
    end;
    $function$;

    drop trigger if exists documents_content_guard on erp.documents;
    create trigger documents_content_guard
      before update on erp.documents
      for each row execute function app.guard_document_content_write();

    create or replace function app.guard_document_block_write()
    returns trigger
    language plpgsql
    set search_path = pg_catalog, pg_temp
    as $function$
    declare
      owner uuid := coalesce(case when tg_op = 'DELETE' then null else new.document_variant_id end, case when tg_op = 'INSERT' then null else old.document_variant_id end);
    begin
      if owner is null or app.document_command() is not null then
        return case when tg_op = 'DELETE' then old else new end;
      end if;
      if tg_op = 'INSERT' and (new.origin <> 'local' or new.template_block_id is not null or new.diverged or new.locked) then
        raise exception 'FORBIDDEN: origin, templateBlockId, diverged and locked are server-managed on a document block.';
      end if;
      if tg_op = 'UPDATE' and (
        new.origin is distinct from old.origin
        or new.template_block_id is distinct from old.template_block_id
        or new.diverged is distinct from old.diverged
        or new.locked is distinct from old.locked) then
        raise exception 'FORBIDDEN: origin, templateBlockId, diverged and locked are server-managed on a document block.';
      end if;
      return case when tg_op = 'DELETE' then old else new end;
    end;
    $function$;

    drop trigger if exists blocks_document_guard on erp.blocks;
    create trigger blocks_document_guard
      before insert or update or delete on erp.blocks
      for each row execute function app.guard_document_block_write();

    drop policy if exists blocks_owner_read on erp.blocks;
    -- Policies are created after the functions above; the setting itself is
    -- transaction-local and never set by generated CRUD.
    create policy blocks_owner_read on erp.blocks as restrictive for select
      using (
        app.bypass_rls()
        -- A documents command (link | follow) runs on the caller's session; a
        -- template publisher need not hold a document role to re-seed the
        -- documents that track the template.
        or app.document_command() in ('link', 'follow')
        or (document_variant_id is not null and app.has_any_role(array['CaseFile.All.Read', 'CaseFile.All.ReadWrite']))
        or (variant_id is not null and app.has_any_role(array['Templates.Read', 'Organization.All.ReadWrite', 'General.All.Read', 'General.All.ReadWrite']))
      );
  `.execute(db);
}
