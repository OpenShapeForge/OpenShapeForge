// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../connection.js";
import { APP_ROLE } from "./app-role.js";
import { ensureCheckConstraint, ensureForeignKey } from "./sql-invariants.js";
import { WORKER_ROLE } from "./worker-role.js";

/**
 * The core's own database invariants on manifest tables: functions,
 * triggers, compound foreign keys and partial indexes the manifest cannot
 * express. Applied after the generated step on every migrate, idempotently —
 * `create or replace`, `if not exists`, and a pg_constraint guard for each
 * constraint — with no ledger and no version. A database is built from the
 * manifest plus this file; there is no history to replay.
 *
 * Four blocks, each guarding one authored entity's contract:
 *
 *   1. ORG-UNIT CLOSURE. platform.org_unit_closure is the transitive closure
 *      of platform.org_unit that group-predicated RLS resolves a session's
 *      groups through. The trigger keeps it exact on every insert, reparent
 *      and delete, refuses a parent from another tenant (the self-referential
 *      FK cannot carry a tenant qualifier, so a foreign-tenant parent would
 *      otherwise become a silent phantom root) and refuses a reparent into
 *      the node's own subtree (a cycle would otherwise surface as an opaque
 *      unique-key violation). SECURITY DEFINER so the closure DML is not
 *      blocked by RLS on the closure table; tenant_id always comes from
 *      NEW/OLD, never from the session.
 *
 *   2. DOCUMENT AUTHORITY. Document is the stable container and
 *      DocumentVersion the sole artifact truth. The two references between
 *      them are tenant-qualified compound keys, replacing the single-column
 *      references the generated schema emits under the same names; a
 *      Document's type is a managed DocumentType of the same tenant; and the
 *      runtime role cannot write a DocumentVersion directly, create a
 *      Document without its first version, or move the current-version
 *      pointer — a trigger denies it even if a later broad grant restores
 *      the DML privilege.
 *
 *   3. LOGICAL DOCUMENT COMMANDS. document_internal.create_with_first_version
 *      and append_version are the only write path, SECURITY DEFINER, taking
 *      tenant and actor from the authenticated session. They are not an
 *      HTTP authorization boundary and deliberately do not repeat authored
 *      roles, statuses or field limits: the canonical Operation runtime has
 *      already authenticated, authorized and schema-validated the request.
 *      The separate schema is load-bearing — the worker role receives broad
 *      EXECUTE on app.*, so document_internal is granted to the API's
 *      restricted role only. Binary artifact metadata is storage-owned and
 *      cannot enter through either command.
 *
 *   4. ARTIFACT BINDING. The artifact id and expected version are only a
 *      provisional association in the creating transaction; a deferred
 *      constraint trigger makes that transaction uncommittable until the
 *      trusted descriptor returned by artifact storage has finalized the
 *      row. Provider object keys never enter the Document schema.
 */
export async function applyCoreInvariants(db: OpenShapeForgeDatabase): Promise<void> {
  await applyOrgUnitClosure(db);
  await applyDocumentAuthority(db);
  await applyDocumentCommands(db);
  await applyArtifactBinding(db);
}

