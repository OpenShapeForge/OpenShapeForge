import {test,expect} from 'bun:test';
import {migrateColumnBlocks} from './column-blocks.js';
import {sourceRecord,blockHash} from '../content/inclusion-copy.js';
import type {ContentBlock} from '../content/types.js';
test('migrates snapshot rows and unchanged locked baselines without losing a local edit',async()=>{
 const block:ContentBlock={id:'approval',definitionKey:'TextColumns',schemaVersion:1,values:{left:'Supplier',right:'Client',leftStyle:'body',distribution:'fill'},references:{},locked:true};
 const copy={source:await sourceRecord([block]),blocks:[block]};
 const result=await migrateColumnBlocks({row:{definition_key:'TextColumns',values:block.values},copy}) as any;
 expect(result.row.values.left[0].values).toEqual({markdown:'Supplier',style:'body'});
 expect(result.row.values.leftStyle).toBeUndefined();
 expect(result.copy.source[0].hash).toBe(await blockHash(result.copy.blocks[0]));
 expect(await migrateColumnBlocks(result)).toEqual(result);
 const divergent={source:copy.source,blocks:[{...block,values:{...block.values,left:'Local edit'}}]};
 expect((await migrateColumnBlocks(divergent) as any).source).toEqual(copy.source);
});
