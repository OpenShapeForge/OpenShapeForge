// SPDX-License-Identifier: BUSL-1.1
import { operationFailure } from '@openshapeforge/operations';
import type { ModuleOperationHandler } from '../modules/contract.js';
import type { OperationContract } from './runtime.js';
import { getGeneratedCrudTables, assertClassifiedQueryAllowed, assertElicitedQueryAllowed } from './entity/catalog.js';
import { fieldColumnMap } from './entity/columns.js';
import { assertBoundFieldQueryAllowed } from './entity/field-bindings.js';
import { labelSearchable, labelSourceOperation, readLabelPages, type LabelPage, type LabelSource } from './entity/label-search.js';
import { auditContext, runWithAuditContext } from '../platform/audit-context.js';

type Source=Extract<NonNullable<OperationContract['implementation']>,{type:'application-search'}>['sources'][number];
const text=(value:unknown):string[]=>typeof value==='string'?[value]:value&&typeof value==='object'?Object.values(value).filter((v):v is string=>typeof v==='string'):[];
const words=(value:string)=>value.replace(/([a-z])([A-Z])/g,'$1 $2').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
export function matchesSearch(source:Source,query:string) {
  const haystack=[source.entity,...text(source.labels),...text(source.description)].join(' ').toLowerCase();
  return words(query).every(word=>haystack.includes(word)||(['s','en'].some(ending=>word.length>ending.length+2&&word.endsWith(ending)&&haystack.includes(word.slice(0,-ending.length)))));
}
export function nativeApplicationSearchHandler(operation:OperationContract):ModuleOperationHandler {
  if(operation.key!=='application.search'||operation.plugin!=='core'||operation.implementation?.type!=='application-search'
    ||operation.auth.mode!=='session'||operation.tenancy.mode!=='required'||operation.effects?.data!=='read')throw Error('Invalid application search binding.');
  const sources=operation.implementation.sources;
  return async(input,{session,platform})=>{
    if(!session?.tenantId||!platform)throw operationFailure({code:'UNAUTHENTICATED',message:'Select an organization.'});
    const query=typeof input.query==='string'?input.query.trim():'';
    const locale=input.locale==='nl'?'nl':'en';
    const first=typeof input.first==='number'?input.first:5;
    const definitions=(await Promise.all([...new Set(sources.map(source=>source.list))].map(id=>platform.operations.get(session,id)))).filter((definition):definition is NonNullable<typeof definition>=>!!definition);
    const available=new Map(definitions.map(d=>[d.id,d]));
    const visible=sources.filter(s=>available.has(s.list));
    const entities=visible.filter(s=>matchesSearch(s,query)).map(s=>({entity:s.entity,label:s.labels[locale]??s.entity}));
    if(!query)return {value:{entities,groups:[],incomplete:false}};
    if(input.entity&&!visible.some(s=>s.entity===input.entity))return {value:{entities:[],groups:[],incomplete:false}};
    const selected=visible.filter(s=>!input.entity||s.entity===input.entity);
    const groups: Array<{entity:string;items:Array<{id:string;label:string}>;nextCursor:string|null}>=[];
    let incomplete=false,index=0;
    // What each source would ask its list Operation, decided once for both read paths.
    const exactId=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(query);
    const plans=selected.flatMap(source=>{
      if(!source.field)return [];
      const table=getGeneratedCrudTables().find(t=>t.source?.authoringEntityName===source.entity);
      const readable=(field:string)=>{
        if(!table)return true;
        try{const probe={filter:{[field]:query}};assertClassifiedQueryAllowed(table,session,probe);assertElicitedQueryAllowed(table,probe);assertBoundFieldQueryAllowed(table,probe);return true;}catch{return false;}
      };
      if(!readable(source.field))return [];
      const columns=table?fieldColumnMap(table):undefined;
      const fields=[source.field,...(source.descriptionField?[source.descriptionField]:[])].filter(field=>
        readable(field)&&(!columns||columns.get(field)?.type==='text'||(exactId&&columns.get(field)?.type==='uuid')));
      if(!fields.length)return [];
      const predicates=fields.map(field=>({[field]:columns?.get(field)?.type==='uuid'?{eq:query}:{contains:query}}));
      return [{source,field:source.field,table,predicates}];
    });
    // The first page of every persisted source is one statement in one
    // transaction: each branch is that entity's own list read, under its own
    // list Operation state, which this Operation declares as a read
    // dependency. A continuation, an Operation-backed source and anything the
    // combined read does not take still go through the canonical Operation.
    const audit=auditContext();
    const combined=audit&&!input.after&&typeof (platform as {db?:{withSession?:unknown}}).db?.withSession==='function'?plans.filter(plan=>plan.table&&labelSearchable(plan.table)):[];
    let pages:Map<string,LabelPage>|undefined;
    if(combined.length){
      const labelSources:LabelSource[]=combined.map(plan=>({key:plan.source.entity,table:plan.table!,filter:{or:plan.predicates},labelField:plan.field}));
      const readOperations=[...new Set([...(audit!.readOperations??[]),...labelSources.map(entry=>labelSourceOperation(entry.table))])];
      try{
        pages=await runWithAuditContext({...audit!,readOperations},()=>platform.db.withSession(session,trx=>readLabelPages(trx,session,labelSources,first)));
      }catch(error){
        // Nothing was returned from the failed statement; every source is read again on its own.
        console.warn('[application-search] combined read failed',(error as {code?:string})?.code??'UNEXPECTED');
      }
      for(const [entity,page] of pages??[])groups.push({entity,...page});
    }
    const remaining=pages?plans.filter(plan=>!combined.includes(plan)):plans;
    // Bounded concurrency; every read is still the canonical Operation, with the live session.
    await Promise.all(Array.from({length:Math.min(4,remaining.length)},async()=>{
      while(index<remaining.length){
        const {source,table,predicates}=remaining[index++]!;
        const definition=available.get(source.list)!;
        const schema=(definition.input.kind==='json-schema'?definition.input.schema:definition.input) as Record<string,any>;
        const properties=schema?.properties??{};
        // All persisted CRUD uses the same structured filter. Operation sources advertise their own query shape.
        const structured=!!table||!!properties.filter;
        const request=structured?{filter:{or:predicates},...(table||'limit'in properties?{limit:first,cursor:input.after}:{first,after:input.after})}
          :{first,after:input.after,[source.field!]:query};
        try{
          const result=await platform.operations.execute(session,{operation:{id:source.list,intent:definition.intent??'list'},input:Object.fromEntries(Object.entries(request).filter(([,v])=>v!==undefined))});
          if('error' in result)throw {operationError:result.error};
          const data=result.data as any;
          const items=(data?.items??[]).flatMap((row:any)=>{const value=row.data??row;return typeof value.id==='string'&&typeof value[source.field!]==='string'?[{id:value.id,label:value[source.field!]}]:[];});
          const nextCursor=data?.nextCursor??data?.pageInfo?.endCursor??null;
          if(items.length)groups.push({entity:source.entity,items,nextCursor:data?.pageInfo?.hasNextPage===false?null:nextCursor});
          if(!structured&&source.descriptionField)incomplete=true;
        }catch(error){
          const code=(error as any)?.operationError?.code;
          if(!['FORBIDDEN','ACCESS_DENIED','OPERATION_FORBIDDEN'].includes(code)){incomplete=true;console.warn('[application-search] source failed',source.entity,code??'UNEXPECTED');}
        }
      }
    }));
    return {value:{entities,groups:groups.sort((a,b)=>a.entity.localeCompare(b.entity)),incomplete}};
  };
}
