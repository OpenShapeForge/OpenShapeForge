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

test('protected descendants survive enclosing deletion and source replacement while free siblings remain editable',async()=>{
 const {includedContentProtection}=await import('./inclusion-protection.js');
 const locked=version('clause',[text('legal','Required terms',true),text('free','Optional note')]);
 const wrapper:ContentBlock={id:'container',definitionKey:'TemplateBlock',schemaVersion:1,values:{parameters:{}},references:{version:{entity:'TemplateVersion',id:'clause'}}};
 const source=version('proposal',[text('intro','Introduction'),wrapper]);
 const resolve=async(id:string)=>{if(id==='clause')return locked.variants[0]!;throw Error('Unreadable source');};
 for(const blocks of [[{id:'intro'}],[{id:'container',definitionKey:'TextBlock',values:{markdown:'Replacement'},references:{}}]]){
  await expect(includedContentProtection(source.variants[0]!,{blocks},registry,resolve)).rejects.toBeDefined();
 }
 const protection=await includedContentProtection(source.variants[0]!,{blocks:[{id:'intro',values:{markdown:'Personal greeting'}},{id:'container',values:{parameters:{},content:{blocks:[{id:'legal'},{id:'free',values:{markdown:'Sales note'}}]}}}]},registry,resolve);
 expect([...protection.keys()]).toEqual(['container/legal']);
});
test('local changes rebase onto a new source without dropping edits, deletions or inserted blocks',async()=>{
 const {rebaseIncludedContent,applyIncludedContent}=await import('./included-content.js');
 const before=version('v1',[text('intro','Original'),text('terms','Terms',true),text('optional','Optional')]).variants[0]!;
 const next=version('v2',[text('new','New source paragraph'),text('intro','New default'),text('terms','Terms',true),text('optional','Updated optional')]).variants[0]!;
 const content={blocks:[{id:'intro',values:{markdown:'Custom greeting'}},{id:'local',definitionKey:'TextBlock',values:{markdown:'Custom block'}},{id:'terms'}]};
 const rebased=rebaseIncludedContent(before,next,content,registry);
 expect(applyIncludedContent(next,rebased,registry).blocks.map(block=>block.values.markdown)).toEqual(['New source paragraph','Custom greeting','Custom block','Terms']);
 const replacement=version('replacement',[text('new','Replacement content'),text('terms','Terms',true)]).variants[0]!;
 expect(applyIncludedContent(replacement,rebaseIncludedContent(before,replacement,content,registry),registry).blocks.map(block=>block.values.markdown)).toEqual(['Custom greeting','Custom block','Replacement content','Terms']);
});
test('new source locks conflict with local changes without mutating either input',async()=>{
 const {rebaseIncludedContent}=await import('./included-content.js');
 const before=version('v1',[text('intro','Original')]).variants[0]!;
 const next=version('v2',[text('intro','Mandatory',true)]).variants[0]!;
 const local={blocks:[{id:'intro',values:{markdown:'Custom'}}]};
 expect(()=>rebaseIncludedContent(before,next,local,registry)).toThrow();expect(local.blocks[0]!.values.markdown).toBe('Custom');expect(next.blocks[0]!.values.markdown).toBe('Mandatory');
});
