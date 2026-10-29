// SPDX-License-Identifier: BUSL-1.1
import {expect,test} from 'bun:test';
import {nativeApplicationSearchHandler,matchesSearch} from './application-search.js';
const source={entity:'Example',labels:{en:'Examples',nl:'Voorbeelden'},description:{en:'Tenant settings',nl:'Organisatie instellingen'},list:'Example.list',get:'Example.get',field:'name',descriptionField:'description'};
const operation={key:'application.search',plugin:'core',auth:{mode:'session'},tenancy:{mode:'required'},effects:{data:'read',external:'none'},implementation:{type:'application-search',sources:[source,{...source,entity:'Hidden',list:'Hidden.list'}]}};
test('both languages and descriptions are searched independently of display locale',()=>{
 expect(matchesSearch(source,'voorb')).toBe(true);expect(matchesSearch(source,'tenant settings')).toBe(true);expect(matchesSearch(source,'instellingen')).toBe(true);
});
test('only available sources are read, using canonical OR predicates and pagination',async()=>{
 const calls:any[]=[];
 const session={tenantId:'tenant',userId:'user'};
 const result=await nativeApplicationSearchHandler(operation as any)({query:'needle',locale:'nl',first:3},{session,platform:{operations:{
 list:async()=>[{id:'Example.list',input:{kind:'json-schema',schema:{properties:{filter:{},first:{}}}}},{id:'Example.get'}],
 execute:async(s:any,request:any)=>{expect(s).toBe(session);calls.push(request);return {data:{items:[{id:'one',name:'Result'}],nextCursor:'next'}}}
 }}} as any);
 expect(calls).toHaveLength(1);expect(calls[0].input).toEqual({first:3,filter:{or:[{name:{contains:'needle'}},{description:{contains:'needle'}}]}});
 expect(('value' in result)?result.value:null).toMatchObject({groups:[{entity:'Example',items:[{id:'one',label:'Result'}],nextCursor:'next'}],incomplete:false});
});
test('empty input lists readable catalogue without reading records',async()=>{
 const result=await nativeApplicationSearchHandler(operation as any)({locale:'nl'},{session:{tenantId:'t'},platform:{operations:{list:async()=>[{id:'Example.list'}],execute:()=>{throw Error('Must not read')}}}} as any);
 expect(('value' in result)?result.value:null).toEqual({entities:[{entity:'Example',label:'Voorbeelden'}],groups:[],incomplete:false});
});

// A catalog-backed collection page: the compiler emits it without `field`,
// `get` or `descriptionField` (catalogApplicationSearchSources), so the one
// thing it can be is a page to match.
const page={entity:'AccessRole',labels:{en:'Roles',nl:'Rollen'},description:{en:'Who may do what.',nl:'Wie wat mag.'},list:'accounts.list-roles'};
const withPage={...operation,implementation:{type:'application-search',sources:[source,page,{...page,entity:'HiddenPage',list:'hidden.list-roles'}]}};
const listed=(...ids:string[])=>ids.map(id=>id==='Example.list'?{id,input:{kind:'json-schema',schema:{properties:{filter:{},first:{}}}}}:{id});

test('a catalog-backed collection page is matched in either language and never read as a record',async()=>{
 const calls:any[]=[];
 const result=await nativeApplicationSearchHandler(withPage as any)({query:'ROLLEN',locale:'en'},{session:{tenantId:'t',userId:'u'},platform:{operations:{
  list:async()=>listed('Example.list','Example.get','accounts.list-roles'),
  execute:async(_session:any,request:any)=>{calls.push(request);return {data:{items:[]}}}
 }}} as any);
 // Labelled in the requested locale, matched on the authored Dutch title in
 // any case; the page itself is never executed.
 expect(('value' in result)?result.value:null).toEqual({entities:[{entity:'AccessRole',label:'Roles'}],groups:[],incomplete:false});
 expect(calls.map(call=>call.operation.id)).toEqual(['Example.list']);
 // The core source still reads with the same canonical filter it read with
 // before a page source stood beside it.
 expect(calls[0].input).toEqual({first:5,filter:{or:[{name:{contains:'ROLLEN'}},{description:{contains:'ROLLEN'}}]}});
});

test('a page whose list Operation this session cannot invoke is neither offered nor named',async()=>{
 const result=await nativeApplicationSearchHandler(withPage as any)({query:'rollen'},{session:{tenantId:'t',userId:'u'},platform:{operations:{
  list:async()=>[],execute:()=>{throw Error('Must not read')}
 }}} as any);
 expect(('value' in result)?result.value:null).toEqual({entities:[],groups:[],incomplete:false});
 // Not even the authored label of a page this session may not list.
 expect(JSON.stringify(result)).not.toContain('Rollen');
});

