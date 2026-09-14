// SPDX-License-Identifier: BUSL-1.1
import { sql, type Kysely } from "kysely";
import { APP_ROLE } from "../app-role.js";
import { WORKER_ROLE } from "../worker-role.js";
import type { VersionedMigration } from "../versioned-runner.js";

/**
 * Link storage-owned artifacts to immutable DocumentVersion heads.
 *
 * The artifact id and expected version are only a provisional association in
 * the creating transaction. The deferred guard makes that transaction
 * uncommittable until the trusted descriptor returned by artifact storage has
 * finalized the row. Provider object keys never enter the Document schema.
 */
const migration: VersionedMigration = {
  version: "0014_document-artifact-binding",
  fileUrl: import.meta.url,
  async up(db: Kysely<any>): Promise<void> {
    await sql`
      alter table erp.document_versions
        add column if not exists artifact_id uuid,
        add column if not exists artifact_version bigint,
        add column if not exists byte_size bigint;

      create unique index if not exists document_versions_tenant_artifact_uidx
        on erp.document_versions (tenant_id, artifact_id)
        where artifact_id is not null;

      alter table erp.document_versions
        drop constraint if exists document_versions_artifact_version_check,
        add constraint document_versions_artifact_version_check
          check (
            artifact_version is null
            or artifact_version between 1 and 9007199254740991
          ),
        drop constraint if exists document_versions_byte_size_check,
        add constraint document_versions_byte_size_check
          check (
            byte_size is null
            or byte_size between 0 and 9007199254740991
          );

      create or replace function document_internal.require_complete_artifact_binding()
      returns trigger
      language plpgsql
      security definer
      set search_path = pg_catalog, pg_temp
      as $function$
      declare
        current_row erp.document_versions%rowtype;
      begin
        select * into current_row
        from erp.document_versions version
        where version.tenant_id = new.tenant_id and version.id = new.id;
        if not found then
          return null;
        end if;
        if current_row.artifact_id is null
          and current_row.artifact_version is null
          and current_row.byte_size is null then
          return null;
        end if;
        if current_row.artifact_id is null
          or current_row.artifact_version is null
          or current_row.byte_size is null
          or current_row.file_name is null
          or current_row.mime_type is null
          or current_row.checksum is null
          or current_row.storage_location is not null then
          raise exception 'DocumentVersion artifact binding is incomplete';
        end if;
        return null;
      end;
      $function$;

      drop trigger if exists document_versions_artifact_complete_guard on erp.document_versions;
      create constraint trigger document_versions_artifact_complete_guard
        after insert or update on erp.document_versions
        deferrable initially deferred
        for each row execute function document_internal.require_complete_artifact_binding();

      revoke all on function document_internal.require_complete_artifact_binding() from public;
      revoke all on function document_internal.require_complete_artifact_binding() from ${sql.ref(WORKER_ROLE)};
      revoke all on function document_internal.require_complete_artifact_binding() from ${sql.ref(APP_ROLE)};

      create or replace function document_internal.create_with_first_version_and_artifact(
        document_input jsonb,
        version_input jsonb,
        target_artifact_id uuid,
        expected_artifact_version bigint
      ) returns table (document_id uuid, document_version_id uuid)
      language plpgsql
      security definer
      set search_path = pg_catalog, pg_temp
      as $function$
      declare
        tenant uuid := app.current_tenant();
        actor uuid := app.current_user_id();
        new_document_id uuid;
        new_version_id uuid;
      begin
        if tenant is null or actor is null then
          raise exception 'An authenticated tenant and user session is required';
        end if;
        if target_artifact_id is null
          or expected_artifact_version is null
          or expected_artifact_version not between 1 and 9007199254740991 then
          raise exception 'Artifact identity and expected version are required';
        end if;
        select created.document_id, created.document_version_id
        into new_document_id, new_version_id
        from document_internal.create_with_first_version(document_input, version_input) created;
        update erp.document_versions version
        set artifact_id = target_artifact_id,
            artifact_version = expected_artifact_version
        where version.tenant_id = tenant
          and version.id = new_version_id
          and version.document_id = new_document_id
          and version.created_by = actor::text
          and version.artifact_id is null
          and version.artifact_version is null
          and exists (
            select 1 from erp.documents document
            where document.tenant_id = tenant
              and document.id = new_document_id
              and document.current_version_id = new_version_id
          );
        if not found then
          raise exception 'DocumentVersion artifact association could not be prepared';
        end if;
        return query select new_document_id, new_version_id;
      end;
      $function$;

      create or replace function document_internal.append_version_with_artifact(
        target_document_id uuid,
        version_input jsonb,
        target_artifact_id uuid,
        expected_artifact_version bigint
      ) returns uuid
      language plpgsql
      security definer
      set search_path = pg_catalog, pg_temp
      as $function$
      declare
        tenant uuid := app.current_tenant();
        actor uuid := app.current_user_id();
        new_version_id uuid;
      begin
        if tenant is null or actor is null then
          raise exception 'An authenticated tenant and user session is required';
        end if;
        if target_artifact_id is null
          or expected_artifact_version is null
          or expected_artifact_version not between 1 and 9007199254740991 then
          raise exception 'Artifact identity and expected version are required';
        end if;
        select document_internal.append_version(target_document_id, version_input)
        into new_version_id;
        update erp.document_versions version
        set artifact_id = target_artifact_id,
            artifact_version = expected_artifact_version
        where version.tenant_id = tenant
          and version.id = new_version_id
          and version.document_id = target_document_id
          and version.created_by = actor::text
          and version.artifact_id is null
          and version.artifact_version is null
          and exists (
            select 1 from erp.documents document
            where document.tenant_id = tenant
              and document.id = target_document_id
              and document.current_version_id = new_version_id
          );
        if not found then
          raise exception 'DocumentVersion artifact association could not be prepared';
        end if;
        return new_version_id;
      end;
      $function$;

      create or replace function document_internal.finalize_artifact_binding(
        target_document_version_id uuid,
        target_artifact_id uuid,
        expected_artifact_version bigint,
        trusted_artifact_version bigint,
        trusted_file_name text,
        trusted_media_type text,
        trusted_sha256 text,
        trusted_byte_size bigint
      ) returns void
      language plpgsql
      security definer
      set search_path = pg_catalog, pg_temp
      as $function$
      declare
        tenant uuid := app.current_tenant();
        actor uuid := app.current_user_id();
      begin
        if tenant is null or actor is null then
          raise exception 'An authenticated tenant and user session is required';
        end if;
        if target_artifact_id is null
          or expected_artifact_version is null
          or expected_artifact_version not between 1 and 9007199254740991
          or trusted_artifact_version is null
          or trusted_artifact_version <= expected_artifact_version
          or trusted_artifact_version > 9007199254740991
          or trusted_file_name is null
          or nullif(btrim(trusted_file_name), '') is null
          or char_length(trusted_file_name) > 255
          or trusted_media_type is null
          or nullif(btrim(trusted_media_type), '') is null
          or char_length(trusted_media_type) > 150
          or trusted_media_type !~ '^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$'
          or trusted_sha256 is null
          or trusted_sha256 !~ '^[a-f0-9]{64}$'
          or trusted_byte_size is null
          or trusted_byte_size not between 0 and 9007199254740991 then
          raise exception 'Trusted artifact descriptor is invalid';
        end if;
        update erp.document_versions version
        set artifact_version = trusted_artifact_version,
            file_name = trusted_file_name,
            mime_type = trusted_media_type,
            checksum = trusted_sha256,
            byte_size = trusted_byte_size,
            storage_location = null
        where version.tenant_id = tenant
          and version.id = target_document_version_id
          and version.created_by = actor::text
          and version.artifact_id = target_artifact_id
          and version.artifact_version = expected_artifact_version
          and version.file_name is null
          and version.mime_type is null
          and version.checksum is null
          and version.byte_size is null
          and version.storage_location is null
          and exists (
            select 1 from erp.documents document
            where document.tenant_id = tenant
              and document.id = version.document_id
              and document.current_version_id = version.id
          );
        if not found then
          raise exception 'DocumentVersion artifact binding could not be finalized';
        end if;
      end;
      $function$;

      revoke all on function document_internal.create_with_first_version_and_artifact(jsonb,jsonb,uuid,bigint) from public;
      revoke all on function document_internal.append_version_with_artifact(uuid,jsonb,uuid,bigint) from public;
      revoke all on function document_internal.finalize_artifact_binding(uuid,uuid,bigint,bigint,text,text,text,bigint) from public;
      revoke all on function document_internal.create_with_first_version_and_artifact(jsonb,jsonb,uuid,bigint) from ${sql.ref(WORKER_ROLE)};
      revoke all on function document_internal.append_version_with_artifact(uuid,jsonb,uuid,bigint) from ${sql.ref(WORKER_ROLE)};
      revoke all on function document_internal.finalize_artifact_binding(uuid,uuid,bigint,bigint,text,text,text,bigint) from ${sql.ref(WORKER_ROLE)};
      grant execute on function document_internal.create_with_first_version_and_artifact(jsonb,jsonb,uuid,bigint) to ${sql.ref(APP_ROLE)};
      grant execute on function document_internal.append_version_with_artifact(uuid,jsonb,uuid,bigint) to ${sql.ref(APP_ROLE)};
      grant execute on function document_internal.finalize_artifact_binding(uuid,uuid,bigint,bigint,text,text,text,bigint) to ${sql.ref(APP_ROLE)};
    `.execute(db);
  },
};

export default migration;
