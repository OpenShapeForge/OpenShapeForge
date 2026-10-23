// SPDX-License-Identifier: BUSL-1.1
import type { CompiledEntityContract } from './authoring/types.js';
import type { JsonSchema } from './plugins.js';

/** Existing authored collection Operations are the allowlist; no new authoring language. */
export function relatedUpdateSchema(owner: CompiledEntityContract, contracts: readonly CompiledEntityContract[], values: (entity: CompiledEntityContract, intent: 'create' | 'update') => JsonSchema): JsonSchema | undefined {
  const branches: JsonSchema[] = [];
  const title = (en: string, nl: string) => ({'x-osf-i18n': {title:{en,nl}}});
  const uuid = { type: 'string', format: 'uuid', ...title('Record ID','Record-ID') };
  const record = (properties: Record<string, unknown>, required: string[]): JsonSchema => ({ type: 'object', additionalProperties: false, properties, required });
  const createValues = (entity: CompiledEntityContract, depth = 0): JsonSchema => {
    const schema = structuredClone(values(entity, 'create'));
    if (depth >= 2) return schema;
    const properties = schema.properties as Record<string, JsonSchema>;
    for (const relation of entity.model.relationships) {
      if (relation.kind !== 'belongsTo' || !relation.foreignKey) continue;
      const column = entity.storage.columns.find(c => c.column === relation.foreignKey);
      const field = column?.field;
      const target = contracts.find(c => c.entity.name === relation.target);
      const op = target?.entityOperations.create;
      if (!field || !properties[field] || !target || !op || op.implementation.type !== 'entity' || op.effects.external !== 'none' || op.interaction.secureInput || op.interaction.confirmation.mode !== 'none' || op.prerequisites?.length || op.concurrency?.editLease || op.reliability.idempotency.mode === 'keyed') continue;
      const nested = createValues(target, depth + 1);
      for (const [bound, predicate] of Object.entries(relation.constraints ?? {})) {
        if ('eq' in predicate) {
          delete (nested.properties as Record<string, unknown>)[bound];
          if (Array.isArray(nested.required)) nested.required = nested.required.filter(key => key !== bound);
        }
      }
      properties[field] = { ...Object.fromEntries(Object.entries(properties[field]!).filter(([key])=>key==='title'||key==='description'||key.startsWith('x-osf-'))), anyOf: [properties[field]!, record({ create: {...nested,...title('New referenced record','Nieuw gekoppeld record')} }, ['create'])] };
    }
    return schema;
  };
  for (const relation of owner.model.relationships) {
    if (relation.kind !== 'hasMany' || relation.ownership !== 'reference' || relation.through || !relation.inverse || !relation.foreignKey) continue;
    const declared = (owner.pluginOperations ?? []).filter(op => op.definition.implementation.type === 'collection' && op.definition.implementation.field === relation.fieldKey);
    if (!declared.some(op => op.definition.implementation.type === 'collection' && op.definition.implementation.action === 'update')) continue;
    const child = contracts.find(c => c.entity.name === relation.target);
    const parentField = child?.storage.columns.find(c => c.column === relation.foreignKey)?.field;
    if (!child || !parentField || !child.entityOperations.update) continue;
    const scoped = (schema: JsonSchema) => {
      const result = structuredClone(schema);
      delete (result.properties as Record<string, unknown>)[parentField];
      if (Array.isArray(result.required)) result.required = result.required.filter(key => key !== parentField);
      return result;
    };
    const properties: Record<string, unknown> = {
      relationship: { const: relation.fieldKey, type: 'string', ...title('Relationship','Relatie'), description:'Use this exact declared relationship key; the server binds its parent reference.' },
      update: { type: 'array', maxItems: 100, ...title('Changed records','Gewijzigde records'), description:'Read each current record version and acquire its update lease when required. Updates retain their own record and field permissions.', items: record({ id: uuid, expectedVersion: { type: 'string', format: 'date-time', ...title('Expected record version','Verwachte recordversie') }, values: scoped(values(child, 'update')), ...(child.entityOperations.update.concurrency?.editLease ? {leaseToken:{type:'string',minLength:1,...title('Record edit lease','Bewerkingslease van het record')}} : {}) }, ['id', 'expectedVersion', 'values', ...(child.entityOperations.update.concurrency?.editLease ? ['leaseToken'] : [])]) },
    };
    if (declared.some(op => op.definition.implementation.type === 'collection' && op.definition.implementation.action === 'insert')) properties.create = { type: 'array', maxItems: 100, ...title('New records','Nieuwe records'), description:'Create these records only when the entire parent save succeeds. Use existing reference IDs where available.', items: scoped(createValues(child)) };
    branches.push(record(properties, ['relationship']));
  }
  return branches.length ? { type: 'array', maxItems: 10, ...title('Related changes','Gerelateerde wijzigingen'), items: { oneOf: branches }, description: 'Related changes committed with this record. Each child keeps its own permissions. New reference records are created only if the whole save succeeds.' } : undefined;
}
