import { expect, test } from 'bun:test';
import { parseTenantColors, resolvePalette, resolveColor } from './colors.js';
const blue = { key:'brand-primary', name:'Merkblauw', value:'#2457d6', active:true };
test('a stable reference follows name and value changes', () => {
 const before = resolvePalette(parseTenantColors({colors:[blue]}));
 const after = resolvePalette(parseTenantColors({colors:[{...blue,name:'Nieuw blauw',value:'#112233'}]}));
 expect(resolveColor('tenant:brand-primary',before)?.value).toBe('#2457D6');
 expect(resolveColor('tenant:brand-primary',after)).toMatchObject({name:'Nieuw blauw',value:'#112233'});
 expect(resolveColor('tenant:brand-primary',resolvePalette([]))).toBeUndefined();
});
test('rejects duplicate keys, unsafe values, excess properties and invalid active state',()=>{
 for(const colors of [[blue,blue],[{...blue,value:'url(x)'}],[{...blue,active:'true'}],[{...blue,tenantId:'other'}]]) expect(()=>parseTenantColors({colors})).toThrow();
});
test('archived colors keep resolving and standard colors cannot be overwritten',()=>{
 const palette=resolvePalette(parseTenantColors({colors:[{...blue,key:'blue',active:false}]}));
 expect(resolveColor('tenant:blue',palette)?.active).toBe(false);
 expect(resolveColor('standard:blue',palette)?.active).toBe(true);
});
