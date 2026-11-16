// SPDX-License-Identifier: BUSL-1.1
import {contentError} from './errors.js';
import {canonicalJson,CONTENT_LIMITS,type JsonObject} from './json.js';
import type {ContentBlock,ContentTemplateVariant,CompiledContentBlockDefinition} from './types.js';

const object=(value:unknown):value is Record<string,unknown>=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
/** A local ordered composition names source blocks; only changed/new blocks carry content. */
export function applyIncludedContent(variant:ContentTemplateVariant,content:unknown,registry:Readonly<Record<string,Partial<Pick<CompiledContentBlockDefinition,'schemaVersion'>>>>):ContentTemplateVariant {
 if(content===undefined)return variant;
 if(!object(content)||Object.keys(content).some(key=>key!=='blocks')||!Array.isArray(content.blocks)||content.blocks.length>CONTENT_LIMITS.blocks)contentError('INVALID_VALUE','Included content must contain an ordered block collection.');
 const source=new Map(variant.blocks.map(block=>[block.id,block]));const seen=new Set<string>();
 const blocks=(content.blocks as unknown[]).map((entry):ContentBlock=>{
  if(!object(entry)||typeof entry.id!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(entry.id))contentError('INVALID_VALUE','An included block requires a valid identity.');
  const row=entry as Record<string,unknown>;const id=row.id as string;
  if(seen.has(id))contentError('DUPLICATE','Included block identities must be unique.');seen.add(id);
  if(Object.keys(row).some(key=>!['id','definitionKey','schemaVersion','values','references','region','layoutKey'].includes(key)))contentError('INVALID_VALUE','Included content carries unsupported block properties.');
  const original=source.get(id);const name=row.definitionKey??original?.definitionKey;
  if(typeof name!=='string'||!registry[name])contentError('BLOCK_UNKNOWN','An included block requires an available block definition.');
  const values=row.values??original?.values;const references=row.references??original?.references??{};
  if(!object(values)||!object(references))contentError('INVALID_VALUE','Included block values and references must be objects.');
  const region=row.region??original?.region;
  if(region!==undefined&&!['body','header','footer'].includes(String(region)))contentError('INVALID_VALUE','An included block requires a valid page region.');
  const layoutKey=region&&region!=='body'?(row.layoutKey??original?.layoutKey):undefined;
  if(layoutKey!==undefined&&(typeof layoutKey!=='string'||!/^[a-z][A-Za-z0-9-]{0,63}$/.test(layoutKey)))contentError('INVALID_VALUE','An included block requires a valid page layout.');
  const block:ContentBlock={id,definitionKey:name as string,schemaVersion:Number(row.schemaVersion??original?.schemaVersion??registry[name as string]!.schemaVersion??1),values:values as JsonObject,references:references as ContentBlock['references'],...(region&&region!=='body'?{region:region as 'header'|'footer'}:{}),...(layoutKey?{layoutKey:layoutKey as string}:{}),...(original?.locked?{locked:true}:{})};
  if(original?.locked&&canonicalJson(block)!==canonicalJson(original))contentError('INVALID_VALUE','A locked source block cannot be changed.');
  return block;
 });
 const locked=variant.blocks.filter(block=>block.locked).map(block=>block.id);
 if(locked.some(id=>!seen.has(id)))contentError('INVALID_VALUE','A locked source block cannot be removed.');
 if(blocks.filter(block=>block.locked).some((block,index)=>block.id!==locked[index]))contentError('INVALID_VALUE','Locked source blocks must retain their order.');
 return {...variant,blocks};
}
