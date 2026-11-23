// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from 'bun:test';
import { bindingField, compileReadBindings, compileTableTotals } from './read-bindings.js';
import { compileCollectionTable } from './collection-table.js';
import type { WebCollectionMoneyTotals, WebCollectionPartsTotals } from '@openshapeforge/interface-web';
const operation = () => ({ id: 'Record.readTerms', key: 'readTerms', target: { scope: 'collection' }, effects: { data: 'read', external: 'none' }, confirmation: { mode: 'none' },
  input: { schema: { type: 'object', required: ['ids'], properties: { ids: { type: 'array', items: { type: 'string' } } } } },
  output: { schema: { properties: { items: { type: 'array', items: { properties: { source: { type: 'object', properties: { id: { type: 'string' } } }, id: { type: 'string' }, status: { enum: ['available','missing','unavailable','ambiguous','failed'] }, value: { type: 'object', properties: { amount: { type: 'number' } } } } } } } } },
});
function fixture(entity: string) {
  const op = operation();
  const owner = { customOperations: { readTerms: op } } as any;
  const source = { contract: { interfaces: { web: { collectionTable: { bindings: { terms: { entity, operation: op.id } } } } } } } as any;
  return { source, op, run: () => compileReadBindings(source, new Map([[entity, owner]])) };
}
test('read bindings share one typed contract across domains', () => {
  for (const entity of ['Agreement', 'Employee']) expect(fixture(entity).run()?.terms?.entityId).toBe(entity);
});
test('writes, external effects and untyped outputs cannot become read bindings', () => {
  const write = fixture('Agreement'); write.op.effects.data = 'write'; expect(write.run).toThrow('canonical collection read');
  const external = fixture('Agreement'); external.op.effects.external = 'send'; expect(external.run).toThrow('canonical collection read');
  const untyped = fixture('Agreement'); (untyped.op.output.schema.properties.items.items.properties.value as any).properties = undefined; expect(untyped.run).toThrow('typed ids');
});
test('bound fields must exist in the declared output schema', () => {
  const schema = { properties: { amount: { type: 'number' } } };
  expect(bindingField(schema, 'amount').type).toBe('number');
  expect(() => bindingField(schema, 'cost.secret')).toThrow('Unknown typed');
  expect(() => bindingField(schema, '__proto__')).toThrow('Invalid binding');
});

test('read bindings validate their declared source invalidation entities',()=>{const f=fixture('Employee');f.source.contract.interfaces.web.collectionTable.bindings.terms.refreshOn=['Employee'];expect(f.run()?.terms?.refreshOn).toEqual(['Employee']);f.source.contract.interfaces.web.collectionTable.bindings.terms.refreshOn=['UnknownSource'];expect(f.run).toThrow('known source entities');});

const totalsOperation = () => ({ id: 'Record.totalTerms', key: 'totalTerms', target: { scope: 'collection' }, effects: { data: 'read', external: 'none' }, confirmation: { mode: 'none' },
  input: { schema: { type: 'object', properties: { filter: { type: 'object' } } } as any },
  output: { schema: { properties: { status: { enum: ['available', 'unavailable', 'failed'] }, count: { type: 'integer' }, excluded: { type: 'integer' },
    totals: { type: 'array', items: { properties: { currencyCode: { type: 'string' }, amount: { type: 'number' } } } } } } as any },
});
function totalsFixture() {
  const op = totalsOperation();
  const source = { contract: { interfaces: { web: { collectionTable: { totals: { entity: 'Agreement', operation: op.id, count: { en: 'contracts' }, label: { en: 'total value', nl: 'totale waarde' } } } } } } } as any;
  return { op, run: () => compileTableTotals(source, new Map([['Agreement', { customOperations: { totalTerms: op } } as any]])) };
}
test('table totals bind a per-currency collection read and localize their wording', () => {
  const totals = totalsFixture().run() as WebCollectionMoneyTotals;
  expect(totals.entityId).toBe('Agreement');
  expect(totals.operation.id).toBe('Record.totalTerms');
  expect(totals.count).toEqual({ en: 'contracts', nl: 'contracts' });
  expect(totals.label.nl).toBe('totale waarde');
});
test('table totals refuse writes, required inputs and a summed-across-currencies shape', () => {
  const write = totalsFixture(); write.op.effects.data = 'write'; expect(write.run).toThrow('canonical collection read');
  const required = totalsFixture(); (required.op.input.schema as any).required = ['ids']; expect(required.run).toThrow('optional filter');
  const single = totalsFixture(); (single.op.output.schema as any).properties.totals = { type: 'number' }; expect(single.run).toThrow('per-currency');
  const noExcluded = totalsFixture(); delete (noExcluded.op.output.schema as any).properties.excluded; expect(noExcluded.run).toThrow('excluded');
});

