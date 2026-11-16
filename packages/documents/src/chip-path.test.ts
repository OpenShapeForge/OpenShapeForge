import {test,expect} from 'bun:test';
import {chipResolver} from './content-runtime.js';
const tenant='11111111-1111-4111-8111-111111111111',chipId='22222222-2222-4222-8222-222222222222',recordId='33333333-3333-4333-8333-333333333333';
const context={} as any;
const pathResult={root:{entity:'Relation',id:recordId},path:'displayName',shape:{baseType:'string',osfType:'string'},value:'Example',sources:[{entity:'Relation',id:recordId,versionId:'v2'}]} as any;
function fixture(key='company.client',value:unknown=recordId){
 const queries:any[]=[];const reads:string[]=[];const paths:any[]=[];
 const trx={executeQuery:async(query:any)=>{queries.push(query);return {rows:[{id:chipId}]};}};
 const read=async(entity:string)=>{reads.push(entity);return {key,updatedAt:'v1',definition:{key:'value'},value};};
 const resolve=chipResolver(trx,tenant,read,()=>({baseType:'string',osfType:'Relation',relationship:{target:'Relation'}} as any),async(root,path)=>{paths.push({root,path});return pathResult;});
 return {resolve,queries,reads,paths};
}
test('a reference chip follows canonical authorized paths and retains record versions',async()=>{
 const f=fixture();expect(await f.resolve('company.client.displayName',context)).toMatchObject({tenantId:tenant,sourceId:chipId,shape:pathResult.shape,value:'Example',sources:pathResult.sources});
 expect(f.queries[0].parameters).toEqual([tenant,'company.client.displayName']);expect(f.queries[0].sql).toContain('order by length(key) desc');expect(f.reads).toEqual(['Chip']);expect(f.paths).toEqual([{root:pathResult.root,path:'displayName'}]);
});
test('an exact dotted chip key remains literal and is not followed',async()=>{
 const f=fixture('company.client.displayName','Literal');expect(await f.resolve('company.client.displayName',context)).toMatchObject({value:'Literal'});expect(f.paths).toEqual([]);
});
test('denied chip or path reads disclose no replacement value',async()=>{
 const trx={executeQuery:async()=>({rows:[{id:chipId}]})};
 const denied=chipResolver(trx,tenant,async()=>null,()=>({baseType:'string'}));expect(await denied('company.client',context)).toBeNull();
 const noPath=chipResolver(trx,tenant,async()=>({key:'company.client',definition:{key:'value'},updatedAt:'v1',value:recordId}),()=>({baseType:'string',relationship:{target:'Relation'}} as any),async()=>null);expect(await noPath('company.client.displayName',context)).toBeNull();
});
