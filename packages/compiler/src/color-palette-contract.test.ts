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
 expect(colors.items.required).toEqual(['key','name','value','active']);
 expect(colors.items.properties.value).toMatchObject({'x-osf-type':'colorValue',pattern:'^#[0-9A-Fa-f]{6}$'});
 expect(colors.items.properties.active.type).toBe('boolean');
});
