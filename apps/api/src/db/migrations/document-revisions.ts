// SPDX-License-Identifier: BUSL-1.1
/**
 * Database-level guards for document revisions (docs/document-revisions.md):
 *
 * - the revision state machine and its server-managed columns, so a generic
 *   entity update or delete cannot publish, supersede, re-point or edit a
 *   frozen revision;
 * - revision-owned blocks: only a draft's blocks change, and their provenance
 *   columns (origin, template_block_id, diverged) are written by commands;
 * - who may read which blocks: a template-owned block needs a template role,
 *   a revision-owned block needs a document role, as a restrictive policy
 *   beside the generated tenant policy.
 *
 * The documents module marks its own commands with the transaction-local
 * setting `app.document_revision_command` (start | follow | publish); the
 * generated CRUD never sets it. Messages open with the public code so the
 * API classifies them (db/database-refusals.ts) instead of redacting them.
 * Role names mirror entities/core/block.yaml and document-revision.yaml.
 */
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../connection.js";

export async function applyDocumentRevisionGuards(db: OpenShapeForgeDatabase): Promise<void> {
  await sql`
    create or replace function app.document_revision_command() returns text
    language sql stable
    as $$ select nullif(current_setting('app.document_revision_command', true), '') $$;

    create or replace function app.has_any_role(candidates text[]) returns boolean
    language sql stable
    as $$ select app.bypass_rls() or coalesce(string_to_array(current_setting('app.roles', true), ',') && candidates, false) $$;

    create or replace function app.guard_document_revision_write()
    returns trigger
    language plpgsql
    set search_path = pg_catalog, pg_temp
    as $function$
    declare
      command text := app.document_revision_command();
    begin
      if tg_op = 'DELETE' then
        if old.status in ('published', 'superseded') then
          raise exception 'INVALID_STATE: A published revision is kept for provenance and cannot be deleted.';
        end if;
        if exists (select 1 from erp.documents d where d.tenant_id = old.tenant_id and d.current_revision_id = old.id) then
          raise exception 'INVALID_STATE: This revision is the document''s current revision and cannot be deleted.';
        end if;
        return old;
      end if;
      if command is not null then
        return new;
      end if;
      if new.published_version_id is distinct from old.published_version_id
        or new.template_version_id is distinct from old.template_version_id
        or new.follow_error is distinct from old.follow_error then
        raise exception 'FORBIDDEN: templateVersion, publishedVersionId and followError are server-managed.';
      end if;
      if new.status is distinct from old.status and not (
        (old.status = 'draft' and new.status = 'submitted')
        or (old.status = 'submitted' and new.status in ('approved', 'rejected', 'draft'))
        or (old.status in ('approved', 'rejected') and new.status = 'draft')
      ) then
        raise exception 'INVALID_STATE: A revision cannot move from % to %.', old.status, new.status;
      end if;
      if old.status <> 'draft' and (
        new.parameters is distinct from old.parameters
        or new.channel is distinct from old.channel
        or new.locale is distinct from old.locale) then
        raise exception 'INVALID_STATE: Only a draft revision can be edited.';
      end if;
      return new;
    end;
    $function$;

    drop trigger if exists document_revisions_state_guard on erp.document_revisions;
    create trigger document_revisions_state_guard
      before update or delete on erp.document_revisions
      for each row execute function app.guard_document_revision_write();

    create or replace function app.guard_revision_block_write()
    returns trigger
    language plpgsql
    set search_path = pg_catalog, pg_temp
    as $function$
    declare
      command text := app.document_revision_command();
      revision uuid := coalesce(case when tg_op = 'DELETE' then null else new.revision_id end, case when tg_op = 'INSERT' then null else old.revision_id end);
      revision_status text;
    begin
      if revision is null then
        return case when tg_op = 'DELETE' then old else new end;
      end if;
      select status into revision_status from erp.document_revisions r where r.id = revision;
      if revision_status is distinct from 'draft' and command is distinct from 'follow' then
        raise exception 'INVALID_STATE: Only the blocks of a draft revision can change.';
      end if;
      if command is null and tg_op = 'INSERT' and (new.origin <> 'local' or new.template_block_id is not null or new.diverged) then
        raise exception 'FORBIDDEN: origin, templateBlockId and diverged are server-managed.';
      end if;
      if command is null and tg_op = 'UPDATE' and (
        new.origin is distinct from old.origin
        or new.template_block_id is distinct from old.template_block_id
        or new.diverged is distinct from old.diverged) then
        raise exception 'FORBIDDEN: origin, templateBlockId and diverged are server-managed.';
      end if;
      return case when tg_op = 'DELETE' then old else new end;
    end;
    $function$;

    drop trigger if exists blocks_revision_guard on erp.blocks;
    create trigger blocks_revision_guard
      before insert or update or delete on erp.blocks
      for each row execute function app.guard_revision_block_write();

    drop policy if exists blocks_owner_read on erp.blocks;
    -- Policies are created after the functions above; the setting itself is
    -- transaction-local and never set by generated CRUD.
    create policy blocks_owner_read on erp.blocks as restrictive for select
      using (
        app.bypass_rls()
        -- A documents command (start | follow | publish) runs on the caller's
        -- session; a template publisher need not hold a document role to
        -- re-seed the drafts that track the template.
        or app.document_revision_command() in ('start', 'follow', 'publish')
        or (revision_id is not null and app.has_any_role(array['CaseFile.All.Read', 'CaseFile.All.ReadWrite']))
        or (variant_id is not null and app.has_any_role(array['Templates.Read', 'Organization.All.ReadWrite', 'General.All.Read', 'General.All.ReadWrite']))
      );
  `.execute(db);
}
