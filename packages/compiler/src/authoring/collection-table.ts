// SPDX-License-Identifier: BUSL-1.1
import type { WebCollectionTable, WebCollectionTableValue, WebValuePath } from '@openshapeforge/interface-web';
import type { CollectionTableValueDefinition } from './types/authoring.js';
import { compileWebValuePath, type ProjectableEntity } from './web-manifest.js';

/** Compile data selection once. Consumers render typed values; they never interpret authored paths. */
export function compileCollectionTable(source: ProjectableEntity, all: ReadonlyMap<string, ProjectableEntity>): WebCollectionTable | undefined {
  const authored = source.contract.interfaces?.web?.collectionTable;
  const tree = source.contract.interfaces?.web?.collectionTree;
  if (!authored) return undefined;
  const name = source.contract.entity.name;
  if (!tree) throw new Error(`${name}: a declarative tree table requires a collection tree.`);
  const children = source.contract.model.relationships.find(item => item.key === tree.children);
  const membership = children && all.get(children.target);
  const through = tree.through && membership?.contract.model.relationships.find(item => item.key === tree.through!.record);
  if (tree.through && (!through || through.kind !== 'belongsTo' || !all.has(through.target))) throw new Error(`${name}: tree through.record must name a readable member reference.`);
  if (through && !all.get(through.target)?.operations.list) throw new Error(`${name}: tree members require a canonical list operation.`);
  if (tree.through?.orderBy && !membership?.contract.model.fields.some(field => field.key === tree.through!.orderBy && field.cardinality !== 'collection')) throw new Error(`${name}: tree orderBy must name a membership scalar.`);
  const record = through ? all.get(through.target)! : source;
  if (authored.description && !source.contract.model.fields.some(field => field.key === authored.description && field.cardinality !== 'collection')) throw new Error(`${name}: table description must name a scalar field.`);
  if (authored.groupBy) {
    const field = source.contract.model.fields.find(field => field.key === authored.groupBy);
    if (!field || field.cardinality === 'collection' || field.baseType === 'object') throw new Error(`${name}: table groupBy must name a scalar field or reference.`);
  }
  if (authored.summary && !source.contract.model.fields.some(field => field.key === authored.summary!.field && field.cardinality !== 'collection')) throw new Error(`${name}: table summary must name a scalar field.`);
  const path = (owner: ProjectableEntity, expression: string, select: 'one' | undefined): WebValuePath => {
    const result = compileWebValuePath(owner, all, expression);
    if (result.cardinality === 'many' && select !== 'one') throw new Error(`${name}: table path ${expression} is collection-valued; declare select: one to require zero or one readable result.`);
    return result;
  };
  const value = (owner: ProjectableEntity, input: CollectionTableValueDefinition): WebCollectionTableValue => {
    const result = input.path ? path(owner, input.path, input.select) : undefined;
    const currency = input.currency ? path(owner, input.currency, input.select) : undefined;
    if (input.format === 'money' && (!result?.field || !currency?.field || result.targetEntityId !== currency.targetEntityId || JSON.stringify(result.path) !== JSON.stringify(currency.path))) throw new Error(`${name}: money requires amount and currency on the same related record.`);
    if (currency?.field) {
      const field = all.get(currency.targetEntityId)?.contract.model.fields.find(field => field.key === currency.field);
      if (field?.baseType !== 'string') throw new Error(`${name}: a currency path requires a string field.`);
    }
    if (input.format && !result) throw new Error(`${name}: a formatted table value requires a typed path.`);
    if (result?.field && input.format && ['money', 'percentage', 'frequency'].includes(input.format)) {
      const field = all.get(result.targetEntityId)?.contract.model.fields.find(field => field.key === result.field);
      if (!field || !['number', 'integer'].includes(field.baseType)) throw new Error(`${name}: ${input.format} requires a numeric field.`);
    }
    return { ...input, ...(input.text ? { text: local(input.text) } : {}), ...(result ? { path: result } : {}), ...(currency ? { currency } : {}), ...(input.when ? { when: { path: path(owner, input.when.path, input.select), equals: input.when.equals } } : {}) } as WebCollectionTableValue;
  };
  const local = (text: { en?: string; nl?: string }) => ({ en: text.en ?? text.nl ?? "", nl: text.nl ?? text.en ?? "" });
  if (authored.membershipDescription && !through) throw new Error(`${name}: membershipDescription requires explicit tree.through.`);
  const keys = new Set<string>();
  const columns = authored.columns.map(column => {
    if (keys.has(column.key)) throw new Error(`${name}: duplicate table column ${column.key}.`);
    keys.add(column.key);
    if (column.membershipValues && !tree.through) throw new Error(`${name}: membership values require explicit tree.through.`);
    return { key: column.key, label: local(column.label), values: column.values.map(item => value(record, item)), ...(column.membershipValues ? { membershipValues: column.membershipValues.map(item => value(membership!, item)) } : {}) };
  });
  return { ...authored, ...(authored.rowLabel ? { rowLabel: path(record, authored.rowLabel, undefined) } : {}), ...(authored.membershipDescription ? { membershipDescription: path(membership!, authored.membershipDescription, undefined) } : {}), ...(authored.recordPanel ? { recordPanel: { title: local(authored.recordPanel.title) } } : {}), heading: { title: local(authored.heading.title), ...(authored.heading.subtitle ? { subtitle: local(authored.heading.subtitle) } : {}) }, views: { tree: local(authored.views.tree), flat: local(authored.views.flat) }, label: local(authored.label), ...(authored.ungrouped ? { ungrouped: local(authored.ungrouped) } : {}), columns } as WebCollectionTable;
}
