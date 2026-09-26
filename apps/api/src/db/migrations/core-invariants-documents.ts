// SPDX-License-Identifier: BUSL-1.1
import { sql, type RawBuilder } from "kysely";
import type { OpenShapeForgeDatabase } from "../connection.js";
import { entityColumnName, entityTableName, manifestTableForEntity } from "../manifest-lookup.js";
import { APP_ROLE } from "./app-role.js";
import { ensureForeignKey } from "./sql-invariants.js";
import { WORKER_ROLE } from "./worker-role.js";

/**
 * The Document blocks of the core invariants (see core-invariants.ts for the
 * overview): DOCUMENT AUTHORITY and LOGICAL DOCUMENT COMMANDS. Every table
 * and authored column is looked up in the generated manifest by entity and
 * field key; the SQL below names no physical table or column itself.
 */

/** Where the Document entities live, as `schema.table`. */
export const DOCUMENTS_TABLE = entityTableName("Document");
export const DOCUMENT_VERSIONS_TABLE = entityTableName("DocumentVersion");
export const documents = sql.table(DOCUMENTS_TABLE);
export const documentVersions = sql.table(DOCUMENT_VERSIONS_TABLE);

function columnsOf<const K extends readonly string[]>(entity: string, keys: K): Record<K[number], string> {
  return Object.fromEntries(keys.map((key) => [key, entityColumnName(entity, key)])) as Record<K[number], string>;
}

/** Physical columns of the Document fields the invariants touch. */
export const documentColumn = columnsOf("Document", [
  "currentVersionId", "documentType", "caseFileId", "caseId", "relationId",
] as const);

/** Physical columns of the DocumentVersion fields the invariants touch. */
export const documentVersionColumn = columnsOf("DocumentVersion", [
  "documentId", "accountId", "versionLabel", "versionNumber", "snapshot", "contentHash",
  "createdBy", "publishedBy", "artifactId", "artifactVersion", "byteSize",
  "fileName", "mimeType", "checksum", "storageLocation",
] as const);

/**
 * The authored fields a logical document command accepts, by field key. The
 * Operation JSON Schema remains responsible for types, required fields,
 * authored limits and statuses. Deliberately a declared subset of the
 * entity's fields rather than "every column but the base ones": the manifest
 * also holds server-managed pointers (latestVersionId, publishedVersion,
 * lifecycleStatus, ...) that no caller may set through a command. The
 * physical column and the cast of each field come from the manifest, so the
 * `input->>'field'` / column pairing in the inserts cannot drift.
 */
export const DOCUMENT_INPUT_FIELDS = [
  "code", "title", "description", "documentType", "status",
  "confidentiality", "source", "author", "isExternal", "registeredAt",
  "receivedAt", "publishedAt", "caseFileId", "caseId", "relationId",
] as const;

export const DOCUMENT_VERSION_INPUT_FIELDS = [
  "versionLabel", "status", "isMajorVersion", "changeSummary", "accountId",
] as const;

/** Binary artifact metadata is storage-owned and cannot enter through a command. */
export const DOCUMENT_VERSION_STORAGE_FIELDS = [
  "fileName", "mimeType", "checksum", "storageLocation", "artifactId",
] as const;

const SQL_TYPE = /^[a-z][a-z0-9_ ]*$/;
const PLPGSQL_VARIABLE = /^[a-z_][a-z0-9_]*$/;

/** `input->>'field'` cast to the manifest column's type; a required boolean defaults to false. */
function jsonInputExpression(entity: string, input: string, field: string): RawBuilder<unknown> {
  const table = manifestTableForEntity(entity);
  const column = table.columns.find((candidate) => candidate.name === entityColumnName(entity, field))!;
  if (!SQL_TYPE.test(column.type)) throw new Error(`Unexpected column type ${column.type} for ${entity}.${field}`);
  if (!PLPGSQL_VARIABLE.test(input)) throw new Error(`Invalid PL/pgSQL variable name: ${input}`);
  const text = sql`${sql.raw(input)}->>${sql.lit(field)}`;
  if (column.type === "text") return text;
  if (column.type === "boolean" && column.required) return sql`coalesce((${text})::boolean, false)`;
  return sql`(${text})::${sql.raw(column.type)}`;
}

function insertColumns(entity: string, fields: readonly string[]): RawBuilder<unknown> {
  return sql.join(fields.map((field) => sql.ref(entityColumnName(entity, field))));
}

function insertValues(entity: string, input: string, fields: readonly string[]): RawBuilder<unknown> {
  return sql.join(fields.map((field) => jsonInputExpression(entity, input, field)));
}

function fieldKeyList(fields: readonly string[]): RawBuilder<unknown> {
  return sql.join(fields.map((field) => sql.lit(field)));
}

