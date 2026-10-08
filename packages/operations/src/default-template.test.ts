import {test,expect} from 'bun:test';
import {defaultTemplatePaths,renderDefaultTemplate} from './default-template.js';
test('templates interpolate related and local scalar fields without evaluating expressions',()=>{
 expect(renderDefaultTemplate('Budget {{ fiscalYear.code }} / {{name}}',new Map([['fiscalYear.code','2027'],['name','Base']]))).toBe('Budget 2027 / Base');
 expect(defaultTemplatePaths('{{name}} {{name}}')).toEqual(['name']);
 for(const value of ['{{a.b.c}}','{{constructor()}}','{{name || 2027}}','{{}}'])expect(()=>defaultTemplatePaths(value)).toThrow();
 expect(()=>renderDefaultTemplate('{{fiscalYear.code}}',new Map())).toThrow();
});
