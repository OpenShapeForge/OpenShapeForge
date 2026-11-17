// SPDX-License-Identifier: BUSL-1.1
/**
 * Database-level guards for document content (docs/document-content.md):
 *
 * - document-owned blocks: their provenance columns (origin,
 *   template_block_id, diverged, locked) are written by commands only, so a
 *   document editor cannot unlock a block or forge its template provenance;
 * - the document's pinned template version and follow problem are written by
 *   commands only.
 *
 * Who may read which blocks (a template-owned block needs a template role, a
 * document-owned block a document role) is the compiler's: block.yaml authors
 * `authorization.ownerAxis` and schema.sql carries the restrictive policy
 * blocks_owner_read with the role names the owner entities declare, so
 * nothing here restates a role name.
 *
 * The documents module marks its own commands with the transaction-local
 * setting `app.document_command` (link | follow); the generated CRUD never
 * sets it. Messages open with the public code so the API classifies them
 * (db/database-refusals.ts) instead of redacting them.
 */
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../connection.js";

export async function applyDocumentContentGuards(db: OpenShapeForgeDatabase): Promise<void> {
  await sql`
    create or replace function app.document_command() returns text
    language sql stable
    as $$ select nullif(current_setting('app.document_command', true), '') $$;

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

  `.execute(db);
}
