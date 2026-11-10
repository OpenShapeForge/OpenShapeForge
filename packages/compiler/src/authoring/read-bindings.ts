// SPDX-License-Identifier: BUSL-1.1
import type { WebCollectionTable } from '@openshapeforge/interface-web';
import type { ProjectableEntity } from './web-manifest.js';
type Schema = Record<string, any>;

export function bindingField(schema: Schema, expression: string): Schema {
  const parts = expression.split('.');
  if (parts.length > 6 || parts.some(key => !/^[a-zA-Z][a-zA-Z0-9]*$/.test(key))) throw new Error('Invalid binding field path.');
  let field = schema;
  for (const key of parts) {
    field = field.properties?.[key];
    if (!field) throw new Error(`Unknown typed binding field ${expression}.`);
  }
  return field;
}

/** A binding references a canonical, harmless batch read, never an arbitrary callback. */
export function compileReadBindings(source: ProjectableEntity, all: ReadonlyMap<string, ProjectableEntity>): WebCollectionTable['bindings'] {
  const bindings = source.contract.interfaces?.web?.collectionTable?.bindings;
  if (!bindings) return undefined;
  return Object.fromEntries(Object.entries(bindings).map(([name, binding]) => {
    if (!/^[a-z][a-zA-Z0-9]*$/.test(name)) throw new Error('Invalid read binding name.');
    if (binding.refreshOn?.some(entity => !all.has(entity))) throw new Error(`${name}: refreshOn requires known source entities.`);
    const owner = all.get(binding.entity);
    const operation = owner && Object.values(owner.customOperations).find(op => op.id === binding.operation || op.key === binding.operation);
    if (!operation || operation.target.scope !== 'collection' || operation.effects.data !== 'read' || operation.effects.external !== 'none' || operation.confirmation.mode !== 'none') throw new Error(`${name}: read binding requires a canonical collection read with no external effects or confirmation.`);
    const input = operation.input.schema as Schema;
    const output = operation.output.schema as Schema;
    const item = output.properties?.items?.items;
    const value = item?.properties?.value;
    const states = item?.properties?.status?.enum;
    if (input.properties?.ids?.type !== 'array' || input.properties.ids.items?.type !== 'string' || !(input.required ?? []).includes('ids') ||
        item?.properties?.id?.type !== 'string' || !item?.properties?.source?.properties || !value?.properties || !Array.isArray(states) || !['available', 'missing', 'unavailable', 'ambiguous', 'failed'].every(state => states.includes(state))) throw new Error(`${name}: read binding requires typed ids input and indexed status/value output.`);
    for (const key of input.required ?? []) if (key !== 'ids' && !Object.hasOwn(binding.parameters ?? {}, key)) throw new Error(`${name}: required binding parameter ${key} is missing.`);
    for (const [key, value] of Object.entries(binding.parameters ?? {})) if (key === 'ids' || !input.properties?.[key] || typeof value !== input.properties[key].type) throw new Error(`${name}: invalid fixed binding parameter ${key}.`);
    return [name, { entityId: binding.entity, operation, schema: value, ...(binding.refreshOn ? { refreshOn: [...new Set(binding.refreshOn)] } : {}), ...(binding.parameters ? { parameters: binding.parameters } : {}) }];
  }));
}
