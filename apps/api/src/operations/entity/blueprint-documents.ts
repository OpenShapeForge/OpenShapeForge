// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import { operationFailure } from "@openshapeforge/operations";
import { withDbSession, type DbSessionInput } from "../../db/session.js";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import { withBlueprintDocumentServices } from "../../modules/platform.js";
import type { GeneratedCrudTable } from "./types.js";

type PortableDocument = { document: Record<string, unknown>; file?: { name: string; base64: string }; variants: { channel: string; locale: string; blocks: { definitionKey: string; values: Record<string, unknown> }[] }[] };
export async function snapshotBlueprintDocuments(db: OpenShapeForgeDatabase, session: DbSessionInput, table: GeneratedCrudTable, values: Record<string, unknown>) {
 const snapshots: Record<string, PortableDocument> = {};
 const columns = table.columns.filter(column => column.document && table.source?.blueprint?.fields.includes(column.sourceField!));
 if (!columns.length) return snapshots;
 return withBlueprintDocumentServices(db, session, async (services, live) => {
  for (const column of columns) {
   const field = column.sourceField!, id = values[field];
   if (id == null) continue;
   await services.records.assertAccess(live, {entityName:"Document", id:String(id), intent:"get"});
   snapshots[field] = await withDbSession(db, session, async trx => {
    const result = await sql<{ document: Record<string,unknown>; artifactId: string | null }>`select jsonb_build_object('title',d.title,'description',d.description,'documentType',d.document_type,'status',d.status,'isExternal',false) as document, v.artifact_id as "artifactId"
      from erp.documents d left join erp.document_versions v on v.id=d.current_version_id and v.tenant_id=d.tenant_id where d.id=${String(id)}::uuid and d.tenant_id=${session.tenantId}::uuid for share of d`.execute(trx);
    const head = result.rows[0]; if (!head) throw new Error("Blueprint document is unavailable.");
    const variants = await sql<{id:string;channel:string;locale:string}>`select id,channel,locale from erp.document_variants where document_id=${String(id)}::uuid and tenant_id=${session.tenantId}::uuid order by channel,locale limit 101`.execute(trx);
    if (variants.rows.length>100) throw new Error("Too many blueprint document variants.");
    const content: PortableDocument = {document:Object.fromEntries(Object.entries(head.document).filter(([,value])=>value!=null)),variants:[]};
    for (const variant of variants.rows) {
     const blocks = await sql<{definitionKey:string;values:Record<string,unknown>}>`select definition_key as "definitionKey",values from erp.blocks where document_variant_id=${variant.id}::uuid and tenant_id=${session.tenantId}::uuid order by document_variant_id_position,id limit 1001`.execute(trx);
     if (blocks.rows.length>1000) throw new Error("Too many blueprint document blocks.");
     content.variants.push({channel:variant.channel,locale:variant.locale,blocks:blocks.rows});
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
 return withBlueprintDocumentServices(db,session,async(services,live)=>{
  const definitions=await services.operations.list(live);
  const execute=async(entity:string,intent:string,input:Record<string,unknown>,expectedVersion?:string)=>{
   const operation=definitions.find(op=>intent==="create" ? op.entityName===entity && op.intent==="create" : op.id===`${entity}.${intent}`);
   if(!operation)throw new Error(`Canonical ${entity}.${intent} is unavailable.`);
   const result=await services.operations.execute(live,{operation,input:{...input,...(expectedVersion?{expectedVersion}:{})}});
   if("error" in result)throw operationFailure(result.error);
   return result.data as Record<string,unknown>;
  };
  const copied:Record<string,string>={};
  for(const [field,snapshot] of Object.entries(snapshots)){
   if(Object.hasOwn(overlay,field))continue;
   let artifact:Record<string,unknown>|undefined;
   if(snapshot.file){
    const bytes=Buffer.from(snapshot.file.base64,"base64");
    const staged=await services.artifacts.stage(live,{purpose:"blueprint-document",fileName:snapshot.file.name,source:(async function*(){yield bytes;})()});
    artifact={artifactId:staged.artifactId,expectedArtifactVersion:staged.version};
   }
   let document=await execute("Document","create",{document:Object.fromEntries(Object.entries(snapshot.document).filter(([,value])=>value!=null)),version:{versionLabel:"1",status:"final",isMajorVersion:true},idempotencyKey:crypto.randomUUID(),...(artifact?{artifact}:{})});
   const id=String(document.id);
   for(const variant of snapshot.variants){
    const documentGet=definitions.find(op=>op.entityName==="Document"&&op.intent==="get");
    if(!documentGet)throw new Error("Canonical Document.get is unavailable.");
    const current=await services.operations.execute(live,{operation:documentGet,input:{id}});
    if("error" in current)throw operationFailure(current.error);
    document=current.data as Record<string,unknown>;
    const added=await execute("Document","insertVariant",{id,values:{channel:variant.channel,locale:variant.locale}},String(document.updatedAt));
    const variantGet=definitions.find(op=>op.entityName==="DocumentVariant"&&op.intent==="get")!;
    const initial=await services.operations.execute(live,{operation:variantGet,input:{id:added.childId}});if("error" in initial)throw operationFailure(initial.error);
    let row=initial.data as Record<string,unknown>;
    for(const block of variant.blocks){
     await execute("DocumentVariant","insertBlock",{id:row.id,values:{definitionKey:block.definitionKey,values:block.values}},String(row.updatedAt));
     const get=definitions.find(op=>op.entityName==="DocumentVariant"&&op.intent==="get")!;
     const refreshed=await services.operations.execute(live,{operation:get,input:{id:row.id}});if("error" in refreshed)throw operationFailure(refreshed.error);row=refreshed.data as Record<string,unknown>;
    }
   }
   copied[field]=id;
  }
  return copied;
 });
}
