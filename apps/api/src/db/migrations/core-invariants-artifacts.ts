// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../connection.js";
import { APP_ROLE } from "./app-role.js";
import {
  DOCUMENT_VERSIONS_TABLE, documentColumn, documentVersionColumn, documents, documentVersions,
} from "./core-invariants-documents.js";
import { ensureCheckConstraint } from "./sql-invariants.js";
import { WORKER_ROLE } from "./worker-role.js";

/**
 * The ARTIFACT BINDING block of the core invariants (see core-invariants.ts
 * for the overview). Tables and authored columns come from the manifest
 * lookups hoisted in core-invariants-documents.ts.
 */
export async function applyArtifactBinding(db: OpenShapeForgeDatabase): Promise<void> {
  const version = Object.fromEntries(
    Object.entries(documentVersionColumn).map(([key, column]) => [key, sql.ref(column)]),
  ) as Record<keyof typeof documentVersionColumn, ReturnType<typeof sql.ref>>;
  const currentVersionId = sql.ref(documentColumn.currentVersionId);

  await sql`
    create unique index if not exists document_versions_tenant_artifact_uidx
      on ${documentVersions} (tenant_id, ${version.artifactId})
      where ${version.artifactId} is not null;
  `.execute(db);
  await ensureCheckConstraint(db, {
    table: DOCUMENT_VERSIONS_TABLE,
    name: "document_versions_artifact_version_check",
    expression: `${documentVersionColumn.artifactVersion} is null or ${documentVersionColumn.artifactVersion} between 1 and 9007199254740991`,
  });
  await ensureCheckConstraint(db, {
    table: DOCUMENT_VERSIONS_TABLE,
    name: "document_versions_byte_size_check",
    expression: `${documentVersionColumn.byteSize} is null or ${documentVersionColumn.byteSize} between 0 and 9007199254740991`,
  });

  await sql`
    create or replace function document_internal.require_complete_artifact_binding()
    returns trigger
    language plpgsql
    security definer
    set search_path = pg_catalog, pg_temp
    as $function$
    declare
      current_row ${documentVersions}%rowtype;
    begin
      select * into current_row
      from ${documentVersions} version
      where version.tenant_id = new.tenant_id and version.id = new.id;
      if not found then
        return null;
      end if;
      if current_row.${version.artifactId} is null
        and current_row.${version.artifactVersion} is null
        and current_row.${version.byteSize} is null then
        return null;
      end if;
      if current_row.${version.artifactId} is null
        or current_row.${version.artifactVersion} is null
        or current_row.${version.byteSize} is null
        or current_row.${version.fileName} is null
        or current_row.${version.mimeType} is null
        or current_row.${version.checksum} is null
        or current_row.${version.storageLocation} is not null then
        raise exception 'DocumentVersion artifact binding is incomplete';
      end if;
      return null;
    end;
    $function$;

    drop trigger if exists document_versions_artifact_complete_guard on ${documentVersions};
    create constraint trigger document_versions_artifact_complete_guard
      after insert or update on ${documentVersions}
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
      update ${documentVersions} version
      set ${version.artifactId} = target_artifact_id,
          ${version.artifactVersion} = expected_artifact_version
      where version.tenant_id = tenant
        and version.id = new_version_id
        and version.${version.documentId} = new_document_id
        and version.${version.createdBy} = actor::text
        and version.${version.artifactId} is null
        and version.${version.artifactVersion} is null
        and exists (
          select 1 from ${documents} document
          where document.tenant_id = tenant
            and document.id = new_document_id
            and document.${currentVersionId} = new_version_id
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
      update ${documentVersions} version
      set ${version.artifactId} = target_artifact_id,
          ${version.artifactVersion} = expected_artifact_version
      where version.tenant_id = tenant
        and version.id = new_version_id
        and version.${version.documentId} = target_document_id
        and version.${version.createdBy} = actor::text
        and version.${version.artifactId} is null
        and version.${version.artifactVersion} is null
        and exists (
          select 1 from ${documents} document
          where document.tenant_id = tenant
            and document.id = target_document_id
            and document.${currentVersionId} = new_version_id
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
      update ${documentVersions} version
      set ${version.artifactVersion} = trusted_artifact_version,
          ${version.fileName} = trusted_file_name,
          ${version.mimeType} = trusted_media_type,
          ${version.checksum} = trusted_sha256,
          ${version.byteSize} = trusted_byte_size,
          ${version.storageLocation} = null
      where version.tenant_id = tenant
        and version.id = target_document_version_id
        and version.${version.createdBy} = actor::text
        and version.${version.artifactId} = target_artifact_id
        and version.${version.artifactVersion} = expected_artifact_version
        and version.${version.fileName} is null
        and version.${version.mimeType} is null
        and version.${version.checksum} is null
        and version.${version.byteSize} is null
        and version.${version.storageLocation} is null
        and exists (
          select 1 from ${documents} document
          where document.tenant_id = tenant
            and document.id = version.${version.documentId}
            and document.${currentVersionId} = version.id
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
}
