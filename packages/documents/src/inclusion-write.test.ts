// SPDX-License-Identifier: BUSL-1.1
import {test,expect} from 'bun:test';
import type {RuntimeEntityValueCarrier} from '@openshapeforge/plugin-runtime';
import {assertBlockInclusionWrite} from './inclusion-write.js';
const tenant='10000000-0000-4000-8000-000000000001',template='10000000-0000-4000-8000-000000000002',variant='10000000-0000-4000-8000-000000000003',block='10000000-0000-4000-8000-000000000004',version='10000000-0000-4000-8000-000000000005',owner='10000000-0000-4000-8000-000000000006';
const carrier={entityName:'Block',fieldKey:'values',definitionField:'definitionKey',schema:'erp',table:'blocks',definitionColumn:'definition_key',valuesColumn:'values',definitions:{
 TextBlock:{entityName:'TextBlock',schemaVersion:1,fields:[{key:'markdown',osfType:'string'}],references:[]},
 TemplateBlock:{entityName:'TemplateBlock',schemaVersion:1,fields:[{key:'parameters',valueFieldsFrom:{reference:'version',headEntity:'Template'}}],references:[{fieldKey:'version',targetEntity:'TemplateVersion',column:'template_version_id',schema:'erp',table:'template_versions',required:true}]}
}} as unknown as RuntimeEntityValueCarrier;
const snapshot=(locked=true)=>({schemaVersion:1,entity:'Template',head:{table:'templates',row:{id:template,tenant_id:tenant,parameters:[]},children:{template_variants:[{table:'template_variants',row:{id:variant,tenant_id:tenant,template_id:template,channel:'document',locale:'en'},children:{blocks:[{table:'blocks',row:{id:block,tenant_id:tenant,variant_id:variant,definition_key:'TextBlock',definition_version:1,values:{markdown:'Required terms'},locked},children:{}}]}}]}}});
function transaction(locked=true,readable=true){return {executeQuery:async(q:{sql:string;parameters:unknown[]})=>{expect(q.parameters[0]).toBe(tenant);return {rows:q.sql.includes('document_variants')?[{channel:'document',locale:'en'}]:readable?[{template_id:template,snapshot:snapshot(locked)}]:[]};}};}
const row={id:'placement',document_variant_id:owner,definition_key:'TemplateBlock',template_version_id:version,values:{parameters:{}}};
test('canonical writes reject deleting or disguising a protected inclusion and tampering through its content',async()=>{
 for(const next of [undefined,{...row,definition_key:'TextBlock',values:{markdown:'Replacement'}},{...row,values:{parameters:{},content:{blocks:[]}}}])await expect(assertBlockInclusionWrite(transaction(),tenant,carrier,row,next)).rejects.toBeDefined();
 await assertBlockInclusionWrite(transaction(),tenant,carrier,row,{...row,values:{parameters:{name:'Customer'}}});
});
test('new placements validate local content; source authoring and free content remain editable',async()=>{
 await expect(assertBlockInclusionWrite(transaction(),tenant,carrier,undefined,{...row,values:{parameters:{},content:{blocks:[]}}})).rejects.toBeDefined();
 await assertBlockInclusionWrite(transaction(false),tenant,carrier,row,undefined);
 await assertBlockInclusionWrite(transaction(),tenant,carrier,{...row,document_variant_id:null},undefined);
});
test('unavailable or cross-tenant sources fail closed without exposing or dropping content',async()=>{
 await expect(assertBlockInclusionWrite(transaction(true,false),tenant,carrier,row,undefined)).rejects.toBeDefined();
});

test('generic writes cannot bypass the source lock on a document-owned text block',async()=>{
 const locked={...row,definition_key:'TextBlock',values:{markdown:'Required text'},locked:true};
 await expect(assertBlockInclusionWrite(transaction(),tenant,carrier,locked,{...locked,values:{markdown:'Changed'}})).rejects.toBeDefined();
 await expect(assertBlockInclusionWrite(transaction(),tenant,carrier,locked,undefined)).rejects.toBeDefined();
 await assertBlockInclusionWrite(transaction(),tenant,carrier,locked,{...locked});
 await assertBlockInclusionWrite(transaction(),tenant,carrier,locked,{...locked,values:{markdown:'New published source'}},{sourceChange:true});
});