test('a page is withheld without a verified tenant',async()=>{
 await expect(nativeApplicationSearchHandler(withPage as any)({query:'rollen'},{session:{userId:'u'},platform:{operations:{
  list:async()=>{throw Error('Must not list')},execute:()=>{throw Error('Must not read')}
 }}} as any)).rejects.toMatchObject({operationError:{code:'UNAUTHENTICATED'}});
});

test('the pages on offer come from the verified session, not from the input',async()=>{
 const session={tenantId:'t',userId:'u',roles:['Example.Read']};
 const seen:any[]=[];
 const result=await nativeApplicationSearchHandler(withPage as any)(
  {query:'rollen',roles:['Organization.Access.Manage'],session:{tenantId:'other',roles:['Organization.Access.Manage']}} as any,
  {session,platform:{operations:{list:async(given:any)=>{seen.push(given);return []},execute:()=>{throw Error('Must not read')}}}} as any);
 expect(seen).toHaveLength(1);
 expect(seen[0]).toBe(session);
 expect(('value' in result)?result.value:null).toEqual({entities:[],groups:[],incomplete:false});
});

test('opt-in timing reports source durations without inputs, identity or results',async()=>{
 const previous=process.env.OSF_SEARCH_TIMING; const info=console.info; const lines:string[]=[];
 process.env.OSF_SEARCH_TIMING='1'; console.info=(line:unknown)=>lines.push(String(line));
 try{
  await nativeApplicationSearchHandler(operation as any)({query:'private-query',locale:'nl'}, {session:{tenantId:'private-tenant'},platform:{operations:{
   list:async()=>listed('Example.list','Example.get'),execute:async()=>({data:{items:[{id:'private-id',name:'private-label'}]}})
  }}} as any);
  const entries=lines.map(line=>JSON.parse(line));
  expect(entries.map(entry=>entry.event)).toEqual(['application-search.catalog','application-search.source','application-search.complete']);
  expect(entries[1]).toMatchObject({entity:'Example',outcome:'success'});
  expect(entries[1].durationMs).toBeGreaterThanOrEqual(0);
  expect(new Set(entries.map(entry=>entry.measurementId)).size).toBe(1);
  expect(lines.join(' ')).not.toMatch(/private-query|private-tenant|private-id|private-label/);
 }finally{console.info=info; if(previous===undefined)delete process.env.OSF_SEARCH_TIMING;else process.env.OSF_SEARCH_TIMING=previous;}
});

test('timing is disabled unless explicitly enabled',async()=>{
 const previous=process.env.OSF_SEARCH_TIMING; const info=console.info; const lines:string[]=[];
 console.info=(line:unknown)=>lines.push(String(line));
 try{
  for(const flag of [undefined,'0']){
   if(flag===undefined)delete process.env.OSF_SEARCH_TIMING;else process.env.OSF_SEARCH_TIMING=flag;
   await nativeApplicationSearchHandler(operation as any)({query:'needle'}, {session:{tenantId:'t'},platform:{operations:{
    list:async()=>listed('Example.list','Example.get'),execute:async()=>({data:{items:[]}})
   }}} as any);
  }
  expect(lines).toEqual([]);
 }finally{console.info=info;if(previous===undefined)delete process.env.OSF_SEARCH_TIMING;else process.env.OSF_SEARCH_TIMING=previous;}
});

test('timing reports skipped catalogue sources and completes empty searches',async()=>{
 const previous=process.env.OSF_SEARCH_TIMING;const info=console.info;const lines:string[]=[];
 process.env.OSF_SEARCH_TIMING='1';console.info=(line:unknown)=>lines.push(String(line));
 try{
  const context={session:{tenantId:'t'},platform:{operations:{list:async()=>listed('accounts.list-roles'),execute:()=>{throw Error('Must not read')}}}} as any;
  await nativeApplicationSearchHandler(withPage as any)({query:'roles'},context);
  const entries=lines.map(line=>JSON.parse(line));
  expect(entries.find(e=>e.event==='application-search.source')).toMatchObject({entity:'AccessRole',outcome:'skipped',reason:'not-record-searchable'});
  expect(entries.at(-1)).toMatchObject({event:'application-search.complete',selectedSources:1});
  lines.length=0;
  await nativeApplicationSearchHandler(withPage as any)({query:''},context);
  expect(JSON.parse(lines.at(-1)!)).toMatchObject({event:'application-search.complete',selectedSources:0});
 }finally{console.info=info;if(previous===undefined)delete process.env.OSF_SEARCH_TIMING;else process.env.OSF_SEARCH_TIMING=previous;}
});
