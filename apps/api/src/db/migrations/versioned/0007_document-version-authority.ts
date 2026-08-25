// SPDX-License-Identifier: BUSL-1.1
import { sql, type Kysely } from "kysely";
import type { VersionedMigration } from "../versioned-runner.js";

/**
 * Make Document the stable container and DocumentVersion the sole artifact
 * truth. The migration intentionally removes the five legacy artifact columns
 * from Document: there is no compatibility projection or duplicate state.
 *
 * The two tables are created here on a fresh database because bespoke
 * migrations run before the generated schema. That lets the composite foreign
 * keys and write guard exist on both fresh installs and upgrades; the generated
 * roll-forward then adds the ordinary RLS policies and remaining references.
 *
 * Application-role writes to DocumentVersion are denied by a trigger even if a
 * later broad grant accidentally restores DML privileges. The two SECURITY
 * DEFINER commands below are the only write path: they obtain tenant and actor
 * from the transaction-local authenticated session and perform each container,
 * version and current-pointer change atomically.
 */
const migration: VersionedMigration = {
  version: "0007_document-version-authority",
  fileUrl: import.meta.url,
  async up(db: Kysely<any>): Promise<void> {
    await sql`
      create schema if not exists erp;

      create table if not exists erp.documents (
        id uuid primary key not null default gen_random_uuid(),
        tenant_id uuid not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        external_id text,
        source_authority text,
        source_organization text,
        source_administration text,
        code text,
        title text not null,
        description text,
        document_type text not null,
        status text not null,
        confidentiality text,
        source text,
        author text,
        is_external boolean not null default false,
        registered_at timestamptz,
        received_at timestamptz,
        published_at timestamptz,
        case_file_id uuid,
        case_id uuid,
        relation_id uuid,
        current_version_id uuid
      );

      create table if not exists erp.document_versions (
        id uuid primary key not null default gen_random_uuid(),
        tenant_id uuid not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        external_id text,
        source_authority text,
        source_organization text,
        source_administration text,
        version_label text not null,
        status text not null,
        created_by text,
        file_name text,
        mime_type text,
        storage_location text,
        checksum text,
        is_major_version boolean not null default false,
        change_summary text,
        document_id uuid,
        account_id uuid
      );

      alter table erp.document_versions
        add column if not exists document_id uuid;
    `.execute(db);

    await sql`
      do $document_version_backfill$
      begin
        if exists (
          select 1
          from erp.document_versions version
          join erp.documents document on document.current_version_id = version.id
          where version.document_id is null
          group by version.id
          having count(*) > 1
        ) then
          raise exception 'Cannot infer document_id: a legacy DocumentVersion is current for multiple Documents';
        end if;

        update erp.document_versions version
        set document_id = document.id
        from erp.documents document
        where version.document_id is null
          and document.current_version_id = version.id
          and document.tenant_id = version.tenant_id;

        if exists (select 1 from erp.document_versions where document_id is null) then
          raise exception 'Cannot make DocumentVersion.document_id required while orphan versions exist';
        end if;

        if exists (
          select 1
          from erp.document_versions version
          join erp.documents document on document.id = version.document_id
          where document.tenant_id <> version.tenant_id
        ) then
          raise exception 'Cannot enforce tenant-consistent DocumentVersion.document_id: cross-tenant rows exist';
        end if;

        if exists (
          select 1
          from erp.documents document
          join erp.document_versions version on version.id = document.current_version_id
          where version.tenant_id <> document.tenant_id
             or version.document_id <> document.id
        ) then
          raise exception 'Cannot enforce Document.current_version_id: cross-tenant or cross-document pointers exist';
        end if;

        if to_regclass('erp.case_files') is not null then
          if exists (
            select 1 from erp.documents document
            join erp.case_files target on target.id = document.case_file_id
            where target.tenant_id <> document.tenant_id
          ) then
            raise exception 'Cannot enforce tenant-consistent Document.case_file_id: cross-tenant rows exist';
          end if;
        end if;
        if to_regclass('erp.cases') is not null then
          if exists (
            select 1 from erp.documents document
            join erp.cases target on target.id = document.case_id
            where target.tenant_id <> document.tenant_id
          ) then
            raise exception 'Cannot enforce tenant-consistent Document.case_id: cross-tenant rows exist';
          end if;
        end if;
        if to_regclass('erp.relations') is not null then
          if exists (
            select 1 from erp.documents document
            join erp.relations target on target.id = document.relation_id
            where target.tenant_id <> document.tenant_id
          ) then
            raise exception 'Cannot enforce tenant-consistent Document.relation_id: cross-tenant rows exist';
          end if;
        end if;
        if to_regclass('erp.accounts') is not null then
          if exists (
            select 1 from erp.document_versions version
            join erp.accounts target on target.id = version.account_id
            where target.tenant_id <> version.tenant_id
          ) then
            raise exception 'Cannot enforce tenant-consistent DocumentVersion.account_id: cross-tenant rows exist';
          end if;
        end if;
      end
      $document_version_backfill$;
    `.execute(db);

    await sql`
      alter table erp.document_versions
        alter column document_id set not null;

      alter table erp.documents
        drop column if exists file_name,
        drop column if exists mime_type,
        drop column if exists storage_location,
        drop column if exists version_label,
        drop column if exists checksum;

      alter table erp.documents
        drop constraint if exists documents_current_version_id_fkey;
      alter table erp.document_versions
        drop constraint if exists document_versions_document_id_fkey;

      create unique index if not exists documents_tenant_identity_uidx
        on erp.documents (tenant_id, id);
      create unique index if not exists document_versions_tenant_document_label_uidx
        on erp.document_versions (tenant_id, document_id, version_label);
      create unique index if not exists document_versions_tenant_document_identity_uidx
        on erp.document_versions (tenant_id, document_id, id);

      alter table erp.document_versions
        add constraint document_versions_document_id_fkey
        foreign key (tenant_id, document_id)
        references erp.documents (tenant_id, id);

      alter table erp.documents
        add constraint documents_current_version_id_fkey
        foreign key (tenant_id, id, current_version_id)
        references erp.document_versions (tenant_id, document_id, id);
    `.execute(db);

    await sql`
      create or replace function app.reject_direct_document_version_write()
      returns trigger
      language plpgsql
      set search_path = pg_catalog, pg_temp
      as $function$
      begin
        if current_user = 'openshapeforge_app' then
          raise exception 'DocumentVersion is immutable and may only be created through a document version command';
        end if;
        if tg_op = 'DELETE' then
          return old;
        end if;
        return new;
      end;
      $function$;

      drop trigger if exists document_versions_write_guard on erp.document_versions;
      create trigger document_versions_write_guard
        before insert or update or delete on erp.document_versions
        for each row execute function app.reject_direct_document_version_write();

      create or replace function app.enforce_document_authority()
      returns trigger
      language plpgsql
      set search_path = pg_catalog, pg_temp
      as $function$
      begin
        if tg_op = 'INSERT' and current_user = 'openshapeforge_app' then
          raise exception 'Document must be created atomically with its first version through a document command';
        end if;
        if tg_op = 'UPDATE'
          and current_user = 'openshapeforge_app'
          and new.current_version_id is distinct from old.current_version_id then
          raise exception 'Document.currentVersionId is server-managed and may only change through a document version command';
        end if;
        if new.case_file_id is not null and not exists (
          select 1 from erp.case_files target
          where target.id = new.case_file_id and target.tenant_id = new.tenant_id
        ) then
          raise exception 'Document.caseFileId must reference the same tenant' using errcode = '23503';
        end if;
        if new.case_id is not null and not exists (
          select 1 from erp.cases target
          where target.id = new.case_id and target.tenant_id = new.tenant_id
        ) then
          raise exception 'Document.caseId must reference the same tenant' using errcode = '23503';
        end if;
        if new.relation_id is not null and not exists (
          select 1 from erp.relations target
          where target.id = new.relation_id and target.tenant_id = new.tenant_id
        ) then
          raise exception 'Document.relationId must reference the same tenant' using errcode = '23503';
        end if;
        return new;
      end;
      $function$;

      drop trigger if exists documents_authority_guard on erp.documents;
      create trigger documents_authority_guard
        before insert or update on erp.documents
        for each row execute function app.enforce_document_authority();

      create or replace function app.enforce_document_version_tenant_references()
      returns trigger
      language plpgsql
      set search_path = pg_catalog, pg_temp
      as $function$
      begin
        if new.account_id is not null and not exists (
          select 1 from erp.accounts target
          where target.id = new.account_id and target.tenant_id = new.tenant_id
        ) then
          raise exception 'DocumentVersion.accountId must reference the same tenant' using errcode = '23503';
        end if;
        return new;
      end;
      $function$;

      drop trigger if exists document_versions_tenant_reference_guard on erp.document_versions;
      create trigger document_versions_tenant_reference_guard
        before insert or update on erp.document_versions
        for each row execute function app.enforce_document_version_tenant_references();
    `.execute(db);

    await sql`
      create or replace function app.create_document_with_first_version(
        document_input jsonb,
        version_input jsonb
      ) returns table (document_id uuid, document_version_id uuid)
      language plpgsql
      security definer
      set search_path = pg_catalog, pg_temp
      as $function$
      declare
        tenant uuid := app.current_tenant();
        actor uuid := app.current_user_id();
        new_document_id uuid := gen_random_uuid();
        new_version_id uuid := gen_random_uuid();
        invalid_key text;
      begin
        if tenant is null or actor is null then
          raise exception 'An authenticated tenant and user session is required';
        end if;
        if not coalesce(
          'CaseFile.All.ReadWrite' = any(
            string_to_array(nullif(current_setting('app.roles', true), ''), ',')
          ),
          false
        ) then
          raise exception 'Not authorized to create Document';
        end if;
        if jsonb_typeof(document_input) <> 'object' or jsonb_typeof(version_input) <> 'object' then
          raise exception 'Document and version inputs must be JSON objects';
        end if;

        select key into invalid_key
        from jsonb_object_keys(document_input) key
        where key <> all(array[
          'code', 'title', 'description', 'documentType', 'status',
          'confidentiality', 'source', 'author', 'isExternal', 'registeredAt',
          'receivedAt', 'publishedAt', 'caseFileId', 'caseId', 'relationId'
        ])
        limit 1;
        if invalid_key is not null then
          raise exception 'Unknown Document input field: %', invalid_key;
        end if;

        select key into invalid_key
        from jsonb_each(document_input) entry(key, value)
        where (key = 'isExternal' and jsonb_typeof(value) <> 'boolean')
           or (key <> 'isExternal' and jsonb_typeof(value) <> 'string')
        limit 1;
        if invalid_key is not null then
          raise exception 'Document input field % has an invalid JSON type', invalid_key;
        end if;

        select key into invalid_key
        from jsonb_object_keys(version_input) key
        where key <> all(array[
          'versionLabel', 'status', 'fileName', 'mimeType', 'storageLocation',
          'checksum', 'isMajorVersion', 'changeSummary', 'accountId'
        ])
        limit 1;
        if invalid_key is not null then
          raise exception 'Unknown DocumentVersion input field: %', invalid_key;
        end if;

        select key into invalid_key
        from jsonb_each(version_input) entry(key, value)
        where (key = 'isMajorVersion' and jsonb_typeof(value) <> 'boolean')
           or (key <> 'isMajorVersion' and jsonb_typeof(value) <> 'string')
        limit 1;
        if invalid_key is not null then
          raise exception 'DocumentVersion input field % has an invalid JSON type', invalid_key;
        end if;

        if nullif(btrim(document_input->>'title'), '') is null
          or nullif(btrim(document_input->>'documentType'), '') is null
          or nullif(btrim(document_input->>'status'), '') is null then
          raise exception 'Document title, documentType and status are required';
        end if;
        if nullif(btrim(version_input->>'versionLabel'), '') is null
          or nullif(btrim(version_input->>'status'), '') is null then
          raise exception 'DocumentVersion versionLabel and status are required';
        end if;
        if char_length(coalesce(document_input->>'code', '')) > 100
          or char_length(document_input->>'title') > 300
          or char_length(coalesce(document_input->>'description', '')) > 8000
          or char_length(coalesce(document_input->>'source', '')) > 200
          or char_length(coalesce(document_input->>'author', '')) > 200 then
          raise exception 'Document input exceeds an authored maximum length';
        end if;
        if char_length(version_input->>'versionLabel') > 50
          or char_length(coalesce(version_input->>'fileName', '')) > 255
          or char_length(coalesce(version_input->>'mimeType', '')) > 150
          or char_length(coalesce(version_input->>'storageLocation', '')) > 1000
          or char_length(coalesce(version_input->>'checksum', '')) > 128
          or char_length(coalesce(version_input->>'changeSummary', '')) > 4000 then
          raise exception 'DocumentVersion input exceeds an authored maximum length';
        end if;

        insert into erp.documents (
          id, tenant_id, code, title, description, document_type, status,
          confidentiality, source, author, is_external, registered_at,
          received_at, published_at, case_file_id, case_id, relation_id
        ) values (
          new_document_id, tenant, document_input->>'code', document_input->>'title',
          document_input->>'description', document_input->>'documentType',
          document_input->>'status', document_input->>'confidentiality',
          document_input->>'source', document_input->>'author',
          coalesce((document_input->>'isExternal')::boolean, false),
          (document_input->>'registeredAt')::timestamptz,
          (document_input->>'receivedAt')::timestamptz,
          (document_input->>'publishedAt')::timestamptz,
          (document_input->>'caseFileId')::uuid,
          (document_input->>'caseId')::uuid,
          (document_input->>'relationId')::uuid
        );

        insert into erp.document_versions (
          id, tenant_id, version_label, status, created_by, file_name, mime_type,
          storage_location, checksum, is_major_version, change_summary,
          document_id, account_id
        ) values (
          new_version_id, tenant, version_input->>'versionLabel',
          version_input->>'status', actor::text, version_input->>'fileName',
          version_input->>'mimeType', version_input->>'storageLocation',
          version_input->>'checksum',
          coalesce((version_input->>'isMajorVersion')::boolean, false),
          version_input->>'changeSummary', new_document_id,
          (version_input->>'accountId')::uuid
        );

        update erp.documents
        set current_version_id = new_version_id, updated_at = now()
        where id = new_document_id and tenant_id = tenant;

        return query select new_document_id, new_version_id;
      end;
      $function$;

      create or replace function app.append_document_version(
        target_document_id uuid,
        version_input jsonb
      ) returns uuid
      language plpgsql
      security definer
      set search_path = pg_catalog, pg_temp
      as $function$
      declare
        tenant uuid := app.current_tenant();
        actor uuid := app.current_user_id();
        new_version_id uuid := gen_random_uuid();
        invalid_key text;
      begin
        if tenant is null or actor is null then
          raise exception 'An authenticated tenant and user session is required';
        end if;
        if not coalesce(
          'CaseFile.All.ReadWrite' = any(
            string_to_array(nullif(current_setting('app.roles', true), ''), ',')
          ),
          false
        ) then
          raise exception 'Not authorized to update Document';
        end if;
        if jsonb_typeof(version_input) <> 'object' then
          raise exception 'Version input must be a JSON object';
        end if;
        select key into invalid_key
        from jsonb_object_keys(version_input) key
        where key <> all(array[
          'versionLabel', 'status', 'fileName', 'mimeType', 'storageLocation',
          'checksum', 'isMajorVersion', 'changeSummary', 'accountId'
        ])
        limit 1;
        if invalid_key is not null then
          raise exception 'Unknown DocumentVersion input field: %', invalid_key;
        end if;
        select key into invalid_key
        from jsonb_each(version_input) entry(key, value)
        where (key = 'isMajorVersion' and jsonb_typeof(value) <> 'boolean')
           or (key <> 'isMajorVersion' and jsonb_typeof(value) <> 'string')
        limit 1;
        if invalid_key is not null then
          raise exception 'DocumentVersion input field % has an invalid JSON type', invalid_key;
        end if;
        if nullif(btrim(version_input->>'versionLabel'), '') is null
          or nullif(btrim(version_input->>'status'), '') is null then
          raise exception 'DocumentVersion versionLabel and status are required';
        end if;
        if char_length(version_input->>'versionLabel') > 50
          or char_length(coalesce(version_input->>'fileName', '')) > 255
          or char_length(coalesce(version_input->>'mimeType', '')) > 150
          or char_length(coalesce(version_input->>'storageLocation', '')) > 1000
          or char_length(coalesce(version_input->>'checksum', '')) > 128
          or char_length(coalesce(version_input->>'changeSummary', '')) > 4000 then
          raise exception 'DocumentVersion input exceeds an authored maximum length';
        end if;

        perform 1 from erp.documents
        where id = target_document_id and tenant_id = tenant
        for update;
        if not found then
          raise exception 'Document not found';
        end if;

        insert into erp.document_versions (
          id, tenant_id, version_label, status, created_by, file_name, mime_type,
          storage_location, checksum, is_major_version, change_summary,
          document_id, account_id
        ) values (
          new_version_id, tenant, version_input->>'versionLabel',
          version_input->>'status', actor::text, version_input->>'fileName',
          version_input->>'mimeType', version_input->>'storageLocation',
          version_input->>'checksum',
          coalesce((version_input->>'isMajorVersion')::boolean, false),
          version_input->>'changeSummary', target_document_id,
          (version_input->>'accountId')::uuid
        );

        update erp.documents
        set current_version_id = new_version_id, updated_at = now()
        where id = target_document_id and tenant_id = tenant;

        return new_version_id;
      end;
      $function$;

      revoke all on function app.create_document_with_first_version(jsonb, jsonb) from public;
      revoke all on function app.append_document_version(uuid, jsonb) from public;
    `.execute(db);
  },
};

export default migration;
