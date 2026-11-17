// SPDX-License-Identifier: BUSL-1.1
/** One-time representation migration. Never used as a reader or editor fallback. */
import { blockHash, parseContentBlock } from '../content/inclusion-copy.js';
const object=(v:unknown):v is Record<string,unknown>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v));
export async function migrateColumnBlocks(input: unknown): Promise<unknown> {
 if(Array.isArray(input))return Promise.all(input.map(migrateColumnBlocks));
 if(!object(input))return input;
 const next:Record<string,unknown>={};
 for(const [key,value] of Object.entries(input))next[key]=await migrateColumnBlocks(value);
 if((input.definitionKey??input.definition_key)==='TextColumns'){
  const materialization = object(next.materialization) && object(next.materialization.result) ? next.materialization.result.value : undefined;
  for (const values of [next.values,next.authoredValues,materialization]) {
  if (!object(values)) continue;
  for(const slot of ['left','center','right']){
   if(typeof values[slot]==='string')values[slot]=(values[slot] as string).trim()?[{id:`column-${slot}-text`,definitionKey:'TextBlock',schemaVersion:1,values:{markdown:values[slot],...(typeof values[`${slot}Style`]==='string'?{style:values[`${slot}Style`]}:{})},references:{}}]:[];
   delete values[`${slot}Style`];
  }
  }
 }
 // Only an unchanged baseline can be re-fingerprinted from the current block.
 // A divergent block remains divergent; its absent original is never invented.
 if(Array.isArray(input.source)&&Array.isArray(input.blocks)&&Array.isArray(next.source)&&Array.isArray(next.blocks)){
  const original=new Map(input.blocks.filter(object).map(block=>[block.id,block]));
  const migrated=new Map(next.blocks.filter(object).map(block=>[block.id,block]));
  next.source=await Promise.all(input.source.map(async entry=>{
   if(!object(entry))return entry;
   const old=original.get(entry.id),now=migrated.get(entry.id);
   if(!old||!now)return entry;
   const oldBlock=parseContentBlock(old,undefined),newBlock=parseContentBlock(now,undefined);
   return entry.hash===await blockHash(oldBlock)?{...entry,hash:await blockHash(newBlock)}:entry;
  }));
 }
 return next;
}
