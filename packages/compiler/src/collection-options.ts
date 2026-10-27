// SPDX-License-Identifier: BUSL-1.1
import type {CompiledEntityInfo,PluginOperationContract} from './plugins.js';
type Entities=readonly Pick<CompiledEntityInfo,'contract'>[];
export function collectionOptionSources(entities:Entities){return entities.flatMap(({contract:c})=>{
 const list=c.entityOperations?.list?.id??c.pluginOperations?.find(op=>op.key==='list')?.id;
 if(!list)return [];
 const allowed=c.source?.query?.filterFields;
 return [{entity:c.entity.name,list,fields:Object.fromEntries(c.model.fields.filter(f=>f.baseType!=='object'&&(!allowed||allowed.includes(f.key))).map(f=>[f.key,{type:f.baseType,many:f.cardinality==='collection'}]))}];
});}
export function collectionOptionsDefinition(entities:Entities):PluginOperationContract{return {
 key:'collection.options',title:'List filter options',description:'Find authorized existing collection values and resolve reference choices without reconstructing missing historical labels.',handler:'listCollectionOptions',
 auth:{mode:'session',roles:[...new Set(entities.flatMap(({contract})=>contract.authorization.roles.read))].sort()},tenancy:{mode:'required'},idempotency:{mode:'none'},effects:{data:'read',external:'none'},
 inputSchema:{type:'object',additionalProperties:false,required:['entity','field'],properties:{entity:{type:'string'},field:{type:'string'},search:{type:'string',maxLength:200},locale:{type:'string',enum:['en','nl']},first:{type:'integer',minimum:1,maximum:100},after:{type:'string',maxLength:8192},referenceEntity:{type:'string'},catalog:{type:'string',enum:['operations']},filter:{type:'object'}}},
 outputSchema:{type:'object',required:['items','nextCursor'],properties:{
  items:{type:'array',items:{type:'object',required:['value','label'],properties:{value:{type:'string'},label:{type:'string'}}}},
  nextCursor:{type:['string','null']}
 }},errors:[],transports:{rest:{method:'POST',path:'/api/core/collection/options',response:{kind:'json'}},mcp:{enabled:true,name:'collection_options'},typescript:{enabled:true,functionName:'collectionOptions'},graphql:{enabled:false,reason:'Use the canonical REST or MCP Operation.'}}
};}
