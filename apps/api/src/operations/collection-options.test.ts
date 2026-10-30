// SPDX-License-Identifier: BUSL-1.1
import {expect,test} from 'bun:test';
import {nativeCollectionOptionsHandler} from './collection-options.js';
const source={entity:'History',list:'History.list',fields:{actor:{type:'string',many:false},tags:{type:'string',many:true}}};
const op={key:'collection.options',plugin:'core',auth:{mode:'session'},tenancy:{mode:'required'},effects:{data:'read'},implementation:{type:'collection-options',sources:[source]}};
const definition={id:'History.list',intent:'list',input:{kind:'json-schema',schema:{properties:{filter:{}}}}};
const handler=nativeCollectionOptionsHandler(op as any);
test('suggestions preserve session, existing constraints and continuation; distinct values retain historical IDs',async()=>{
 const session={tenantId:'tenant-a'};let request:any;
 const result=await handler({entity:'History',field:'actor',search:'former',first:2,after:'cursor',filter:{category:{eq:'important'}}},{session,platform:{operations:{get:async(_session:any,id:string)=>[definition].find(d=>d.id===id),execute:async(s:any,r:any)=>{expect(s).toBe(session);request=r;return {data:{items:[{actor:'former-user'},{actor:'former-user'}],nextCursor:'next'}};}}}} as any);
 expect(request.input).toEqual({first:2,after:'cursor',filter:{and:[{category:{eq:'important'}},{actor:{contains:'former'}}]}});
 expect(result).toEqual({value:{items:[{value:'former-user',label:'former-user'}],nextCursor:'next'}});
});
test('an unavailable entity and undeclared field cannot be enumerated',async()=>{
 for(const [field,definitions] of [['actor',[]],['secret',[definition]]] as const){
  let called=false;await expect(handler({entity:'History',field},{session:{tenantId:'other'},platform:{operations:{get:async(_session:any,id:string)=>definitions.find(d=>d.id===id),execute:async()=>{called=true;}}}} as any)).rejects.toThrow();expect(called).toBe(false);
 }
});
test('anonymous enumeration is refused before reading catalogue',async()=>{await expect(handler({entity:'History',field:'actor'},{} as any)).rejects.toThrow();});
test('canonical list refusal is not converted to empty choices',async()=>{await expect(handler({entity:'History',field:'actor'},{session:{tenantId:'t'},platform:{operations:{get:async(_session:any,id:string)=>[definition].find(d=>d.id===id),execute:async()=>({error:{code:'FORBIDDEN',message:'Denied'}})}}} as any)).rejects.toThrow();});
test('collection members become individual choices',async()=>{
 const result=await handler({entity:'History',field:'tags'},{session:{tenantId:'t'},platform:{operations:{get:async(_session:any,id:string)=>[definition].find(d=>d.id===id),execute:async()=>({data:{items:[{tags:['one','two']},{tags:['two']}],nextCursor:null}})}}} as any);
 expect(result).toEqual({value:{items:[{value:'one',label:'one'},{value:'two',label:'two'}],nextCursor:null}});
});
test('private resource choices use their authorized localized label projection',async()=>{
 const read={id:'fixture.get',intent:'get',input:{kind:'json-schema',schema:{}}};
 const localized=nativeCollectionOptionsHandler(op as any,[{name:'fixture',realtimeResources:[{
  entity:'PrivateFixture',readOperationId:'fixture.get',idInputField:'recordId',
  labelFields:{en:['localized.name.en','name'],nl:['localized.name.nl','name']},
 }]}] as any);
 const calls:any[]=[];
 const result=await localized({entity:'History',field:'actor',referenceEntity:'PrivateFixture',locale:'nl'},{session:{tenantId:'t'},platform:{operations:{
  get:async(_session:any,id:string)=>[definition,read].find(d=>d.id===id),
  execute:async(_session:any,request:any)=>{calls.push(request);return request.operation.id==='History.list'
   ?{data:{items:[{actor:'run-1'}],nextCursor:null}}
   :{data:{id:'run-1',name:'Approval',localized:{name:{en:'Approval',nl:'Goedkeuring'}}}};},
 }}} as any);
 expect(calls[1]).toMatchObject({operation:{id:'fixture.get'},input:{recordId:'run-1'}});
 expect(result).toEqual({value:{items:[{value:'run-1',label:'Goedkeuring'}],nextCursor:null}});
});
test('private resource choices retain the ID when the canonical read is denied',async()=>{
 const read={id:'fixture.get',intent:'get',input:{kind:'json-schema',schema:{}}};
 const localized=nativeCollectionOptionsHandler(op as any,[{name:'fixture',realtimeResources:[{
  entity:'PrivateFixture',readOperationId:'fixture.get',idInputField:'recordId',labelFields:{en:['name'],nl:['name']},
 }]}] as any);
 const result=await localized({entity:'History',field:'actor',referenceEntity:'PrivateFixture',locale:'en'},{session:{tenantId:'t'},platform:{operations:{
  get:async(_session:any,id:string)=>[definition,read].find(d=>d.id===id),execute:async(_session:any,request:any)=>request.operation.id==='History.list'
   ?{data:{items:[{actor:'run-1'}],nextCursor:null}}:{error:{code:'FORBIDDEN',message:'Denied'}},
 }}} as any);
 expect(result).toEqual({value:{items:[{value:'run-1',label:'run-1'}],nextCursor:null}});
});
test('security managers choose ceiling entities without a target read grant',async()=>{
 const {default:inventory}=await import('../generated/compiler/authorization-operations.json');
 const target=inventory.rows.find(row=>row.grantable)!.entity;
 const definition={id:'AuthorizationProfile.list',intent:'list',input:{kind:'json-schema',schema:{}}};
 const handler=nativeCollectionOptionsHandler({...op,implementation:{type:'collection-options',sources:[{entity:'AuthorizationProfile',list:definition.id,fields:{targetEntity:{type:'string',many:false}}},{entity:target,labels:{nl:'Beheerdoel'},list:target+'.list',fields:{}}]}} as any);
 const platform={operations:{get:async(_session:any,id:string)=>id===definition.id?definition:undefined}};
 const input={entity:'AuthorizationProfile',field:'targetEntity',catalog:'entities',locale:'nl',search:'Beheerdoel'};
 const result=await handler(input,{session:{tenantId:'tenant',roles:['Organization.Security.Manage']},platform} as any);
 expect(result).toEqual({value:{items:[{value:target,label:'Beheerdoel'}],nextCursor:null}});
 await expect(handler(input,{session:{tenantId:'tenant',roles:[]},platform} as any)).rejects.toMatchObject({operationError:{code:'FORBIDDEN'}});
});
