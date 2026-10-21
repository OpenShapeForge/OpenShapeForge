// SPDX-License-Identifier: BUSL-1.1
import { createHash } from "node:crypto";
import type { PlatformSchemaManifest } from "./schema.js";
const id = (value: string) => '"' + value.replaceAll('"', '""') + '"';
const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
/** Preserve a Document field's policy when its target is edited through another interface. */
export function documentFieldInvariants(manifest: PlatformSchemaManifest): string | undefined {
  const statements: string[] = [];
  for (const table of manifest.tables) for (const column of table.columns) {
    const policy = column.document;
    if (!policy) continue;
    const suffix = createHash("sha256").update(`${table.schema}.${table.name}.${column.name}`).digest("hex").slice(0, 16);
    const check = `app.${id(`document_policy_${suffix}`)}`;
    const trigger = `app.${id(`document_guard_${suffix}`)}`;
    const name = id(`document_policy_${suffix}`);
    const owner = `${id(table.schema)}.${id(table.name)}`;
    const col = id(column.name);
    const conditions = ["d.id is null"];
    if (policy.documentType) conditions.push(`d.document_type <> ${literal(policy.documentType)}`);
    if (policy.content === "blocks") conditions.push("v.artifact_id is not null");
    else {
      conditions.push("v.artifact_id is null", "exists(select 1 from erp.document_variants dv join erp.blocks b on b.document_variant_id=dv.id and b.tenant_id=dv.tenant_id where dv.document_id=d.id and dv.tenant_id=d.tenant_id)");
      if (policy.mimeTypes) conditions.push(`v.mime_type is null or v.mime_type not in (${policy.mimeTypes.map(literal).join(",")})`);
      if (policy.maxBytes) conditions.push(`v.byte_size is null or v.byte_size > ${policy.maxBytes}`);
    }
    statements.push(`
create or replace function ${check}(policy_document_id uuid, policy_tenant_id uuid) returns void language plpgsql as $policy$
begin
 if policy_document_id is null then return; end if;
 perform 1 from erp.documents d where d.id=policy_document_id and d.tenant_id=policy_tenant_id for update;
 if not exists(select 1 from erp.documents d left join erp.document_versions v on v.id=d.current_version_id and v.tenant_id=d.tenant_id
   where d.id=policy_document_id and d.tenant_id=policy_tenant_id and not (${conditions.join(" or ")})) then
   raise exception 'Document does not satisfy the field content policy' using errcode='23514';
 end if;
end $policy$;
create or replace function ${trigger}() returns trigger language plpgsql as $guard$
declare policy_doc uuid;
begin
 if TG_ARGV[0]='owner' then perform ${check}(NEW.${col},NEW.tenant_id);
 elsif TG_ARGV[0]='document' then
  if exists(select 1 from ${owner} r where r.${col}=NEW.id and r.tenant_id=NEW.tenant_id) then perform ${check}(NEW.id,NEW.tenant_id); end if;
 elsif TG_ARGV[0]='block' then
  select document_id into policy_doc from erp.document_variants where id=NEW.document_variant_id and tenant_id=NEW.tenant_id;
  if exists(select 1 from ${owner} r where r.${col}=policy_doc and r.tenant_id=NEW.tenant_id) then perform ${check}(policy_doc,NEW.tenant_id); end if;
 else
  if exists(select 1 from ${owner} r where r.${col}=NEW.document_id and r.tenant_id=NEW.tenant_id) then perform ${check}(NEW.document_id,NEW.tenant_id); end if;
 end if;
 return NEW;
end $guard$;
drop trigger if exists ${name} on ${owner};
create trigger ${name} after insert or update of ${col} on ${owner} for each row execute function ${trigger}('owner');
drop trigger if exists ${name} on erp.documents;
create trigger ${name} after update of current_version_id,document_type on erp.documents for each row execute function ${trigger}('document');
drop trigger if exists ${name} on erp.document_variants;
create trigger ${name} after insert or update of document_id on erp.document_variants for each row execute function ${trigger}('variant');
drop trigger if exists ${name} on erp.blocks;
create trigger ${name} after insert or update of document_variant_id on erp.blocks for each row execute function ${trigger}('block');
`);
  }
  for (const table of manifest.tables) for (const value of table.columns) {
    const binding = value.typedBy;
    if (!binding?.documentColumn) continue;
    const suffix=createHash("sha256").update(`${table.schema}.${table.name}.${value.name}:typed`).digest("hex").slice(0,16);
    const owner=`${id(table.schema)}.${id(table.name)}`, col=id(binding.documentColumn), def=id(binding.definitionColumn);
    const fn=`app.${id(`typed_document_${suffix}`)}`, guard=`app.${id(`typed_document_guard_${suffix}`)}`, name=id(`typed_document_${suffix}`);
    statements.push(`
create or replace function ${fn}(doc uuid, tenant uuid, definition jsonb) returns void language plpgsql as $policy$
declare p jsonb := definition->'document';
begin
 if doc is null then return; end if;
 if definition->>'osfType' is distinct from 'Document' or p->>'content' not in ('file','blocks') then raise exception 'Invalid Document field definition' using errcode='23514'; end if;
 perform 1 from erp.documents where id=doc and tenant_id=tenant for update;
 if not exists(select 1 from erp.documents d left join erp.document_versions v on v.id=d.current_version_id and v.tenant_id=d.tenant_id
 where d.id=doc and d.tenant_id=tenant
 and (p->>'documentType' is null or d.document_type=p->>'documentType')
 and case when p->>'content'='blocks' then v.artifact_id is null
 else v.artifact_id is not null
 and not exists(select 1 from erp.document_variants dv join erp.blocks b on b.document_variant_id=dv.id and b.tenant_id=dv.tenant_id where dv.document_id=d.id and dv.tenant_id=d.tenant_id)
 and (p->'mimeTypes' is null or (p->'mimeTypes') ? v.mime_type)
 and (p->>'maxBytes' is null or v.byte_size <= (p->>'maxBytes')::bigint) end) then
 raise exception 'Document does not satisfy the field content policy' using errcode='23514'; end if;
end $policy$;
create or replace function ${guard}() returns trigger language plpgsql as $guard$
declare r record; policy_doc uuid;
begin
 if TG_ARGV[0]='owner' then perform ${fn}(NEW.${col},NEW.tenant_id,NEW.${def});
 elsif TG_ARGV[0]='document' then
  for r in select * from ${owner} where ${col}=NEW.id and tenant_id=NEW.tenant_id loop perform ${fn}(NEW.id,NEW.tenant_id,r.${def}); end loop;
 elsif TG_ARGV[0]='block' then
  select document_id into policy_doc from erp.document_variants where id=NEW.document_variant_id and tenant_id=NEW.tenant_id;
  for r in select * from ${owner} where ${col}=policy_doc and tenant_id=NEW.tenant_id loop perform ${fn}(policy_doc,NEW.tenant_id,r.${def}); end loop;
 else
  for r in select * from ${owner} where ${col}=NEW.document_id and tenant_id=NEW.tenant_id loop perform ${fn}(NEW.document_id,NEW.tenant_id,r.${def}); end loop;
 end if; return NEW;
end $guard$;
drop trigger if exists ${name} on ${owner};
create trigger ${name} after insert or update of ${col},${def} on ${owner} for each row execute function ${guard}('owner');
drop trigger if exists ${name} on erp.documents;
create trigger ${name} after update of current_version_id,document_type on erp.documents for each row execute function ${guard}('document');
drop trigger if exists ${name} on erp.document_variants;
create trigger ${name} after insert or update of document_id on erp.document_variants for each row execute function ${guard}('variant');
drop trigger if exists ${name} on erp.blocks;
create trigger ${name} after insert or update of document_variant_id on erp.blocks for each row execute function ${guard}('block');
`);
  }
  return statements.length ? statements.join("\n") : undefined;
}