export async function applyDocumentAuthority(db: OpenShapeForgeDatabase): Promise<void> {
  // The generated schema binds current_version_id to a version of the same
  // tenant; this widens the same-named key so the version is also one of
  // THIS document's. The helper drops the generated two-column constraint
  // when it finds it and is a no-op once the three-column one is in place,
  // and the generated DO block sees the name and leaves it alone on every
  // later apply.
  await ensureForeignKey(db, {
    table: DOCUMENTS_TABLE,
    name: "documents_current_version_id_fkey",
    columns: ["tenant_id", "id", documentColumn.currentVersionId],
    references: { table: DOCUMENT_VERSIONS_TABLE, columns: ["tenant_id", documentVersionColumn.documentId, "id"] },
  });
  // A Document's code is a managed DocumentType of the same tenant. The
  // package seed (packages/documents/src/document-types.seed.yaml) is what
  // gives a tenant its initial catalog; the host applies it when a tenant is
  // created, before the first Document.
  await ensureForeignKey(db, {
    table: DOCUMENTS_TABLE,
    name: "documents_document_type_fkey",
    columns: ["tenant_id", documentColumn.documentType],
    references: { table: entityTableName("DocumentType"), columns: ["tenant_id", entityColumnName("DocumentType", "code")] },
    onUpdate: "restrict",
    onDelete: "restrict",
  });

  const version = documentVersionColumn;
  const document = documentColumn;
  await sql`
    create or replace function app.publishing_entity() returns text
    language sql stable
    as $$ select nullif(current_setting('app.publishing_entity', true), '') $$;

    -- The generic snapshot publish (packages/versioning) is the second write
    -- path beside the document commands: it inserts the frozen content under
    -- the transaction-local marker app.publishing_entity = 'Document' and
    -- supplies no label. Snapshot labels live in a reserved namespace,
    -- snapshot-<version number>, that an upload may never use, so the
    -- per-document label uniqueness never collides between the two kinds.
    create or replace function app.reject_direct_document_version_write()
    returns trigger
    language plpgsql
    set search_path = pg_catalog, pg_temp
    as $function$
    begin
      -- DELETE has OLD only: branch before every NEW reference. The app role
      -- remains unable to delete immutable versions directly, while the table
      -- owner can perform system cleanup and cascades without dereferencing an
      -- unassigned trigger record.
      if tg_op = 'DELETE' then
        if current_user = ${sql.lit(APP_ROLE)} then
          raise exception 'DocumentVersion is immutable and may only be created through a document version command';
        end if;
        return old;
      end if;
      if tg_op = 'INSERT' and app.publishing_entity() = 'Document'
        and new.${sql.ref(version.versionNumber)} is not null and new.${sql.ref(version.snapshot)} is not null and new.${sql.ref(version.contentHash)} is not null then
        new.${sql.ref(version.versionLabel)} := coalesce(new.${sql.ref(version.versionLabel)}, 'snapshot-' || new.${sql.ref(version.versionNumber)}::text);
        new.${sql.ref(version.createdBy)} := coalesce(new.${sql.ref(version.createdBy)}, new.${sql.ref(version.publishedBy)}::text);
        return new;
      end if;
      if new.${sql.ref(version.versionLabel)} like 'snapshot-%' and (tg_op = 'INSERT' or new.${sql.ref(version.versionLabel)} is distinct from old.${sql.ref(version.versionLabel)}) then
        raise exception 'VALIDATION: The version label prefix snapshot- is reserved for published document snapshots.';
      end if;
      if current_user = ${sql.lit(APP_ROLE)} then
        raise exception 'DocumentVersion is immutable and may only be created through a document version command';
      end if;
      return new;
    end;
    $function$;

    drop trigger if exists document_versions_write_guard on ${documentVersions};
    create trigger document_versions_write_guard
      before insert or update or delete on ${documentVersions}
      for each row execute function app.reject_direct_document_version_write();

    create or replace function app.enforce_document_authority()
    returns trigger
    language plpgsql
    set search_path = pg_catalog, pg_temp
    as $function$
    begin
      if tg_op = 'INSERT' and current_user = ${sql.lit(APP_ROLE)} then
        raise exception 'Document must be created atomically with its first version through a document command';
      end if;
      if tg_op = 'UPDATE'
        and current_user = ${sql.lit(APP_ROLE)}
        and new.${sql.ref(document.currentVersionId)} is distinct from old.${sql.ref(document.currentVersionId)} then
        raise exception 'Document.currentVersionId is server-managed and may only change through a document version command';
      end if;
      if new.${sql.ref(document.caseFileId)} is not null and not exists (
        select 1 from ${sql.table(entityTableName("CaseFile"))} target
        where target.id = new.${sql.ref(document.caseFileId)} and target.tenant_id = new.tenant_id
      ) then
        raise exception 'Document.caseFileId must reference the same tenant' using errcode = '23503';
      end if;
      if new.${sql.ref(document.caseId)} is not null and not exists (
        select 1 from ${sql.table(entityTableName("Case"))} target
        where target.id = new.${sql.ref(document.caseId)} and target.tenant_id = new.tenant_id
      ) then
        raise exception 'Document.caseId must reference the same tenant' using errcode = '23503';
      end if;
      if new.${sql.ref(document.relationId)} is not null and not exists (
        select 1 from ${sql.table(entityTableName("Relation"))} target
        where target.id = new.${sql.ref(document.relationId)} and target.tenant_id = new.tenant_id
      ) then
        raise exception 'Document.relationId must reference the same tenant' using errcode = '23503';
      end if;
      return new;
    end;
    $function$;

    drop trigger if exists documents_authority_guard on ${documents};
    create trigger documents_authority_guard
      before insert or update on ${documents}
      for each row execute function app.enforce_document_authority();

    create or replace function app.enforce_document_version_tenant_references()
    returns trigger
    language plpgsql
    set search_path = pg_catalog, pg_temp
    as $function$
    begin
      if new.${sql.ref(version.accountId)} is not null and not exists (
        select 1 from ${sql.table(entityTableName("Relation"))} target
        where target.id = new.${sql.ref(version.accountId)} and target.tenant_id = new.tenant_id
      ) then
        raise exception 'DocumentVersion.accountId must reference the same tenant' using errcode = '23503';
      end if;
      return new;
    end;
    $function$;

    drop trigger if exists document_versions_tenant_reference_guard on ${documentVersions};
    create trigger document_versions_tenant_reference_guard
      before insert or update on ${documentVersions}
      for each row execute function app.enforce_document_version_tenant_references();
  `.execute(db);
}