async function applyOrgUnitClosure(db: OpenShapeForgeDatabase): Promise<void> {
  // INSERT: self-row (NEW.id, NEW.id, 0) + copy parent's ancestor paths +1.
  // UPDATE of parent_id: standard closure reparent — delete edges that link
  //   the moved subtree to its OLD ancestors (crossing the moved node), then
  //   reinsert the cross-product of the NEW parent's ancestor paths × the
  //   moved subtree. Assert the tenant never changes.
  // DELETE: remove every closure edge that touches the deleted node. The
  //   parent_id FK (ON DELETE RESTRICT) blocks deleting a unit that still has
  //   children, so a deleted node is always a leaf w.r.t. org_unit rows.
  await sql`
    create or replace function platform.org_unit_closure_maintain()
    returns trigger
    language plpgsql
    security definer
    set search_path = platform, pg_temp
    as $fn$
    begin
      if tg_op = 'INSERT' then
        -- A non-null parent must reference a same-tenant org_unit. Its
        -- closure self-row (parent_id, parent_id, 0) exists iff such a row
        -- exists in this tenant; its absence means the FK was satisfied by a
        -- foreign-tenant (or otherwise unreachable) id. Fail loudly rather
        -- than silently writing a phantom root.
        if new.parent_id is not null and not exists (
          select 1 from platform.org_unit_closure c
          where c.tenant_id = new.tenant_id
            and c.ancestor_id = new.parent_id
            and c.descendant_id = new.parent_id
            and c.depth = 0
        ) then
          raise exception
            'org_unit.parent_id % is not a valid parent in tenant % (cross-tenant or nonexistent parent)',
            new.parent_id, new.tenant_id;
        end if;
        -- Self-row at depth 0.
        insert into platform.org_unit_closure (tenant_id, ancestor_id, descendant_id, depth)
        values (new.tenant_id, new.id, new.id, 0);
        -- Inherit the parent's ancestors, one level deeper.
        if new.parent_id is not null then
          insert into platform.org_unit_closure (tenant_id, ancestor_id, descendant_id, depth)
          select c.tenant_id, c.ancestor_id, new.id, c.depth + 1
          from platform.org_unit_closure c
          where c.tenant_id = new.tenant_id
            and c.descendant_id = new.parent_id;
        end if;
        return new;

      elsif tg_op = 'UPDATE' then
        if new.tenant_id <> old.tenant_id then
          raise exception 'org_unit.tenant_id is immutable (% -> %)', old.tenant_id, new.tenant_id;
        end if;
        if new.parent_id is distinct from old.parent_id then
          -- Same same-tenant-parent guard as on INSERT: a reparent onto a
          -- cross-tenant or nonexistent parent must abort, not silently
          -- detach the subtree into a phantom root.
          if new.parent_id is not null and not exists (
            select 1 from platform.org_unit_closure c
            where c.tenant_id = new.tenant_id
              and c.ancestor_id = new.parent_id
              and c.descendant_id = new.parent_id
              and c.depth = 0
          ) then
            raise exception
              'org_unit.parent_id % is not a valid parent in tenant % (cross-tenant or nonexistent parent)',
              new.parent_id, new.tenant_id;
          end if;
          -- Reparent cycle guard: the new parent must not lie within the
          -- moved subtree. If new.parent_id is a descendant of new.id, the
          -- move would make the node its own ancestor. Fail loudly rather
          -- than aborting later with an opaque unique-constraint violation.
          if new.parent_id is not null and exists (
            select 1 from platform.org_unit_closure c
            where c.tenant_id = new.tenant_id
              and c.ancestor_id = new.id
              and c.descendant_id = new.parent_id
          ) then
            raise exception
              'org_unit reparent would create a cycle: parent % is within the subtree of %',
              new.parent_id, new.id;
          end if;
          -- The subtree rooted at the moved node (its self + all descendants).
          -- Delete edges linking that subtree to any ancestor OUTSIDE the
          -- subtree (i.e. the old cross-boundary paths).
          delete from platform.org_unit_closure
          where tenant_id = new.tenant_id
            and descendant_id in (
              select descendant_id from platform.org_unit_closure
              where tenant_id = new.tenant_id and ancestor_id = new.id
            )
            and ancestor_id not in (
              select descendant_id from platform.org_unit_closure
              where tenant_id = new.tenant_id and ancestor_id = new.id
            );
          -- Reinsert the cross-product: NEW parent's ancestor paths ×
          -- the moved subtree, summing depths across the new join point.
          if new.parent_id is not null then
            insert into platform.org_unit_closure (tenant_id, ancestor_id, descendant_id, depth)
            select super.tenant_id, super.ancestor_id, sub.descendant_id, super.depth + sub.depth + 1
            from platform.org_unit_closure super
            cross join platform.org_unit_closure sub
            where super.tenant_id = new.tenant_id
              and super.descendant_id = new.parent_id
              and sub.tenant_id = new.tenant_id
              and sub.ancestor_id = new.id;
          end if;
        end if;
        return new;

      elsif tg_op = 'DELETE' then
        -- Tear down every edge that references the deleted node. The FK
        -- RESTRICT guarantees it has no child org_unit rows.
        delete from platform.org_unit_closure
        where tenant_id = old.tenant_id
          and (ancestor_id = old.id or descendant_id = old.id);
        return old;
      end if;
      return null;
    end;
    $fn$;

    -- Row-level, after the write so NEW.id exists.
    drop trigger if exists org_unit_closure_maintain_trg on platform.org_unit;
    create trigger org_unit_closure_maintain_trg
      after insert or update or delete on platform.org_unit
      for each row execute function platform.org_unit_closure_maintain();
  `.execute(db);
}

