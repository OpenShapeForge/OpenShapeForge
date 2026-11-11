// SPDX-License-Identifier: BUSL-1.1
import {test, expect} from 'bun:test';
import {deriveTypedValue} from './derive-typed-values.js';
const schema = {type:'array',items:{type:'object',properties:{key:{type:'string',maxLength:64,'x-osf-derive-on-create':{from:'name',transform:'slug',onConflict:'suffix'}},name:{type:'string'}}}};
test('names allocate unique stable identities and preserve them across reorder and rename',()=>{
 const original=deriveTypedValue(schema,[{name:'Mérkblauw'},{name:'Mérkblauw'},{name:'2027'}]) as any[];
 expect(original.map(row=>row.key)).toEqual(['merkblauw','merkblauw-2','item-2027']);
 expect(deriveTypedValue(schema,[{...original[1],name:'Nachtblauw'},original[0],{name:'Merkblauw'}],original)).toEqual([{key:'merkblauw-2',name:'Nachtblauw'},original[0],{key:'merkblauw-3',name:'Merkblauw'}]);
 expect(()=>deriveTypedValue(schema,[{key:'arbitrary',name:'Blue'}])).toThrow();
 expect(()=>deriveTypedValue(schema,[original[0],original[0]],original)).toThrow();
 expect(()=>deriveTypedValue(schema,[{name:''}])).toThrow();
});
test('same YAML rule works for a second typed object such as a named section',()=>{
 const object=schema.items;
 const created=deriveTypedValue(object,{name:'First section'});
 expect(created).toEqual({name:'First section',key:'first-section'});
 expect(deriveTypedValue(object,{name:'Renamed'},created)).toEqual({name:'Renamed',key:'first-section'});
});
