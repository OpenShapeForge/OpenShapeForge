import {operationFailure} from '@openshapeforge/operations';
import {TemplateContentError} from './content/errors.js';
// SPDX-License-Identifier: BUSL-1.1
import type {RuntimeEntityValueCarrier} from '@openshapeforge/plugin-runtime';
import {rows} from './commands.js';
import {templateSnapshotContent} from './content-snapshot.js';
import {selectContentTemplateVariant} from './content/validation.js';
import {includedContentProtection,assertIncludedProtection,templateComposition} from './content/inclusion-protection.js';
import type {CompiledContentBlockRegistry,ContentTemplateVariant} from './content/types.js';
import {refuse} from './validation.js';
import {canonicalJson} from './content/json.js';

/** Canonical writes check the same source graph as rendering. The transaction/caller already owns the block. */
async function checkBlockInclusionWrite(trx:unknown,tenantId:string,carrier:RuntimeEntityValueCarrier,before:Readonly<Record<string,unknown>>|undefined,after:Readonly<Record<string,unknown>>|undefined,options:{sourceChange?:boolean}={}):Promise<void>{
 if(carrier.entityName!=='Block'||!(before?.document_variant_id||after?.document_variant_id))return;
 if(before?.locked===true&&!options.sourceChange){
  const definition=carrier.definitions[String(before[carrier.definitionColumn])];
  const columns=[carrier.definitionColumn,carrier.valuesColumn,'locked','definition_version','document_variant_id','document_variant_id_position','region','layout_key',...(definition?.references.flatMap(ref=>[ref.column,...(ref.parameterColumn?[ref.parameterColumn]:[])])??[])];
  if(!after||columns.some(key=>canonicalJson(before[key]??null)!==canonicalJson(after[key]??null)))refuse('INVALID_STATE','This document block is locked by its source and cannot be changed, moved or removed.');
 }
 if(![before,after].some(row=>row&&templateComposition(carrier.definitions[String(row[carrier.definitionColumn])]?.fields??[])))return;
 const owner=String(before?.document_variant_id??after?.document_variant_id);
 const variant=(await rows<{channel:string;locale:string}>(trx,'select channel,locale from erp.document_variants where tenant_id=$1 and id=$2 for share',[tenantId,owner]))[0];
 if(!variant)refuse('NOT_FOUND','The owning document variant is not available.');
 const registry=Object.fromEntries(Object.entries(carrier.definitions).map(([key,entry])=>[key,{entityName:entry.entityName,schemaVersion:entry.schemaVersion,fields:{},renderers:{},...(templateComposition(entry.fields)?{composition:templateComposition(entry.fields)}:{})}])) as CompiledContentBlockRegistry;
 const versions=new Map<string,ContentTemplateVariant>();
 async function resolve(id:string):Promise<ContentTemplateVariant>{
  if(versions.has(id))return versions.get(id)!;
  const version=(await rows<{template_id:string;snapshot:unknown}>(trx,'select template_id,snapshot from erp.template_versions where tenant_id=$1 and id=$2 for share',[tenantId,id]))[0];
  if(!version)refuse('DEPENDENCY_UNRESOLVED','The included template version is not available.');
  const frozen=templateSnapshotContent(version!.snapshot,{tenantId,templateId:version!.template_id,channel:variant!.channel,carrier,allowedDefinitions:Object.keys(carrier.definitions),definitionVersionColumn:'definition_version'});
  const selected=selectContentTemplateVariant({variants:frozen.variants} as any,variant!.channel,variant!.locale);versions.set(id,selected);return selected;
 }
 async function protection(row:Readonly<Record<string,unknown>>|undefined):Promise<ReadonlyMap<string,string>>{
  if(!row)return new Map();
  const definition=carrier.definitions[String(row[carrier.definitionColumn])];if(!definition)return new Map();
  const composition=templateComposition(definition.fields);if(!composition)return new Map();
  const reference=definition.references.find(ref=>ref.fieldKey===composition.templateVersionField);if(!reference)refuse('DEPENDENCY_INVALID','The inclusion has no typed source reference.');
  const version=String(row[reference!.column]??'');const values=(row[carrier.valuesColumn]??{}) as Record<string,unknown>;
  return includedContentProtection(await resolve(version),values.content,registry,resolve);
 }
 const required=await protection(before),actual=await protection(after);
 if(required.size&&before&&after&&['document_variant_id','document_variant_id_position'].some(key=>canonicalJson(before[key]??null)!==canonicalJson(after[key]??null)))refuse('INVALID_STATE','A block containing protected template content cannot be moved out of its placement.');
 assertIncludedProtection(required,actual,true);
}

export async function assertBlockInclusionWrite(...args:Parameters<typeof checkBlockInclusionWrite>):Promise<void>{
 try{await checkBlockInclusionWrite(...args);}catch(error){if(error instanceof TemplateContentError)throw operationFailure({code:"INVALID_STATE",message:error.message,retryable:false});throw error;}
}
