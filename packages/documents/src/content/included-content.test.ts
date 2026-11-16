// SPDX-License-Identifier: BUSL-1.1
import {test,expect} from 'bun:test';
import {materializeTemplateContent,type CompiledContentBlockRegistry,type ContentTemplateVersion,type ContentBlock,type ContentResolvers} from './index.js';
const text=(id:string,value:string,locked=false):ContentBlock=>({id,definitionKey:'TextBlock',schemaVersion:1,values:{markdown:value},references:{},...(locked?{locked:true}:{})});
const version=(id:string,blocks:readonly ContentBlock[],tenantId='tenant'):ContentTemplateVersion=>({id,tenantId,templateId:`template-${id}`,versionNumber:1,parameters:{},variants:[{id:`variant-${id}`,channel:'document',locale:'en',blocks,allowedDefinitions:['TextBlock','TemplateBlock']}]});
const registry:CompiledContentBlockRegistry={TextBlock:{entityName:'TextBlock',schemaVersion:1,fields:{markdown:{baseType:'string',required:true}},renderers:{document:'markdown'}},TemplateBlock:{entityName:'TemplateBlock',schemaVersion:1,fields:{version:{baseType:'string',required:true,relationship:{target:'TemplateVersion'}},parameters:{baseType:'object'},content:{baseType:'object'}},renderers:{},composition:{templateVersionField:'version',parametersField:'parameters'}}};
const include=(id:string,content?:object):ContentBlock=>({id,definitionKey:'TemplateBlock',schemaVersion:1,values:{parameters:{},...(content?{content:content as any}:{})},references:{version:{entity:'TemplateVersion',id:'source'}}});
async function render(content?:object,sourceTenant='tenant',twice=false){
 const original=version('source',[text('title','Title'),text('protected','Required clause',true),text('remove','Optional')],sourceTenant);
 const root=version('root',[include('one',content),...(twice?[include('two')]:[])]);
 const resolvers:ContentResolvers={resolveTemplateVersion:id=>id==='root'?root:id==='source'?original:null,resolveGlobalVariable:()=>null,resolveEntity:()=>null,materializeBlock:input=>({operationId:'materialize',result:input.definitionKey==='TemplateBlock'?{kind:'template',referenceField:'version',parameters:input.values.parameters??{},...(input.values.content?{content:input.values.content}:{})} as any:{kind:'block',value:input.values}})};
 const result=await materializeTemplateContent({tenantId:'tenant',templateVersionId:'root',channel:'document',locale:'en'},registry,resolvers);
 return {result,original};
}
test('included blocks edit, insert and delete locally while preserving source and the other inclusion',async()=>{
 const content={blocks:[{id:'title',values:{markdown:'Changed locally'}},{id:'new-block',definitionKey:'TextBlock',values:{markdown:'Inserted between'}},{id:'protected'}]};
 const {result,original}=await render(content,'tenant',true);
 expect(result.blocks.map(block=>block.values.markdown)).toEqual(['Changed locally','Inserted between','Required clause','Title','Required clause','Optional']);
 expect(original.variants[0]!.blocks.map(block=>block.values.markdown)).toEqual(['Title','Required clause','Optional']);
 expect(result.templates.find(template=>template.path[0]==='one')!.version.variants[0]!.blocks[0]!.values.markdown).toBe('Title');
});
test('a locked source block cannot be changed, removed, unlocked or duplicated by a client',async()=>{
 for(const blocks of [[{id:'protected',values:{markdown:'Forged'}}],[],[{id:'protected',locked:false}],[{id:'protected'},{id:'protected'}]])await expect(render({blocks})).rejects.toBeDefined();
});
test('a missing source version or an unavailable block definition never silently drops content',async()=>{
 await expect(render({blocks:[{id:'protected'},{id:'missing-source'}]})).rejects.toBeDefined();
 await expect(render({blocks:[{id:'protected'},{id:'new',definitionKey:'Unknown',values:{}}]})).rejects.toBeDefined();
});
test('inserted block fields use their normal semantic validation',async()=>{
 await expect(render({blocks:[{id:'protected'},{id:'new',definitionKey:'TextBlock',values:{markdown:42}}]})).rejects.toBeDefined();
});
test('the chosen source version remains tenant-bound with local content',async()=>{
 await expect(render({blocks:[{id:'protected'}]},'another-tenant')).rejects.toBeDefined();
});
