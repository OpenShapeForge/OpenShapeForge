// SPDX-License-Identifier: BUSL-1.1
import {expect,test} from 'bun:test';
import {collectLocalWebAuthoring} from './local-web-authoring.js';
import {resolvedWebInterfaceSchema} from './web-interface-schema.js';

test('source export refuses CI before reading host files',async()=>{
 const original=process.env.CI;process.env.CI='true';
 try{await expect(collectLocalWebAuthoring('/not-a-host',[],'authoring')).rejects.toThrow('forbidden');}
 finally{if(original===undefined)delete process.env.CI;else process.env.CI=original;}
});
test('source target cannot escape the host',async()=>{
 await expect(collectLocalWebAuthoring('/host',[],'../outside')).rejects.toThrow('inside the host');
});
test('form schema resolves from the installed compiler without host-owned copies',()=>{
 const schema=resolvedWebInterfaceSchema();
 expect(schema).toHaveProperty('properties');
 expect(JSON.stringify(schema)).not.toContain('"$ref"');
});
