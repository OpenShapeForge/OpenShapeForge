// SPDX-License-Identifier: BUSL-1.1
import {expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
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

test('local component choices include the active host catalogue overrides',async()=>{
 const root=mkdtempSync(join(tmpdir(),'osf-local-catalog-'));
 const keys=['CI','GITHUB_ACTIONS','RELEASE_SHA'] as const;
 const original=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 try{
  for(const key of keys)delete process.env[key];
  mkdirSync(join(root,'host/catalogs'),{recursive:true});
  writeFileSync(join(root,'authoring.config.yaml'),Bun.YAML.stringify({layers:[resolve(import.meta.dir,'../../config/authoring'),'host']}));
  writeFileSync(join(root,'host/catalogs/components.yaml'),'components:\n  Input:\n    description: Host input description\n  HostField:\n    kind: field\n    description: Host supplied field\n');
  const result=await collectLocalWebAuthoring(root,[],'host/entities');
  expect(result.components).toContainEqual({name:'HostField',description:'Host supplied field'});
  expect(result.components).toContainEqual({name:'Input',description:'Host input description'});
 }finally{
  for(const key of keys){if(original[key]===undefined)delete process.env[key];else process.env[key]=original[key];}
  rmSync(root,{recursive:true,force:true});
 }
});
