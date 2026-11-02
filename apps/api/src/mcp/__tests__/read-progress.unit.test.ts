// SPDX-License-Identifier: BUSL-1.1
import { emptyCatalogDatabase } from "../../db/__tests__/empty-catalog-db.js";
import {expect,test} from "bun:test";
import {Client,InMemoryTransport} from "@modelcontextprotocol/client";
import documents from "@openshapeforge/documents/runtime";
import versioning from "@openshapeforge/versioning/runtime";
import accounts from "../../accounts/runtime.js";
import type {RuntimeModule} from "../../modules/contract.js";
import {ModulePlatformRuntime} from "../../modules/platform.js";
import {__buildGeneratedMcpServerForTests} from "../generated-mcp-server.js";
import {READ_PROGRESS_META_KEY as KEY} from "@openshapeforge/plugin-runtime/read-progress";

test("generated MCP bridge delivers opt-in read snapshots on the original request only",async()=>{
  for(const optIn of [true,false]){
    const db=emptyCatalogDatabase(),platform=new ModulePlatformRuntime(db);
    const server=__buildGeneratedMcpServerForTests({db,modulePlatform:platform,session:{tenantId:"11111111-1111-4111-8111-111111111111",userId:"22222222-2222-4222-8222-222222222222",roles:["General.All.Read"],groups:[],scope:"self",credential:"bearer"},modules:[accounts,documents as unknown as RuntimeModule,versioning as unknown as RuntimeModule,{name:"notebook",operationHandlers:{importNotebook:async()=>({value:undefined}),deliverToNotebook:()=>{throw new Error("This test does not exercise Notebook.deliver.")}}}],operationToolProjection:{mode:"searchable",search:"osf_search_operations",execute:"osf_execute_operation"}});
    let calls=0,release!:()=>void;const wait=new Promise<void>(resolve=>release=resolve),updates:unknown[]=[];
    platform.registerStaticOperations([{
      definition:{id:"TemplateVersion.materialize",intent:"invoke",name:"Synthetic read",description:"Synthetic evidence",input:{kind:"json-schema",schema:{type:"object"}},output:{kind:"json-schema",schema:{type:"object"}},effects:{data:"read",external:"none"},reliability:{idempotency:{mode:"natural"}}},available:()=>true,
      execute:async(session)=>{calls++;expect(await platform.services.readProgress!.report(session,{data:{items:[{id:"first"}]}})).toBe(optIn);if(optIn)await wait;return {data:{items:[{id:"first"},{id:"last"}]},operations:[]};},
    }]);
    const client=new Client({name:"read-progress-test",version:"1"}),[a,b]=InMemoryTransport.createLinkedPair();
    try{
      await server.connect(b);await client.connect(a);
      const result=await client.callTool({name:"osf_execute_operation",arguments:{operationId:"TemplateVersion.materialize",input:{}},...(optIn?{_meta:{[KEY]:{version:1}}}:{})},{onprogress:progress=>{updates.push(progress);release();}});
      expect(result.isError).toBeFalsy();expect(result.structuredContent).toMatchObject({data:{items:[{id:"first"},{id:"last"}]}});expect(calls).toBe(1);
      expect(updates).toHaveLength(optIn?1:0);
      if(optIn)expect(updates[0]).toMatchObject({_meta:{[KEY]:{version:1,readOnly:true,operationId:"TemplateVersion.materialize",toolName:"osf_execute_operation",sequence:1}}});
    }finally{release();platform.unregisterServer(server);await client.close();await server.close();}
  }
});

test("authored dedicated MCP tools report on the same request without changing their final projection",async()=>{
  for(const optIn of [true,false]){
    const db=emptyCatalogDatabase(),platform=new ModulePlatformRuntime(db),updates:unknown[]=[];
    let calls=0;
    const fixture={...documents,operationHandlers:{...documents.operationHandlers,materializeTemplate:async(_input:unknown,context:any)=>{
      calls++;
      expect(Boolean(context.signal)).toBe(optIn);
      expect(await context.platform.readProgress.report(context.session,{data:{items:[{id:"first"}]}})).toBe(optIn);
      return {value:{items:[{id:"first"},{id:"last"}]}};
    }}} as unknown as RuntimeModule;
    const server=__buildGeneratedMcpServerForTests({db,modulePlatform:platform,session:{tenantId:"11111111-1111-4111-8111-111111111111",userId:"22222222-2222-4222-8222-222222222222",roles:["General.All.Read"],groups:[],scope:"self",credential:"bearer"},modules:[accounts,fixture,versioning as unknown as RuntimeModule,{name:"notebook",operationHandlers:{importNotebook:async()=>({value:undefined}),deliverToNotebook:()=>{throw new Error("This test does not exercise Notebook.deliver.")}}}],operationToolProjection:{mode:"dedicated",search:"osf_search_operations",execute:"osf_execute_operation"}});
    const client=new Client({name:"direct-read-progress-test",version:"1"}),[a,b]=InMemoryTransport.createLinkedPair();
    try{
      await server.connect(b);await client.connect(a);
      const result=await client.callTool({name:"template_version_materialize",arguments:{templateVersionId:"33333333-3333-4333-8333-333333333333",channel:"document",locale:"en"},...(optIn?{_meta:{[KEY]:{version:1}}}:{})},{onprogress:p=>{updates.push(p);}});
      expect(result.isError).toBeFalsy();expect(result.structuredContent).toEqual({items:[{id:"first"},{id:"last"}]});expect(calls).toBe(1);
      expect(updates).toHaveLength(optIn?1:0);
      if(optIn)expect(updates[0]).toMatchObject({_meta:{[KEY]:{operationId:"TemplateVersion.materialize",toolName:"template_version_materialize",readOnly:true}}});
    }finally{platform.unregisterServer(server);await client.close();await server.close();}
  }
});