async function applyDocumentAuthority(db: OpenShapeForgeDatabase): Promise<void> {
  // The generated schema references these two under the same names with a
  // single column each; the tenant-qualified key is what makes a version's
  // tenant and its document's tenant provably one. The helper drops the
  // single-column constraint when it finds it and is a no-op once the
  // compound one is in place, and the generated DO block sees the name and
  // leaves it alone on every later apply.
  await ensureForeignKey(db, {
    table: "erp.document_versions",
    name: "document_versions_document_id_fkey",
    columns: ["tenant_id", "document_id"],
    references: { table: "erp.documents", columns: ["tenant_id", "id"] },
  });
  await ensureForeignKey(db, {
    table: "erp.documents",
    name: "documents_current_version_id_fkey",
    columns: ["tenant_id", "id", "current_version_id"],
    references: { table: "erp.document_versions", columns: ["tenant_id", "document_id", "id"] },
  });
  // A Document's code is a managed DocumentType of the same tenant. The
  // package seed (packages/documents/src/document-types.seed.yaml) is what
  // gives a tenant its initial catalog; the host applies it when a tenant is
  // created, before the first Document.
  await ensureForeignKey(db, {
    table: "erp.documents",
    name: "documents_document_type_fkey",
    columns: ["tenant_id", "document_type"],
    references: { table: "erp.document_types", columns: ["tenant_id", "code"] },
    onUpdate: "restrict",
    onDelete: "restrict",
  });

  await sql`
    create or replace function app.publishing_entity() returns text
    language sql stable
    as $$ select nullif(current_setting('app.publishing_entity', true), '') $$;

    -- The generic snapshot publish (packages/versioning) is the second write
    -- path beside the document commands: it inserts the frozen content under
    -- the transaction-local marker app.publishing_entity = 'Document' and
    -- supplies no label, so the version number doubles as the label.
    create or replace function app.reject_direct_document_version_write()
    returns trigger
    language plpgsql
    set search_path = pg_catalog, pg_temp
    as $function$
    begin
      if tg_op = 'INSERT' and app.publishing_entity() = 'Document' and new.version_number is not null then
        new.version_label := coalesce(new.version_label, 'v' || new.version_number::text);
        new.created_by := coalesce(new.created_by, new.published_by::text);
        return new;
      end if;
      if current_user = ${sql.lit(APP_ROLE)} then
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
      if tg_op = 'INSERT' and current_user = ${sql.lit(APP_ROLE)} then
        raise exception 'Document must be created atomically with its first version through a document command';
      end if;
      if tg_op = 'UPDATE'
        and current_user = ${sql.lit(APP_ROLE)}
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
}

async function applyDocumentCommands(db: OpenShapeForgeDatabase): Promise<void> {
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
}

async function applyArtifactBinding(db: OpenShapeForgeDatabase): Promise<void> {
  await sql`
    create unique index if not exists document_versions_tenant_artifact_uidx
      on erp.document_versions (tenant_id, artifact_id)
      where artifact_id is not null;
  `.execute(db);
  await ensureCheckConstraint(db, {
    table: "erp.document_versions",
    name: "document_versions_artifact_version_check",
    expression: "artifact_version is null or artifact_version between 1 and 9007199254740991",
  });
  await ensureCheckConstraint(db, {
    table: "erp.document_versions",
    name: "document_versions_byte_size_check",
    expression: "byte_size is null or byte_size between 0 and 9007199254740991",
  });

  await sql`
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
}
