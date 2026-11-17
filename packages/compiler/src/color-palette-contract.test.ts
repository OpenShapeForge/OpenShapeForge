// SPDX-License-Identifier: BUSL-1.1
import {collectAuthoredEntityPluginOperations} from "./generate-operations.js";
import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {parse} from 'yaml';
import {operationFieldObjectSchema} from '@openshapeforge/operations';

test('tenant palette projects editable named color rows through the shared field contract',()=>{
 const types=parse(readFileSync(new URL('../config/authoring/catalogs/osf-types.yaml',import.meta.url),'utf8')).types;
 const schema=operationFieldObjectSchema([{key:'value',osfType:'colorPalette'}],{osfTypes:types}) as any;
 const colors=schema.properties.value.properties.colors;
 expect(colors).toMatchObject({type:'array',maxItems:100});
 expect(Object.keys(colors.items.properties)).toEqual(['key','name','value','active']);
 expect(colors.items.required).toEqual(['name','value','active']);
 expect(colors.items.properties.key['x-osf-derive-on-create']).toEqual({from:'name',transform:'slug',onConflict:'suffix'});
 expect(colors.items.properties.value).toMatchObject({'x-osf-type':'colorValue',pattern:'^#[0-9A-Fa-f]{6}$'});
 expect(colors.items.properties.active.type).toBe('boolean');
});


test('palette discovery requires tenant authentication but no administrative role',()=>{
 const operations=collectAuthoredEntityPluginOperations([{contract:{entity:{name:'TenantSetting',title:'Settings'},authorization:{roles:{read:['Organization.Security.Manage']}},model:{fields:[],relationships:[]}}}] as any,{repoRoot:'.',authoringDir:'.',webPresent:true});
 const palette=operations.find(op=>op.key==='colors.list')!;
 expect(palette.auth).toEqual({mode:'session'});
 expect(palette.tenancy).toEqual({mode:'required'});
 expect(palette.effects).toEqual({data:'read',external:'none'});
});

test('color and icon patterns retain database-check compatibility', async () => {
 const {isPosixSafePattern}=await import('./authoring/field-value-checks.js');
 const types=parse(readFileSync(new URL('../config/authoring/catalogs/osf-types.yaml',import.meta.url),'utf8')).types;
 expect(isPosixSafePattern(types.color.validation.pattern)).toBe(true);
 expect(isPosixSafePattern(types.icon.validation.pattern)).toBe(true);
});
