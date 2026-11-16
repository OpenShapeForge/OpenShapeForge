// SPDX-License-Identifier: BUSL-1.1
import {applyIncludedContent,canonicalJson} from './included-content.js';
import {contentError} from './errors.js';
import {CONTENT_LIMITS} from './json.js';
import type {ContentBlock,ContentTemplateVariant,CompiledContentBlockRegistry} from './types.js';
export type InclusionVariantResolver=(id:string)=>Promise<ContentTemplateVariant>;
export function assertIncludedProtection(before:ReadonlyMap<string,string>,after:ReadonlyMap<string,string>,relocated=false):void {
 if(relocated){const remaining=[...after.values()];let at=0;for(const value of before.values()){const found=remaining.indexOf(value,at);if(found<0)contentError('INVALID_VALUE','The replacement cannot retain protected template content.');at=found+1;}return;}
 for(const [path,value] of before)if(after.get(path)!==value)contentError('INVALID_VALUE','Protected template content cannot be removed or changed through an enclosing inclusion.');
 if([...after.keys()].filter(key=>before.has(key)).join('\n')!==[...before.keys()].join('\n'))contentError('INVALID_VALUE','Protected template content must retain its order.');
}
/** Source locks protect their descendants even when an unlocked enclosing block is removed or replaced. */
export async function includedContentProtection(variant:ContentTemplateVariant,content:unknown,registry:CompiledContentBlockRegistry,resolve:InclusionVariantResolver):Promise<ReadonlyMap<string,string>> {
 registry=Object.fromEntries(Object.entries(registry).map(([key,definition])=>{const fields=definition.source?.fields;const composition=definition.composition??(Array.isArray(fields)?templateComposition(fields as Readonly<Record<string,unknown>>[]):undefined);return [key,composition?{...definition,composition}:definition];}));
 let visits=0;
 async function walk(source:ContentTemplateVariant,local:unknown,ancestors:readonly string[]):Promise<Map<string,string>> {
  if(ancestors.includes(source.id))contentError('TEMPLATE_CYCLE','Template inclusion contains a cycle.');
  if(ancestors.length>=CONTENT_LIMITS.templateDepth||++visits>CONTENT_LIMITS.blocks*CONTENT_LIMITS.templateDepth)contentError('CONTENT_LIMIT_EXCEEDED','Template protection exceeds the content budget.');
  const lineage=[...ancestors,source.id];
  async function child(block:ContentBlock):Promise<Map<string,string>>{
   const field=registry[block.definitionKey]?.composition?.templateVersionField;if(!field)return new Map();
   const ref=block.references[field];if(!ref||Array.isArray(ref)||!('id' in ref))contentError('DEPENDENCY_INVALID','A template inclusion requires its frozen source.');
   return walk(await resolve((ref as {id:string}).id),block.values.content,lineage);
  }
  const effective=applyIncludedContent(source,local,registry),result=new Map<string,string>();
  const current=new Map(effective.blocks.map(block=>[block.id,block]));
  const childResults=new Map<string,Map<string,string>>();const requiredOrder=new Map<string,string>();
  for(const block of source.blocks){
   const required=await child(block);if(block.locked)requiredOrder.set(block.id,canonicalJson(block));for(const [path,value] of required)requiredOrder.set(`${block.id}/${path}`,value);
   const next=current.get(block.id),actual=next?(canonicalJson(next)===canonicalJson(block)?required:await child(next)):new Map<string,string>();
   const field=registry[block.definitionKey]?.composition?.templateVersionField;
   assertIncludedProtection(required,actual,Boolean(next&&field&&canonicalJson(block.references[field]??null)!==canonicalJson(next.references[field]??null)));childResults.set(block.id,actual);
  }
  for(const block of effective.blocks){
   if(block.locked)result.set(block.id,canonicalJson(block));
   for(const [path,value] of childResults.get(block.id)??await child(block))result.set(`${block.id}/${path}`,value);
  }
  assertIncludedProtection(requiredOrder,result,true);
  return result;
 }
 return walk(variant,content,[]);
}

/** The existing typed argument contract identifies a template inclusion without another block type system. */
export function templateComposition(fields:readonly Readonly<Record<string,unknown>>[]):{templateVersionField:string;parametersField:string}|undefined {
 for(const field of fields){const binding=field.valueFieldsFrom as Record<string,unknown>|undefined;
  if(binding?.headEntity==='Template'&&typeof binding.reference==='string'&&typeof field.key==='string')return {templateVersionField:binding.reference,parametersField:field.key};
 }
 return undefined;
}