export async function applyDocumentCommands(db: OpenShapeForgeDatabase): Promise<void> {
  const version = documentVersionColumn;
  const document = documentColumn;
  // The version insert, shared by both commands; only the document id differs.
  const versionInsert = (documentId: RawBuilder<unknown>) => sql`
      insert into ${documentVersions} (
        id, tenant_id, ${insertColumns("DocumentVersion", DOCUMENT_VERSION_INPUT_FIELDS)},
        ${sql.ref(version.createdBy)}, ${sql.ref(version.documentId)}
      ) values (
        new_version_id, tenant, ${insertValues("DocumentVersion", "version_input", DOCUMENT_VERSION_INPUT_FIELDS)},
        actor::text, ${documentId}
      );`;
  // The storage-managed and the accepted version keys, checked in that order.
  const versionInputGuards = sql`
      select key into invalid_key
      from jsonb_object_keys(version_input) key
      where key = any(array[${fieldKeyList(DOCUMENT_VERSION_STORAGE_FIELDS)}])
      limit 1;
      if invalid_key is not null then
        raise exception 'DocumentVersion binary field % is storage-managed', invalid_key;
      end if;

      select key into invalid_key
      from jsonb_object_keys(version_input) key
      where key <> all(array[${fieldKeyList(DOCUMENT_VERSION_INPUT_FIELDS)}])
      limit 1;
      if invalid_key is not null then
        raise exception 'Unknown DocumentVersion input field: %', invalid_key;
      end if;`;

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

      -- The logical Document key set. The Operation JSON Schema remains
      -- responsible for types, required fields, authored limits and statuses.
      select key into invalid_key
      from jsonb_object_keys(document_input) key
      where key <> all(array[${fieldKeyList(DOCUMENT_INPUT_FIELDS)}])
      limit 1;
      if invalid_key is not null then
        raise exception 'Unknown Document input field: %', invalid_key;
      end if;
      ${versionInputGuards}

      insert into ${documents} (
        id, tenant_id, ${insertColumns("Document", DOCUMENT_INPUT_FIELDS)}
      ) values (
        new_document_id, tenant, ${insertValues("Document", "document_input", DOCUMENT_INPUT_FIELDS)}
      );
      ${versionInsert(sql`new_document_id`)}

      update ${documents}
      set ${sql.ref(document.currentVersionId)} = new_version_id, updated_at = now()
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
      ${versionInputGuards}

      perform 1
      from ${documents}
      where id = target_document_id and tenant_id = tenant
      for update;
      if not found then
        raise exception 'Document not found';
      end if;
      ${versionInsert(sql`target_document_id`)}

      update ${documents}
      set ${sql.ref(document.currentVersionId)} = new_version_id, updated_at = now()
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
}
