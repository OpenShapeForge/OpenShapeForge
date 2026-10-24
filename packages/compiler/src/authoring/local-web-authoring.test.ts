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
 const keys=['CI','GITHUB_ACTIONS','RELEASE_SHA'] as const;
 const original=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 try{
  for(const key of keys)delete process.env[key];
  await expect(collectLocalWebAuthoring('/host',[],'../outside')).rejects.toThrow('inside the host');
 }finally{for(const key of keys){if(original[key]===undefined)delete process.env[key];else process.env[key]=original[key];}}
});
test('form schema resolves from the installed compiler without host-owned copies',()=>{
 const schema=resolvedWebInterfaceSchema();
 expect(schema).toHaveProperty('properties');
 expect(JSON.stringify(schema)).not.toContain('"$ref"');
});
