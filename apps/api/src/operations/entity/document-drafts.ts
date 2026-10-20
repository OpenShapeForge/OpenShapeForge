// SPDX-License-Identifier: BUSL-1.1
import { sql, type Transaction } from "kysely";
import type { DB } from "../../generated/db/types.js";
import { currentDbSessionDatabase, type DbSessionInput } from "../../db/session.js";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import { withBlueprintDocumentServices } from "../../modules/platform.js";
import { generatedCrudError } from "./catalog.js";
import { operationFailure } from "@openshapeforge/operations";
import { normalizeTimestampToken } from "../../db/timestamps.js";

type BlockDraft = { id?: string; definitionKey: string; values: Record<string,unknown> };
export type DocumentContentDraft = { documentId: string; variants: { id:string; expectedVersion:string; blocks:BlockDraft[] }[] };
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
/** One parent Operation transaction owns every canonical child mutation. No transport-selected Operation names. */
export async function applyDocumentContentDraft(trx:Transaction<DB>,session:DbSessionInput,original:unknown,input:unknown):Promise<string> {
 if(!record(input)||input.documentId!==original||!Array.isArray(input.variants)||input.variants.length>100)throw generatedCrudError("Invalid document draft.","BAD_USER_INPUT");
 const db=currentDbSessionDatabase() as OpenShapeForgeDatabase|undefined;
 if(!db)throw generatedCrudError("A document edit requires an active transaction.","INVALID_DEFINITION");
 const variants=await sql<{id:string;updatedAt:string}>`select id::text,updated_at::text as "updatedAt" from erp.document_variants where document_id=${String(original)}::uuid and tenant_id=${session.tenantId}::uuid order by id for update`.execute(trx);
 const supplied=input.variants;
 if(supplied.length!==variants.rows.length||new Set(supplied.map(v=>record(v)?v.id:null)).size!==supplied.length)throw generatedCrudError("Reload the complete document before editing.","VERSION_CONFLICT");
 for(const item of supplied){
  if(!record(item)||typeof item.id!=="string"||typeof item.expectedVersion!=="string"||!Array.isArray(item.blocks)||item.blocks.length>1000)throw generatedCrudError("Invalid document variant draft.","BAD_USER_INPUT");
  const row=variants.rows.find(v=>v.id===item.id);
  if(!row||normalizeTimestampToken(row.updatedAt)!==normalizeTimestampToken(item.expectedVersion))throw generatedCrudError("The document has changed. Reload before saving.","VERSION_CONFLICT");
 }
 return withBlueprintDocumentServices(db,session,async(services,live)=>{
  await services.records.assertAccess(live,{entityName:"Document",id:String(original),intent:"get"});
  const operations=await services.operations.list(live);
  const execute=async(id:string,args:Record<string,unknown>)=>{
   const operation=operations.find(op=>op.id===id);if(!operation)throw generatedCrudError("Document editing is unavailable.","INVALID_DEFINITION");
   const result=await services.operations.execute(live,{operation,input:args});if("error" in result)throw operationFailure(result.error);
   return result.data as Record<string,unknown>;
  };
  for(const raw of supplied){
   const variant=raw as DocumentContentDraft["variants"][number];
   let current=await execute("DocumentVariant.get",{id:variant.id});
   const mutation=async(action:string,args:Record<string,unknown>)=>{
    const result=await execute(`DocumentVariant.${action}Block`,{id:variant.id,expectedVersion:current.updatedAt,...args});
    current=await execute("DocumentVariant.get",{id:variant.id});return result;
   };
   const existing=await sql<{id:string;definitionKey:string;values:Record<string,unknown>}>`select id::text,definition_key as "definitionKey",values from erp.blocks where document_variant_id=${variant.id}::uuid and tenant_id=${session.tenantId}::uuid order by document_variant_id_position,id for update`.execute(trx);
   const desired:string[]=[];const used=new Set<string>();
   for(const block of variant.blocks){
    if(!record(block)||typeof block.definitionKey!=="string"||!record(block.values)||block.id!==undefined&&typeof block.id!=="string")throw generatedCrudError("Invalid document block.","BAD_USER_INPUT");
    if(block.id){
     const old=existing.rows.find(row=>row.id===block.id);
     if(!old||used.has(block.id)||old.definitionKey!==block.definitionKey)throw generatedCrudError("Invalid document block identity.","BAD_USER_INPUT");
     used.add(block.id);desired.push(block.id);
     if(JSON.stringify(old.values)!==JSON.stringify(block.values))await mutation("update",{childId:block.id,values:{values:block.values}});
    }else{
     const result=await mutation("insert",{values:{definitionKey:block.definitionKey,values:block.values}});desired.push(String(result.childId));
    }
   }
   for(const old of existing.rows)if(!used.has(old.id))await mutation("remove",{childId:old.id});
   // Move only out-of-position blocks; protected blocks remain governed by their canonical Operation.
   const order=await sql<{id:string}>`select id::text from erp.blocks where document_variant_id=${variant.id}::uuid and tenant_id=${session.tenantId}::uuid order by document_variant_id_position,id`.execute(trx);
   const actual=order.rows.map(row=>row.id);
   for(let index=desired.length-1;index>=0;index--){const id=desired[index]!,beforeId=desired[index+1]??null;const at=actual.indexOf(id);if((actual[at+1]??null)===beforeId)continue;await mutation("move",{childId:id,beforeId});actual.splice(at,1);const before=beforeId?actual.indexOf(beforeId):actual.length;actual.splice(before,0,id);}
  }
  return String(original);
 });
}
