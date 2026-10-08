// SPDX-License-Identifier: BUSL-1.1
import { defaultTemplatePaths } from '@openshapeforge/operations';
import type { TableDefinition } from '../../schema.js';
/** Resolve the limited field-path vocabulary against actual storage, before emitting a runtime. */
export function validateDefaultTemplates(tables: readonly TableDefinition[]): void {
  for (const table of tables) for (const column of table.columns) {
    if (column.defaultTemplate === undefined) continue;
    if (column.type !== 'text' && !column.type.startsWith('varchar')) throw new Error('defaultTemplate requires a persisted string field.');
    if (column.default !== undefined || column.deriveOnCreate || column.writtenBy?.length) throw new Error('defaultTemplate cannot coexist with another default or server writer.');
    for (const path of defaultTemplatePaths(column.defaultTemplate)) {
      const [key, field] = path.split('.');
      let source = table;
      let sourceField = key;
      if (field) {
        const relations = (table.source?.graphql?.relationships ?? []).filter(relation => relation.name === key || relation.name === `${key}Id`);
        if (relations.length !== 1 || relations[0]!.resolve !== 'belongsTo') throw new Error(`Unknown or non-single defaultTemplate relationship ${path}.`);
        const target = tables.find(candidate => candidate.source?.graphql?.typeName === relations[0]!.target);
        if (!target) throw new Error(`Unavailable defaultTemplate target ${path}.`);
        source = target; sourceField = field;
      }
      const selected = source.columns.find(candidate => candidate.sourceField === sourceField);
      if (!selected || selected.defaultTemplate || selected.deriveOnCreate || selected.name === column.name && source === table || !['text','varchar','numeric','integer','bigint','boolean','date'].some(type => selected.type.startsWith(type))) throw new Error(`Invalid defaultTemplate source ${path}.`);
    }
  }
}