function partsFixture(parts: unknown[] = [{ path: 'people', label: { en: 'people', nl: 'mensen' } }, { path: 'fte', label: { en: 'FTE' }, decimalPlaces: 1 }]) {
  const op = totalsOperation();
  op.output.schema = { properties: { status: { enum: ['available', 'unavailable', 'failed'] }, people: { type: 'integer' }, fte: { type: 'number' }, label: { type: 'string' } } } as any;
  const source = { contract: { interfaces: { web: { collectionTable: { totals: { entity: 'Employee', operation: op.id, parts } } } } } } as any;
  return { op, run: () => compileTableTotals(source, new Map([['Employee', { customOperations: { totalTerms: op } } as any]])) };
}
test('numeric table totals name numeric output properties and localize their labels', () => {
  const totals = partsFixture().run() as WebCollectionPartsTotals;
  expect(totals.entityId).toBe('Employee');
  expect(totals.parts).toEqual([{ path: 'people', label: { en: 'people', nl: 'mensen' } }, { path: 'fte', label: { en: 'FTE', nl: 'FTE' }, decimalPlaces: 1 }]);
});
test('numeric table totals refuse unknown, non-numeric, status and duplicate parts and a read without a filter', () => {
  expect(partsFixture([{ path: 'missing', label: { en: 'x' } }]).run).toThrow('part missing must name a numeric property');
  expect(partsFixture([{ path: 'label', label: { en: 'x' } }]).run).toThrow('part label must name a numeric property');
  expect(partsFixture([{ path: 'status', label: { en: 'x' } }]).run).toThrow('part status must name a numeric property');
  expect(partsFixture([{ path: 'fte', label: { en: 'x' } }, { path: 'fte', label: { en: 'y' } }]).run).toThrow('duplicate part fte');
  const unfiltered = partsFixture(); (unfiltered.op.input.schema as any).properties = {}; expect(unfiltered.run).toThrow('optional filter input');
  const required = partsFixture(); (required.op.input.schema as any).required = ['filter']; expect(required.run).toThrow('optional filter input');
});

