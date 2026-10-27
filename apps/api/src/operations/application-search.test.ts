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
 expect(result.value).toMatchObject({groups:[{entity:'Example',items:[{id:'one',label:'Result'}],nextCursor:'next'}],incomplete:false});
});
test('empty input lists readable catalogue without reading records',async()=>{
 const result=await nativeApplicationSearchHandler(operation as any)({locale:'nl'},{session:{tenantId:'t'},platform:{operations:{list:async()=>[{id:'Example.list'}],execute:()=>{throw Error('Must not read')}}}} as any);
 expect(result.value).toEqual({entities:[{entity:'Example',label:'Voorbeelden'}],groups:[],incomplete:false});
});
