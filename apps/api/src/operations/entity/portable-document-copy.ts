// SPDX-License-Identifier: BUSL-1.1
import { operationFailure } from "@openshapeforge/operations";
import type { ModulePlatformServices } from "../../modules/contract.js";
import type { TrustedSessionContext } from "../../auth/trusted-context.js";
export type PortableDocument = { document: Record<string, unknown>; file?: { name: string; base64: string }; variants: { channel: string; locale: string; blocks: { definitionKey: string; values: Record<string, unknown> }[] }[] };

/** Copy portable content only through the destination session's canonical Operations. */
export async function copyPortableDocuments(services: Pick<ModulePlatformServices, "operations" | "artifacts">, live: TrustedSessionContext, snapshots: Record<string,PortableDocument>, overlay: Record<string,unknown>): Promise<Record<string,string>> {
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
}
