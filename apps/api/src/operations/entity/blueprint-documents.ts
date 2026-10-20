// SPDX-License-Identifier: BUSL-1.1
import { copyPortableDocuments, type PortableDocument } from "./portable-document-copy.js";
import { sql } from "kysely";
import { operationFailure } from "@openshapeforge/operations";
import { withDbSession, type DbSessionInput } from "../../db/session.js";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import { withBlueprintDocumentServices } from "../../modules/platform.js";
import type { GeneratedCrudTable } from "./types.js";


export async function snapshotBlueprintDocuments(db: OpenShapeForgeDatabase, session: DbSessionInput, table: GeneratedCrudTable, values: Record<string, unknown>) {
 const snapshots: Record<string, PortableDocument> = {};
 const columns = table.columns.filter(column => column.document && table.source?.blueprint?.fields.includes(column.sourceField!));
 if (!columns.length) return snapshots;
 return withBlueprintDocumentServices(db, session, async (services, live) => {
  const operations=await services.operations.list(live);
  const documentRead=operations.find(operation=>operation.entityName==="Document" && operation.intent==="get");
  const blockRead=operations.find(operation=>operation.entityName==="Block" && operation.intent==="get");
  if(!documentRead)throw operationFailure({code:"FORBIDDEN",message:"Blueprint document content is unavailable.",retryable:false});
  for (const column of columns) {
   const field = column.sourceField!, id = values[field];
   if (id == null) continue;
   await services.records.assertAccess(live, {entityName:"Document", id:String(id), intent:"get"});
   snapshots[field] = await withDbSession(db, session, async trx => {
    const result = await sql<{ artifactId: string | null }>`select v.artifact_id as "artifactId"
      from erp.documents d left join erp.document_versions v on v.id=d.current_version_id and v.tenant_id=d.tenant_id where d.id=${String(id)}::uuid and d.tenant_id=${session.tenantId}::uuid for share of d`.execute(trx);
    const head = result.rows[0]; if (!head) throw new Error("Blueprint document is unavailable.");
    const authorized=await services.operations.execute(live,{operation:documentRead,input:{id:String(id)}});
    if("error" in authorized)throw operationFailure(authorized.error);
    const source=authorized.data as Record<string,unknown>;
    if(!source || ["title","documentType","status"].some(field=>typeof source[field]!=="string"))throw operationFailure({code:"FORBIDDEN",message:"Blueprint document metadata is unavailable.",retryable:false});
    const metadata=Object.fromEntries(["title","description","documentType","status","confidentiality"].filter(field=>source[field]!=null).map(field=>[field,source[field]]));
    const variants = await sql<{id:string;channel:string;locale:string}>`select id,channel,locale from erp.document_variants where document_id=${String(id)}::uuid and tenant_id=${session.tenantId}::uuid order by channel,locale limit 101`.execute(trx);
    if (variants.rows.length>100) throw new Error("Too many blueprint document variants.");
    const content: PortableDocument = {document:{...metadata,isExternal:false},variants:[]};
    for (const variant of variants.rows) {
     const blocks = await sql<{id:string}>`select id::text from erp.blocks where document_variant_id=${variant.id}::uuid and tenant_id=${session.tenantId}::uuid order by document_variant_id_position,id limit 1001`.execute(trx);
     if (blocks.rows.length>1000) throw new Error("Too many blueprint document blocks.");
     if(blocks.rows.length && !blockRead)throw operationFailure({code:"FORBIDDEN",message:"Blueprint blocks are unavailable.",retryable:false});
     const visibleBlocks:PortableDocument["variants"][number]["blocks"]=[];
     for(const block of blocks.rows){
      const authorized=await services.operations.execute(live,{operation:blockRead!,input:{id:block.id}});
      if("error" in authorized)throw operationFailure(authorized.error);
      const value=authorized.data as Record<string,unknown>;
      if(!value || typeof value.definitionKey!=="string" || !value.values || typeof value.values!=="object" || Array.isArray(value.values))throw operationFailure({code:"FORBIDDEN",message:"Blueprint block content is unavailable.",retryable:false});
      visibleBlocks.push({definitionKey:value.definitionKey,values:value.values as Record<string,unknown>});
     }
     content.variants.push({channel:variant.channel,locale:variant.locale,blocks:visibleBlocks});
    }
    if (head.artifactId) {
     const file = await services.artifacts.read(live,{artifactId:head.artifactId,owner:{entity:"Document",id:String(id)}});
     if(file.bytes.byteLength>20*1024*1024) throw new Error("Blueprint files are limited to 20 MiB.");
     content.file={name:file.descriptor.fileName,base64:Buffer.from(file.bytes).toString("base64")};
    }
    return content;
   });
  }
  return snapshots;
 });
}
export async function copyBlueprintDocuments(db: OpenShapeForgeDatabase, session: DbSessionInput, snapshots: Record<string,PortableDocument>, overlay: Record<string,unknown>) {
 if(!Object.keys(snapshots).some(field=>!Object.hasOwn(overlay,field))) return {};
 return withBlueprintDocumentServices(db,session,(services,live)=>copyPortableDocuments(services,live,snapshots,overlay));
}
