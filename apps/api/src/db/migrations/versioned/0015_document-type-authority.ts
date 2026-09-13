// SPDX-License-Identifier: BUSL-1.1
import { type Kysely, sql } from "kysely";
import type { VersionedMigration } from "../versioned-runner.js";

/**
 * Make the managed DocumentType catalog authoritative for Document codes.
 *
 * Versioned migrations run before generated DDL, so the table is created in
 * its exact generated shape for fresh installs. Existing tenants with any
 * Documents receive the nine historical base records before the composite FK
 * is installed. This frozen upgrade snapshot is deliberately independent of
 * the mutable package seed asset: changing future initial-catalog labels can
 * never change the checksum or effects of an already-applied migration.
 */
const migration: VersionedMigration = {
  version: "0015_document-type-authority",
  fileUrl: import.meta.url,
  async up(db: Kysely<any>): Promise<void> {
    await sql`
      create schema if not exists erp;

      create table if not exists erp.document_types (
        id uuid primary key not null default gen_random_uuid(),
        tenant_id uuid not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        external_id text,
        source_authority text,
        source_organization text,
        source_administration text,
        code text not null,
        name text not null,
        description text,
        default_confidentiality text,
        requires_registration boolean not null default true,
        allows_external_publication boolean not null default false
      );
    `.execute(db);

    await sql`
      do $document_type_preflight$
      begin
        if exists (
          select 1
          from erp.document_types
          group by tenant_id, code
          having count(*) > 1
        ) then
          raise exception 'DocumentType authority migration refused: duplicate tenant/code rows exist';
        end if;
      end
      $document_type_preflight$;

      create unique index if not exists document_types_tenant_code_uidx
        on erp.document_types (tenant_id, code);

      insert into erp.document_types (
        tenant_id,
        code,
        name,
        description,
        default_confidentiality,
        requires_registration,
        allows_external_publication
      )
      select
        tenants.tenant_id,
        seed.code,
        seed.name,
        null,
        null,
        true,
        false
      from (select distinct tenant_id from erp.documents) tenants
      cross join (values
        ('incoming_mail', 'Incoming mail'),
        ('outgoing_mail', 'Outgoing mail'),
        ('note', 'Note'),
        ('decision', 'Decision'),
        ('attachment', 'Attachment'),
        ('form', 'Form'),
        ('evidence', 'Evidence'),
        ('contract', 'Contract'),
        ('report', 'Report')
      ) as seed(code, name)
      on conflict (tenant_id, code) do nothing;

      do $document_type_reference_preflight$
      begin
        if exists (
          select 1
          from erp.documents document
          where not exists (
            select 1
            from erp.document_types document_type
            where document_type.tenant_id = document.tenant_id
              and document_type.code = document.document_type
          )
        ) then
          raise exception 'DocumentType authority migration refused: an existing Document code has no managed DocumentType in the same tenant';
        end if;
      end
      $document_type_reference_preflight$;

      create unique index if not exists document_types_tenant_identity_uidx
        on erp.document_types (tenant_id, id);

      alter table erp.documents
        drop constraint if exists documents_document_type_fkey,
        add constraint documents_document_type_fkey
          foreign key (tenant_id, document_type)
          references erp.document_types (tenant_id, code)
          on update restrict
          on delete restrict;
    `.execute(db);
  },
};

export default migration;
