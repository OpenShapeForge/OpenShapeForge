// SPDX-License-Identifier: BUSL-1.1
import { sql, type Kysely } from "kysely";
import { APP_ROLE } from "../app-role.js";
import { WORKER_ROLE } from "../worker-role.js";
import type { VersionedMigration } from "../versioned-runner.js";

/**
 * Atomic, logical-only Document commands for the canonical Operation runtime.
 *
 * Unlike the legacy app.* commands from 0007, these functions are not an HTTP
 * authorization boundary and deliberately do not repeat authored roles,
 * statuses or field limits. The canonical Operation runtime has already
 * authenticated, authorized and schema-validated the request before reviewed
 * document code may call this private database seam.
 *
 * The separate schema is load-bearing: the worker role receives broad EXECUTE
 * on app.* session helpers, so document_internal is granted only to the API's
 * restricted application role. Inputs contain logical metadata only. Binary
 * artifact metadata remains storage-owned and cannot enter through either
 * command.
 */
const migration: VersionedMigration = {
  version: "0012_document-logical-commands",
  fileUrl: import.meta.url,
  async up(db: Kysely<any>): Promise<void> {
    await sql`
      create schema if not exists document_internal;

      revoke all on schema document_internal from public;
      revoke all on schema document_internal from ${sql.ref(WORKER_ROLE)};
      grant usage on schema document_internal to ${sql.ref(APP_ROLE)};

      create or replace function document_internal.create_with_first_version(
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
        if jsonb_typeof(document_input) is distinct from 'object'
          or jsonb_typeof(version_input) is distinct from 'object' then
          raise exception 'Document and version inputs must be JSON objects';
        end if;

        -- This is the logical Document key set already accepted by 0007. The
        -- Operation JSON Schema remains responsible for types, required fields,
        -- authored limits and statuses.
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
        from jsonb_object_keys(version_input) key
        where key = any(array[
          'fileName', 'mimeType', 'checksum', 'storageLocation', 'artifactId'
        ])
        limit 1;
        if invalid_key is not null then
          raise exception 'DocumentVersion binary field % is storage-managed', invalid_key;
        end if;

        select key into invalid_key
        from jsonb_object_keys(version_input) key
        where key <> all(array[
          'versionLabel', 'status', 'isMajorVersion', 'changeSummary', 'accountId'
        ])
        limit 1;
        if invalid_key is not null then
          raise exception 'Unknown DocumentVersion input field: %', invalid_key;
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
          id, tenant_id, version_label, status, created_by, is_major_version,
          change_summary, document_id, account_id
        ) values (
          new_version_id, tenant, version_input->>'versionLabel',
          version_input->>'status', actor::text,
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

      create or replace function document_internal.append_version(
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
        if jsonb_typeof(version_input) is distinct from 'object' then
          raise exception 'Version input must be a JSON object';
        end if;

        select key into invalid_key
        from jsonb_object_keys(version_input) key
        where key = any(array[
          'fileName', 'mimeType', 'checksum', 'storageLocation', 'artifactId'
        ])
        limit 1;
        if invalid_key is not null then
          raise exception 'DocumentVersion binary field % is storage-managed', invalid_key;
        end if;

        select key into invalid_key
        from jsonb_object_keys(version_input) key
        where key <> all(array[
          'versionLabel', 'status', 'isMajorVersion', 'changeSummary', 'accountId'
        ])
        limit 1;
        if invalid_key is not null then
          raise exception 'Unknown DocumentVersion input field: %', invalid_key;
        end if;

        perform 1
        from erp.documents
        where id = target_document_id and tenant_id = tenant
        for update;
        if not found then
          raise exception 'Document not found';
        end if;

        insert into erp.document_versions (
          id, tenant_id, version_label, status, created_by, is_major_version,
          change_summary, document_id, account_id
        ) values (
          new_version_id, tenant, version_input->>'versionLabel',
          version_input->>'status', actor::text,
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

      revoke all on function document_internal.create_with_first_version(jsonb, jsonb) from public;
      revoke all on function document_internal.append_version(uuid, jsonb) from public;
      revoke all on function document_internal.create_with_first_version(jsonb, jsonb) from ${sql.ref(WORKER_ROLE)};
      revoke all on function document_internal.append_version(uuid, jsonb) from ${sql.ref(WORKER_ROLE)};
      grant execute on function document_internal.create_with_first_version(jsonb, jsonb) to ${sql.ref(APP_ROLE)};
      grant execute on function document_internal.append_version(uuid, jsonb) to ${sql.ref(APP_ROLE)};
    `.execute(db);
  },
};

export default migration;
