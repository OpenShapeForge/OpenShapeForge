// SPDX-License-Identifier: BUSL-1.1
import type { CompiledEntityInfo, PluginOperationContract } from './plugins.js';

export function applicationSearchDefinition(entities: readonly Pick<CompiledEntityInfo,'contract'>[]): PluginOperationContract {
  return {
    key:'application.search', title:'Search application', description:'Find readable application entities and records by names and descriptions in every authored language.',
    handler:'searchApplication', auth:{mode:'session',roles:[...new Set(entities.flatMap(({contract})=>contract.authorization.roles.read))].sort()},
    tenancy:{mode:'required'}, idempotency:{mode:'none'}, effects:{data:'read',external:'none'},
    inputSchema:{type:'object',additionalProperties:false,properties:{query:{type:'string',maxLength:200},locale:{type:'string',enum:['en','nl']},
      entity:{type:'string',maxLength:200},after:{type:'string',maxLength:4096},first:{type:'integer',minimum:1,maximum:20}}},
    outputSchema:{type:'object',required:['entities','groups','incomplete'],properties:{
      entities:{type:'array',items:{type:'object'}}, groups:{type:'array',items:{type:'object'}},incomplete:{type:'boolean'}
    }},errors:[],transports:{rest:{method:'POST',path:'/api/core/application/search',response:{kind:'json'}},
      mcp:{enabled:true,name:'application_search'},typescript:{enabled:true,functionName:'applicationSearch'},graphql:{enabled:false,reason:'Use the canonical REST or MCP search Operation.'}}
  };
}
export function applicationSearchSources(entities: readonly Pick<CompiledEntityInfo,'contract'>[]) {
  return entities.flatMap(({contract:c})=>{
    const list=c.entityOperations?.list?.id ?? c.pluginOperations?.find(op=>op.key==='list')?.id;
    const get=c.entityOperations?.get?.id ?? c.pluginOperations?.find(op=>op.key==='get')?.id;
    if(!list)return [];
    const field=c.entity.filterField ?? c.entity.displayTemplate?.match(/^\{\{\s*(\w+)\s*\}\}$/)?.[1]
      ?? ['name','title','label','displayName','key'].find(key=>c.model.fields.some(f=>f.key===key&&f.baseType==='string'));
    const description=c.model.fields.find(f=>f.key==='description'&&f.baseType==='string'&&f.cardinality!=='collection');
    const viewTitle=Object.values(c.views??{}).find(view=>view.list?.title)?.list?.title;
    const labels=typeof viewTitle==='object'?viewTitle:c.entity.labels??{en:c.entity.title,nl:c.entity.title};
    return [{entity:c.entity.name,labels:{...labels},description:typeof c.entity.description==='object'?{...c.entity.description}:c.entity.description??'',
      list,...(get?{get}:{}),...(field?{field}:{}),...(description?{descriptionField:description.key}:{})}];
  });
}
