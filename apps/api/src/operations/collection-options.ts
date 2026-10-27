// SPDX-License-Identifier: BUSL-1.1
import {operationFailure} from '@openshapeforge/operations';
import type {ModuleOperationHandler} from '../modules/contract.js';
import type {OperationContract} from './runtime.js';
import {getGeneratedCrudTables,assertClassifiedQueryAllowed,assertElicitedQueryAllowed} from './entity/catalog.js';
import {assertBoundFieldQueryAllowed} from './entity/field-bindings.js';
export function nativeCollectionOptionsHandler(operation:OperationContract):ModuleOperationHandler {
 if(operation.key!=='collection.options'||operation.plugin!=='core'||operation.implementation?.type!=='collection-options'||operation.auth.mode!=='session'||operation.tenancy.mode!=='required'||operation.effects?.data!=='read')throw Error('Invalid collection options binding.');
 const sources=operation.implementation.sources;
 return async(input,{session,platform})=>{
  if(!session?.tenantId||!platform)throw operationFailure({code:'UNAUTHENTICATED',message:'Select an organization.'});
  const definitions=await platform.operations.list(session), available=new Map(definitions.map(d=>[d.id,d]));
  const source=sources.find(s=>s.entity===input.entity&&available.has(s.list));
  const field=typeof input.field==='string'?input.field:'';
  if(!source||!Object.hasOwn(source.fields,field))throw operationFailure({code:'FORBIDDEN',message:'This filter source is unavailable.'});
  const table=getGeneratedCrudTables().find(t=>t.source?.authoringEntityName===source.entity);
  if(table){const probe={filter:{[field]:''}};assertClassifiedQueryAllowed(table,session,probe);assertElicitedQueryAllowed(table,probe);assertBoundFieldQueryAllowed(table,probe);}
  const search=typeof input.search==='string'?input.search.trim():'';
  const first=typeof input.first==='number'?input.first:25;
  const definition=available.get(source.list)!;
  const schema=(definition.input.kind==='json-schema'?definition.input.schema:definition.input) as Record<string,any>;
  const structured=!!table||!!schema?.properties?.filter;
  if(!structured)throw operationFailure({code:'INVALID_INPUT',message:'This list does not support structured value suggestions.'});
  const candidates=new Map<string,string>();
  if(!input.after&&input.referenceEntity&&search){
   const ref=sources.find(s=>s.entity===input.referenceEntity&&available.has(s.list));
   if(ref&&available.has('application.search')){
    const response=await platform.operations.execute(session,{operation:{id:'application.search',intent:'invoke'},input:{query:search,entity:ref.entity,locale:input.locale??'en',first:20}});
    if('error'in response)throw operationFailure(response.error);
    for(const group of (response.data as any).groups??[])for(const item of group.items)candidates.set(item.id,item.label);
   }
  }
  if(!input.after&&input.catalog==='operations')for(const d of definitions){
   const title=typeof d.name==='string'?d.name:d.name?.[input.locale==='nl'?'nl':'en']??d.id;
   if(!search||`${d.id} ${title}`.toLowerCase().includes(search.toLowerCase()))candidates.set(d.id,title);
  }
  const spec=source.fields[field]!;
  const typedFilter=search?(spec.many?{[field]:{contains:search}}:spec.type==='string'?{[field]:{contains:search}}:{[field]:{eq:search}}):undefined;
  const clauses=[input.filter,typedFilter].filter(Boolean);
  const params={...(clauses.length?{filter:clauses.length===1?clauses[0]:{and:clauses}}:{}),...(table?{limit:first,cursor:input.after}:{first,after:input.after})};
  const response=await platform.operations.execute(session,{operation:{id:source.list,intent:definition.intent??'list'},input:Object.fromEntries(Object.entries(params).filter(([,v])=>v!==undefined))});
  if('error'in response)throw operationFailure(response.error);
  const data=response.data as any;
  for(const row of data.items??[]){const value=(row.data??row)[field];for(const entry of Array.isArray(value)?value:[value])if(['string','number','boolean'].includes(typeof entry))candidates.set(String(entry),candidates.get(String(entry))??String(entry));}
  return {value:{items:[...candidates].map(([value,label])=>({value,label})),nextCursor:data.nextCursor??null}};
 };
}
