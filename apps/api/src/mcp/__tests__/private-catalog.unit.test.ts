import {expect,test} from 'bun:test';
import {catalog} from '../catalog.js';
import {staticToolCall} from '../dispatch-static-tools.js';
import {getGeneratedCrudTables} from '../../operations/entity/table-registry.js';
test('a confidential catalog tool without its matching runtime definition never enters ordinary execution',async()=>{
 const tool={key:'fixture.private-catalog',plugin:'fixture',name:'fixture_private_catalog',title:'Private fixture',description:'fixture',inputSchema:{type:'object'},outputSchema:{type:'object',properties:{secret:{type:'string','x-osf-classification':{sensitivity:'confidential'}}}},auth:{mode:'public' as const},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false}};
 catalog.operationTools.push(tool);
 let touched=0;
 const bound=new Proxy({},{get(){touched++;throw Error('Ordinary execution inspected a confidential catalog handler');}});
 try{
  const result=await staticToolCall({name:tool.name,request:{params:{arguments:{}}},operations:new Map([[tool.key,bound]]),operationToolProjection:{mode:'dedicated'},session:{roles:[],groups:[],credential:'bearer'},moduleSession:{},tables:new Map(getGeneratedCrudTables().map(t=>[t.name,t])),searchableStaticOperationIds:new Set(),modulePlatform:{listOperationSnapshot:async()=>({definitions:[],providerIds:new Set()})},allowedEditLeaseOperationIds:new Set()} as never);
  expect(result?.isError).toBe(true);
  expect(result?.structuredContent).toMatchObject({error:{code:'INTERACTION_REQUIRED'}});
  expect(touched).toBe(0);
 }finally{catalog.operationTools.pop();}
});
