import { bindingField, compileReadBindings, compileTableTotals } from './read-bindings.js';
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
  const children = source.contract.model.relationships.find(item => item.key === tree?.children);
  const membership = children && all.get(children.target);
  const through = tree?.through && membership?.contract.model.relationships.find(item => item.key === tree.through!.record);
  if (tree?.through && (!through || through.kind !== 'belongsTo' || !all.has(through.target))) throw new Error(`${name}: tree through.record must name a readable member reference.`);
  if (through && !all.get(through.target)?.operations.list) throw new Error(`${name}: tree members require a canonical list operation.`);
  if (tree?.through?.orderBy && !membership?.contract.model.fields.some(field => field.key === tree.through!.orderBy && field.cardinality !== 'collection')) throw new Error(`${name}: tree orderBy must name a membership scalar.`);
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
  const bindings = compileReadBindings(source, all);
  const totals = compileTableTotals(source, all);
  const value = (owner: ProjectableEntity, input: CollectionTableValueDefinition): WebCollectionTableValue => {
    if (input.binding) {
      const binding = bindings?.[input.binding];
      if (!binding || !input.path || input.when || input.text) throw new Error(`${name}: invalid bound value.`);
      const schema = bindingField(binding.schema, input.path);
      if ([schema.type].flat().some(type => type === 'object' || type === 'array')) throw new Error(`${name}: a bound table cell must be scalar.`);
      if (input.format === 'money') {
        if (!input.currency || ![schema.type].flat().includes('number') || bindingField(binding.schema, input.currency).type !== 'string') throw new Error(`${name}: bound money needs a numeric amount and typed currency.`);
      }
      return { binding: input.binding, boundPath: input.path.split('.'), schema, ...(input.currency ? { boundCurrency: input.currency.split('.') } : {}), ...(input.format ? { format: input.format } : {}) };
    }
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
    if (column.membershipValues && !tree?.through) throw new Error(`${name}: membership values require explicit tree.through.`);
    return { key: column.key, label: local(column.label), values: column.values.map(item => value(record, item)), ...(column.membershipValues ? { membershipValues: column.membershipValues.map(item => value(membership!, item)) } : {}) };
  });
  const panel = authored.recordPanel;
  if (panel?.actions?.some(action => !["edit", "openFull"].includes(action))) throw new Error(`${name}: invalid summary action.`);
  if (panel?.summaryColumns) {
    if (panel.binding || !panel.heading || panel.summaryColumns.some(key => !keys.has(key))) throw new Error(`${name}: record summaries require a heading and known table columns.`);
    if (panel.fields?.some(key => !record.contract.model.fields.some(field => field.key === key))) throw new Error(`${name}: summary fields require direct record fields.`);
    for (const key of [panel.heading, panel.subtitle, ...(panel.fields ?? [])].filter(Boolean)) path(record, key!, undefined);
  }
  if (panel?.view !== undefined) {
    if ((all.get(record.contract.entity.name) ?? record).contract.interfaces?.web?.namedViews?.[panel.view]?.kind !== 'record') throw new Error(`${name}: record panel view ${panel.view} must name a record view of ${record.contract.entity.name}.`);
    if (panel.includeRecord === true || panel.summaryColumns || panel.binding || panel.fields || panel.heading || panel.subtitle || panel.collection || panel.layout) throw new Error(`${name}: a record panel view replaces the inline record body.`);
  }
  if (panel?.primaryMembership) {
    if (!membership || !through || !panel.summaryColumns) throw new Error(`${name}: primaryMembership requires a summary and a membership tree.`);
    path(membership, panel.primaryMembership.field, undefined);
  }
  const sections = panel?.sections?.map(section => {
    const owner = section.scope === "treeParent" ? source : record;
    const relation = owner.contract.model.relationships.find(item => item.key === section.relationship);
    const target = relation && all.get(relation.target);
    if (section.scope && !tree) throw new Error(`${name}: section scope requires a collection tree.`);
    if (section.scope === "recordAndTreeParent" && record !== source) throw new Error(`${name}: combined scope requires the same entity for parent and record.`);
    if (!panel?.summaryColumns || !target || relation?.kind !== "hasMany") throw new Error(`${name}: invalid summary relationship ${section.relationship}.`);
    if (section.orderBy) {
      if (!target.contract.model.fields.some(field => field.key === section.orderBy && field.cardinality !== "collection" && ["string", "number", "integer"].includes(field.baseType))) throw new Error(`${name}: summary orderBy requires a direct field.`);
      path(target, section.orderBy, undefined);
    }
    if (section.presentation && !["options", "rows"].includes(section.presentation)) throw new Error(`${name}: invalid summary presentation.`);
    for (const key of Object.keys(section.where ?? {})) path(target, key, undefined);
    return { ...section, ...(section.groupBy ? { groupBy: path(target, section.groupBy, undefined) } : {}), title: local(section.title), label: value(target, section.label), description: section.description && value(target, section.description), details: section.details?.map(item => value(target, item)), values: section.values.map(item => value(target, item)) };
  });
  if (authored.recordPanel?.binding) {
    const panel = authored.recordPanel, binding = bindings?.[panel.binding!];
    if (!binding) throw new Error(`${name}: record panel binding is unknown.`);
    if (panel.avatar) bindingField(binding.schema, panel.avatar);
    for (const tab of panel.layout?.tabs ?? []) for (const group of tab.groups) for (const field of group.fields) bindingField(binding.schema, field);
    for (const field of [...panel.fields ?? [], ...panel.heading ? [panel.heading] : [], ...panel.subtitle ? [panel.subtitle] : []]) bindingField(binding.schema, field);
    if (panel.collection) {
      const schema = bindingField(binding.schema, panel.collection.field);
      if (schema.type !== 'array' || !schema.items?.properties) throw new Error(`${name}: panel collection must be a typed record array.`);
      for (const field of panel.collection.columns) bindingField(schema.items, field);
    }
  }
  const navigation = authored.navigation?.map(link => {
    if (!link.route.startsWith('/') || link.route.startsWith('//')) throw new Error(`${name}: collection navigation requires local routes.`);
    return { ...link, label: local(link.label) };
  });
  return { ...authored, ...(bindings ? { bindings } : {}), ...(totals ? { totals } : {}), ...(navigation ? { navigation } : {}), ...(authored.rowLabel ? { rowLabel: path(record, authored.rowLabel, undefined) } : {}), ...(authored.membershipDescription ? { membershipDescription: path(membership!, authored.membershipDescription, undefined) } : {}), ...(authored.recordPanel ? { recordPanel: { ...authored.recordPanel, ...(sections ? { sections } : {}), title: local(authored.recordPanel.title), ...(authored.recordPanel.collection ? { collection: { ...authored.recordPanel.collection, title: local(authored.recordPanel.collection.title) } } : {}), ...(authored.recordPanel.note ? { note: local(authored.recordPanel.note) } : {}) } } : {}), heading: { title: local(authored.heading.title), ...(authored.heading.subtitle ? { subtitle: local(authored.heading.subtitle) } : {}) }, views: { tree: local(authored.views.tree), flat: local(authored.views.flat) }, label: local(authored.label), ...(authored.ungrouped ? { ungrouped: local(authored.ungrouped) } : {}), columns } as WebCollectionTable;
}
