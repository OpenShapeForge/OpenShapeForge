// SPDX-License-Identifier: BUSL-1.1
import {expect,test} from 'bun:test';
import {copyBlueprintGraph,planBlueprintGraph,type BlueprintGraphRecord} from './blueprint-graph.js';
const record=(entity:string,sourceId:string,values:Record<string,unknown>={},references:BlueprintGraphRecord['references']={}):BlueprintGraphRecord=>({entity,sourceId,values,references});
test('Copy values and reconnect parents, formula references and external periods',async()=>{
 const graph=[record('Term','term',{coefficient:-1},{line:{entity:'Line',sourceId:'result'},source:{entity:'Line',sourceId:'cost'}}),record('Value','value',{amount:'120000'},{line:{entity:'Line',sourceId:'cost'},period:{entity:'Period',sourceId:'source-jan'}}),record('Line','cost',{name:'Hosting'},{budget:{entity:'Budget',sourceId:'budget'},parent:{entity:'Line',sourceId:'group'}}),record('Line','result',{name:'Profit'},{budget:{entity:'Budget',sourceId:'budget'}}),record('Line','group',{name:'COGS'},{budget:{entity:'Budget',sourceId:'budget'}}),record('Budget','budget',{name:'Budget 2027'})];
 const written:{entity:string;values:Record<string,unknown>;id:string}[]=[];
 await copyBlueprintGraph(graph,{Period:{'source-jan':'destination-jan'}},{create:async(entity,values)=>{const id='new-'+written.length;written.push({entity,values,id});return id;}});
 const find=(name:string)=>written.find(r=>r.values.name===name)!;
 expect(find('Hosting').values.parent).toBe(find('COGS').id);
 expect(written.find(r=>r.entity==='Term')!.values.source).toBe(find('Hosting').id);
 expect(written.find(r=>r.entity==='Value')!.values).toMatchObject({amount:'120000',period:'destination-jan'});
 expect(written.filter(r=>r.values.budget).every(r=>r.values.budget===find('Budget 2027').id)).toBe(true);
});
test('Same mechanism copies an unrelated Proposal with sections and priced items',async()=>{
 const writes:any[]=[];
 await copyBlueprintGraph([record('Item','i',{price:'99.50'},{section:{entity:'Section',sourceId:'s'}}),record('Section','s',{title:'Services'},{proposal:{entity:'Proposal',sourceId:'p'}}),record('Proposal','p',{title:'Standard'})],{}, {create:async(entity,values)=>{const id='copy-'+writes.length;writes.push({entity,values,id});return id;}});
 expect(writes.map(r=>r.entity)).toEqual(['Proposal','Section','Item']);expect(writes[2].values).toEqual({price:'99.50',section:'copy-1'});
});
test('Missing external binding, duplicate identity and cycles fail before creating anything',async()=>{
 let writes=0;const adapter={create:async()=>{writes++;return'new';}};
 for(const graph of [[record('A','a',{}, {customer:{entity:'Customer',sourceId:'outside'}})],[record('A','a'),record('A','a')],[record('A','a',{}, {self:{entity:'A',sourceId:'a'}})]]) await expect(copyBlueprintGraph(graph,{},adapter)).rejects.toThrow();
 expect(writes).toBe(0);
});
test('Scalar values cannot smuggle source relationship identities',()=>{
 expect(()=>planBlueprintGraph([record('A','a',{parent:'source'},{parent:null})])).toThrow('scalar');
});
