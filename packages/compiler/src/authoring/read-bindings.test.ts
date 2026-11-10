// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from 'bun:test';
import { bindingField, compileReadBindings } from './read-bindings.js';
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