test('a team panel preserves a typed forecast summary above a named employee record view', () => {
  const f=fixture('Employee');
  const values=f.op.output.schema.properties.items.items.properties.value.properties as Record<string,unknown>;
  Object.assign(values,{name:{type:'string'},avatarDocumentId:{type:'string'},basePay:{type:'number'},additionalEmployerCosts:{type:'number'},employerCostPercentage:{type:'number'},totalCost:{type:'number'},periodStart:{type:'string'},periodEnd:{type:'string'}});
  const panel:any={title:{en:'Person details'},view:'workforcePanel',binding:'terms',avatar:'avatarDocumentId',heading:'name',layout:{tabs:[{id:'forecast',label:{en:'Forecast'},groups:[{title:{en:'Employer costs'},fields:['basePay','additionalEmployerCosts','employerCostPercentage','totalCost','periodStart','periodEnd']}]}]}};
  const table:any={...f.source.contract.interfaces.web.collectionTable,heading:{title:{en:'Workforce'}},views:{tree:{en:'By team'},flat:{en:'Teams'}},label:{en:'Person'},columns:[{key:'salary',label:{en:'Salary'},values:[{binding:'terms',path:'basePay'}]}],recordPanel:panel};
  Object.assign(f.source.contract,{entity:{name:'Team'},model:{fields:[],relationships:[{key:'memberships',kind:'hasMany',target:'Membership'}]}});
  Object.assign(f.source.contract.interfaces.web,{collectionTable:table,collectionTree:{children:'memberships',through:{record:'employeeId'}}});
  const employee:any={customOperations:{readTerms:f.op},operations:{list:{}},contract:{entity:{name:'Employee'},model:{fields:[],relationships:[]},interfaces:{web:{namedViews:{workforcePanel:{kind:'record',fields:['name']}}}}}};
  const membership:any={contract:{model:{fields:[],relationships:[{key:'employeeId',kind:'belongsTo',target:'Employee'}]}}};
  const run=()=>compileCollectionTable(f.source,new Map([['Team',f.source],['Membership',membership],['Employee',employee]]));
  expect(run()!.recordPanel).toMatchObject(panel);
  expect(run()!.bindings!.terms!.schema.properties).toMatchObject(values);
  panel.layout.tabs[0].groups[0].fields=['unknownForecastField'];
  expect(run).toThrow('Unknown typed binding field');
  panel.layout.tabs[0].groups[0].fields=['basePay'];
  panel.binding='unknown'; expect(run).toThrow('binding is unknown');
  panel.binding='terms'; panel.includeRecord=true; expect(run).toThrow('replaces the inline record body');
  delete panel.includeRecord; panel.fields=['basePay']; expect(run).toThrow('replaces the inline record body');
  delete panel.fields; delete panel.binding; expect(run).toThrow('replaces the inline record body');
});

test('a table value carries its localized empty label, and a footer is summary or totals, never both', () => {
  const f=fixture('Employee');
  Object.assign(f.op.output.schema.properties.items.items.properties.value.properties as Record<string,unknown>,{endDate:{type:['string','null'],format:'date'}});
  const table:any={...f.source.contract.interfaces.web.collectionTable,heading:{title:{en:'Workforce'}},views:{tree:{en:'By team'},flat:{en:'All'}},label:{en:'Person'},columns:[{key:'end',label:{en:'End'},values:[{binding:'terms',path:'endDate',emptyLabel:{en:'Indefinite',nl:'Onbepaald'}}]},{key:'name',label:{en:'Name'},values:[{path:'name',emptyLabel:{en:'Unnamed'}}]}]};
  Object.assign(f.source.contract,{entity:{name:'Employee'},model:{fields:[{key:'name',baseType:'string',osfType:'string',cardinality:'single'}],relationships:[]}});
  Object.assign(f.source.contract.interfaces.web,{collectionTable:table});
  const totals=partsFixture();
  const all=new Map([['Employee',{...f.source,customOperations:{readTerms:f.op,totalTerms:totals.op}} as any]]);
  const run=()=>compileCollectionTable(f.source,all)!;
  expect(run().columns[0]!.values[0]).toMatchObject({binding:'terms',boundPath:['endDate'],emptyLabel:{en:'Indefinite',nl:'Onbepaald'}});
  expect(run().columns[1]!.values[0]).toMatchObject({path:{field:'name'},emptyLabel:{en:'Unnamed',nl:'Unnamed'}});
  table.columns[1].values[0]={text:{en:'Fixed'},emptyLabel:{en:'Never'}}; expect(run).toThrow('emptyLabel requires a value path');
  table.columns.pop();
  table.totals={entity:'Employee',operation:totals.op.id,parts:[{path:'people',label:{en:'people'}}]};
  expect((run().totals as WebCollectionPartsTotals).parts[0]!.path).toBe('people');
  table.summary={field:'name'}; expect(run).toThrow('either summary or totals');
});
