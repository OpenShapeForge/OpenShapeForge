// SPDX-License-Identifier: BUSL-1.1
import {expect,test} from 'bun:test';
import {nativeCollectionOptionsHandler} from './collection-options.js';
const source={entity:'History',list:'History.list',fields:{actor:{type:'string',many:false},tags:{type:'string',many:true}}};
const op={key:'collection.options',plugin:'core',auth:{mode:'session'},tenancy:{mode:'required'},effects:{data:'read'},implementation:{type:'collection-options',sources:[source]}};
const definition={id:'History.list',intent:'list',input:{kind:'json-schema',schema:{properties:{filter:{}}}}};
const handler=nativeCollectionOptionsHandler(op as any);
test('suggestions preserve session, existing constraints and continuation; distinct values retain historical IDs',async()=>{
 const session={tenantId:'tenant-a'};let request:any;
 const result=await handler({entity:'History',field:'actor',search:'former',first:2,after:'cursor',filter:{category:{eq:'important'}}},{session,platform:{operations:{list:async()=>[definition],execute:async(s:any,r:any)=>{expect(s).toBe(session);request=r;return {data:{items:[{actor:'former-user'},{actor:'former-user'}],nextCursor:'next'}};}}}} as any);
 expect(request.input).toEqual({first:2,after:'cursor',filter:{and:[{category:{eq:'important'}},{actor:{contains:'former'}}]}});
 expect(result).toEqual({value:{items:[{value:'former-user',label:'former-user'}],nextCursor:'next'}});
});
test('an unavailable entity and undeclared field cannot be enumerated',async()=>{
 for(const [field,definitions] of [['actor',[]],['secret',[definition]]] as const){
  let called=false;await expect(handler({entity:'History',field},{session:{tenantId:'other'},platform:{operations:{list:async()=>definitions,execute:async()=>{called=true;}}}} as any)).rejects.toThrow();expect(called).toBe(false);
 }
});
test('anonymous enumeration is refused before reading catalogue',async()=>{await expect(handler({entity:'History',field:'actor'},{} as any)).rejects.toThrow();});
test('canonical list refusal is not converted to empty choices',async()=>{await expect(handler({entity:'History',field:'actor'},{session:{tenantId:'t'},platform:{operations:{list:async()=>[definition],execute:async()=>({error:{code:'FORBIDDEN',message:'Denied'}})}}} as any)).rejects.toThrow();});
test('collection members become individual choices',async()=>{
 const result=await handler({entity:'History',field:'tags'},{session:{tenantId:'t'},platform:{operations:{list:async()=>[definition],execute:async()=>({data:{items:[{tags:['one','two']},{tags:['two']}],nextCursor:null}})}}} as any);
 expect(result).toEqual({value:{items:[{value:'one',label:'one'},{value:'two',label:'two'}],nextCursor:null}});
});
